//! Общие мелочи: даты в формате Python/Swift, нормализация значений, каталог источников, версии.

use chrono::{DateTime, NaiveDateTime, SecondsFormat, TimeZone, Utc};
use std::cmp::Ordering;

// ---------------------------------------------------------------- даты

/// Разбор даты `datetime.isoformat()` Python и ISO 8601 Swift/C#: «2026-11-05T09:42:00+00:00»,
/// «…Z», с долями секунды и без часового пояса (тогда UTC).
pub fn parse_date(s: &str) -> Option<DateTime<Utc>> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(d) = DateTime::parse_from_rfc3339(s) {
        return Some(d.with_timezone(&Utc));
    }
    for fmt in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S"] {
        if let Ok(n) = NaiveDateTime::parse_from_str(s, fmt) {
            return Some(Utc.from_utc_datetime(&n));
        }
    }
    // «+0000» без двоеточия.
    for fmt in ["%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S%.f%z", "%a, %d %b %Y %H:%M:%S %z", "%d %b %Y %H:%M:%S %z", "%a, %d %b %Y %H:%M %z"] {
        if let Ok(d) = DateTime::parse_from_str(s, fmt) {
            return Some(d.with_timezone(&Utc));
        }
    }
    if let Ok(d) = DateTime::parse_from_rfc2822(s) {
        return Some(d.with_timezone(&Utc));
    }
    // RFC 822 с названием пояса (GMT, UTC, MSK не поддерживаем — только GMT/UTC/UT/Z).
    let trimmed = s.trim_end_matches(" GMT").trim_end_matches(" UTC").trim_end_matches(" UT");
    if trimmed.len() != s.len() {
        for fmt in ["%a, %d %b %Y %H:%M:%S", "%d %b %Y %H:%M:%S", "%a, %d %b %Y %H:%M"] {
            if let Ok(n) = NaiveDateTime::parse_from_str(trimmed, fmt) {
                return Some(Utc.from_utc_datetime(&n));
            }
        }
    }
    None
}

/// Формат Swift `ISO8601DateFormatter`: «2026-11-05T09:42:00Z».
pub fn format_date(d: &DateTime<Utc>) -> String {
    d.to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// С миллисекундами — для журнала синхронизации, где два изменения в одну секунду должны различаться.
pub fn format_precise(d: &DateTime<Utc>) -> String {
    d.to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn now_string() -> String {
    format_date(&Utc::now())
}

pub fn now_precise() -> String {
    format_precise(&Utc::now())
}

// ---------------------------------------------------------------- нормализация

pub mod normalize {


    pub fn domain(raw: &str) -> String {
        let mut s = raw.trim().to_lowercase();
        for p in ["https://", "http://"] {
            if let Some(rest) = s.strip_prefix(p) {
                s = rest.to_string();
            }
        }
        if let Some(rest) = s.strip_prefix("www.") {
            s = rest.to_string();
        }
        if let Some(i) = s.find(['/', '?', '#']) {
            s.truncate(i);
        }
        s
    }

    /// Последние 10 цифр телефона: +7 (843) 212-48-90 и 8 843 2124890 совпадают.
    pub fn phone(raw: &str) -> String {
        let digits: Vec<char> = raw.chars().filter(|c| c.is_numeric()).collect();
        let start = digits.len().saturating_sub(10);
        digits[start..].iter().collect()
    }

    pub fn email(raw: &str) -> String {
        raw.trim().to_lowercase()
    }

    /// Название без кавычек, регистра, «ё» и лишних пробелов.
    pub fn name(raw: &str) -> String {
        let lowered = raw.to_lowercase().replace('ё', "е");
        let cleaned: String = lowered.chars().map(|c| if c.is_alphanumeric() { c } else { ' ' }).collect();
        cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    pub fn value(raw: &str, kind: crate::models::ExclusionKind) -> String {
        use crate::models::ExclusionKind::*;
        match kind {
            Domain => domain(raw),
            Phone => phone(raw),
            Email => email(raw),
            Name => name(raw),
        }
    }
}

// ---------------------------------------------------------------- каталог источников

pub struct SourceInfo {
    pub key: &'static str,
    pub title: &'static str,
    pub access: &'static str,
    pub note: &'static str,
}

pub const KNOWN_SOURCES: &[SourceInfo] = &[
    SourceInfo { key: "fl_ru", title: "RSS-ленты", access: "Бесплатно", note: "Любые публичные RSS- и Atom-ленты заказов, например FL.ru. Ленты хранят только последние записи." },
    SourceInfo { key: "telegram_channels", title: "Telegram-каналы", access: "Бесплатно", note: "Только публичные каналы с веб-превью t.me/s. Bot API чужие каналы не читает." },
    SourceInfo { key: "vk_communities", title: "VK-сообщества", access: "Бесплатный ключ", note: "Нужен бесплатный сервисный ключ VK (dev.vk.com). Читаются стены выбранных сообществ." },
    SourceInfo { key: "osm_organizations", title: "OpenStreetMap", access: "Бесплатно", note: "Overpass API, данные ODbL (© участники OpenStreetMap). Полнота в РФ ниже, чем у Яндекса и 2ГИС." },
    SourceInfo { key: "site_checker", title: "Проверка сайтов", access: "Бесплатно", note: "Один запрос к главной странице: доступность, HTTPS, мобильная вёрстка, год, онлайн-запись." },
];

/// Источники, которые сознательно не подключены, с причиной.
pub const UNAVAILABLE_SOURCES: &[(&str, &str)] = &[
    ("Яндекс Карты", "Бесплатные условия запрещают сохранять данные."),
    ("2ГИС", "Бесплатно только демо-ключ на 1 месяц."),
    ("Поисковые системы", "Официальные API платные или закрыты для новых клиентов."),
    ("Kwork, Habr Freelance", "Нет API и RSS, robots.txt запрещает автоматический сбор."),
];

pub fn source_title(key: &str) -> String {
    if let Some(i) = KNOWN_SOURCES.iter().find(|i| i.key == key) {
        return i.title.to_string();
    }
    if key == "import" {
        return "Импорт".into();
    }
    key.to_string()
}

// ---------------------------------------------------------------- версии

/// Номер версии вида 1.0.4 (тег v1.0.4 тоже понимается), до четырёх частей.
#[derive(Debug, Clone, Eq)]
pub struct AppVersion(pub Vec<u32>);

impl PartialEq for AppVersion {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl AppVersion {
    pub fn parse(text: &str) -> Option<Self> {
        let mut s = text.trim();
        if let Some(r) = s.strip_prefix('v').or_else(|| s.strip_prefix('V')) {
            s = r;
        }
        // «1.0.4-beta» → 1.0.4: суффиксы предварительных версий не учитываются.
        if let Some(i) = s.find(['-', '+', ' ']) {
            s = &s[..i];
        }
        let parts: Vec<&str> = s.split('.').collect();
        if parts.is_empty() || parts.len() > 4 {
            return None;
        }
        let mut nums = Vec::new();
        for p in parts {
            if p.is_empty() || !p.chars().all(|c| c.is_ascii_digit()) {
                return None;
            }
            nums.push(p.parse().ok()?);
        }
        Some(AppVersion(nums))
    }
}

impl PartialOrd for AppVersion {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for AppVersion {
    fn cmp(&self, other: &Self) -> Ordering {
        let n = self.0.len().max(other.0.len());
        for i in 0..n {
            let a = self.0.get(i).copied().unwrap_or(0);
            let b = other.0.get(i).copied().unwrap_or(0);
            if a != b {
                return a.cmp(&b);
            }
        }
        Ordering::Equal
    }
}

impl std::fmt::Display for AppVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s: Vec<String> = self.0.iter().map(|x| x.to_string()).collect();
        write!(f, "{}", s.join("."))
    }
}

// ---------------------------------------------------------------- прочее

pub trait NilIfEmpty {
    fn nil_if_empty(&self) -> Option<String>;
}

impl NilIfEmpty for str {
    fn nil_if_empty(&self) -> Option<String> {
        let t = self.trim();
        if t.is_empty() { None } else { Some(t.to_string()) }
    }
}

impl NilIfEmpty for Option<String> {
    fn nil_if_empty(&self) -> Option<String> {
        self.as_deref().and_then(|s| s.nil_if_empty())
    }
}

/// Первые `n` символов (не байтов).
pub fn prefix_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Первые 24 символа SHA-256 в hex — так же, как в Python-версии.
pub fn short_hash(s: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(s.as_bytes());
    hex::encode(digest)[..24].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_parse_python_and_swift_formats() {
        let a = parse_date("2026-11-05T09:42:00+00:00").unwrap();
        let b = parse_date("2026-11-05T09:42:00Z").unwrap();
        let c = parse_date("2026-11-05T09:42:00.123456+00:00").unwrap();
        let d = parse_date("2026-11-05T09:42:00").unwrap();
        assert_eq!(a, b);
        assert_eq!(a, d);
        assert_eq!(c.timestamp(), a.timestamp());
        assert!(parse_date("").is_none());
        assert!(parse_date("вчера").is_none());
        assert_eq!(format_date(&a), "2026-11-05T09:42:00Z");
    }

    #[test]
    fn normalization_matches_reference() {
        assert_eq!(normalize::domain("https://www.Example.ru/path?x=1"), "example.ru");
        assert_eq!(normalize::phone("+7 (843) 212-48-90"), "8432124890");
        assert_eq!(normalize::phone("8 843 2124890"), "8432124890");
        assert_eq!(normalize::name("ООО «Ёлка», 24"), "ооо елка 24");
        assert_eq!(normalize::email("  A@B.RU "), "a@b.ru");
    }

    #[test]
    fn versions_compare_with_missing_parts() {
        let v = |s| AppVersion::parse(s).unwrap();
        assert!(v("1.0.9") < v("1.0.10"));
        assert!(v("1.0.9") < v("1.0.9.1"));
        assert_eq!(v("v1.2"), v("1.2.0"));
        assert_eq!(v("1.0.4-beta").to_string(), "1.0.4");
        assert!(AppVersion::parse("1.x").is_none());
        assert!(AppVersion::parse("1.2.3.4.5").is_none());
        assert!(AppVersion::parse("").is_none());
    }

    #[test]
    fn short_hash_is_24_hex() {
        let h = short_hash("fl_ru|abc");
        assert_eq!(h.len(), 24);
        assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
