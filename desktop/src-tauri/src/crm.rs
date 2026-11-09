//! Экспорт лидов во внешние сервисы: Bitrix24 (входящий вебхук), Notion (интеграция и база данных)
//! и любой JSON-вебхук (Make, n8n, Zapier, свой сервер). Ключи хранит приложение в защищённом
//! хранилище, сюда они приходят параметрами и никуда не записываются.

use crate::export::ExportField;
use crate::models::{LeadItem, LeadKind};
use crate::search::http::{HttpRequest, HttpResponse, HttpTransport, Sleeper};
use crate::util::{format_date, source_title, NilIfEmpty};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CrmKind {
    Bitrix,
    Notion,
    Webhook,
}

impl CrmKind {
    pub const ALL: [CrmKind; 3] = [CrmKind::Bitrix, CrmKind::Notion, CrmKind::Webhook];

    pub fn raw(self) -> &'static str {
        match self {
            CrmKind::Bitrix => "bitrix",
            CrmKind::Notion => "notion",
            CrmKind::Webhook => "webhook",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.raw() == s)
    }
    pub fn title(self) -> &'static str {
        match self {
            CrmKind::Bitrix => "Bitrix24",
            CrmKind::Notion => "Notion",
            CrmKind::Webhook => "Вебхук",
        }
    }
    /// Имя секрета назначения в защищённом хранилище.
    pub fn secret_name(self) -> String {
        format!("export.{}.secret", self.raw())
    }
}

/// Понятные ошибки. Секреты в текст не попадают.
#[derive(Debug, Clone, PartialEq)]
pub enum CrmError {
    InvalidAddress(String),
    Unauthorized(String),
    Forbidden(String),
    NotFound(String),
    RateLimited,
    Server(u16, String),
    BadResponse(String),
    Network(String),
}

impl std::fmt::Display for CrmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CrmError::InvalidAddress(s) => f.write_str(s),
            CrmError::Unauthorized(s) => write!(f, "Доступ не подтверждён: {s}"),
            CrmError::Forbidden(s) => write!(f, "Недостаточно прав: {s}"),
            CrmError::NotFound(s) => write!(f, "Не найдено: {s}"),
            CrmError::RateLimited => f.write_str("Сервис просит подождать: слишком много запросов. Повторите экспорт через минуту."),
            CrmError::Server(code, s) if s.is_empty() => write!(f, "Сервис ответил ошибкой {code}"),
            CrmError::Server(code, s) => write!(f, "Ошибка {code}: {s}"),
            CrmError::BadResponse(s) => write!(f, "Непонятный ответ сервиса: {s}"),
            CrmError::Network(s) => write!(f, "Нет связи с сервисом: {s}"),
        }
    }
}

impl std::error::Error for CrmError {}

impl CrmError {
    /// Ошибка, после которой нет смысла отправлять остальные лиды.
    pub fn stops_export(&self) -> bool {
        matches!(self, CrmError::Unauthorized(_) | CrmError::Forbidden(_) | CrmError::NotFound(_) | CrmError::InvalidAddress(_) | CrmError::Network(_))
    }
}

// ------------------------------------------------------------------ журнал отправленных

/// Какие лиды уже ушли в конкретное назначение: id лида → id записи на стороне сервиса.
/// Хранится в локальной базе (kv), в облако не синхронизируется.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ExportLedger {
    #[serde(default)]
    pub sent: BTreeMap<String, String>,
}

impl ExportLedger {
    pub fn decode(raw: Option<&str>) -> Self {
        raw.and_then(|r| serde_json::from_str(r).ok()).unwrap_or_default()
    }

    pub fn encoded(&self) -> String {
        crate::cloud::types::canonical_json(&serde_json::to_value(self).unwrap_or_default())
    }

    /// Ключ kv для назначения. Адрес вебхука содержит секрет, поэтому в ключ идёт только хэш.
    pub fn storage_key(kind: CrmKind, target: &str) -> String {
        format!("export.ledger.{}.{}", kind.raw(), fnv1a(&target.to_lowercase()))
    }
}

fn fnv1a(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:x}")
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct CrmFailure {
    pub title: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrmReport {
    pub exported: usize,
    pub skipped: usize,
    pub failures: Vec<CrmFailure>,
    pub stopped_early: bool,
}

impl CrmReport {
    pub fn summary(&self) -> String {
        let mut parts = vec![format!("Отправлено: {}", self.exported)];
        if self.skipped > 0 {
            parts.push(format!("пропущено как уже отправленные: {}", self.skipped));
        }
        if !self.failures.is_empty() {
            parts.push(format!("с ошибкой: {}", self.failures.len()));
        }
        parts.join(", ")
    }
}

#[async_trait]
pub trait CrmDestination: Send + Sync {
    fn kind(&self) -> CrmKind;
    /// Что-то, однозначно определяющее место назначения (портал, база, адрес). Идёт в ключ журнала.
    fn target(&self) -> String;
    /// Пауза между запросами, чтобы уложиться в лимиты сервиса (секунды).
    fn pause(&self) -> f64;
    /// Отправить один лид. Возвращает id записи на стороне сервиса.
    async fn send(&self, item: &LeadItem, t: &dyn HttpTransport) -> Result<String, CrmError>;
}

#[allow(clippy::too_many_arguments)] // порядок и набор параметров нужны тестам
pub async fn run_export(
    items: &[LeadItem],
    dest: &dyn CrmDestination,
    mut ledger: ExportLedger,
    resend: bool,
    t: &dyn HttpTransport,
    sleeper: &Sleeper,
    cancel: &CancellationToken,
    progress: &(dyn Fn(usize, usize) + Send + Sync),
) -> (CrmReport, ExportLedger) {
    let mut report = CrmReport::default();
    let mut first = true;
    for (i, item) in items.iter().enumerate() {
        progress(i, items.len());
        if cancel.is_cancelled() {
            report.stopped_early = true;
            break;
        }
        if !resend && ledger.sent.contains_key(&item.id) {
            report.skipped += 1;
            continue;
        }
        if !first && dest.pause() > 0.0 {
            sleeper(dest.pause()).await;
        }
        first = false;
        match send_retrying(item, dest, t, sleeper).await {
            Ok(remote) => {
                ledger.sent.insert(item.id.clone(), remote);
                report.exported += 1;
            }
            Err(e) => {
                report.failures.push(CrmFailure { title: item.data.title.clone(), message: e.to_string() });
                if e.stops_export() {
                    report.stopped_early = true;
                    break;
                }
            }
        }
    }
    progress(items.len(), items.len());
    (report, ledger)
}

/// Один повтор после «слишком много запросов».
async fn send_retrying(item: &LeadItem, d: &dyn CrmDestination, t: &dyn HttpTransport, sleeper: &Sleeper) -> Result<String, CrmError> {
    match d.send(item, t).await {
        Err(CrmError::RateLimited) => {
            sleeper(2.0).await;
            d.send(item, t).await
        }
        other => other,
    }
}

async fn perform(t: &dyn HttpTransport, req: HttpRequest) -> Result<HttpResponse, CrmError> {
    t.send(req).await.map_err(|e| CrmError::Network(e.message()))
}

fn post_json(url: String, body: &Value, headers: Vec<(String, String)>) -> HttpRequest {
    let mut h = vec![("Content-Type".to_string(), "application/json".to_string()), ("Accept".to_string(), "application/json".to_string())];
    h.extend(headers);
    HttpRequest { method: "POST".into(), url, headers: h, body: Some(crate::cloud::types::canonical_json(body).into_bytes()), timeout: 30.0 }
}

fn id_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => n.as_i64().map(|i| i.to_string()).or_else(|| n.as_f64().filter(|f| f.fract() == 0.0).map(|f| (f as i64).to_string())),
        _ => None,
    }
}

fn parse_object(data: &[u8]) -> Option<Map<String, Value>> {
    serde_json::from_slice::<Value>(data).ok().and_then(|v| v.as_object().cloned())
}

/// Текст лида для поля «Комментарий» / тела страницы.
pub fn comment(item: &LeadItem) -> String {
    let d = &item.data;
    let mut lines: Vec<String> = Vec::new();
    if !d.description.is_empty() {
        lines.push(d.description.clone());
    }
    if !d.url.is_empty() {
        lines.push(format!("Ссылка: {}", d.url));
    }
    lines.push(format!("Источник: {}", source_title(&d.source)));
    lines.push(format!("Оценка: {} ({})", d.score.round() as i64, d.relevance.title()));
    if let Some(b) = ExportField::Budget.value(item).nil_if_empty() {
        lines.push(format!("Бюджет: {b}"));
    }
    if !d.score_reasons.is_empty() {
        lines.push(format!("Почему: {}", d.score_reasons.join("; ")));
    }
    if !item.note.is_empty() {
        lines.push(format!("Заметка: {}", item.note));
    }
    lines.join("\n")
}

fn chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

// ------------------------------------------------------------------ Bitrix24

/// Bitrix24 через входящий вебхук (бесплатный тариф тоже). Создаёт лиды методом `crm.lead.add`.
pub struct Bitrix24 {
    pub base: String,
}

impl Bitrix24 {
    pub fn new(webhook: &str) -> Result<Self, CrmError> {
        Ok(Self { base: Self::normalize(webhook)? })
    }

    /// Проверяет и приводит адрес вебхука к виду `https://host/rest/<user>/<code>/`.
    /// Вставленный вместе с методом адрес (`.../crm.lead.add.json`) тоже принимается.
    pub fn normalize(raw: &str) -> Result<String, CrmError> {
        let bad = || CrmError::InvalidAddress("Вставьте адрес входящего вебхука целиком, например https://ваш-портал.bitrix24.ru/rest/1/abc123def456/".into());
        let u = url::Url::parse(raw.trim()).map_err(|_| bad())?;
        let host = u.host_str().filter(|h| !h.is_empty()).ok_or_else(bad)?;
        if u.scheme() != "https" {
            return Err(bad());
        }
        let parts: Vec<&str> = u.path().split('/').filter(|p| !p.is_empty()).collect();
        let rest = parts.iter().position(|p| *p == "rest").ok_or_else(bad)?;
        if parts.len() < rest + 3 || parts[rest + 1].parse::<u64>().is_err() || parts[rest + 2].is_empty() {
            return Err(bad());
        }
        let port = u.port().map(|p| format!(":{p}")).unwrap_or_default();
        Ok(format!("https://{host}{port}/{}/", parts[..=rest + 2].join("/")))
    }

    /// Поля лида для `crm.lead.add`.
    pub fn fields(item: &LeadItem) -> Value {
        let d = &item.data;
        let mut f = Map::new();
        f.insert("TITLE".into(), json!(chars(&d.title, 250)));
        f.insert("SOURCE_ID".into(), json!("OTHER"));
        f.insert("SOURCE_DESCRIPTION".into(), json!(format!("Customers: {}", source_title(&d.source))));
        f.insert("COMMENTS".into(), json!(comment(item)));
        f.insert("OPENED".into(), json!("Y"));
        // Связь с исходной записью: по ней видно, откуда пришёл лид.
        f.insert("ORIGINATOR_ID".into(), json!("lead-generator"));
        f.insert("ORIGIN_ID".into(), json!(item.id));
        let name = d.customer_name.clone().nil_if_empty().or_else(|| (d.kind == LeadKind::Organization).then(|| d.title.clone()).nil_if_empty());
        if let Some(name) = name {
            f.insert("COMPANY_TITLE".into(), json!(name));
        }
        let list = |vals: Vec<String>| Value::Array(vals.into_iter().map(|v| json!({"VALUE": v, "VALUE_TYPE": "WORK"})).collect());
        if !d.phones().is_empty() {
            f.insert("PHONE".into(), list(d.phones()));
        }
        if !d.emails().is_empty() {
            f.insert("EMAIL".into(), list(d.emails()));
        }
        if let Some(w) = d.website.clone().nil_if_empty() {
            f.insert("WEB".into(), list(vec![w]));
        }
        if let Some(a) = d.address.clone().nil_if_empty() {
            f.insert("ADDRESS".into(), json!(a));
        }
        if let Some(r) = d.region.clone().nil_if_empty() {
            f.insert("ADDRESS_CITY".into(), json!(r));
        }
        if let Some(b) = d.budget {
            f.insert("OPPORTUNITY".into(), json!(b));
            if let Some(c) = d.currency.clone().nil_if_empty() {
                f.insert("CURRENCY_ID".into(), json!(if c == "₽" { "RUB".to_string() } else { c.to_uppercase() }));
            }
        }
        Value::Object(f)
    }

    fn request(&self, method: &str, body: &Value) -> HttpRequest {
        post_json(format!("{}{method}.json", self.base), body, vec![])
    }

    /// Разбор ответа Bitrix24: `{"result": 123}` или `{"error": "...", "error_description": "..."}`.
    pub fn parse(data: &[u8], status: u16) -> Result<Value, CrmError> {
        let obj = parse_object(data);
        if let Some(err) = obj.as_ref().and_then(|o| o.get("error")).and_then(Value::as_str) {
            let text = obj
                .as_ref()
                .and_then(|o| o.get("error_description"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .nil_if_empty()
                .unwrap_or_else(|| err.to_string());
            return Err(match err.to_uppercase().as_str() {
                "QUERY_LIMIT_EXCEEDED" => CrmError::RateLimited,
                "INVALID_CREDENTIALS" | "WRONG_AUTH_TYPE" | "NO_AUTH_FOUND" | "EXPIRED_TOKEN" | "INVALID_TOKEN" => {
                    CrmError::Unauthorized(format!("Bitrix24 не принял вебхук. Проверьте адрес или создайте вебхук заново. ({text})"))
                }
                "INSUFFICIENT_SCOPE" | "ACCESS_DENIED" => {
                    CrmError::Forbidden(format!("у вебхука нет права «CRM (crm)». Откройте его настройки в Bitrix24 и отметьте CRM. ({text})"))
                }
                "ERROR_METHOD_NOT_FOUND" => CrmError::NotFound(format!("метод не найден. Возможно, у вебхука нет права «CRM (crm)». ({text})")),
                _ => CrmError::Server(status, text),
            });
        }
        match status {
            429 | 503 => return Err(CrmError::RateLimited),
            401 => return Err(CrmError::Unauthorized("Bitrix24 не принял вебхук.".into())),
            404 => return Err(CrmError::NotFound("портал или вебхук. Проверьте адрес.".into())),
            s if !(200..300).contains(&s) => return Err(CrmError::Server(s, String::new())),
            _ => {}
        }
        obj.and_then(|mut o| o.remove("result")).ok_or_else(|| CrmError::BadResponse("нет поля result".into()))
    }

    /// Проверка подключения: вебхук действует и у него есть доступ к CRM.
    pub async fn check(&self, t: &dyn HttpTransport) -> Result<(), CrmError> {
        let r = perform(t, self.request("crm.lead.fields", &json!({}))).await?;
        Self::parse(&r.data, r.status).map(|_| ())
    }
}

#[async_trait]
impl CrmDestination for Bitrix24 {
    fn kind(&self) -> CrmKind {
        CrmKind::Bitrix
    }
    fn target(&self) -> String {
        url::Url::parse(&self.base).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_else(|| self.base.clone())
    }
    /// Лимит Bitrix24: около 2 запросов в секунду.
    fn pause(&self) -> f64 {
        0.6
    }
    async fn send(&self, item: &LeadItem, t: &dyn HttpTransport) -> Result<String, CrmError> {
        let body = json!({"fields": Self::fields(item), "params": {"REGISTER_SONET_EVENT": "N"}});
        let r = perform(t, self.request("crm.lead.add", &body)).await?;
        let result = Self::parse(&r.data, r.status)?;
        id_string(&result).ok_or_else(|| CrmError::BadResponse("в ответе нет номера лида".into()))
    }
}

// ------------------------------------------------------------------ Notion

/// Свойство базы Notion.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct NotionProperty {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
}

impl NotionProperty {
    /// Типы, в которые экспорт умеет писать.
    pub const WRITABLE: [&'static str; 10] = ["title", "rich_text", "url", "email", "phone_number", "number", "select", "multi_select", "checkbox", "date"];

    pub fn is_writable(&self) -> bool {
        Self::WRITABLE.contains(&self.kind.as_str())
    }

    pub fn type_title(&self) -> &str {
        match self.kind.as_str() {
            "title" => "заголовок",
            "rich_text" => "текст",
            "url" => "ссылка",
            "email" => "email",
            "phone_number" => "телефон",
            "number" => "число",
            "select" => "выбор",
            "multi_select" => "теги",
            "checkbox" => "флажок",
            "date" => "дата",
            other => other,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NotionDatabase {
    pub id: String,
    pub title: String,
    pub properties: Vec<NotionProperty>,
}

const NOTION_API: &str = "https://api.notion.com/v1/";
const NOTION_VERSION: &str = "2022-06-28";

pub struct NotionDestination {
    pub token: String,
    pub database_id: String,
    /// Свойство базы → поле лида.
    pub mapping: BTreeMap<String, ExportField>,
    pub properties: Vec<NotionProperty>,
}

impl NotionDestination {
    pub fn new(token: &str, database_id: &str, properties: Vec<NotionProperty>, mapping: BTreeMap<String, ExportField>) -> Self {
        Self { token: token.trim().to_string(), database_id: database_id.into(), mapping, properties }
    }

    /// ID базы из ссылки (`https://www.notion.so/workspace/Leads-0123…?v=…`) или из самого ID.
    pub fn database_id_from(raw: &str) -> Result<String, CrmError> {
        let s = raw.trim();
        let path = url::Url::parse(s).map(|u| u.path().to_string()).unwrap_or_else(|_| s.to_string());
        let compact: Vec<char> = path.replace('-', "").chars().collect();
        let mut run = 0;
        let mut end = None;
        for (i, c) in compact.iter().enumerate() {
            run = if c.is_ascii_hexdigit() { run + 1 } else { 0 };
            if run >= 32 {
                end = Some(i);
            }
        }
        let end = end.ok_or_else(|| {
            CrmError::InvalidAddress("Вставьте ссылку на базу данных Notion (Поделиться → Скопировать ссылку) или её ID из 32 символов.".into())
        })?;
        let id: String = compact[end - 31..=end].iter().collect::<String>().to_lowercase();
        Ok(format!("{}-{}-{}-{}-{}", &id[0..8], &id[8..12], &id[12..16], &id[16..20], &id[20..32]))
    }

    fn request(path: &str, token: &str, method: &str, body: Option<&Value>) -> HttpRequest {
        let mut h = vec![
            ("Authorization".to_string(), format!("Bearer {token}")),
            ("Notion-Version".to_string(), NOTION_VERSION.to_string()),
            ("Accept".to_string(), "application/json".to_string()),
        ];
        if body.is_some() {
            h.push(("Content-Type".into(), "application/json".into()));
        }
        HttpRequest {
            method: method.into(),
            url: format!("{NOTION_API}{path}"),
            headers: h,
            body: body.map(|b| crate::cloud::types::canonical_json(b).into_bytes()),
            timeout: 30.0,
        }
    }

    /// Ошибки Notion: `{"object":"error","status":401,"code":"unauthorized","message":"..."}`.
    pub fn check(data: &[u8], status: u16) -> Result<Map<String, Value>, CrmError> {
        let obj = parse_object(data).unwrap_or_default();
        if (200..300).contains(&status) && obj.get("object").and_then(Value::as_str) != Some("error") {
            return Ok(obj);
        }
        let code = obj.get("code").and_then(Value::as_str).unwrap_or("");
        let message = obj.get("message").and_then(Value::as_str).unwrap_or("").to_string();
        Err(if status == 401 || code == "unauthorized" {
            CrmError::Unauthorized("Notion не принял ключ интеграции. Скопируйте его заново на notion.so/my-integrations.".into())
        } else if status == 403 || code == "restricted_resource" {
            CrmError::Forbidden("у интеграции нет доступа к базе. Откройте базу в Notion → ••• → Подключения → добавьте интеграцию.".into())
        } else if status == 404 || code == "object_not_found" {
            CrmError::NotFound("база не найдена или к ней не подключена интеграция. Откройте базу → ••• → Подключения → добавьте интеграцию.".into())
        } else if status == 429 || code == "rate_limited" {
            CrmError::RateLimited
        } else if status == 400 || code == "validation_error" {
            CrmError::Server(400, format!("Notion отклонил данные: {message}. Проверьте сопоставление полей."))
        } else {
            CrmError::Server(status, message)
        })
    }

    /// Схема базы: название и свойства.
    pub async fn fetch_database(token: &str, id: &str, t: &dyn HttpTransport) -> Result<NotionDatabase, CrmError> {
        let r = perform(t, Self::request(&format!("databases/{id}"), token.trim(), "GET", None)).await?;
        Self::parse_database(&Self::check(&r.data, r.status)?, id)
    }

    pub fn parse_database(obj: &Map<String, Value>, id: &str) -> Result<NotionDatabase, CrmError> {
        let props = obj.get("properties").and_then(Value::as_object).ok_or_else(|| CrmError::BadResponse("в базе нет свойств".into()))?;
        let title: String = obj
            .get("title")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|t| t.get("plain_text").and_then(Value::as_str)).collect())
            .unwrap_or_default();
        let mut list: Vec<NotionProperty> = props
            .iter()
            .filter_map(|(name, v)| v.get("type").and_then(Value::as_str).map(|t| NotionProperty { name: name.clone(), kind: t.to_string() }))
            .collect();
        // Заголовок первым, остальные по имени.
        list.sort_by(|a, b| ((a.kind != "title") as u8, &a.name).cmp(&((b.kind != "title") as u8, &b.name)));
        Ok(NotionDatabase { id: id.into(), title: if title.is_empty() { "Без названия".into() } else { title }, properties: list })
    }

    /// Сопоставление по умолчанию: заголовок ← название, остальные — по похожему имени свойства.
    pub fn auto_mapping(properties: &[NotionProperty]) -> BTreeMap<String, ExportField> {
        use ExportField::*;
        let synonyms: Vec<(ExportField, &[&str])> = vec![
            (Title, &["название", "name", "title", "имя", "лид"]),
            (Url, &["ссылка", "url", "link", "источник ссылка"]),
            (Phone, &["телефон", "phone", "тел"]),
            (Emails, &["email", "e-mail", "почта", "mail"]),
            (Website, &["сайт", "website", "web", "site"]),
            (Address, &["адрес", "address"]),
            (Region, &["регион", "город", "region", "city"]),
            (Category, &["категория", "category", "тип проекта"]),
            (Source, &["источник", "source"]),
            (Score, &["оценка", "score", "балл"]),
            (Relevance, &["релевантность", "relevance", "приоритет"]),
            (Kind, &["тип", "kind", "type"]),
            (Budget, &["бюджет", "budget", "сумма"]),
            (DiscoveredAt, &["обнаружен", "дата", "date", "найден"]),
            (Description, &["описание", "description"]),
            (Note, &["заметка", "note", "комментарий"]),
            (Reasons, &["причины оценки", "причины", "reasons"]),
            (Favorite, &["избранное", "favorite"]),
        ];
        let mut out = BTreeMap::new();
        let mut used: Vec<ExportField> = vec![];
        for p in properties.iter().filter(|p| p.kind == "title") {
            out.insert(p.name.clone(), Title);
            used.push(Title);
        }
        for p in properties.iter().filter(|p| p.is_writable()) {
            if out.contains_key(&p.name) {
                continue;
            }
            let n = p.name.to_lowercase().trim().to_string();
            let found = ExportField::ALL
                .iter()
                .copied()
                .find(|f| !used.contains(f) && (synonyms.iter().any(|(sf, names)| sf == f && names.contains(&n.as_str())) || f.title().to_lowercase() == n));
            if let Some(f) = found {
                out.insert(p.name.clone(), f);
                used.push(f);
            }
        }
        out
    }

    /// Значение свойства Notion из поля лида. `None` — пропустить (пустое или неподходящее).
    pub fn value(field: ExportField, item: &LeadItem, kind: &str) -> Option<Value> {
        let raw = match field {
            ExportField::Phone => item.data.phones().first().cloned().unwrap_or_default(),
            ExportField::Emails => item.data.emails().first().cloned().unwrap_or_default(),
            _ => field.value(item),
        };
        if kind == "checkbox" {
            return Some(json!({"checkbox": if field == ExportField::Favorite { item.favorite } else { !raw.is_empty() }}));
        }
        let text = chars(&raw, 2000);
        if text.is_empty() {
            return None;
        }
        let rich = |s: &str| json!([{"text": {"content": s}}]);
        match kind {
            "title" => Some(json!({"title": rich(&text)})),
            "rich_text" => {
                let t = match field {
                    ExportField::Phone => item.data.phones().join(", "),
                    ExportField::Emails => item.data.emails().join(", "),
                    _ => text,
                };
                Some(json!({"rich_text": rich(&t)}))
            }
            "url" => {
                let u = match field {
                    ExportField::Emails => format!("mailto:{text}"),
                    ExportField::Phone => format!("tel:{}", text.chars().filter(|c| c.is_numeric() || *c == '+').collect::<String>()),
                    _ => text,
                };
                Some(json!({"url": u}))
            }
            "email" => text.contains('@').then(|| json!({"email": text})),
            "phone_number" => Some(json!({"phone_number": text})),
            "number" => {
                let n = match field {
                    ExportField::Score => Some(item.data.score.round()),
                    ExportField::Budget => item.data.budget,
                    _ => text.replace(',', ".").parse::<f64>().ok(),
                }?;
                Some(json!({"number": n}))
            }
            "select" => Some(json!({"select": {"name": chars(&text, 100).replace(',', " ")}})),
            "multi_select" => {
                let tags: Vec<String> = text.split([',', ';']).map(|t| chars(t.trim(), 100)).filter(|t| !t.is_empty()).collect();
                (!tags.is_empty()).then(|| json!({"multi_select": tags.iter().take(20).map(|t| json!({"name": t})).collect::<Vec<_>>()}))
            }
            "date" => {
                let date = if field == ExportField::DiscoveredAt { Some(item.discovered_at) } else { crate::util::parse_date(&text) }?;
                Some(json!({"date": {"start": format_date(&date)}}))
            }
            _ => None,
        }
    }

    pub fn page_body(&self, item: &LeadItem) -> Value {
        let mut props = Map::new();
        for p in &self.properties {
            if let Some(v) = self.mapping.get(&p.name).and_then(|f| Self::value(*f, item, &p.kind)) {
                props.insert(p.name.clone(), v);
            }
        }
        // Текст лида — в тело страницы, абзацами по 2000 символов (лимит Notion).
        let text: Vec<char> = comment(item).chars().collect();
        let children: Vec<Value> = text
            .chunks(2000)
            .take(20)
            .map(|c| {
                let s: String = c.iter().collect();
                json!({"object": "block", "type": "paragraph", "paragraph": {"rich_text": [{"text": {"content": s}}]}})
            })
            .collect();
        json!({"parent": {"database_id": self.database_id}, "properties": props, "children": children})
    }
}

#[async_trait]
impl CrmDestination for NotionDestination {
    fn kind(&self) -> CrmKind {
        CrmKind::Notion
    }
    fn target(&self) -> String {
        self.database_id.clone()
    }
    /// Лимит Notion: в среднем 3 запроса в секунду.
    fn pause(&self) -> f64 {
        0.4
    }
    async fn send(&self, item: &LeadItem, t: &dyn HttpTransport) -> Result<String, CrmError> {
        let r = perform(t, Self::request("pages", &self.token, "POST", Some(&self.page_body(item)))).await?;
        let obj = Self::check(&r.data, r.status)?;
        obj.get("id").and_then(Value::as_str).map(str::to_string).ok_or_else(|| CrmError::BadResponse("в ответе нет id страницы".into()))
    }
}

// ------------------------------------------------------------------ вебхук

/// Любой адрес, принимающий JSON методом POST: сценарии Make, n8n, Zapier, Pipedream или свой сервер.
pub struct WebhookDestination {
    pub url: String,
}

impl WebhookDestination {
    pub fn new(raw: &str) -> Result<Self, CrmError> {
        Ok(Self { url: Self::normalize(raw)? })
    }

    /// Адрес вебхука секретный (в нём ключ сценария), поэтому принимается только https.
    pub fn normalize(raw: &str) -> Result<String, CrmError> {
        let bad = || CrmError::InvalidAddress("Нужен адрес вебхука, начинающийся с https://".into());
        let u = url::Url::parse(raw.trim()).map_err(|_| bad())?;
        if u.scheme() != "https" || u.host_str().map(str::is_empty).unwrap_or(true) {
            return Err(bad());
        }
        Ok(u.to_string())
    }

    /// Тело запроса: один лид, все поля экспорта, плюс телефоны и email списками.
    pub fn payload(item: &LeadItem) -> Value {
        let mut lead = Map::new();
        for f in ExportField::ALL {
            lead.insert(f.key().into(), json!(f.value(item)));
        }
        lead.insert("phones".into(), json!(item.data.phones()));
        lead.insert("email_list".into(), json!(item.data.emails()));
        lead.insert("score".into(), json!(item.data.score.round()));
        lead.insert("favorite".into(), json!(item.favorite));
        json!({"event": "lead.exported", "source": "lead-generator", "lead_id": item.id, "lead": lead})
    }
}

#[async_trait]
impl CrmDestination for WebhookDestination {
    fn kind(&self) -> CrmKind {
        CrmKind::Webhook
    }
    fn target(&self) -> String {
        self.url.clone()
    }
    fn pause(&self) -> f64 {
        0.25
    }
    async fn send(&self, item: &LeadItem, t: &dyn HttpTransport) -> Result<String, CrmError> {
        let req = post_json(self.url.clone(), &Self::payload(item), vec![("X-LeadGen-Lead-Id".into(), item.id.clone())]);
        let r = perform(t, req).await?;
        match r.status {
            200..=299 => Ok(parse_object(&r.data).and_then(|o| o.get("id").and_then(id_string)).unwrap_or_else(|| item.id.clone())),
            401 => Err(CrmError::Unauthorized("адрес вебхука отклонил запрос.".into())),
            403 => Err(CrmError::Forbidden("адрес вебхука отклонил запрос.".into())),
            404 | 410 => Err(CrmError::NotFound("адрес вебхука не существует или сценарий выключен.".into())),
            429 => Err(CrmError::RateLimited),
            code => Err(CrmError::Server(code, String::from_utf8_lossy(&r.data[..r.data.len().min(200)]).trim().to_string())),
        }
    }
}

/// Приведение назначения, настроенного пользователем, к объекту отправки.
pub fn arc_dest(d: impl CrmDestination + 'static) -> Arc<dyn CrmDestination> {
    Arc::new(d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{LeadData, Relevance};
    use crate::search::http::testing::FakeTransport;
    use crate::search::http::{no_sleep, SearchError};
    use chrono::Utc;

    fn item(id: &str, title: &str) -> LeadItem {
        let mut d = LeadData::new(LeadKind::Organization, "osm_organizations", id, title);
        d.phone = Some("+7 843 212-48-90".into());
        d.website = Some("https://lavanda.ru".into());
        d.address = Some("Казань, Баумана 1".into());
        d.region = Some("Казань".into());
        d.score = 71.4;
        d.relevance = Relevance::High;
        d.score_reasons = vec!["нет сайта".into()];
        d.contacts.insert("email".into(), "info@lavanda.ru".into());
        d.customer_name = Some(title.into());
        LeadItem {
            id: id.into(), data: d, discovered_at: Utc::now(), favorite: true, archived: false, excluded: false, seen: false, note: "позвонить".into()
        }
    }

    fn ok(body: &str) -> Result<HttpResponse, SearchError> {
        Ok(HttpResponse::new(200, body))
    }

    #[test]
    fn bitrix_address_normalization() {
        let ok = |s: &str| Bitrix24::normalize(s).unwrap();
        assert_eq!(ok("https://p.bitrix24.ru/rest/1/abc123/"), "https://p.bitrix24.ru/rest/1/abc123/");
        assert_eq!(ok(" https://p.bitrix24.ru/rest/12/abc123/crm.lead.add.json?x=1 "), "https://p.bitrix24.ru/rest/12/abc123/");
        for bad in ["http://p.bitrix24.ru/rest/1/abc/", "https://p.bitrix24.ru/", "https://p.bitrix24.ru/rest/x/abc/", "https://p.bitrix24.ru/rest/1", "мусор"]
        {
            assert!(matches!(Bitrix24::normalize(bad), Err(CrmError::InvalidAddress(_))), "{bad}");
        }
    }

    #[test]
    fn bitrix_fields_cover_contacts_and_origin() {
        let f = Bitrix24::fields(&item("node/1", "Лаванда"));
        assert_eq!(f["TITLE"], "Лаванда");
        assert_eq!(f["ORIGIN_ID"], "node/1");
        assert_eq!(f["COMPANY_TITLE"], "Лаванда");
        assert_eq!(f["PHONE"][0]["VALUE"], "+7 843 212-48-90");
        assert_eq!(f["EMAIL"][0]["VALUE"], "info@lavanda.ru");
        assert_eq!(f["WEB"][0]["VALUE"], "https://lavanda.ru");
        assert_eq!(f["ADDRESS_CITY"], "Казань");
        assert!(f["COMMENTS"].as_str().unwrap().contains("Заметка: позвонить"));
    }

    #[test]
    fn bitrix_responses() {
        assert_eq!(Bitrix24::parse(br#"{"result":123}"#, 200).unwrap(), json!(123));
        assert_eq!(Bitrix24::parse(br#"{"error":"QUERY_LIMIT_EXCEEDED"}"#, 503).unwrap_err(), CrmError::RateLimited);
        assert!(matches!(Bitrix24::parse(br#"{"error":"INVALID_CREDENTIALS","error_description":"x"}"#, 401), Err(CrmError::Unauthorized(_))));
        assert!(matches!(Bitrix24::parse(br#"{"error":"insufficient_scope"}"#, 403), Err(CrmError::Forbidden(_))));
        assert!(matches!(Bitrix24::parse(b"", 404), Err(CrmError::NotFound(_))));
        assert!(matches!(Bitrix24::parse(b"{}", 200), Err(CrmError::BadResponse(_))));
    }

    #[tokio::test]
    async fn exporter_skips_sent_retries_rate_limit_and_stops_on_auth() {
        let dest = Bitrix24::new("https://p.bitrix24.ru/rest/1/abc/").unwrap();
        let t = FakeTransport::new(vec![ok(r#"{"result":11}"#), Ok(HttpResponse::new(200, r#"{"error":"QUERY_LIMIT_EXCEEDED"}"#)), ok(r#"{"result":12}"#)]);
        let items = vec![item("a", "A"), item("b", "B"), item("c", "C")];
        let mut ledger = ExportLedger::default();
        ledger.sent.insert("c".into(), "99".into());
        let (rep, ledger) = run_export(&items, &dest, ledger, false, t.as_ref(), &no_sleep(), &CancellationToken::new(), &|_, _| {}).await;
        assert_eq!((rep.exported, rep.skipped, rep.failures.len()), (2, 1, 0));
        assert_eq!(ledger.sent["a"], "11");
        assert_eq!(ledger.sent["b"], "12");
        assert_eq!(rep.summary(), "Отправлено: 2, пропущено как уже отправленные: 1");
        let t = FakeTransport::new(vec![ok(r#"{"error":"INVALID_CREDENTIALS"}"#), ok(r#"{"result":1}"#)]);
        let (rep, _) = run_export(&items, &dest, ExportLedger::default(), false, t.as_ref(), &no_sleep(), &CancellationToken::new(), &|_, _| {}).await;
        assert!(rep.stopped_early);
        assert_eq!((rep.exported, rep.failures.len()), (0, 1));
        assert_eq!(t.urls().len(), 1);
    }

    #[tokio::test]
    async fn resend_ignores_ledger() {
        let dest = WebhookDestination::new("https://hook.example/abc").unwrap();
        let t = FakeTransport::new(vec![ok(r#"{"id":"r1"}"#)]);
        let mut ledger = ExportLedger::default();
        ledger.sent.insert("a".into(), "old".into());
        let (rep, ledger) = run_export(&[item("a", "A")], &dest, ledger, true, t.as_ref(), &no_sleep(), &CancellationToken::new(), &|_, _| {}).await;
        assert_eq!(rep.exported, 1);
        assert_eq!(ledger.sent["a"], "r1");
    }

    #[test]
    fn ledger_key_hides_webhook_secret_and_roundtrips() {
        let k = ExportLedger::storage_key(CrmKind::Webhook, "https://hook.example/SECRET-123");
        assert!(k.starts_with("export.ledger.webhook.") && !k.contains("SECRET"));
        assert_eq!(k, ExportLedger::storage_key(CrmKind::Webhook, "HTTPS://HOOK.example/secret-123"));
        assert_eq!(fnv1a(""), "cbf29ce484222325");
        assert_eq!(fnv1a("a"), "af63dc4c8601ec8c");
        let mut l = ExportLedger::default();
        l.sent.insert("x".into(), "1".into());
        assert_eq!(ExportLedger::decode(Some(&l.encoded())), l);
        assert_eq!(ExportLedger::decode(Some("мусор")), ExportLedger::default());
    }

    #[test]
    fn notion_database_id_extraction() {
        let want = "01234567-89ab-cdef-0123-456789abcdef";
        for s in ["https://www.notion.so/ws/Leads-0123456789abcdef0123456789abcdef?v=abc", "0123456789ABCDEF0123456789abcdef", want] {
            assert_eq!(NotionDestination::database_id_from(s).unwrap(), want, "{s}");
        }
        assert!(NotionDestination::database_id_from("https://notion.so/short").is_err());
    }

    fn props() -> Vec<NotionProperty> {
        [
            ("Название", "title"),
            ("Телефон", "phone_number"),
            ("Сайт", "url"),
            ("Оценка", "number"),
            ("Теги", "multi_select"),
            ("Избранное", "checkbox"),
            ("Дата", "date"),
            ("Формула", "formula"),
        ]
        .iter()
        .map(|(n, t)| NotionProperty { name: n.to_string(), kind: t.to_string() })
        .collect()
    }

    #[test]
    fn notion_auto_mapping_and_values() {
        let m = NotionDestination::auto_mapping(&props());
        assert_eq!(m["Название"], ExportField::Title);
        assert_eq!(m["Телефон"], ExportField::Phone);
        assert_eq!(m["Сайт"], ExportField::Website);
        assert_eq!(m["Оценка"], ExportField::Score);
        assert_eq!(m["Дата"], ExportField::DiscoveredAt);
        assert!(!m.contains_key("Формула"));
        let it = item("a", "Лаванда");
        assert_eq!(NotionDestination::value(ExportField::Score, &it, "number"), Some(json!({"number": 71.0})));
        assert_eq!(NotionDestination::value(ExportField::Favorite, &it, "checkbox"), Some(json!({"checkbox": true})));
        assert_eq!(NotionDestination::value(ExportField::Emails, &it, "email"), Some(json!({"email": "info@lavanda.ru"})));
        assert_eq!(NotionDestination::value(ExportField::Phone, &it, "url"), Some(json!({"url": "tel:+78432124890"})));
        assert_eq!(NotionDestination::value(ExportField::Budget, &it, "number"), None);
        assert_eq!(NotionDestination::value(ExportField::Title, &it, "formula"), None);
        assert_eq!(NotionDestination::value(ExportField::Reasons, &it, "multi_select"), Some(json!({"multi_select": [{"name": "нет сайта"}]})));
    }

    #[test]
    fn notion_page_body_splits_long_text_and_skips_unmapped() {
        let dest = NotionDestination::new(" tok ", "db-id", props(), NotionDestination::auto_mapping(&props()));
        assert_eq!(dest.token, "tok");
        let mut it = item("a", "Лаванда");
        it.data.description = "я".repeat(4500);
        let body = dest.page_body(&it);
        assert_eq!(body["parent"]["database_id"], "db-id");
        assert_eq!(body["properties"]["Название"]["title"][0]["text"]["content"], "Лаванда");
        assert!(body["properties"].get("Формула").is_none());
        let children = body["children"].as_array().unwrap();
        assert_eq!(children.len(), 3);
        assert!(children.iter().all(|c| c["paragraph"]["rich_text"][0]["text"]["content"].as_str().unwrap().chars().count() <= 2000));
    }

    #[test]
    fn notion_errors_and_database_parsing() {
        assert!(matches!(NotionDestination::check(br#"{"object":"error","code":"unauthorized"}"#, 401), Err(CrmError::Unauthorized(_))));
        assert!(matches!(NotionDestination::check(br#"{"object":"error","code":"object_not_found"}"#, 404), Err(CrmError::NotFound(_))));
        assert_eq!(NotionDestination::check(b"{}", 429).unwrap_err(), CrmError::RateLimited);
        assert_eq!(
            NotionDestination::check(br#"{"object":"error","code":"validation_error","message":"bad"}"#, 400).unwrap_err().to_string(),
            "Ошибка 400: Notion отклонил данные: bad. Проверьте сопоставление полей."
        );
        let obj =
            parse_object(r#"{"title":[{"plain_text":"Лиды"}],"properties":{"b":{"type":"number"},"Имя":{"type":"title"},"a":{"type":"url"}}}"#.as_bytes())
                .unwrap();
        let db = NotionDestination::parse_database(&obj, "id").unwrap();
        assert_eq!(db.title, "Лиды");
        assert_eq!(db.properties.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["Имя", "a", "b"]);
    }

    #[tokio::test]
    async fn webhook_sends_payload_and_maps_statuses() {
        assert!(WebhookDestination::new("http://x.example/a").is_err());
        assert!(WebhookDestination::new("https://hook.example/a").is_ok());
        let dest = WebhookDestination::new("https://hook.example/a").unwrap();
        let t = FakeTransport::new(vec![Ok(HttpResponse::new(200, "ok")), Ok(HttpResponse::new(404, "")), Ok(HttpResponse::new(500, " упало "))]);
        let it = item("a", "Лаванда");
        assert_eq!(dest.send(&it, t.as_ref()).await.unwrap(), "a");
        let sent: Value = serde_json::from_slice(t.requests.lock().unwrap()[0].body.as_ref().unwrap()).unwrap();
        assert_eq!(sent["event"], "lead.exported");
        assert_eq!(sent["lead"]["title"], "Лаванда");
        assert_eq!(sent["lead"]["phones"][0], "+7 843 212-48-90");
        assert_eq!(sent["lead"]["favorite"], true);
        assert!(t.requests.lock().unwrap()[0].headers.iter().any(|h| h.0 == "X-LeadGen-Lead-Id" && h.1 == "a"));
        assert!(matches!(dest.send(&it, t.as_ref()).await, Err(CrmError::NotFound(_))));
        assert_eq!(dest.send(&it, t.as_ref()).await.unwrap_err(), CrmError::Server(500, "упало".into()));
    }

    #[tokio::test]
    async fn network_failure_stops_export() {
        let dest = WebhookDestination::new("https://hook.example/a").unwrap();
        let t = FakeTransport::new(vec![]);
        let (rep, _) = run_export(
            &[item("a", "A"), item("b", "B")],
            &dest,
            ExportLedger::default(),
            false,
            t.as_ref(),
            &no_sleep(),
            &CancellationToken::new(),
            &|_, _| {},
        )
        .await;
        assert!(rep.stopped_early);
        assert_eq!(rep.failures.len(), 1);
    }
}
