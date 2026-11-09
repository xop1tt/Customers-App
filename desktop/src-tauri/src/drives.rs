//! Подключаемые сервисы: облачные диски, к которым приложение само входит по кнопке «Подключиться»
//! (OAuth в браузере или WebDAV с паролем приложения), и куда выгружает резервные копии базы.
//! Каталог, адреса, разбор ответов и запросы выгрузки не зависят от сети и проверяются тестами.

use crate::search::http::{HttpRequest, HttpResponse, HttpTransport};
use crate::util::{format_date, parse_date};
use base64::Engine;
use chrono::{DateTime, Duration, Utc};
use rand::RngExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const URL_SAFE: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;
const STANDARD: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DriveService {
    GoogleDrive,
    Dropbox,
    OneDrive,
    YandexDisk,
    Mega,
    PCloud,
    Webdav,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DriveAuth {
    OAuth(OAuthProvider),
    Webdav { default_url: &'static str, password_page: Option<&'static str> },
}

impl DriveService {
    pub const ALL: [DriveService; 7] = [
        DriveService::GoogleDrive,
        DriveService::Dropbox,
        DriveService::OneDrive,
        DriveService::YandexDisk,
        DriveService::Mega,
        DriveService::PCloud,
        DriveService::Webdav,
    ];

    pub fn raw(self) -> &'static str {
        match self {
            DriveService::GoogleDrive => "googleDrive",
            DriveService::Dropbox => "dropbox",
            DriveService::OneDrive => "oneDrive",
            DriveService::YandexDisk => "yandexDisk",
            DriveService::Mega => "mega",
            DriveService::PCloud => "pCloud",
            DriveService::Webdav => "webdav",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|d| d.raw() == s)
    }
    pub fn title(self) -> &'static str {
        match self {
            DriveService::GoogleDrive => "Google Диск",
            DriveService::Dropbox => "Dropbox",
            DriveService::OneDrive => "OneDrive",
            DriveService::YandexDisk => "Яндекс Диск",
            DriveService::Mega => "MEGA",
            DriveService::PCloud => "pCloud",
            DriveService::Webdav => "WebDAV / Nextcloud",
        }
    }
    pub fn subtitle(self) -> &'static str {
        match self {
            DriveService::GoogleDrive => "Вход через Google, доступ только к файлам приложения",
            DriveService::Dropbox => "Вход через Dropbox, отдельная папка приложения",
            DriveService::OneDrive => "Вход через Microsoft, папка приложения",
            DriveService::YandexDisk => "Логин и пароль приложения Яндекса (WebDAV)",
            DriveService::Mega => "Через MEGAcmd: команда mega-webdav открывает папку по WebDAV",
            DriveService::PCloud => "Логин и пароль pCloud (WebDAV)",
            DriveService::Webdav => "Nextcloud, ownCloud, Synology, Keenetic и другие",
        }
    }
    pub fn auth(self) -> DriveAuth {
        match self {
            DriveService::GoogleDrive => DriveAuth::OAuth(OAuthProvider::Google),
            DriveService::Dropbox => DriveAuth::OAuth(OAuthProvider::Dropbox),
            DriveService::OneDrive => DriveAuth::OAuth(OAuthProvider::Microsoft),
            DriveService::YandexDisk => {
                DriveAuth::Webdav { default_url: "https://webdav.yandex.ru", password_page: Some("https://id.yandex.ru/security/app-passwords") }
            }
            DriveService::Mega => DriveAuth::Webdav { default_url: "http://127.0.0.1:4443/", password_page: Some("https://mega.io/cmd") },
            DriveService::PCloud => DriveAuth::Webdav { default_url: "https://ewebdav.pcloud.com", password_page: None },
            DriveService::Webdav => DriveAuth::Webdav { default_url: "", password_page: None },
        }
    }
    /// MEGAcmd раздаёт WebDAV только на этом компьютере и без пароля.
    pub fn password_optional(self) -> bool {
        self == DriveService::Mega
    }
    /// Имя секрета с подключением: своё для каждого пользователя приложения и сервиса.
    pub fn secret_name(self, user: &str) -> String {
        format!("integration.{}.{}", self.raw().to_lowercase(), user.to_lowercase())
    }
}

/// Поставщик OAuth 2.0 с PKCE. Идентификатор клиента — публичный, но он свой у каждого
/// зарегистрированного приложения: его создаёт владелец репозитория и передаёт при сборке. В коде ключей нет.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum OAuthProvider {
    Google,
    Dropbox,
    Microsoft,
}

impl OAuthProvider {
    pub const ALL: [OAuthProvider; 3] = [OAuthProvider::Google, OAuthProvider::Dropbox, OAuthProvider::Microsoft];

    pub fn raw(self) -> &'static str {
        match self {
            OAuthProvider::Google => "google",
            OAuthProvider::Dropbox => "dropbox",
            OAuthProvider::Microsoft => "microsoft",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|p| p.raw() == s)
    }
    pub fn authorize_url(self) -> &'static str {
        match self {
            OAuthProvider::Google => "https://accounts.google.com/o/oauth2/v2/auth",
            OAuthProvider::Dropbox => "https://www.dropbox.com/oauth2/authorize",
            OAuthProvider::Microsoft => "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        }
    }
    pub fn token_url(self) -> &'static str {
        match self {
            OAuthProvider::Google => "https://oauth2.googleapis.com/token",
            OAuthProvider::Dropbox => "https://api.dropboxapi.com/oauth2/token",
            OAuthProvider::Microsoft => "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        }
    }
    pub fn scope(self) -> Option<&'static str> {
        match self {
            OAuthProvider::Google => Some("https://www.googleapis.com/auth/drive.file"),
            OAuthProvider::Dropbox => None, // права задаются в консоли Dropbox (App folder, files.content.write)
            OAuthProvider::Microsoft => Some("Files.ReadWrite.AppFolder offline_access"),
        }
    }
    /// Имя переменной репозитория для сборки.
    pub fn build_variable(self) -> &'static str {
        match self {
            OAuthProvider::Google => "GOOGLE_OAUTH_CLIENT_ID",
            OAuthProvider::Dropbox => "DROPBOX_APP_KEY",
            OAuthProvider::Microsoft => "MICROSOFT_CLIENT_ID",
        }
    }
    pub fn console_page(self) -> &'static str {
        match self {
            OAuthProvider::Google => "https://console.cloud.google.com/apis/credentials",
            OAuthProvider::Dropbox => "https://www.dropbox.com/developers/apps",
            OAuthProvider::Microsoft => "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
        }
    }
    pub fn client_id_label(self) -> &'static str {
        match self {
            OAuthProvider::Google => "Client ID",
            OAuthProvider::Dropbox => "App key",
            OAuthProvider::Microsoft => "Application (client) ID",
        }
    }
    /// Google для приложений «Desktop» требует client_secret даже при PKCE; он не считается секретом.
    pub fn needs_client_secret(self) -> bool {
        self == OAuthProvider::Google
    }
    /// Имя секрета с ключом, введённым пользователем. Общий для всех учётных записей на этом компьютере.
    pub fn secret_name(self) -> String {
        format!("integration.oauthkey.{}", self.raw())
    }
    fn extra_authorize_params(self) -> &'static [(&'static str, &'static str)] {
        match self {
            OAuthProvider::Google => &[("access_type", "offline"), ("prompt", "consent")],
            OAuthProvider::Dropbox => &[("token_access_type", "offline")],
            OAuthProvider::Microsoft => &[("prompt", "select_account")],
        }
    }

    /// Ключ, вшитый в сборку (переменные окружения при компиляции).
    fn embedded(self) -> (Option<&'static str>, Option<&'static str>) {
        match self {
            OAuthProvider::Google => (option_env!("GOOGLE_OAUTH_CLIENT_ID"), option_env!("GOOGLE_OAUTH_CLIENT_SECRET")),
            OAuthProvider::Dropbox => (option_env!("DROPBOX_APP_KEY"), None),
            OAuthProvider::Microsoft => (option_env!("MICROSOFT_CLIENT_ID"), None),
        }
    }
}

/// Ключ OAuth-приложения, который пользователь ввёл в приложении («Добавить ключ»).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthKey {
    pub client_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
}

impl OAuthKey {
    /// Подходит ли ключ поставщику: идентификатор без пробелов, для Google ещё и секрет.
    pub fn problem(&self, provider: OAuthProvider) -> Option<String> {
        let id = self.client_id.trim();
        if id.is_empty() {
            return Some(format!("Введите {}", provider.client_id_label()));
        }
        if id.chars().any(char::is_whitespace) || id.starts_with('$') {
            return Some(format!("{} не должен содержать пробелов", provider.client_id_label()));
        }
        if provider.needs_client_secret() && self.client_secret.as_deref().unwrap_or("").trim().is_empty() {
            return Some("Для Google нужен ещё Client secret".into());
        }
        None
    }
    pub fn encoded(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
    pub fn decode(text: Option<&str>) -> Option<Self> {
        text.and_then(|t| serde_json::from_str(t).ok())
    }
}

/// Порт и адрес возврата из браузера. Порт постоянный: Dropbox сверяет адрес возврата целиком.
pub mod redirect {
    pub const PORT: u16 = 47811;
    pub const PATH: &str = "/oauth/callback";
    pub fn uri() -> String {
        format!("http://localhost:{PORT}{PATH}")
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct OAuthClient {
    pub provider: OAuthProvider,
    pub client_id: String,
    pub client_secret: Option<String>,
}

impl OAuthClient {
    pub fn new(provider: OAuthProvider, client_id: Option<&str>, client_secret: Option<&str>) -> Option<Self> {
        let id = client_id.unwrap_or("").trim();
        // Пустое значение или не подставленная переменная сборки: подключение недоступно.
        if id.is_empty() || id.starts_with('$') || id.contains(' ') {
            return None;
        }
        let secret = client_secret.map(str::trim).filter(|s| !s.is_empty() && !s.starts_with('$')).map(str::to_string);
        if provider.needs_client_secret() && secret.is_none() {
            return None;
        }
        Some(Self { provider, client_id: id.into(), client_secret: secret })
    }

    pub fn from_key(provider: OAuthProvider, key: &OAuthKey) -> Option<Self> {
        if key.problem(provider).is_some() {
            return None;
        }
        Self::new(provider, Some(&key.client_id), key.client_secret.as_deref())
    }

    pub fn from_build(provider: OAuthProvider) -> Option<Self> {
        let (id, secret) = provider.embedded();
        Self::new(provider, id, secret)
    }

    /// Ключ, вшитый при сборке, главнее введённого вручную: владелец сборки отвечает за свой ключ.
    pub fn resolve(provider: OAuthProvider, stored: Option<&OAuthKey>) -> Option<Self> {
        Self::from_build(provider).or_else(|| stored.and_then(|k| Self::from_key(provider, k)))
    }
}

/// Токены OAuth. Хранятся только в защищённом хранилище.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthToken {
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "iso_opt")]
    pub expires_at: Option<DateTime<Utc>>,
}

impl OAuthToken {
    /// Истёк или истечёт в ближайшую минуту.
    pub fn is_expired(&self, now: DateTime<Utc>) -> bool {
        self.expires_at.map(|e| e - now < Duration::seconds(60)).unwrap_or(false)
    }
}

mod iso_opt {
    use super::*;
    use serde::{Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &Option<DateTime<Utc>>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(d) => s.serialize_str(&format_date(d)),
            None => s.serialize_none(),
        }
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<DateTime<Utc>>, D::Error> {
        Ok(Option::<String>::deserialize(d)?.and_then(|s| parse_date(&s)))
    }
}

mod iso {
    use super::*;
    use serde::{Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &DateTime<Utc>, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format_date(v))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<DateTime<Utc>, D::Error> {
        let s = String::deserialize(d)?;
        parse_date(&s).ok_or_else(|| serde::de::Error::custom("неверная дата"))
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum IntegrationError {
    NotConfigured(OAuthProvider),
    Denied(String),
    StateMismatch,
    BadResponse(String),
    Http(u16, String),
    InvalidUrl,
    Reauthorize,
    Network(String),
}

impl std::fmt::Display for IntegrationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IntegrationError::NotConfigured(p) => write!(f, "Не задан ключ приложения ({}). Нажмите «Добавить ключ» и введите свой", p.build_variable()),
            IntegrationError::Denied(s) => write!(f, "Вход отменён: {s}"),
            IntegrationError::StateMismatch => f.write_str("Ответ браузера не относится к этому входу. Попробуйте ещё раз"),
            IntegrationError::BadResponse(s) => write!(f, "Непонятный ответ сервиса: {s}"),
            IntegrationError::Http(code, s) if s.is_empty() => write!(f, "Сервис ответил ошибкой {code}"),
            IntegrationError::Http(code, s) => write!(f, "Сервис ответил ошибкой {code}: {s}"),
            IntegrationError::InvalidUrl => f.write_str("Неверный адрес сервера. Нужен адрес https:// (или http:// только для этого компьютера)"),
            IntegrationError::Reauthorize => f.write_str("Доступ к диску истёк. Подключите его заново"),
            IntegrationError::Network(s) => write!(f, "Нет связи с сервисом: {s}"),
        }
    }
}

impl std::error::Error for IntegrationError {}

// ------------------------------------------------------------------ OAuth

pub mod oauth {
    use super::*;

    /// Адрес страницы входа с PKCE (S256). challenge = base64url(SHA-256(verifier)).
    pub fn authorize_url(client: &OAuthClient, state: &str, code_challenge: &str) -> String {
        let mut u = url::Url::parse(client.provider.authorize_url()).expect("authorize url");
        {
            let mut q = u.query_pairs_mut();
            q.append_pair("client_id", &client.client_id)
                .append_pair("redirect_uri", &redirect::uri())
                .append_pair("response_type", "code")
                .append_pair("state", state)
                .append_pair("code_challenge", code_challenge)
                .append_pair("code_challenge_method", "S256");
            if let Some(scope) = client.provider.scope() {
                q.append_pair("scope", scope);
            }
            for (k, v) in client.provider.extra_authorize_params() {
                q.append_pair(k, v);
            }
        }
        u.to_string()
    }

    /// Случайная строка для verifier и state: 43–128 символов из [A-Za-z0-9-._~] (RFC 7636).
    pub fn random_verifier(length: usize) -> String {
        const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
        let mut rng = rand::rng();
        (0..length.clamp(43, 128)).map(|_| CHARS[rng.random_range(0..CHARS.len())] as char).collect()
    }

    pub fn challenge(verifier: &str) -> String {
        URL_SAFE.encode(Sha256::digest(verifier.as_bytes()))
    }

    fn form_request(url: &str, params: &[(&str, &str)]) -> HttpRequest {
        let body = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(params.iter().copied()).finish();
        HttpRequest {
            method: "POST".into(),
            url: url.into(),
            headers: vec![("Content-Type".into(), "application/x-www-form-urlencoded".into()), ("Accept".into(), "application/json".into())],
            body: Some(body.into_bytes()),
            timeout: 30.0,
        }
    }

    /// Обмен кода на токены.
    pub fn token_request(client: &OAuthClient, code: &str, verifier: &str) -> HttpRequest {
        let uri = redirect::uri();
        let mut params = vec![
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", uri.as_str()),
            ("client_id", client.client_id.as_str()),
            ("code_verifier", verifier),
        ];
        if let Some(s) = &client.client_secret {
            params.push(("client_secret", s));
        }
        form_request(client.provider.token_url(), &params)
    }

    pub fn refresh_request(client: &OAuthClient, refresh_token: &str) -> HttpRequest {
        let mut params = vec![("grant_type", "refresh_token"), ("refresh_token", refresh_token), ("client_id", client.client_id.as_str())];
        if let Some(s) = &client.client_secret {
            params.push(("client_secret", s));
        }
        if client.provider == OAuthProvider::Microsoft {
            if let Some(scope) = client.provider.scope() {
                params.push(("scope", scope));
            }
        }
        form_request(client.provider.token_url(), &params)
    }

    /// Ответ сервера токенов. refresh_token при обновлении может не прийти — тогда остаётся прежний.
    pub fn parse_token(data: &[u8], previous_refresh: Option<&str>, now: DateTime<Utc>) -> Result<OAuthToken, IntegrationError> {
        let obj: Value = serde_json::from_slice(data)
            .ok()
            .filter(Value::is_object)
            .ok_or_else(|| IntegrationError::BadResponse(String::from_utf8_lossy(&data[..data.len().min(200)]).into_owned()))?;
        if let Some(err) = obj.get("error").and_then(Value::as_str) {
            if err == "invalid_grant" {
                return Err(IntegrationError::Reauthorize);
            }
            return Err(IntegrationError::Denied(obj.get("error_description").and_then(Value::as_str).unwrap_or(err).to_string()));
        }
        let access = obj
            .get("access_token")
            .and_then(Value::as_str)
            .filter(|a| !a.is_empty())
            .ok_or_else(|| IntegrationError::BadResponse("нет access_token".into()))?;
        let expires = obj.get("expires_in").and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())));
        Ok(OAuthToken {
            access_token: access.into(),
            refresh_token: obj.get("refresh_token").and_then(Value::as_str).map(str::to_string).or_else(|| previous_refresh.map(str::to_string)),
            expires_at: expires.map(|e| now + Duration::milliseconds((e * 1000.0) as i64)),
        })
    }
}

/// Возврат из браузера на http://localhost:47811/oauth/callback?code=…&state=….
#[derive(Debug, Clone, PartialEq)]
pub struct OAuthCallback {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

impl OAuthCallback {
    /// Разбирает первую строку HTTP-запроса («GET /oauth/callback?… HTTP/1.1»). Чужой путь — None.
    pub fn parse(request_line: &str) -> Option<Self> {
        let parts: Vec<&str> = request_line.split_whitespace().collect();
        if parts.len() < 2 || parts[0] != "GET" {
            return None;
        }
        let u = url::Url::parse(&format!("http://localhost{}", parts[1])).ok()?;
        if u.path() != redirect::PATH {
            return None;
        }
        let q = |n: &str| u.query_pairs().find(|(k, _)| k == n).map(|(_, v)| v.into_owned());
        Some(Self { code: q("code"), state: q("state"), error: q("error_description").or_else(|| q("error")) })
    }

    /// Код, если вход разрешён и state совпал.
    pub fn validated(&self, expected_state: &str) -> Result<String, IntegrationError> {
        if let Some(e) = &self.error {
            return Err(IntegrationError::Denied(e.clone()));
        }
        if self.state.as_deref() != Some(expected_state) {
            return Err(IntegrationError::StateMismatch);
        }
        self.code.clone().filter(|c| !c.is_empty()).ok_or_else(|| IntegrationError::BadResponse("нет кода авторизации".into()))
    }
}

/// Сохранённое подключение диска (целиком в защищённом хранилище).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveConnection {
    pub service: DriveService,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<OAuthToken>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webdav_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub login: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(with = "iso")]
    pub connected_at: DateTime<Utc>,
}

impl DriveConnection {
    pub fn new(service: DriveService) -> Self {
        Self { service, token: None, webdav_url: None, login: None, password: None, connected_at: Utc::now() }
    }
    pub fn encoded(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
    pub fn decode(text: Option<&str>) -> Option<Self> {
        text.and_then(|t| serde_json::from_str(t).ok())
    }
}

// ------------------------------------------------------------------ выгрузка

pub const FOLDER: &str = "Customers";

/// Проверка адреса WebDAV: https, либо http только на этом компьютере (MEGAcmd).
pub fn webdav_base(raw: &str) -> Result<String, IntegrationError> {
    let mut s = raw.trim().to_string();
    if !s.ends_with('/') {
        s.push('/');
    }
    let u = url::Url::parse(&s).map_err(|_| IntegrationError::InvalidUrl)?;
    let host = u.host_str().map(|h| h.trim_matches(['[', ']']).to_lowercase()).ok_or(IntegrationError::InvalidUrl)?;
    if !u.username().is_empty() || u.password().is_some() {
        return Err(IntegrationError::InvalidUrl);
    }
    let local = ["127.0.0.1", "localhost", "::1"].contains(&host.as_str());
    if u.scheme() == "https" || (u.scheme() == "http" && local) {
        Ok(u.to_string())
    } else {
        Err(IntegrationError::InvalidUrl)
    }
}

pub fn basic_auth(login: &str, password: &str) -> String {
    format!("Basic {}", STANDARD.encode(format!("{login}:{password}")))
}

fn path_encode(s: &str) -> String {
    const SET: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC.remove(b'-').remove(b'.').remove(b'_').remove(b'~').remove(b'/');
    percent_encoding::utf8_percent_encode(s, SET).to_string()
}

/// JSON только из ASCII: Dropbox требует экранировать не-ASCII символы в заголовке (\uXXXX).
pub fn ascii_json(object: &Value) -> String {
    let text = crate::cloud::types::canonical_json(object);
    let mut out = String::new();
    for unit in text.encode_utf16() {
        if unit < 0x80 {
            out.push(unit as u8 as char);
        } else {
            out.push_str(&format!("\\u{unit:04x}"));
        }
    }
    out.replace("\\/", "/")
}

/// Запросы по порядку: для WebDAV сначала MKCOL папки (405 — папка уже есть), потом PUT файла.
pub fn upload_requests(c: &DriveConnection, file_name: &str, data: &[u8]) -> Result<Vec<HttpRequest>, IntegrationError> {
    let name = file_name.replace('/', "_");
    let req = |method: &str, url: String, headers: Vec<(String, String)>, body: Option<Vec<u8>>| HttpRequest {
        method: method.into(),
        url,
        headers,
        body,
        timeout: 120.0,
    };
    match c.service.auth() {
        DriveAuth::Webdav { .. } => {
            let base = webdav_base(c.webdav_url.as_deref().unwrap_or(""))?;
            let dir = format!("{base}{FOLDER}/");
            let mut mk = vec![];
            let mut put = vec![("Content-Type".to_string(), "application/octet-stream".to_string())];
            if let Some(login) = c.login.as_deref().filter(|l| !l.is_empty()) {
                let auth = basic_auth(login, c.password.as_deref().unwrap_or(""));
                mk.push(("Authorization".to_string(), auth.clone()));
                put.push(("Authorization".to_string(), auth));
            }
            Ok(vec![req("MKCOL", dir.clone(), mk, None), req("PUT", format!("{dir}{}", path_encode(&name)), put, Some(data.to_vec()))])
        }
        DriveAuth::OAuth(provider) => {
            let token = c.token.as_ref().ok_or(IntegrationError::Reauthorize)?;
            let bearer = ("Authorization".to_string(), format!("Bearer {}", token.access_token));
            let r = match provider {
                OAuthProvider::Google => {
                    let boundary = format!("lg-{}", uuid::Uuid::new_v4());
                    let meta = json!({"name": format!("{FOLDER} {name}")}).to_string();
                    let mut body = Vec::new();
                    body.extend_from_slice(format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n").as_bytes());
                    body.extend_from_slice(data);
                    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
                    req(
                        "POST",
                        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart".into(),
                        vec![("Content-Type".into(), format!("multipart/related; boundary={boundary}")), bearer],
                        Some(body),
                    )
                }
                OAuthProvider::Dropbox => req(
                    "POST",
                    "https://content.dropboxapi.com/2/files/upload".into(),
                    vec![
                        ("Content-Type".into(), "application/octet-stream".into()),
                        ("Dropbox-API-Arg".into(), ascii_json(&json!({"path": format!("/{FOLDER}/{name}"), "mode": "add", "autorename": true}))),
                        bearer,
                    ],
                    Some(data.to_vec()),
                ),
                OAuthProvider::Microsoft => req(
                    "PUT",
                    format!("https://graph.microsoft.com/v1.0/me/drive/special/approot:/{}:/content", path_encode(&format!("{FOLDER}/{name}"))),
                    vec![("Content-Type".into(), "application/octet-stream".into()), bearer],
                    Some(data.to_vec()),
                ),
            };
            Ok(vec![r])
        }
    }
}

/// Ответ на запрос выгрузки — успех? MKCOL: 405/301 значат «папка уже есть».
pub fn is_success(method: &str, status: u16) -> bool {
    if method == "MKCOL" {
        return (200..300).contains(&status) || status == 405 || status == 301;
    }
    (200..300).contains(&status)
}

async fn send(t: &dyn HttpTransport, r: HttpRequest) -> Result<HttpResponse, IntegrationError> {
    t.send(r).await.map_err(|e| IntegrationError::Network(e.message()))
}

fn body_snippet(r: &HttpResponse) -> String {
    String::from_utf8_lossy(&r.data[..r.data.len().min(200)]).trim().to_string()
}

/// Загрузить файл на диск. Просроченный токен OAuth обновляется (обновлённое подключение возвращается,
/// чтобы вызывающий сохранил его в хранилище). Возвращает подключение (возможно с новым токеном).
pub async fn upload_file(
    c: &DriveConnection,
    client: Option<&OAuthClient>,
    file_name: &str,
    data: &[u8],
    t: &dyn HttpTransport,
) -> Result<DriveConnection, IntegrationError> {
    let mut conn = c.clone();
    if let (DriveAuth::OAuth(provider), Some(token)) = (conn.service.auth(), conn.token.clone()) {
        if token.is_expired(Utc::now()) {
            let client = client.ok_or(IntegrationError::NotConfigured(provider))?;
            let refresh = token.refresh_token.clone().ok_or(IntegrationError::Reauthorize)?;
            let r = send(t, oauth::refresh_request(client, &refresh)).await?;
            conn.token = Some(oauth::parse_token(&r.data, Some(&refresh), Utc::now())?);
        }
    }
    for req in upload_requests(&conn, file_name, data)? {
        let method = req.method.clone();
        let r = send(t, req).await?;
        if !is_success(&method, r.status) {
            return Err(match r.status {
                401 | 403 if matches!(conn.service.auth(), DriveAuth::OAuth(_)) => IntegrationError::Reauthorize,
                401 | 403 => IntegrationError::Http(r.status, "логин или пароль не приняты".into()),
                code => IntegrationError::Http(code, body_snippet(&r)),
            });
        }
    }
    Ok(conn)
}

/// Проверка подключения WebDAV: создаётся (или находится) папка приложения.
pub async fn check_webdav(c: &DriveConnection, t: &dyn HttpTransport) -> Result<(), IntegrationError> {
    let reqs = upload_requests(c, "check", b"")?;
    let mk = reqs.into_iter().next().ok_or(IntegrationError::InvalidUrl)?;
    let r = send(t, mk).await?;
    match r.status {
        s if is_success("MKCOL", s) => Ok(()),
        401 | 403 => Err(IntegrationError::Http(r.status, "логин или пароль не приняты".into())),
        code => Err(IntegrationError::Http(code, body_snippet(&r))),
    }
}

// ------------------------------------------------------------------ вход через браузер

const CALLBACK_PAGE: &str = "<!doctype html><html lang=\"ru\"><head><meta charset=\"utf-8\"><title>Customers</title>\
<style>body{background:#1b1c1f;color:#e6e7e9;font:16px system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0}\
main{max-width:420px;padding:24px;text-align:center}h1{font-size:18px;font-weight:600;margin:0 0 8px}p{color:#9a9ca1;margin:0}</style></head>\
<body><main><h1>%TITLE%</h1><p>%TEXT%</p></main></body></html>";

fn callback_page(ok: bool) -> String {
    let (title, text) = if ok {
        ("Вход выполнен", "Можно закрыть эту вкладку и вернуться в Customers.")
    } else {
        ("Вход не выполнен", "Вернитесь в Customers и попробуйте ещё раз.")
    };
    let body = CALLBACK_PAGE.replace("%TITLE%", title).replace("%TEXT%", text);
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{body}",
        body.len()
    )
}

/// Ждёт возврат из браузера на localhost:47811. Слушает только локальный интерфейс.
pub async fn wait_for_callback(state: &str, timeout_secs: u64, cancel: &tokio_util::sync::CancellationToken) -> Result<String, IntegrationError> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", redirect::PORT))
        .await
        .map_err(|e| IntegrationError::Network(format!("порт {} занят: {e}", redirect::PORT)))?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    loop {
        let accepted = tokio::select! {
            r = listener.accept() => r.map_err(|e| IntegrationError::Network(e.to_string()))?,
            _ = tokio::time::sleep_until(deadline) => return Err(IntegrationError::Denied("время ожидания вышло".into())),
            _ = cancel.cancelled() => return Err(IntegrationError::Denied("отменено".into())),
        };
        let (mut sock, _) = accepted;
        let mut buf = vec![0u8; 8192];
        let n = tokio::time::timeout(std::time::Duration::from_secs(5), sock.read(&mut buf)).await.ok().and_then(Result::ok).unwrap_or(0);
        let head = String::from_utf8_lossy(&buf[..n]).to_string();
        let first = head.lines().next().unwrap_or("");
        let Some(cb) = OAuthCallback::parse(first) else {
            let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            continue; // чужой запрос (favicon и т. п.)
        };
        let result = cb.validated(state);
        let _ = sock.write_all(callback_page(result.is_ok()).as_bytes()).await;
        let _ = sock.shutdown().await;
        return result;
    }
}

/// Полный вход OAuth: открывает браузер (`open`), ждёт возврат, обменивает код на токены.
pub async fn connect_oauth(
    client: &OAuthClient,
    open: &(dyn Fn(&str) -> Result<(), String> + Send + Sync),
    t: &dyn HttpTransport,
    cancel: &tokio_util::sync::CancellationToken,
) -> Result<OAuthToken, IntegrationError> {
    let verifier = oauth::random_verifier(64);
    let state = oauth::random_verifier(32);
    let url = oauth::authorize_url(client, &state, &oauth::challenge(&verifier));
    // Сначала занимаем порт, потом открываем браузер: иначе быстрый ответ придёт в никуда.
    let wait = wait_for_callback(&state, 300, cancel);
    tokio::pin!(wait);
    open(&url).map_err(|e| IntegrationError::Denied(format!("не удалось открыть браузер: {e}")))?;
    let code = wait.await?;
    let r = send(t, oauth::token_request(client, &code, &verifier)).await?;
    oauth::parse_token(&r.data, None, Utc::now())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::http::testing::FakeTransport;

    fn client(p: OAuthProvider) -> OAuthClient {
        OAuthClient::new(p, Some("client-id"), Some("secret")).unwrap()
    }

    #[test]
    fn catalog_matches_previous_versions() {
        assert_eq!(DriveService::ALL.len(), 7);
        assert_eq!(DriveService::OneDrive.secret_name("Анна"), "integration.onedrive.анна");
        assert_eq!(DriveService::PCloud.secret_name("A"), "integration.pcloud.a");
        assert_eq!(OAuthProvider::Google.secret_name(), "integration.oauthkey.google");
        assert!(DriveService::Mega.password_optional() && !DriveService::Webdav.password_optional());
        assert_eq!(DriveService::parse("googleDrive"), Some(DriveService::GoogleDrive));
        assert_eq!(DriveService::GoogleDrive.auth(), DriveAuth::OAuth(OAuthProvider::Google));
    }

    #[test]
    fn oauth_client_validation() {
        assert!(OAuthClient::new(OAuthProvider::Dropbox, Some(" key "), None).is_some());
        assert!(OAuthClient::new(OAuthProvider::Dropbox, Some("$(DROPBOX_APP_KEY)"), None).is_none());
        assert!(OAuthClient::new(OAuthProvider::Dropbox, Some("a b"), None).is_none());
        assert!(OAuthClient::new(OAuthProvider::Google, Some("id"), None).is_none(), "Google требует secret");
        assert!(OAuthClient::new(OAuthProvider::Google, Some("id"), Some("$SECRET")).is_none());
        let key = OAuthKey { client_id: "id".into(), client_secret: Some(" s ".into()) };
        assert_eq!(OAuthClient::from_key(OAuthProvider::Google, &key).unwrap().client_secret.as_deref(), Some("s"));
        assert_eq!(OAuthKey { client_id: "".into(), client_secret: None }.problem(OAuthProvider::Dropbox).as_deref(), Some("Введите App key"));
        assert_eq!(OAuthKey::decode(Some(&key.encoded())), Some(key));
    }

    #[test]
    fn authorize_url_has_pkce_and_fixed_redirect() {
        let u = url::Url::parse(&oauth::authorize_url(&client(OAuthProvider::Google), "st", "ch")).unwrap();
        let q: std::collections::HashMap<_, _> = u.query_pairs().into_owned().collect();
        assert_eq!(q["redirect_uri"], "http://localhost:47811/oauth/callback");
        assert_eq!((q["code_challenge"].as_str(), q["code_challenge_method"].as_str(), q["response_type"].as_str()), ("ch", "S256", "code"));
        assert_eq!(q["access_type"], "offline");
        assert_eq!(q["scope"], "https://www.googleapis.com/auth/drive.file");
        let d = url::Url::parse(&oauth::authorize_url(&client(OAuthProvider::Dropbox), "st", "ch")).unwrap();
        assert!(d.query_pairs().all(|(k, _)| k != "scope"));
    }

    #[test]
    fn pkce_challenge_matches_rfc7636_vector() {
        assert_eq!(oauth::challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        let v = oauth::random_verifier(10);
        assert_eq!(v.len(), 43);
        assert!(v.chars().all(|c| c.is_ascii_alphanumeric() || "-._~".contains(c)));
        assert_ne!(oauth::random_verifier(64), oauth::random_verifier(64));
        assert_eq!(oauth::random_verifier(500).len(), 128);
    }

    #[test]
    fn token_parsing() {
        let now = Utc::now();
        let t = oauth::parse_token(br#"{"access_token":"a","refresh_token":"r","expires_in":3600}"#, None, now).unwrap();
        assert_eq!((t.access_token.as_str(), t.refresh_token.as_deref()), ("a", Some("r")));
        assert!(!t.is_expired(now) && t.is_expired(now + Duration::seconds(3550)));
        let kept = oauth::parse_token(br#"{"access_token":"b","expires_in":"60"}"#, Some("old"), now).unwrap();
        assert_eq!(kept.refresh_token.as_deref(), Some("old"));
        assert_eq!(oauth::parse_token(br#"{"error":"invalid_grant"}"#, None, now).unwrap_err(), IntegrationError::Reauthorize);
        assert_eq!(
            oauth::parse_token(r#"{"error":"access_denied","error_description":"нет"}"#.as_bytes(), None, now).unwrap_err(),
            IntegrationError::Denied("нет".into())
        );
        assert!(matches!(oauth::parse_token(b"<html>", None, now), Err(IntegrationError::BadResponse(_))));
        assert!(matches!(oauth::parse_token(b"{}", None, now), Err(IntegrationError::BadResponse(_))));
    }

    #[test]
    fn token_requests_are_form_encoded() {
        let r = oauth::token_request(&client(OAuthProvider::Google), "co de", "ver");
        let body = String::from_utf8(r.body.unwrap()).unwrap();
        assert!(
            body.contains("grant_type=authorization_code")
                && body.contains("code=co+de")
                && body.contains("client_secret=secret")
                && body.contains("code_verifier=ver")
        );
        let m = String::from_utf8(oauth::refresh_request(&client(OAuthProvider::Microsoft), "rt").body.unwrap()).unwrap();
        assert!(m.contains("scope=Files.ReadWrite.AppFolder") && m.contains("refresh_token=rt"));
    }

    #[test]
    fn callback_parsing_and_validation() {
        let cb = OAuthCallback::parse("GET /oauth/callback?code=abc&state=xyz HTTP/1.1").unwrap();
        assert_eq!(cb.validated("xyz").unwrap(), "abc");
        assert_eq!(cb.validated("other").unwrap_err(), IntegrationError::StateMismatch);
        assert!(OAuthCallback::parse("GET /favicon.ico HTTP/1.1").is_none());
        assert!(OAuthCallback::parse("POST /oauth/callback HTTP/1.1").is_none());
        let denied = OAuthCallback::parse("GET /oauth/callback?error=access_denied&error_description=No+way&state=x HTTP/1.1").unwrap();
        assert_eq!(denied.validated("x").unwrap_err(), IntegrationError::Denied("No way".into()));
        assert!(matches!(OAuthCallback::parse("GET /oauth/callback?state=x HTTP/1.1").unwrap().validated("x"), Err(IntegrationError::BadResponse(_))));
    }

    fn webdav(url: &str, login: Option<&str>) -> DriveConnection {
        let mut c = DriveConnection::new(DriveService::Webdav);
        c.webdav_url = Some(url.into());
        c.login = login.map(str::to_string);
        c.password = Some("pw".into());
        c
    }

    #[test]
    fn webdav_addresses() {
        assert_eq!(webdav_base("https://cloud.example/remote.php/dav/files/a").unwrap(), "https://cloud.example/remote.php/dav/files/a/");
        assert_eq!(webdav_base("http://127.0.0.1:4443").unwrap(), "http://127.0.0.1:4443/");
        assert_eq!(webdav_base("http://localhost/").unwrap(), "http://localhost/");
        for bad in ["http://cloud.example/", "ftp://x.example", "https://user:pw@x.example/", "мусор", ""] {
            assert_eq!(webdav_base(bad).unwrap_err(), IntegrationError::InvalidUrl, "{bad}");
        }
    }

    #[test]
    fn webdav_requests_make_folder_then_put() {
        let r = upload_requests(&webdav("https://cloud.example/dav", Some("anna")), "backup 1/2.db", b"DATA").unwrap();
        assert_eq!((r[0].method.as_str(), r[0].url.as_str()), ("MKCOL", "https://cloud.example/dav/Customers/"));
        assert_eq!((r[1].method.as_str(), r[1].url.as_str()), ("PUT", "https://cloud.example/dav/Customers/backup%201_2.db"));
        assert_eq!(r[1].body.as_deref(), Some(b"DATA".as_slice()));
        assert_eq!(r[1].headers.iter().find(|h| h.0 == "Authorization").unwrap().1, "Basic YW5uYTpwdw==");
        let anon = upload_requests(&webdav("http://127.0.0.1:4443/", None), "x.db", b"").unwrap();
        assert!(!anon[0].headers.iter().any(|h| h.0 == "Authorization"));
        assert!(is_success("MKCOL", 405) && is_success("MKCOL", 301) && !is_success("PUT", 405) && is_success("PUT", 201));
    }

    #[test]
    fn oauth_upload_requests() {
        let mut c = DriveConnection::new(DriveService::Dropbox);
        assert_eq!(upload_requests(&c, "a.db", b"").unwrap_err(), IntegrationError::Reauthorize);
        c.token = Some(OAuthToken { access_token: "AT".into(), refresh_token: None, expires_at: None });
        let d = &upload_requests(&c, "резерв.db", b"x").unwrap()[0];
        assert_eq!(d.headers.iter().find(|h| h.0 == "Authorization").unwrap().1, "Bearer AT");
        let arg = &d.headers.iter().find(|h| h.0 == "Dropbox-API-Arg").unwrap().1;
        assert!(arg.is_ascii() && arg.contains("\\u0440") && arg.contains("/Customers/"));
        let mut g = DriveConnection::new(DriveService::GoogleDrive);
        g.token = c.token.clone();
        let gr = &upload_requests(&g, "a.db", b"BIN").unwrap()[0];
        assert!(gr.headers.iter().any(|h| h.0 == "Content-Type" && h.1.starts_with("multipart/related; boundary=lg-")));
        let body = String::from_utf8(gr.body.clone().unwrap()).unwrap();
        assert!(body.contains(r#"{"name":"Customers a.db"}"#) && body.contains("BIN"));
        let mut m = DriveConnection::new(DriveService::OneDrive);
        m.token = c.token.clone();
        assert_eq!(
            upload_requests(&m, "a b.db", b"").unwrap()[0].url,
            "https://graph.microsoft.com/v1.0/me/drive/special/approot:/Customers/a%20b.db:/content"
        );
    }

    #[tokio::test]
    async fn upload_refreshes_expired_token_and_returns_updated_connection() {
        let mut c = DriveConnection::new(DriveService::GoogleDrive);
        c.token = Some(OAuthToken { access_token: "old".into(), refresh_token: Some("rt".into()), expires_at: Some(Utc::now() - Duration::minutes(5)) });
        let t = FakeTransport::new(vec![Ok(HttpResponse::new(200, r#"{"access_token":"new","expires_in":3600}"#)), Ok(HttpResponse::new(200, "{}"))]);
        let updated = upload_file(&c, Some(&client(OAuthProvider::Google)), "b.db", b"x", t.as_ref()).await.unwrap();
        assert_eq!(updated.token.as_ref().unwrap().access_token, "new");
        assert_eq!(updated.token.unwrap().refresh_token.as_deref(), Some("rt"));
        assert_eq!(t.requests.lock().unwrap()[1].headers.iter().find(|h| h.0 == "Authorization").unwrap().1, "Bearer new");
        // без ключа приложения обновить токен нельзя
        let t = FakeTransport::new(vec![]);
        assert!(matches!(upload_file(&c, None, "b.db", b"x", t.as_ref()).await, Err(IntegrationError::NotConfigured(_))));
    }

    #[tokio::test]
    async fn upload_errors_are_explained() {
        let c = webdav("https://cloud.example/dav", Some("anna"));
        let t = FakeTransport::new(vec![Ok(HttpResponse::new(401, ""))]);
        assert_eq!(upload_file(&c, None, "b.db", b"x", t.as_ref()).await.unwrap_err(), IntegrationError::Http(401, "логин или пароль не приняты".into()));
        let t = FakeTransport::new(vec![Ok(HttpResponse::new(405, "")), Ok(HttpResponse::new(507, "Insufficient Storage"))]);
        assert_eq!(upload_file(&c, None, "b.db", b"x", t.as_ref()).await.unwrap_err(), IntegrationError::Http(507, "Insufficient Storage".into()));
        let mut g = DriveConnection::new(DriveService::Dropbox);
        g.token = Some(OAuthToken { access_token: "a".into(), refresh_token: None, expires_at: None });
        let t = FakeTransport::new(vec![Ok(HttpResponse::new(401, ""))]);
        assert_eq!(upload_file(&g, None, "b.db", b"x", t.as_ref()).await.unwrap_err(), IntegrationError::Reauthorize);
        let ok = FakeTransport::new(vec![Ok(HttpResponse::new(201, "")), Ok(HttpResponse::new(201, ""))]);
        upload_file(&c, None, "b.db", b"x", ok.as_ref()).await.unwrap();
        assert!(check_webdav(&c, FakeTransport::new(vec![Ok(HttpResponse::new(405, ""))]).as_ref()).await.is_ok());
        assert!(check_webdav(&c, FakeTransport::new(vec![Ok(HttpResponse::new(403, ""))]).as_ref()).await.is_err());
    }

    #[test]
    fn connection_roundtrip_reads_swift_iso_dates() {
        let text = r#"{"service":"googleDrive","connectedAt":"2026-11-05T09:42:00Z","token":{"accessToken":"a","refreshToken":"r","expiresAt":"2026-11-05T10:42:00Z"}}"#;
        let c = DriveConnection::decode(Some(text)).unwrap();
        assert_eq!(c.service, DriveService::GoogleDrive);
        assert_eq!(c.token.as_ref().unwrap().expires_at.unwrap().timestamp(), 1_793_875_320);
        assert_eq!(DriveConnection::decode(Some(&c.encoded())), Some(c));
        assert!(DriveConnection::decode(Some("{}")).is_none());
    }

    #[tokio::test]
    async fn loopback_callback_roundtrip_ignores_strangers() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let cancel = tokio_util::sync::CancellationToken::new();
        let server = tokio::spawn({
            let cancel = cancel.clone();
            async move { wait_for_callback("STATE", 20, &cancel).await }
        });
        let get = |path: &'static str| async move {
            let mut last = None;
            for _ in 0..50 {
                match tokio::net::TcpStream::connect(("127.0.0.1", redirect::PORT)).await {
                    Ok(mut s) => {
                        s.write_all(format!("GET {path} HTTP/1.1\r\nHost: localhost\r\n\r\n").as_bytes()).await.unwrap();
                        let mut out = String::new();
                        s.read_to_string(&mut out).await.unwrap();
                        last = Some(out);
                        break;
                    }
                    Err(_) => tokio::time::sleep(std::time::Duration::from_millis(50)).await,
                }
            }
            last.expect("сервер не запустился")
        };
        assert!(get("/favicon.ico").await.starts_with("HTTP/1.1 404"));
        let page = get("/oauth/callback?code=CODE&state=STATE").await;
        assert!(page.contains("Вход выполнен"));
        assert_eq!(server.await.unwrap().unwrap(), "CODE");
    }
}
