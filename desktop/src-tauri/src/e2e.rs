//! Приёмочные проверки реального приложения (workflow e2e.yml, папка desktop/e2e).
//!
//! Модуль есть только в сборке с флагом компиляции `--cfg e2e`; в релиз он не входит (release-check следит за этим).
//! Идея: в окно настоящего приложения (WKWebView на macOS, WebView2 на Windows) после загрузки страницы вставляется
//! сценарий `driver.js`. Он нажимает кнопки и вызывает команды ядра так же, как интерфейс, сверяет результат с эталоном
//! и присылает отчёт событием `e2e-report`. Отдельный WebDriver не нужен: для WKWebView его не существует.
//!
//! Переменные окружения (задаёт desktop/e2e/run.cjs):
//! * `CUSTOMERS_E2E_DIR` — пустая папка: данные приложения, журналы, файлы выгрузки;
//! * `CUSTOMERS_E2E_SCRIPT` — путь к сценарию, `CUSTOMERS_E2E_CONFIG` — настройки сценария (JSON);
//! * `CUSTOMERS_E2E_OUT` — путь к файлу отчёта; рядом пишется журнал `<имя>.log`;
//! * `CUSTOMERS_E2E_REWRITE` — подмена адресов запросов ядра: `https://узел=http://127.0.0.1:порт;…` (в том числе облака Supabase);
//! * `CUSTOMERS_E2E_CONTROL` — адрес, на который событие `e2e-mock` передаёт режим тестового сервера;
//! * `CUSTOMERS_E2E_TIMEOUT` — предел времени в секундах (по умолчанию 420).

use crate::paths::AppPaths;
use crate::search::http::{HttpRequest, HttpResponse, HttpTransport, SearchError};
use async_trait::async_trait;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{AppHandle, Listener, Webview};

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// Папки данных внутри папки проверки: настоящие данные пользователя не затрагиваются.
pub fn paths() -> Option<AppPaths> {
    var("CUSTOMERS_E2E_DIR").map(|d| AppPaths::under(&PathBuf::from(d)))
}

/// Облако проверки. Сборка e2e не получает ключей рабочего проекта: вход возможен только в облако, поэтому на его место
/// встаёт тестовый сервер (`e2e/mock-server.cjs`, узел `cloud`). Вне прогона проверок (нет подмены адресов) возвращает `None`.
pub fn cloud_config() -> Option<crate::cloud::config::CloudConfig> {
    var("CUSTOMERS_E2E_REWRITE")?;
    crate::cloud::config::CloudConfig::new("https://cloud.e2e.example", &format!("sb_publishable_{}", "e".repeat(30)))
}

/// Транспорт ядра с подменой адресов: запросы к внешним сервисам уходят на локальный тестовый сервер.
pub struct RewriteTransport {
    inner: Arc<dyn HttpTransport>,
    rules: Vec<(String, String)>,
}

impl RewriteTransport {
    pub fn new(inner: Arc<dyn HttpTransport>, spec: &str) -> Self {
        let rules = spec
            .split(';')
            .filter_map(|r| r.split_once('='))
            .map(|(from, to)| (from.trim().trim_end_matches('/').to_string(), to.trim().trim_end_matches('/').to_string()))
            .filter(|(from, to)| !from.is_empty() && !to.is_empty())
            .collect();
        Self { inner, rules }
    }

    pub fn rewrite(&self, url: &str) -> String {
        for (from, to) in &self.rules {
            if let Some(rest) = url.strip_prefix(from.as_str()) {
                if rest.is_empty() || rest.starts_with(['/', '?', '#']) {
                    return format!("{to}{rest}");
                }
            }
        }
        url.to_string()
    }
}

#[async_trait]
impl HttpTransport for RewriteTransport {
    async fn send(&self, mut request: HttpRequest) -> Result<HttpResponse, SearchError> {
        request.url = self.rewrite(&request.url);
        self.inner.send(request).await
    }
}

pub fn wrap_transport(inner: Arc<dyn HttpTransport>) -> Arc<dyn HttpTransport> {
    match var("CUSTOMERS_E2E_REWRITE") {
        Some(spec) => Arc::new(RewriteTransport::new(inner, &spec)),
        None => inner,
    }
}

fn out_path() -> Option<PathBuf> {
    var("CUSTOMERS_E2E_OUT").map(PathBuf::from)
}

fn log_line(text: &str) {
    let Some(out) = out_path() else { return };
    let log = out.with_extension("log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(log) {
        let _ = writeln!(f, "{text}");
    }
}

/// Событие приходит из страницы как строка JSON: `"{…}"` или уже без кавычек.
fn payload_text(raw: &str) -> String {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .map(|v| match v {
            serde_json::Value::String(s) => s,
            other => other.to_string(),
        })
        .unwrap_or_else(|| raw.to_string())
}

fn screenshot(path: &std::path::Path) {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("screencapture").arg("-x").arg(path).status();
    #[cfg(windows)]
    {
        let script = format!(
            "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; \
             $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); \
             $g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size); $bmp.Save('{}')",
            path.display()
        );
        let _ = std::process::Command::new("powershell").args(["-NoProfile", "-Command", &script]).status();
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = path;
}

/// Слушатели событий страницы и предел времени. Вызывается один раз при запуске.
pub fn install(app: &AppHandle) {
    let handle = app.clone();
    app.listen("e2e-report", move |event| {
        let text = payload_text(event.payload());
        if let Some(out) = out_path() {
            let _ = std::fs::write(&out, &text);
        }
        let failed = serde_json::from_str::<serde_json::Value>(&text).ok().and_then(|v| v["failed"].as_u64()).unwrap_or(1);
        log_line(&format!("отчёт получен, не пройдено: {failed}"));
        let app = handle.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(500));
            app.exit(if failed == 0 { 0 } else { 1 });
        });
    });
    // Сценарий переключает поведение тестового сервера (например, «вышла новая версия»): запрос уходит из ядра, не из страницы.
    app.listen("e2e-mock", |event| {
        let (Some(url), mode) = (var("CUSTOMERS_E2E_CONTROL"), payload_text(event.payload())) else { return };
        log_line(&format!("тестовый сервер: режим {mode}"));
        tauri::async_runtime::spawn(async move {
            if let Err(e) = reqwest::Client::new().post(url).body(mode).send().await {
                log_line(&format!("тестовый сервер не ответил: {e}"));
            }
        });
    });
    app.listen("e2e-log", |event| log_line(&payload_text(event.payload())));
    app.listen("e2e-shot", |event| {
        let name = payload_text(event.payload());
        let (Some(dir), true) = (var("CUSTOMERS_E2E_DIR"), name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')) else { return };
        let folder = PathBuf::from(dir).join("shots");
        let _ = std::fs::create_dir_all(&folder);
        std::thread::spawn(move || screenshot(&folder.join(format!("{name}.png"))));
    });
    let limit: u64 = var("CUSTOMERS_E2E_TIMEOUT").and_then(|v| v.parse().ok()).unwrap_or(420);
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(limit));
        log_line(&format!("предел времени {limit} с исчерпан, сценарий не завершился"));
        app.exit(3);
    });
}

static INJECTED: AtomicBool = AtomicBool::new(false);

/// После первой загрузки страницы вставляет настройки и сценарий.
pub fn on_page_load(webview: &Webview, payload: &PageLoadPayload<'_>) {
    if !matches!(payload.event(), PageLoadEvent::Finished) || INJECTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let (Some(script), config) = (var("CUSTOMERS_E2E_SCRIPT"), var("CUSTOMERS_E2E_CONFIG").unwrap_or_else(|| "{}".into())) else {
        log_line("CUSTOMERS_E2E_SCRIPT не задан");
        return;
    };
    match std::fs::read_to_string(&script) {
        Ok(code) => {
            log_line(&format!("страница загружена ({}), сценарий вставлен", payload.url()));
            let _ = webview.eval(format!("window.__E2E__ = {config};\n{code}"));
        }
        Err(e) => log_line(&format!("не удалось прочитать сценарий {script}: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Echo;
    #[async_trait]
    impl HttpTransport for Echo {
        async fn send(&self, request: HttpRequest) -> Result<HttpResponse, SearchError> {
            Ok(HttpResponse::new(200, request.url.into_bytes()))
        }
    }

    #[test]
    fn rewrites_only_matching_prefixes() {
        let t = RewriteTransport::new(Arc::new(Echo), "https://api.github.com=http://127.0.0.1:9/gh; https://dav.test = http://127.0.0.1:9/dav/");
        assert_eq!(t.rewrite("https://api.github.com/repos/x"), "http://127.0.0.1:9/gh/repos/x");
        assert_eq!(t.rewrite("https://dav.test"), "http://127.0.0.1:9/dav");
        assert_eq!(t.rewrite("https://api.github.com.evil.example/x"), "https://api.github.com.evil.example/x");
        assert_eq!(t.rewrite("https://other.example/"), "https://other.example/");
    }

    #[test]
    fn payload_is_unwrapped_from_json_string() {
        assert_eq!(payload_text("\"{\\\"failed\\\":0}\""), "{\"failed\":0}");
        assert_eq!(payload_text("{\"a\":1}"), "{\"a\":1}");
    }
}
