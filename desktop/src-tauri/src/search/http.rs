//! HTTP для источников: пауза между запросами, лимит запросов на запуск, повторы с растущей задержкой.
//! Транспорт подменяется в тестах.

use async_trait::async_trait;
use chrono::Utc;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

pub const USER_AGENT: &str = "Customers/1.1 (personal non-commercial research)";
const RETRY_STATUSES: [u16; 5] = [429, 500, 502, 503, 504];

#[derive(Debug, Clone)]
pub enum SearchError {
    Http { message: String, status: Option<u16>, transient: bool },
    Budget(String),
    Cancelled,
    Other(String),
}

impl SearchError {
    pub fn http(message: impl Into<String>, status: Option<u16>, transient: bool) -> Self {
        SearchError::Http { message: message.into(), status, transient }
    }
    pub fn message(&self) -> String {
        match self {
            SearchError::Http { message, .. } => message.clone(),
            SearchError::Budget(m) | SearchError::Other(m) => m.clone(),
            SearchError::Cancelled => "поиск остановлен".into(),
        }
    }
}

impl std::fmt::Display for SearchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

impl std::error::Error for SearchError {}

#[derive(Debug, Clone, Default)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    pub timeout: f64,
}

#[derive(Debug, Clone, Default)]
pub struct HttpResponse {
    pub status: u16,
    pub data: Vec<u8>,
    /// Заголовки в нижнем регистре.
    pub headers: HashMap<String, String>,
    pub url: Option<String>,
}

impl HttpResponse {
    pub fn new(status: u16, data: impl Into<Vec<u8>>) -> Self {
        Self { status, data: data.into(), ..Default::default() }
    }
    pub fn with_headers(mut self, h: &[(&str, &str)]) -> Self {
        for (k, v) in h {
            self.headers.insert(k.to_lowercase(), v.to_string());
        }
        self
    }

    /// Текст ответа: UTF-8, иначе Windows-1251 (старые русские сайты).
    pub fn text(&self) -> String {
        match std::str::from_utf8(&self.data) {
            Ok(s) => s.to_string(),
            Err(_) => encoding_rs::WINDOWS_1251.decode(&self.data).0.into_owned(),
        }
    }
}

#[async_trait]
pub trait HttpTransport: Send + Sync {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, SearchError>;
}

/// Реальный транспорт. Перенаправления на локальные адреса запрещены.
pub struct ReqwestTransport {
    client: reqwest::Client,
}

impl ReqwestTransport {
    pub fn new() -> Self {
        let policy = reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 10 {
                attempt.error("слишком много перенаправлений")
            } else if crate::search::sources::is_public_http_url(attempt.url().as_str()) {
                attempt.follow()
            } else {
                attempt.error("перенаправление на непубличный адрес")
            }
        });
        let client = reqwest::Client::builder().redirect(policy).timeout(Duration::from_secs(180)).build().expect("http client");
        Self { client }
    }
}

impl Default for ReqwestTransport {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl HttpTransport for ReqwestTransport {
    async fn send(&self, req: HttpRequest) -> Result<HttpResponse, SearchError> {
        let method = reqwest::Method::from_bytes(req.method.as_bytes()).unwrap_or(reqwest::Method::GET);
        let mut b = self.client.request(method, &req.url);
        if req.timeout > 0.0 {
            b = b.timeout(Duration::from_secs_f64(req.timeout));
        }
        for (k, v) in &req.headers {
            b = b.header(k, v);
        }
        if let Some(body) = req.body {
            b = b.body(body);
        }
        let resp = b.send().await.map_err(|e| {
            let transient = !e.is_builder() && !e.is_redirect();
            let msg = if e.is_timeout() { "время ожидания вышло".to_string() } else { e.without_url().to_string() };
            SearchError::http(msg, None, transient)
        })?;
        let status = resp.status().as_u16();
        let url = resp.url().to_string();
        let mut headers = HashMap::new();
        for (k, v) in resp.headers() {
            if let Ok(v) = v.to_str() {
                headers.insert(k.as_str().to_lowercase(), v.to_string());
            }
        }
        let data = resp.bytes().await.map_err(|e| SearchError::http(e.without_url().to_string(), None, true))?.to_vec();
        Ok(HttpResponse { status, data, headers, url: Some(url) })
    }
}

pub type Sleeper = Arc<dyn Fn(f64) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

pub fn real_sleeper() -> Sleeper {
    Arc::new(|secs| {
        Box::pin(async move {
            if secs > 0.0 {
                tokio::time::sleep(Duration::from_secs_f64(secs)).await;
            }
        })
    })
}

pub fn no_sleep() -> Sleeper {
    Arc::new(|_| Box::pin(async {}))
}

#[derive(Clone)]
pub struct HttpSettings {
    pub min_interval: f64,
    pub max_requests: usize,
    pub max_attempts: usize,
    pub base_delay: f64,
    pub timeout: f64,
}

impl Default for HttpSettings {
    fn default() -> Self {
        Self { min_interval: 1.0, max_requests: 50, max_attempts: 4, base_delay: 2.0, timeout: 20.0 }
    }
}

pub struct SourceHttp {
    name: String,
    transport: Arc<dyn HttpTransport>,
    cfg: HttpSettings,
    sleeper: Sleeper,
    cancel: CancellationToken,
    state: Mutex<(usize, Option<Instant>)>,
}

impl SourceHttp {
    pub fn new(name: &str, transport: Arc<dyn HttpTransport>, cfg: HttpSettings, sleeper: Sleeper, cancel: CancellationToken) -> Self {
        Self { name: name.into(), transport, cfg, sleeper, cancel, state: Mutex::new((0, None)) }
    }

    pub fn requests_made(&self) -> usize {
        self.state.lock().unwrap().0
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }

    pub async fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<HttpResponse, SearchError> {
        self.send(HttpRequest {
            method: "GET".into(),
            url: url.into(),
            headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            ..Default::default()
        })
        .await
    }

    pub async fn post_form(&self, url: &str, fields: &[(&str, &str)]) -> Result<HttpResponse, SearchError> {
        let body = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(fields.iter().copied()).finish();
        self.send(HttpRequest {
            method: "POST".into(),
            url: url.into(),
            headers: vec![("Content-Type".into(), "application/x-www-form-urlencoded; charset=utf-8".into())],
            body: Some(body.into_bytes()),
            ..Default::default()
        })
        .await
    }

    async fn pause(&self, secs: f64) -> Result<(), SearchError> {
        if secs <= 0.0 {
            return Ok(());
        }
        let sleep = (self.sleeper)(secs);
        tokio::select! {
            _ = sleep => Ok(()),
            _ = self.cancel.cancelled() => Err(SearchError::Cancelled),
        }
    }

    async fn send(&self, mut request: HttpRequest) -> Result<HttpResponse, SearchError> {
        request.timeout = self.cfg.timeout;
        request.headers.push(("User-Agent".into(), USER_AGENT.into()));
        let shown = Self::safe(&request.url);
        let mut last_error = SearchError::http(format!("{}: запрос не выполнен", self.name), None, true);
        for attempt in 1..=self.cfg.max_attempts.max(1) {
            if self.cancel.is_cancelled() {
                return Err(SearchError::Cancelled);
            }
            let wait = {
                let st = self.state.lock().unwrap();
                if st.0 >= self.cfg.max_requests {
                    return Err(SearchError::Budget(format!("{}: лимит {} запросов за запуск", self.name, self.cfg.max_requests)));
                }
                st.1.map(|l| self.cfg.min_interval - l.elapsed().as_secs_f64()).unwrap_or(0.0)
            };
            self.pause(wait).await?;
            {
                let mut st = self.state.lock().unwrap();
                st.1 = Some(Instant::now());
                st.0 += 1;
            }
            let outcome = tokio::select! {
                r = self.transport.send(request.clone()) => r,
                _ = self.cancel.cancelled() => return Err(SearchError::Cancelled),
            };
            match outcome {
                Ok(resp) if resp.status < 400 => return Ok(resp),
                Ok(resp) => {
                    let transient = RETRY_STATUSES.contains(&resp.status);
                    let err = SearchError::http(format!("HTTP {} для {shown}", resp.status), Some(resp.status), transient);
                    if !transient {
                        return Err(err);
                    }
                    last_error = err;
                    if let Some(secs) = resp.headers.get("retry-after").and_then(|v| Self::retry_after(v)) {
                        if attempt < self.cfg.max_attempts {
                            self.pause(secs.min(120.0)).await?;
                            continue;
                        }
                    }
                }
                Err(SearchError::Http { message, status, transient }) => {
                    if !transient {
                        return Err(SearchError::Http { message, status, transient });
                    }
                    last_error = SearchError::http(format!("{shown}: {message}"), status, true);
                }
                Err(e) => return Err(e),
            }
            if attempt < self.cfg.max_attempts {
                let jitter = rand::random::<f64>() * 0.5;
                self.pause(self.cfg.base_delay * 2f64.powi(attempt as i32 - 1) + jitter).await?;
            }
        }
        Err(last_error)
    }

    /// Retry-After: число секунд или HTTP-дата.
    pub fn retry_after(value: &str) -> Option<f64> {
        let v = value.trim();
        if let Ok(secs) = v.parse::<f64>() {
            return Some(secs.max(0.0));
        }
        let date = chrono::DateTime::parse_from_rfc2822(v).ok()?;
        Some((date.with_timezone(&Utc) - Utc::now()).num_milliseconds().max(0) as f64 / 1000.0)
    }

    /// Адрес без параметров (там бывают ключи доступа).
    pub fn safe(url: &str) -> String {
        url.split('?').next().unwrap_or(url).to_string()
    }
}

#[cfg(test)]
pub mod testing {
    use super::*;
    use std::collections::VecDeque;

    /// Транспорт-заглушка: ответы по очереди, все запросы запоминаются.
    pub struct FakeTransport {
        pub responses: Mutex<VecDeque<Result<HttpResponse, SearchError>>>,
        pub requests: Mutex<Vec<HttpRequest>>,
        pub by_url: Mutex<HashMap<String, Result<HttpResponse, SearchError>>>,
    }

    impl FakeTransport {
        pub fn new(responses: Vec<Result<HttpResponse, SearchError>>) -> Arc<Self> {
            Arc::new(Self { responses: Mutex::new(responses.into()), requests: Mutex::new(vec![]), by_url: Mutex::new(HashMap::new()) })
        }
        pub fn routes(routes: Vec<(&str, Result<HttpResponse, SearchError>)>) -> Arc<Self> {
            let t = Self::new(vec![]);
            for (u, r) in routes {
                t.by_url.lock().unwrap().insert(u.to_string(), r);
            }
            t
        }
        pub fn urls(&self) -> Vec<String> {
            self.requests.lock().unwrap().iter().map(|r| r.url.clone()).collect()
        }
    }

    #[async_trait]
    impl HttpTransport for FakeTransport {
        async fn send(&self, request: HttpRequest) -> Result<HttpResponse, SearchError> {
            self.requests.lock().unwrap().push(request.clone());
            if let Some(r) = self.by_url.lock().unwrap().get(&request.url) {
                return r.clone();
            }
            self.responses.lock().unwrap().pop_front().unwrap_or_else(|| Err(SearchError::http("нет ответа в заглушке", None, false)))
        }
    }

    pub fn http_for(t: Arc<dyn HttpTransport>) -> SourceHttp {
        SourceHttp::new("тест", t, HttpSettings { min_interval: 0.0, ..Default::default() }, no_sleep(), CancellationToken::new())
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;

    fn ok(body: &str) -> Result<HttpResponse, SearchError> {
        Ok(HttpResponse::new(200, body))
    }

    #[tokio::test]
    async fn retries_transient_statuses() {
        let t = FakeTransport::new(vec![Ok(HttpResponse::new(503, "")), Ok(HttpResponse::new(429, "")), ok("готово")]);
        let r = http_for(t.clone()).get("https://example.com/a?key=1", &[]).await.unwrap();
        assert_eq!(r.text(), "готово");
        assert_eq!(t.urls().len(), 3);
    }

    #[tokio::test]
    async fn permanent_errors_are_not_retried_and_hide_query() {
        let t = FakeTransport::new(vec![Ok(HttpResponse::new(404, "")), ok("x")]);
        let e = http_for(t.clone()).get("https://example.com/a?key=SECRET", &[]).await.unwrap_err();
        assert!(matches!(e, SearchError::Http { status: Some(404), transient: false, .. }));
        assert!(!e.message().contains("SECRET"));
        assert_eq!(t.urls().len(), 1);
    }

    #[tokio::test]
    async fn gives_up_after_max_attempts() {
        let t = FakeTransport::new(vec![Ok(HttpResponse::new(500, "")); 6]);
        let e = http_for(t.clone()).get("https://example.com/", &[]).await.unwrap_err();
        assert!(matches!(e, SearchError::Http { transient: true, .. }));
        assert_eq!(t.urls().len(), 4);
    }

    #[tokio::test]
    async fn request_budget_is_enforced() {
        let t = FakeTransport::new(vec![ok("a"), ok("b"), ok("c")]);
        let h = SourceHttp::new("лимит", t, HttpSettings { max_requests: 2, min_interval: 0.0, ..Default::default() }, no_sleep(), CancellationToken::new());
        h.get("https://example.com/1", &[]).await.unwrap();
        h.get("https://example.com/2", &[]).await.unwrap();
        assert!(matches!(h.get("https://example.com/3", &[]).await, Err(SearchError::Budget(_))));
    }

    #[tokio::test]
    async fn cancellation_stops_requests() {
        let t = FakeTransport::new(vec![ok("a")]);
        let cancel = CancellationToken::new();
        let h = SourceHttp::new("стоп", t.clone(), HttpSettings::default(), no_sleep(), cancel.clone());
        cancel.cancel();
        assert!(matches!(h.get("https://example.com/", &[]).await, Err(SearchError::Cancelled)));
        assert!(t.urls().is_empty());
    }

    #[tokio::test]
    async fn retry_after_header_is_honoured() {
        let slept = Arc::new(Mutex::new(Vec::<f64>::new()));
        let s2 = slept.clone();
        let sleeper: Sleeper = Arc::new(move |secs| {
            s2.lock().unwrap().push(secs);
            Box::pin(async {})
        });
        let t = FakeTransport::new(vec![Ok(HttpResponse::new(429, "").with_headers(&[("Retry-After", "7")])), ok("ok")]);
        let h = SourceHttp::new("ra", t, HttpSettings { min_interval: 0.0, ..Default::default() }, sleeper, CancellationToken::new());
        h.get("https://example.com/", &[]).await.unwrap();
        assert!(slept.lock().unwrap().contains(&7.0));
    }

    #[test]
    fn retry_after_parses_numbers_and_dates() {
        assert_eq!(SourceHttp::retry_after("12"), Some(12.0));
        assert_eq!(SourceHttp::retry_after("-5"), Some(0.0));
        assert_eq!(SourceHttp::retry_after("Wed, 01 Jan 2020 00:00:00 GMT"), Some(0.0));
        assert_eq!(SourceHttp::retry_after("мусор"), None);
    }

    #[test]
    fn decodes_windows_1251() {
        let (bytes, _, _) = encoding_rs::WINDOWS_1251.encode("Привет");
        assert_eq!(HttpResponse::new(200, bytes.to_vec()).text(), "Привет");
    }
}
