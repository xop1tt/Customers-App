//! Вход, регистрация, восстановление и смена пароля, смена адреса — через Supabase Auth.
//!
//! Каждое письмо сначала разрешает функция email-gate (лимиты устройства, IP, адреса и общий
//! суточный), и только потом приложение просит Auth отправить письмо. Обычный вход писем не
//! тратит. Токены обновляются автоматически; при отзыве сессии сервером — `SessionExpired`.

use crate::cloud::config::CloudConfig;
use crate::cloud::error::{CloudError, CloudResult};
use crate::cloud::validation;
use crate::search::http::{HttpRequest, HttpTransport};
use chrono::{DateTime, Duration, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct CloudUser {
    pub id: String,
    #[serde(default)]
    pub email: String,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "non_empty")]
    pub new_email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email_confirmed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    /// Пользовательские данные Auth: сюда при регистрации попадает имя пользователя.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_metadata: Option<Value>,
}

fn non_empty<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(Option::<String>::deserialize(d)?.filter(|s| !s.is_empty()))
}

impl CloudUser {
    /// Имя пользователя, указанное при регистрации.
    pub fn username(&self) -> Option<String> {
        let name = self.user_metadata.as_ref()?.get("display_name")?.as_str()?.trim();
        (!name.is_empty()).then(|| name.to_string())
    }
    pub fn is_confirmed(&self) -> bool {
        self.email_confirmed_at.as_deref().map(|s| !s.is_empty()).unwrap_or(false)
    }
}

/// Сессия: токены и пользователь. Хранится только в защищённом хранилище (через `SessionStore`).
#[derive(Debug, Clone, PartialEq)]
pub struct CloudSession {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: DateTime<Utc>,
    pub user: CloudUser,
}

impl CloudSession {
    pub fn expires_soon(&self, now: DateTime<Utc>, margin_secs: i64) -> bool {
        self.expires_at - now < Duration::seconds(margin_secs)
    }

    pub fn to_json(&self) -> String {
        json!({
            "accessToken": self.access_token,
            "refreshToken": self.refresh_token,
            "expiresAt": self.expires_at.timestamp(),
            "user": self.user,
        })
        .to_string()
    }

    /// Читает сессию, сохранённую этим приложением или версиями для macOS / Windows. Время истечения
    /// там — секунды от 2001 года (Swift), unix-секунды или строка ISO 8601.
    pub fn from_json(text: &str) -> Option<Self> {
        let v: Value = serde_json::from_str(text).ok()?;
        let access_token = v.get("accessToken")?.as_str()?.to_string();
        let refresh_token = v.get("refreshToken")?.as_str()?.to_string();
        let exp = v.get("expiresAt")?;
        let expires_at = if let Some(n) = exp.as_f64() {
            // Секунды от 2001-01-01 (≈ 8·10^8) отличаются от unix-времени (≈ 1.7·10^9).
            let unix = if n < 1.5e9 { n + 978_307_200.0 } else { n };
            Utc.timestamp_opt(unix as i64, 0).single()?
        } else {
            crate::util::parse_date(exp.as_str()?)?
        };
        let user: CloudUser = serde_json::from_value(v.get("user")?.clone()).ok()?;
        Some(CloudSession { access_token, refresh_token, expires_at, user })
    }
}

/// Где хранится сессия между запусками.
pub trait SessionStore: Send + Sync {
    fn load(&self) -> Option<CloudSession>;
    fn save(&self, session: Option<&CloudSession>);
}

#[derive(Default)]
pub struct MemorySessionStore(pub Mutex<Option<CloudSession>>);

impl SessionStore for MemorySessionStore {
    fn load(&self) -> Option<CloudSession> {
        self.0.lock().unwrap().clone()
    }
    fn save(&self, s: Option<&CloudSession>) {
        *self.0.lock().unwrap() = s.cloned();
    }
}

/// Чем закончилось открытие ссылки из письма.
#[derive(Debug, Clone, PartialEq)]
pub enum CallbackResult {
    SignedIn { kind: String },
    Message(String),
}

#[derive(Debug, Clone, Copy)]
pub enum MailAction {
    Signup,
    Recovery,
    EmailChange,
}

impl MailAction {
    fn raw(self) -> &'static str {
        match self {
            MailAction::Signup => "signup",
            MailAction::Recovery => "recovery",
            MailAction::EmailChange => "email_change",
        }
    }
}

pub struct CloudAuth {
    pub config: CloudConfig,
    transport: Arc<dyn HttpTransport>,
    store: Arc<dyn SessionStore>,
    device_id: String,
    session: Mutex<Option<CloudSession>>,
    refresh_lock: tokio::sync::Mutex<()>,
}

fn redirect_param(redirect: &str) -> String {
    percent_encoding::utf8_percent_encode(redirect, percent_encoding::NON_ALPHANUMERIC).to_string()
}

fn json_text(data: &[u8]) -> Value {
    serde_json::from_slice(data).unwrap_or(Value::Null)
}

impl CloudAuth {
    pub fn new(config: CloudConfig, transport: Arc<dyn HttpTransport>, store: Arc<dyn SessionStore>, device_id: String) -> Self {
        let session = Mutex::new(store.load());
        Self { config, transport, store, device_id, session, refresh_lock: tokio::sync::Mutex::new(()) }
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    pub fn session(&self) -> Option<CloudSession> {
        self.session.lock().unwrap().clone()
    }

    pub fn user(&self) -> Option<CloudUser> {
        self.session().map(|s| s.user)
    }

    fn set_session(&self, s: Option<CloudSession>) {
        self.store.save(s.as_ref());
        *self.session.lock().unwrap() = s;
    }

    // ------------------------------------------------------------ запросы

    pub async fn request(&self, method: &str, path: &str, body: Option<&Value>, token: Option<&str>, extra: &[(&str, &str)]) -> CloudResult<(u16, Vec<u8>)> {
        let mut headers = vec![
            ("apikey".to_string(), self.config.anon_key.clone()),
            ("Content-Type".to_string(), "application/json".to_string()),
            ("Accept".to_string(), "application/json".to_string()),
        ];
        if let Some(t) = token {
            headers.push(("Authorization".into(), format!("Bearer {t}")));
        }
        for (k, v) in extra {
            headers.push((k.to_string(), v.to_string()));
        }
        let req = HttpRequest {
            method: method.into(),
            url: format!("{}{}", self.config.url, path),
            headers,
            body: body.map(|b| b.to_string().into_bytes()),
            timeout: 20.0,
        };
        match self.transport.send(req).await {
            Ok(r) => Ok((r.status, r.data)),
            Err(e) => Err(CloudError::Network(e.message())),
        }
    }

    async fn auth(&self, method: &str, path: &str, body: Option<&Value>, token: Option<&str>) -> CloudResult<Vec<u8>> {
        let (status, data) = self.request(method, &format!("/auth/v1{path}"), body, token, &[]).await?;
        if (200..300).contains(&status) {
            Ok(data)
        } else {
            Err(CloudError::from_auth(status, &data))
        }
    }

    /// Разрешение на письмо от email-gate. Отказ — понятное сообщение с временем ожидания.
    async fn gate(&self, action: MailAction, email: &str) -> CloudResult<()> {
        let body = json!({"action": action.raw(), "email": email, "device_id": self.device_id});
        let (status, data) = self.request("POST", "/functions/v1/email-gate", Some(&body), None, &[]).await?;
        if (200..300).contains(&status) {
            return Ok(());
        }
        let obj = json_text(&data);
        if obj.get("reason").and_then(Value::as_str) == Some("invalid_email") {
            return Err(CloudError::InvalidEmail);
        }
        if let Some(m) = obj.get("message").and_then(Value::as_str) {
            return Err(CloudError::RateLimited(m.to_string()));
        }
        Err(CloudError::Server(format!("HTTP {status}")))
    }

    fn take(&self, data: &[u8]) -> CloudResult<CloudSession> {
        let v = json_text(data);
        let bad = || CloudError::Server("неожиданный ответ сервера".into());
        let access = v.get("access_token").and_then(Value::as_str).ok_or_else(bad)?;
        let refresh = v.get("refresh_token").and_then(Value::as_str).ok_or_else(bad)?;
        let user: CloudUser = serde_json::from_value(v.get("user").cloned().unwrap_or(Value::Null)).map_err(|_| bad())?;
        let exp = match v.get("expires_at").and_then(Value::as_f64) {
            Some(t) => Utc.timestamp_opt(t as i64, 0).single().unwrap_or_else(Utc::now),
            None => Utc::now() + Duration::seconds(v.get("expires_in").and_then(Value::as_f64).unwrap_or(3600.0) as i64),
        };
        let s = CloudSession { access_token: access.into(), refresh_token: refresh.into(), expires_at: exp, user };
        self.set_session(Some(s.clone()));
        Ok(s)
    }

    fn valid_email(raw: &str) -> CloudResult<String> {
        validation::normalized_email(raw).ok_or(CloudError::InvalidEmail)
    }

    // ------------------------------------------------------------ регистрация

    /// Регистрация. Если адрес уже занят, ответ такой же, как для нового: письмо просто не придёт.
    pub async fn sign_up(&self, raw_email: &str, password: &str) -> CloudResult<()> {
        self.sign_up_named(raw_email, password, None).await
    }

    /// Регистрация с именем пользователя: оно сохраняется в данных учётной записи и показывается в приложении.
    pub async fn sign_up_named(&self, raw_email: &str, password: &str, username: Option<&str>) -> CloudResult<()> {
        let email = Self::valid_email(raw_email)?;
        if let Some(p) = validation::password_problem(password) {
            return Err(CloudError::WeakPassword(Some(p)));
        }
        self.gate(MailAction::Signup, &email).await?;
        let mut body = json!({"email": email, "password": password, "options": {"email_redirect_to": self.config.redirect}});
        if let Some(name) = username.map(str::trim).filter(|n| !n.is_empty()) {
            body["data"] = json!({"display_name": name});
        }
        let data = self.auth("POST", &format!("/signup?redirect_to={}", redirect_param(self.config.redirect)), Some(&body), None).await?;
        // Если на сервере выключено подтверждение почты, Auth сразу возвращает сессию.
        if json_text(&data).get("access_token").is_some() {
            self.take(&data)?;
        }
        Ok(())
    }

    pub async fn resend_confirmation(&self, raw_email: &str) -> CloudResult<()> {
        let email = Self::valid_email(raw_email)?;
        self.gate(MailAction::Signup, &email).await?;
        let body = json!({"type": "signup", "email": email, "options": {"email_redirect_to": self.config.redirect}});
        self.auth("POST", "/resend", Some(&body), None).await?;
        Ok(())
    }

    /// Подтверждение кодом из письма (регистрация, восстановление, смена адреса).
    pub async fn verify(&self, raw_email: &str, raw_code: &str, kind: &str) -> CloudResult<Option<CloudSession>> {
        let email = Self::valid_email(raw_email)?;
        let code = validation::code(raw_code).ok_or(CloudError::InvalidCode)?;
        let data = self.auth("POST", "/verify", Some(&json!({"type": kind, "email": email, "token": code})), None).await?;
        if json_text(&data).get("access_token").is_some() {
            return self.take(&data).map(Some);
        }
        Ok(None)
    }

    // ------------------------------------------------------------ вход и выход

    pub async fn sign_in(&self, raw_email: &str, password: &str) -> CloudResult<CloudSession> {
        let email = Self::valid_email(raw_email)?;
        if password.is_empty() {
            return Err(CloudError::InvalidCredentials);
        }
        let data = self.auth("POST", "/token?grant_type=password", Some(&json!({"email": email, "password": password})), None).await?;
        self.take(&data)
    }

    /// Выход: сессия отзывается на сервере (если есть сеть) и всегда удаляется с этого компьютера.
    pub async fn sign_out(&self) {
        if let Some(s) = self.session() {
            let _ = self.auth("POST", "/logout?scope=local", None, Some(&s.access_token)).await;
        }
        self.set_session(None);
    }

    /// Только забыть сессию на этом компьютере (без запроса на сервер).
    pub fn forget_session(&self) {
        self.set_session(None);
    }

    /// Действующая сессия: при скором истечении токен обновляется.
    pub async fn valid_session(&self) -> CloudResult<CloudSession> {
        let s = self.session().ok_or(CloudError::SessionExpired)?;
        if !s.expires_soon(Utc::now(), 60) {
            return Ok(s);
        }
        self.refresh().await
    }

    /// Параллельные вызовы ждут одно обновление (refresh-токен одноразовый).
    pub async fn refresh(&self) -> CloudResult<CloudSession> {
        let before = self.session().ok_or(CloudError::SessionExpired)?;
        let _guard = self.refresh_lock.lock().await;
        if let Some(now) = self.session() {
            if now.refresh_token != before.refresh_token && !now.expires_soon(Utc::now(), 60) {
                return Ok(now); // пока мы ждали, другой вызов уже обновил токен
            }
        }
        let s = self.session().ok_or(CloudError::SessionExpired)?;
        let result = match self.auth("POST", "/token?grant_type=refresh_token", Some(&json!({"refresh_token": s.refresh_token})), None).await {
            Ok(data) => self.take(&data),
            Err(e) => Err(e),
        };
        match result {
            Err(e @ (CloudError::SessionExpired | CloudError::InvalidCredentials)) => {
                self.set_session(None);
                let _ = e;
                Err(CloudError::SessionExpired)
            }
            Err(CloudError::Server(m)) if m.to_lowercase().contains("refresh token") => {
                self.set_session(None);
                Err(CloudError::SessionExpired)
            }
            other => other,
        }
    }

    /// Запрос с токеном пользователя; при 401 один раз обновляет токен и повторяет.
    pub async fn authorized(&self, method: &str, path: &str, body: Option<&Value>, headers: &[(&str, &str)]) -> CloudResult<(u16, Vec<u8>)> {
        let mut s = self.valid_session().await?;
        let mut res = self.request(method, path, body, Some(&s.access_token), headers).await?;
        if res.0 == 401 {
            s = self.refresh().await?;
            res = self.request(method, path, body, Some(&s.access_token), headers).await?;
            if res.0 == 401 {
                self.set_session(None);
                return Err(CloudError::SessionExpired);
            }
        }
        Ok(res)
    }

    /// Свежие данные пользователя с сервера (подтверждение почты, новый адрес).
    pub async fn reload_user(&self) -> CloudResult<CloudUser> {
        let (status, data) = self.authorized("GET", "/auth/v1/user", None, &[]).await?;
        if !(200..300).contains(&status) {
            let e = CloudError::from_auth(status, &data);
            if e == CloudError::SessionExpired {
                self.set_session(None);
            }
            return Err(e);
        }
        let u: CloudUser = serde_json::from_slice(&data).map_err(|_| CloudError::Server("неожиданный ответ сервера".into()))?;
        if let Some(mut s) = self.session() {
            s.user = u.clone();
            self.set_session(Some(s));
        }
        Ok(u)
    }

    // ------------------------------------------------------------ пароль

    pub async fn request_password_reset(&self, raw_email: &str) -> CloudResult<()> {
        let email = Self::valid_email(raw_email)?;
        self.gate(MailAction::Recovery, &email).await?;
        self.auth("POST", &format!("/recover?redirect_to={}", redirect_param(self.config.redirect)), Some(&json!({"email": email})), None).await?;
        Ok(())
    }

    /// Новый пароль после входа по коду восстановления. Остальные сессии завершаются.
    pub async fn set_new_password(&self, password: &str) -> CloudResult<()> {
        if let Some(p) = validation::password_problem(password) {
            return Err(CloudError::WeakPassword(Some(p)));
        }
        let (status, data) = self.authorized("PUT", "/auth/v1/user", Some(&json!({"password": password})), &[]).await?;
        if !(200..300).contains(&status) {
            return Err(CloudError::from_auth(status, &data));
        }
        let _ = self.sign_out_others().await;
        let _ = self.refresh().await;
        Ok(())
    }

    /// Смена пароля из настроек: сначала текущий пароль проверяется входом на сервере.
    pub async fn change_password(&self, current: &str, new: &str) -> CloudResult<()> {
        let email = self.session().ok_or(CloudError::SessionExpired)?.user.email;
        if let Some(p) = validation::password_problem(new) {
            return Err(CloudError::WeakPassword(Some(p)));
        }
        match self.sign_in(&email, current).await {
            Err(CloudError::InvalidCredentials) => return Err(CloudError::Server("текущий пароль неверный".into())),
            Err(e) => return Err(e),
            Ok(_) => {}
        }
        self.set_new_password(new).await
    }

    async fn sign_out_others(&self) -> CloudResult<()> {
        let (status, data) = self.authorized("POST", "/auth/v1/logout?scope=others", None, &[]).await?;
        if (200..300).contains(&status) {
            Ok(())
        } else {
            Err(CloudError::from_auth(status, &data))
        }
    }

    // ------------------------------------------------------------ адрес почты

    /// Смена адреса: нужен текущий пароль. Письма уходят на оба адреса; адрес меняется только после
    /// подтверждения обоих (Secure email change в Supabase).
    pub async fn change_email(&self, raw_new: &str, password: &str) -> CloudResult<()> {
        let current = self.session().ok_or(CloudError::SessionExpired)?.user.email;
        let new = Self::valid_email(raw_new)?;
        if new == current.to_lowercase() {
            return Err(CloudError::Server("это текущий адрес".into()));
        }
        match self.sign_in(&current, password).await {
            Err(CloudError::InvalidCredentials) => return Err(CloudError::Server("пароль неверный".into())),
            Err(e) => return Err(e),
            Ok(_) => {}
        }
        self.gate(MailAction::EmailChange, &current).await?;
        let (status, data) =
            self.authorized("PUT", &format!("/auth/v1/user?redirect_to={}", redirect_param(self.config.redirect)), Some(&json!({"email": new})), &[]).await?;
        if !(200..300).contains(&status) {
            return Err(CloudError::from_auth(status, &data));
        }
        let _ = self.reload_user().await;
        Ok(())
    }

    /// Повторить письма смены адреса (с соблюдением лимитов).
    pub async fn resend_email_change(&self) -> CloudResult<()> {
        let u = self.user().ok_or(CloudError::SessionExpired)?;
        let new = u.new_email.ok_or(CloudError::SessionExpired)?;
        self.gate(MailAction::EmailChange, &u.email).await?;
        self.auth("POST", "/resend", Some(&json!({"type": "email_change", "email": new})), None).await?;
        Ok(())
    }

    pub async fn confirm_email_change(&self, email: &str, code: &str) -> CloudResult<()> {
        self.verify(email, code, "email_change").await?;
        let _ = self.reload_user().await;
        Ok(())
    }

    // ------------------------------------------------------------ удаление учётной записи

    /// Удаляет учётную запись и все данные в облаке. Пароль проверяется заново.
    pub async fn delete_account(&self, password: &str) -> CloudResult<()> {
        let email = self.session().ok_or(CloudError::SessionExpired)?.user.email;
        match self.sign_in(&email, password).await {
            Err(CloudError::InvalidCredentials) => return Err(CloudError::Server("пароль неверный".into())),
            Err(e) => return Err(e),
            Ok(_) => {}
        }
        let (status, data) = self.authorized("POST", "/functions/v1/delete-account", None, &[]).await?;
        if !(200..300).contains(&status) {
            let m = json_text(&data).get("message").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("HTTP {status}"));
            return Err(CloudError::Server(m));
        }
        self.set_session(None);
        Ok(())
    }

    // ------------------------------------------------------------ ссылки из писем

    /// Обработка leadgenerator://auth/callback#access_token=…&refresh_token=…&type=…
    pub async fn handle_callback(&self, url: &str) -> CloudResult<CallbackResult> {
        let params = Self::fragment_params(url);
        if let Some(err) = params.get("error_description").or_else(|| params.get("error")) {
            if params.get("error_code").map(String::as_str) == Some("otp_expired") {
                return Err(CloudError::InvalidCode);
            }
            return Err(CloudError::Server(err.clone()));
        }
        if let (Some(access), Some(refresh)) = (params.get("access_token"), params.get("refresh_token")) {
            let exp = params
                .get("expires_at")
                .and_then(|v| v.parse::<f64>().ok())
                .and_then(|t| Utc.timestamp_opt(t as i64, 0).single())
                .unwrap_or_else(|| Utc::now() + Duration::seconds(params.get("expires_in").and_then(|v| v.parse::<i64>().ok()).unwrap_or(3600)));
            self.set_session(Some(CloudSession { access_token: access.clone(), refresh_token: refresh.clone(), expires_at: exp, user: CloudUser::default() }));
            if let Err(e) = self.reload_user().await {
                self.set_session(None);
                return Err(e);
            }
            return Ok(CallbackResult::SignedIn { kind: params.get("type").cloned().unwrap_or_default() });
        }
        if let Some(m) = params.get("message") {
            return Ok(CallbackResult::Message(m.clone()));
        }
        Err(CloudError::Server("ссылка не распознана".into()))
    }

    pub fn fragment_params(url: &str) -> HashMap<String, String> {
        let mut out = HashMap::new();
        let Ok(u) = url::Url::parse(url) else { return out };
        for source in [u.fragment().map(str::to_string), u.query().map(str::to_string)] {
            for pair in source.unwrap_or_default().split('&').filter(|p| !p.is_empty()) {
                let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
                let dec = |s: &str| percent_encoding::percent_decode_str(&s.replace('+', " ")).decode_utf8_lossy().into_owned();
                out.entry(dec(k)).or_insert_with(|| dec(v));
            }
        }
        out
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::search::http::{HttpResponse, SearchError};
    use async_trait::async_trait;
    use std::collections::VecDeque;

    /// Заглушка сервера: ответы по очереди, все запросы запоминаются.
    pub struct Server {
        pub replies: Mutex<VecDeque<(u16, String)>>,
        pub seen: Mutex<Vec<HttpRequest>>,
    }

    impl Server {
        pub fn new(replies: Vec<(u16, &str)>) -> Arc<Self> {
            Arc::new(Self { replies: Mutex::new(replies.into_iter().map(|(s, b)| (s, b.to_string())).collect()), seen: Mutex::new(vec![]) })
        }
        pub fn paths(&self) -> Vec<String> {
            self.seen.lock().unwrap().iter().map(|r| format!("{} {}", r.method, r.url.replace("https://x.supabase.co", ""))).collect()
        }
        pub fn body(&self, i: usize) -> Value {
            serde_json::from_slice(self.seen.lock().unwrap()[i].body.as_ref().unwrap()).unwrap()
        }
    }

    #[async_trait]
    impl HttpTransport for Server {
        async fn send(&self, request: HttpRequest) -> Result<HttpResponse, SearchError> {
            self.seen.lock().unwrap().push(request);
            match self.replies.lock().unwrap().pop_front() {
                Some((s, b)) => Ok(HttpResponse::new(s, b)),
                None => Err(SearchError::http("нет сети", None, true)),
            }
        }
    }

    pub fn config() -> CloudConfig {
        CloudConfig::new("https://x.supabase.co", "sb_publishable_test").unwrap()
    }

    pub fn token_json(access: &str, refresh: &str, expires_in: i64) -> String {
        json!({"access_token": access, "refresh_token": refresh, "expires_in": expires_in,
               "user": {"id": "u1", "email": "me@example.com", "email_confirmed_at": "2026-01-01T00:00:00Z"}})
        .to_string()
    }

    fn auth_with(server: Arc<Server>) -> (CloudAuth, Arc<MemorySessionStore>) {
        let store = Arc::new(MemorySessionStore::default());
        (CloudAuth::new(config(), server, store.clone(), "dev-1".into()), store)
    }

    #[tokio::test]
    async fn sign_in_stores_session_and_sends_public_key() {
        let server = Server::new(vec![(200, &token_json("a1", "r1", 3600))]);
        let (auth, store) = auth_with(server.clone());
        let s = auth.sign_in(" ME@example.com ", "Passw0rd").await.unwrap();
        assert_eq!(s.user.email, "me@example.com");
        assert_eq!(store.load().unwrap().access_token, "a1");
        assert_eq!(server.paths(), ["POST /auth/v1/token?grant_type=password"]);
        assert_eq!(server.body(0), json!({"email": "me@example.com", "password": "Passw0rd"}));
        assert!(server.seen.lock().unwrap()[0].headers.iter().any(|h| h.0 == "apikey" && h.1 == "sb_publishable_test"));
    }

    #[tokio::test]
    async fn wrong_password_and_validation_do_not_hit_server_when_invalid() {
        let server = Server::new(vec![(400, r#"{"error_code":"invalid_credentials"}"#)]);
        let (auth, _) = auth_with(server.clone());
        assert_eq!(auth.sign_in("me@example.com", "x").await.unwrap_err(), CloudError::InvalidCredentials);
        assert_eq!(auth.sign_in("bad", "x").await.unwrap_err(), CloudError::InvalidEmail);
        assert_eq!(auth.sign_in("me@example.com", "").await.unwrap_err(), CloudError::InvalidCredentials);
        assert_eq!(server.seen.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn sign_up_asks_gate_first_and_stops_when_denied() {
        let server = Server::new(vec![(429, r#"{"message":"Подождите 60 с"}"#)]);
        let (auth, _) = auth_with(server.clone());
        assert_eq!(auth.sign_up("me@example.com", "Passw0rd").await.unwrap_err(), CloudError::RateLimited("Подождите 60 с".into()));
        assert_eq!(server.paths(), ["POST /functions/v1/email-gate"]);
        assert_eq!(server.body(0), json!({"action": "signup", "email": "me@example.com", "device_id": "dev-1"}));
        let server = Server::new(vec![(200, "{}"), (200, "{}")]);
        let (auth, _) = auth_with(server.clone());
        auth.sign_up("me@example.com", "Passw0rd").await.unwrap();
        assert!(server.paths()[1].starts_with("POST /auth/v1/signup?redirect_to=leadgenerator"));
        assert!(auth.session().is_none());
        assert_eq!(auth.sign_up("me@example.com", "weak").await.unwrap_err().to_string(), "В пароле нужно: не короче 8 символов, заглавная буква, цифра.");
    }

    #[tokio::test]
    async fn expiring_token_is_refreshed_before_request() {
        let server = Server::new(vec![(200, &token_json("a2", "r2", 3600)), (200, r#"{"ok":true}"#)]);
        let store = Arc::new(MemorySessionStore::default());
        store.save(Some(&CloudSession {
            access_token: "a1".into(),
            refresh_token: "r1".into(),
            expires_at: Utc::now() + Duration::seconds(10),
            user: CloudUser { id: "u1".into(), email: "me@example.com".into(), ..Default::default() },
        }));
        let auth = CloudAuth::new(config(), server.clone(), store.clone(), "d".into());
        let (status, _) = auth.authorized("GET", "/rest/v1/x", None, &[]).await.unwrap();
        assert_eq!(status, 200);
        assert_eq!(server.paths(), ["POST /auth/v1/token?grant_type=refresh_token", "GET /rest/v1/x"]);
        assert_eq!(server.body(0), json!({"refresh_token": "r1"}));
        assert_eq!(server.seen.lock().unwrap()[1].headers.iter().find(|h| h.0 == "Authorization").unwrap().1, "Bearer a2");
        assert_eq!(store.load().unwrap().refresh_token, "r2");
    }

    #[tokio::test]
    async fn revoked_refresh_token_clears_session() {
        let server = Server::new(vec![(400, r#"{"error_code":"refresh_token_not_found"}"#)]);
        let store = Arc::new(MemorySessionStore::default());
        store.save(Some(&CloudSession {
            access_token: "a".into(),
            refresh_token: "r".into(),
            expires_at: Utc::now() - Duration::seconds(5),
            user: CloudUser::default(),
        }));
        let auth = CloudAuth::new(config(), server, store.clone(), "d".into());
        assert_eq!(auth.valid_session().await.unwrap_err(), CloudError::SessionExpired);
        assert!(store.load().is_none());
        assert_eq!(auth.valid_session().await.unwrap_err(), CloudError::SessionExpired);
    }

    #[tokio::test]
    async fn unauthorized_response_refreshes_once_then_retries() {
        let server = Server::new(vec![(401, "{}"), (200, &token_json("a2", "r2", 3600)), (200, "[]")]);
        let (auth, _) = auth_with(Server::new(vec![(200, &token_json("a1", "r1", 3600))]));
        let _ = auth;
        let store = Arc::new(MemorySessionStore::default());
        store.save(Some(&CloudSession {
            access_token: "a1".into(),
            refresh_token: "r1".into(),
            expires_at: Utc::now() + Duration::hours(1),
            user: CloudUser::default(),
        }));
        let auth = CloudAuth::new(config(), server.clone(), store, "d".into());
        let (status, body) = auth.authorized("GET", "/rest/v1/leads", None, &[]).await.unwrap();
        assert_eq!((status, body.as_slice()), (200, b"[]".as_slice()));
        assert_eq!(server.paths().len(), 3);
        // повторный 401 после обновления завершает сессию
        let server = Server::new(vec![(401, "{}"), (200, &token_json("a3", "r3", 3600)), (401, "{}")]);
        let store = Arc::new(MemorySessionStore::default());
        store.save(Some(&CloudSession {
            access_token: "a1".into(),
            refresh_token: "r1".into(),
            expires_at: Utc::now() + Duration::hours(1),
            user: CloudUser::default(),
        }));
        let auth = CloudAuth::new(config(), server, store.clone(), "d".into());
        assert_eq!(auth.authorized("GET", "/x", None, &[]).await.unwrap_err(), CloudError::SessionExpired);
        assert!(store.load().is_none());
    }

    #[tokio::test]
    async fn network_failure_is_reported_as_network_error() {
        let (auth, _) = auth_with(Server::new(vec![]));
        assert!(matches!(auth.sign_in("me@example.com", "Passw0rd").await.unwrap_err(), CloudError::Network(_)));
    }

    #[tokio::test]
    async fn sign_out_always_forgets_session() {
        let server = Server::new(vec![(200, &token_json("a1", "r1", 3600))]);
        let (auth, store) = auth_with(server.clone());
        auth.sign_in("me@example.com", "Passw0rd").await.unwrap();
        auth.sign_out().await; // сети нет — сессия всё равно удаляется
        assert!(auth.session().is_none() && store.load().is_none());
    }

    #[tokio::test]
    async fn change_password_checks_current_password_first() {
        let server = Server::new(vec![(200, &token_json("a1", "r1", 3600)), (400, r#"{"error_code":"invalid_credentials"}"#)]);
        let (auth, _) = auth_with(server.clone());
        auth.sign_in("me@example.com", "Passw0rd").await.unwrap();
        let e = auth.change_password("wrong", "NewPassw0rd").await.unwrap_err();
        assert_eq!(e, CloudError::Server("текущий пароль неверный".into()));
        assert_eq!(server.seen.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn email_callback_signs_in_and_loads_user() {
        let server = Server::new(vec![(200, r#"{"id":"u1","email":"me@example.com","email_confirmed_at":"2026-01-01T00:00:00Z"}"#)]);
        let (auth, store) = auth_with(server.clone());
        let r = auth.handle_callback("leadgenerator://auth/callback#access_token=AT&refresh_token=RT&expires_in=3600&type=signup").await.unwrap();
        assert_eq!(r, CallbackResult::SignedIn { kind: "signup".into() });
        assert_eq!(store.load().unwrap().user.email, "me@example.com");
        assert!(store.load().unwrap().user.is_confirmed());
        assert_eq!(
            auth.handle_callback("leadgenerator://auth/callback#error=access_denied&error_code=otp_expired&error_description=x").await.unwrap_err(),
            CloudError::InvalidCode
        );
        assert_eq!(
            auth.handle_callback("leadgenerator://auth/callback#message=Confirm+link+in+second+email").await.unwrap(),
            CallbackResult::Message("Confirm link in second email".into())
        );
        assert!(auth.handle_callback("leadgenerator://auth/callback").await.is_err());
    }

    #[tokio::test]
    async fn invalid_callback_user_load_drops_session() {
        let (auth, store) = auth_with(Server::new(vec![(401, "{}"), (401, "{}")]));
        assert!(auth.handle_callback("leadgenerator://auth/callback#access_token=AT&refresh_token=RT").await.is_err());
        assert!(store.load().is_none());
    }

    #[tokio::test]
    async fn delete_account_requires_password_and_clears_session() {
        let server = Server::new(vec![(200, &token_json("a1", "r1", 3600)), (200, &token_json("a2", "r2", 3600)), (200, "{}")]);
        let (auth, store) = auth_with(server.clone());
        auth.sign_in("me@example.com", "Passw0rd").await.unwrap();
        auth.delete_account("Passw0rd").await.unwrap();
        assert!(store.load().is_none());
        assert_eq!(server.paths()[2], "POST /functions/v1/delete-account");
    }

    #[test]
    fn session_json_reads_every_platform_format() {
        let user = json!({"id":"u","email":"a@b.cd"});
        // Swift: секунды от 2001-01-01
        let swift = json!({"accessToken":"a","refreshToken":"r","expiresAt": 800_000_000.5, "user": user}).to_string();
        assert_eq!(CloudSession::from_json(&swift).unwrap().expires_at.timestamp(), 1_778_307_200);
        let unix = json!({"accessToken":"a","refreshToken":"r","expiresAt": 1_900_000_000, "user": user}).to_string();
        assert_eq!(CloudSession::from_json(&unix).unwrap().expires_at.timestamp(), 1_900_000_000);
        let iso = json!({"accessToken":"a","refreshToken":"r","expiresAt":"2030-01-01T00:00:00Z","user":user}).to_string();
        assert_eq!(CloudSession::from_json(&iso).unwrap().expires_at.timestamp(), 1_893_456_000);
        assert!(CloudSession::from_json("{}").is_none());
        let s = CloudSession::from_json(&unix).unwrap();
        assert_eq!(CloudSession::from_json(&s.to_json()).unwrap(), s);
    }
}
