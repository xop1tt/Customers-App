//! Модели данных. JSON лида совместим с Python-версией (`Lead.to_json`) и с базами macOS/Windows,
//! поэтому разбор намеренно мягкий: неверный тип поля не отбрасывает весь лид.

use crate::util::{format_date, normalize, parse_date};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LeadKind {
    Order,
    Organization,
}

impl LeadKind {
    pub fn as_str(self) -> &'static str {
        match self {
            LeadKind::Order => "order",
            LeadKind::Organization => "organization",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "order" => Some(LeadKind::Order),
            "organization" => Some(LeadKind::Organization),
            _ => None,
        }
    }
    pub fn title(self) -> &'static str {
        match self {
            LeadKind::Order => "Заказ",
            LeadKind::Organization => "Организация",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Relevance {
    High,
    Medium,
    Low,
    Rejected,
}

impl Relevance {
    pub fn as_str(self) -> &'static str {
        match self {
            Relevance::High => "high",
            Relevance::Medium => "medium",
            Relevance::Low => "low",
            Relevance::Rejected => "rejected",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "high" => Some(Relevance::High),
            "medium" => Some(Relevance::Medium),
            "low" => Some(Relevance::Low),
            "rejected" => Some(Relevance::Rejected),
            _ => None,
        }
    }
    pub fn title(self) -> &'static str {
        match self {
            Relevance::High => "Высокая",
            Relevance::Medium => "Средняя",
            Relevance::Low => "Низкая",
            Relevance::Rejected => "Не подходит",
        }
    }
    pub fn rank(self) -> i32 {
        match self {
            Relevance::High => 3,
            Relevance::Medium => 2,
            Relevance::Low => 1,
            Relevance::Rejected => 0,
        }
    }
}

/// Результат внешнего анализатора. Хранится отдельно от исходных данных.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExternalResult {
    pub service: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub processed_at: Option<String>,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub score: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LeadData {
    pub kind: LeadKind,
    pub source: String,
    pub external_id: String,
    pub title: String,
    pub url: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub discovered_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub budget: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    pub contacts: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub customer_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub website: Option<String>,
    pub facts: Vec<String>,
    pub assumptions: Vec<String>,
    pub score: f64,
    pub relevance: Relevance,
    pub score_reasons: Vec<String>,
    pub status: String,
    pub external_results: Vec<ExternalResult>,
}

impl LeadData {
    pub fn new(kind: LeadKind, source: &str, external_id: &str, title: &str) -> Self {
        LeadData {
            kind,
            source: source.into(),
            external_id: external_id.into(),
            title: title.into(),
            url: String::new(),
            description: String::new(),
            published_at: None,
            discovered_at: None,
            budget: None,
            currency: None,
            region: None,
            contacts: BTreeMap::new(),
            category: None,
            project_type: None,
            customer_name: None,
            address: None,
            phone: None,
            website: None,
            facts: vec![],
            assumptions: vec![],
            score: 0.0,
            relevance: Relevance::Rejected,
            score_reasons: vec![],
            status: "new".into(),
            external_results: vec![],
        }
    }

    pub fn is_organization(&self) -> bool {
        self.kind == LeadKind::Organization
    }

    /// Мягкий разбор: каждое поле читается отдельно, ошибка типа даёт значение по умолчанию.
    pub fn from_value(v: &Value) -> Self {
        let o = v.as_object().cloned().unwrap_or_default();
        let s = |k: &str| o.get(k).and_then(Value::as_str).map(str::to_string);
        let date = |k: &str| o.get(k).and_then(Value::as_str).and_then(parse_date);
        let strs = |k: &str| -> Vec<String> {
            o.get(k)
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                .unwrap_or_default()
        };
        let mut d = LeadData::new(
            s("kind").and_then(|k| LeadKind::parse(&k)).unwrap_or(LeadKind::Order),
            &s("source").unwrap_or_default(),
            &s("external_id").unwrap_or_default(),
            &s("title").unwrap_or_default(),
        );
        d.url = s("url").unwrap_or_default();
        d.description = s("description").unwrap_or_default();
        d.published_at = date("published_at");
        d.discovered_at = date("discovered_at");
        d.budget = o.get("budget").and_then(Value::as_f64);
        d.currency = s("currency");
        d.region = s("region");
        d.contacts = o
            .get("contacts")
            .and_then(Value::as_object)
            .map(|m| m.iter().filter_map(|(k, v)| v.as_str().map(|x| (k.clone(), x.to_string()))).collect())
            .unwrap_or_default();
        d.category = s("category");
        d.project_type = s("project_type");
        d.customer_name = s("customer_name");
        d.address = s("address");
        d.phone = s("phone");
        d.website = s("website");
        d.facts = strs("facts");
        d.assumptions = strs("assumptions");
        d.score = o.get("score").and_then(Value::as_f64).unwrap_or(0.0);
        d.relevance = s("relevance").and_then(|r| Relevance::parse(&r)).unwrap_or(Relevance::Rejected);
        d.score_reasons = strs("score_reasons");
        d.status = s("status").unwrap_or_else(|| "new".into());
        d.external_results = o
            .get("external_results")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|x| serde_json::from_value(x.clone()).ok()).collect())
            .unwrap_or_default();
        d
    }

    pub fn parse_json(text: &str) -> Option<Self> {
        serde_json::from_str::<Value>(text).ok().filter(Value::is_object).map(|v| Self::from_value(&v))
    }

    /// Значение JSON с датами в формате `2026-11-05T09:42:00Z` (без долей секунды).
    pub fn to_value(&self) -> Value {
        let mut v = serde_json::to_value(self).unwrap_or(Value::Null);
        if let Some(o) = v.as_object_mut() {
            for k in ["published_at", "discovered_at"] {
                if let Some(d) = match k {
                    "published_at" => self.published_at,
                    _ => self.discovered_at,
                } {
                    o.insert(k.into(), Value::String(format_date(&d)));
                }
            }
        }
        v
    }

    /// Домен сайта без протокола и www (для исключений и дедупликации).
    pub fn domain(&self) -> Option<String> {
        self.website.as_ref().filter(|w| !w.is_empty()).map(|w| normalize::domain(w))
    }

    /// Все email из контактов.
    pub fn emails(&self) -> Vec<String> {
        self.contacts.values().filter(|v| v.contains('@') && v.contains('.') && !v.starts_with('@')).cloned().collect()
    }

    /// Все телефоны: поле phone и контакты.
    pub fn phones(&self) -> Vec<String> {
        let mut out = Vec::new();
        if let Some(p) = &self.phone {
            if !p.is_empty() {
                out.push(p.clone());
            }
        }
        for (k, v) in &self.contacts {
            if (k.to_lowercase().contains("phone") || k.contains("тел")) && !out.contains(v) {
                out.push(v.clone());
            }
        }
        out
    }
}

/// Лид в локальной базе: данные конвейера + то, что пользователь сделал в приложении.
#[derive(Debug, Clone, PartialEq)]
pub struct LeadItem {
    pub id: String,
    pub data: LeadData,
    pub discovered_at: DateTime<Utc>,
    pub favorite: bool,
    pub archived: bool,
    pub excluded: bool,
    pub seen: bool,
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SourceState {
    pub source: String,
    pub last_success_at: Option<String>,
    pub last_attempt_at: Option<String>,
    pub consecutive_failures: i64,
    pub status: String,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PipelineError {
    pub id: i64,
    pub at: Option<String>,
    pub module: String,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExclusionKind {
    Domain,
    Phone,
    Email,
    Name,
}

impl ExclusionKind {
    pub const ALL: [ExclusionKind; 4] = [ExclusionKind::Domain, ExclusionKind::Phone, ExclusionKind::Email, ExclusionKind::Name];

    pub fn as_str(self) -> &'static str {
        match self {
            ExclusionKind::Domain => "domain",
            ExclusionKind::Phone => "phone",
            ExclusionKind::Email => "email",
            ExclusionKind::Name => "name",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.as_str() == s)
    }
    pub fn title(self) -> &'static str {
        match self {
            ExclusionKind::Domain => "Домен",
            ExclusionKind::Phone => "Телефон",
            ExclusionKind::Email => "Email",
            ExclusionKind::Name => "Название",
        }
    }

    /// Формат введённого значения по его виду: email, телефон (от 10 цифр), домен или адрес сайта.
    /// None — не похоже ни на одно из них (для ручного ввода это название организации).
    pub fn detect(raw: &str) -> Option<Self> {
        let v = raw.trim();
        if v.is_empty() {
            return None;
        }
        if v.contains('@') {
            return if v.contains(' ') { None } else { Some(ExclusionKind::Email) };
        }
        if v.chars().filter(|c| c.is_numeric()).count() >= 10 && v.chars().all(|c| c.is_numeric() || " +-()".contains(c)) {
            return Some(ExclusionKind::Phone);
        }
        if v.contains('.') && !v.contains(' ') && v.chars().any(char::is_alphabetic) {
            return Some(ExclusionKind::Domain);
        }
        None
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Exclusion {
    pub id: i64,
    pub kind: ExclusionKind,
    pub value: String,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SyncLogEntry {
    pub id: i64,
    pub at: Option<String>,
    pub ok: bool,
    pub added: i64,
    pub updated: i64,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LeadEvent {
    pub id: i64,
    pub at: Option<String>,
    pub action: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SaveOutcome {
    Added,
    Updated,
    Unchanged,
    Duplicate,
}

/// Представление лида для интерфейса: данные + пометки, плоским JSON.
pub fn lead_to_ui(l: &LeadItem) -> Value {
    let d = &l.data;
    json!({
        "id": l.id,
        "data": d.to_value(),
        "discoveredAt": format_date(&l.discovered_at),
        "favorite": l.favorite,
        "archived": l.archived,
        "excluded": l.excluded,
        "seen": l.seen,
        "note": l.note,
        "phones": d.phones(),
        "emails": d.emails(),
    })
}

pub fn empty_object() -> Map<String, Value> {
    Map::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lead_json_is_tolerant_and_roundtrips() {
        let v: Value = serde_json::from_str(
            r#"{"kind":"organization","source":"osm_organizations","external_id":"node/1","title":"Лаванда",
                "budget":"много","contacts":{"phone":"+7 843 000-00-00","bad":5},"relevance":"high","score":71.5,
                "published_at":"2026-11-05T09:42:00+00:00","facts":["a",1,"b"]}"#,
        )
        .unwrap();
        let d = LeadData::from_value(&v);
        assert_eq!(d.kind, LeadKind::Organization);
        assert_eq!(d.budget, None, "неверный тип поля не ломает лид");
        assert_eq!(d.contacts.len(), 1);
        assert_eq!(d.facts, vec!["a", "b"]);
        assert_eq!(d.relevance, Relevance::High);
        let out = d.to_value();
        assert_eq!(out["published_at"], "2026-11-05T09:42:00Z");
        assert_eq!(LeadData::from_value(&out), d);
    }

    #[test]
    fn exclusion_kind_detection() {
        use ExclusionKind::*;
        assert_eq!(ExclusionKind::detect("a@b.ru"), Some(Email));
        assert_eq!(ExclusionKind::detect("+7 (843) 212-48-90"), Some(Phone));
        assert_eq!(ExclusionKind::detect("https://www.example.ru/x"), Some(Domain));
        assert_eq!(ExclusionKind::detect("Студия Лаванда"), None);
        assert_eq!(ExclusionKind::detect("  "), None);
        assert_eq!(ExclusionKind::detect("a b@c.ru"), None);
    }

    #[test]
    fn phones_and_emails_come_from_contacts() {
        let mut d = LeadData::new(LeadKind::Order, "x", "1", "t");
        d.phone = Some("8 800 000-00-00".into());
        d.contacts.insert("phone".into(), "+7 843 000-00-00".into());
        d.contacts.insert("email".into(), "a@b.ru".into());
        d.contacts.insert("telegram".into(), "@name".into());
        assert_eq!(d.phones().len(), 2);
        assert_eq!(d.emails(), vec!["a@b.ru"]);
    }
}
