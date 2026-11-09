//! Настройки поиска. Хранятся в базе пользователя как JSON и синхронизируются через облако, поэтому
//! имена полей совпадают с теми, что писали версии для macOS и Windows. Недостающие поля берутся по
//! умолчанию: новые настройки не сбрасывают сохранённые.

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const RSS: &str = "fl_ru";
pub const TELEGRAM: &str = "telegram_channels";
pub const VK: &str = "vk_communities";
pub const OSM: &str = "osm_organizations";
pub const ALL_SOURCES: [&str; 4] = [RSS, TELEGRAM, VK, OSM];

pub const ORDER_KEYWORDS: &[&str] = &[
    "сайт",
    "бот",
    "приложени",
    "разработ",
    "программист",
    "автоматизац",
    "crm",
    "срм",
    "парсер",
    "интеграц",
    "лендинг",
    "верстк",
    "доработ",
    "интернет-магазин",
    "telegram",
    "телеграм",
    "python",
    "api",
];

fn strings(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FeedSourceSettings {
    pub enabled: bool,
    pub interval_hours: f64,
    pub feeds: Vec<String>,
    /// Пусто — в оценку идут все записи.
    pub keywords: Vec<String>,
}

impl Default for FeedSourceSettings {
    fn default() -> Self {
        Self { enabled: true, interval_hours: 2.0, feeds: strings(&["https://www.fl.ru/rss/all.xml"]), keywords: vec![] }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TelegramSourceSettings {
    pub enabled: bool,
    pub interval_hours: f64,
    pub channels: Vec<String>,
    pub max_pages: u32,
    pub keywords: Vec<String>,
}

impl Default for TelegramSourceSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            interval_hours: 3.0,
            channels: strings(&["teleworko", "vacanciesbest", "freetasks", "theyseeku"]),
            max_pages: 3,
            keywords: strings(ORDER_KEYWORDS),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VkSourceSettings {
    pub enabled: bool,
    pub interval_hours: f64,
    pub communities: Vec<String>,
    pub page_size: u32,
    pub max_pages: u32,
    pub keywords: Vec<String>,
}

impl Default for VkSourceSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            interval_hours: 3.0,
            communities: vec![],
            page_size: 50,
            max_pages: 2,
            keywords: strings(&["сайт", "бот", "приложени", "разработ", "программист", "автоматизац", "crm", "парсер", "интеграц"]),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsmCategory {
    pub key: String,
    pub label: String,
    pub group: String,
    pub filters: Vec<String>,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default = "ten")]
    pub weight: f64,
}

fn yes() -> bool {
    true
}
fn ten() -> f64 {
    10.0
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogFile {
    categories: Vec<OsmCategory>,
    group_titles: BTreeMap<String, String>,
}

/// Единый каталог категорий OpenStreetMap (data/osm_catalog.json). Его читает и интерфейс.
static CATALOG: Lazy<CatalogFile> = Lazy::new(|| serde_json::from_str(include_str!("../../data/osm_catalog.json")).expect("osm_catalog.json"));

pub fn osm_categories() -> Vec<OsmCategory> {
    CATALOG.categories.clone()
}

pub fn osm_group_titles() -> BTreeMap<String, String> {
    CATALOG.group_titles.clone()
}

/// Сохранённые категории пользователя плюс новые из каталога (выключенные): выбор пользователя не меняется.
pub fn merge_categories(stored: Vec<OsmCategory>) -> Vec<OsmCategory> {
    let known: std::collections::HashSet<String> = stored.iter().map(|c| c.key.clone()).collect();
    let mut out = stored;
    out.extend(CATALOG.categories.iter().filter(|c| !known.contains(&c.key)).cloned());
    out
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct OsmSourceSettings {
    pub enabled: bool,
    pub interval_hours: f64,
    pub regions: Vec<String>,
    pub categories: Vec<OsmCategory>,
    pub check_websites: bool,
    /// Одинаковый запрос регион × категория не чаще, чем раз в N дней.
    pub refresh_days: f64,
    /// Повторная проверка уже известной организации.
    pub recheck_days: f64,
    pub max_new_per_run: u32,
    pub endpoint: String,
}

impl Default for OsmSourceSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            interval_hours: 120.0,
            regions: strings(&["Ереван"]),
            categories: osm_categories(),
            check_websites: true,
            refresh_days: 7.0,
            recheck_days: 60.0,
            max_new_per_run: 40,
            endpoint: "https://overpass-api.de/api/interpreter".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SearchSettings {
    pub rss: FeedSourceSettings,
    pub telegram: TelegramSourceSettings,
    pub vk: VkSourceSettings,
    pub osm: OsmSourceSettings,
}

impl SearchSettings {
    pub fn is_enabled(&self, key: &str) -> bool {
        match key {
            RSS => self.rss.enabled,
            TELEGRAM => self.telegram.enabled,
            VK => self.vk.enabled,
            OSM => self.osm.enabled,
            _ => false,
        }
    }

    pub fn interval_hours(&self, key: &str) -> f64 {
        match key {
            RSS => self.rss.interval_hours,
            TELEGRAM => self.telegram.interval_hours,
            VK => self.vk.interval_hours,
            OSM => self.osm.interval_hours,
            _ => 24.0,
        }
    }

    /// Настройки нового пользователя: регионы, каналы и слова пустые, их выбирает сам человек.
    pub fn blank_start() -> Self {
        let mut s = Self::default();
        s.osm.regions.clear();
        s.telegram.channels.clear();
        s.telegram.keywords.clear();
        s
    }

    /// Сохранённые настройки, а для нового пользователя (в базе ничего нет) пустой старт.
    pub fn stored(json: Option<&str>) -> Self {
        match json {
            Some(j) if !j.is_empty() => Self::decode(j),
            _ => Self::blank_start(),
        }
    }

    pub fn decode(json: &str) -> Self {
        let mut s: SearchSettings = serde_json::from_str(json).unwrap_or_default();
        s.osm.categories = merge_categories(std::mem::take(&mut s.osm.categories));
        s
    }

    pub fn encoded(&self) -> String {
        crate::cloud::types::canonical_json(&serde_json::to_value(self).unwrap_or_default())
    }
}

/// Секреты, которые нужны источникам. Хранит их приложение (защищённое хранилище), а не настройки.
#[derive(Debug, Clone, Default)]
pub struct SearchSecrets {
    pub vk_token: Option<String>,
}

pub fn source_problem(key: &str, s: &SearchSettings, secrets: &SearchSecrets) -> Option<String> {
    match key {
        RSS => s.rss.feeds.is_empty().then(|| "не добавлено ни одной ленты".to_string()),
        TELEGRAM => s.telegram.channels.is_empty().then(|| "не добавлено ни одного канала".to_string()),
        VK => {
            if secrets.vk_token.as_deref().unwrap_or("").is_empty() {
                Some("нет сервисного ключа VK".into())
            } else {
                s.vk.communities.is_empty().then(|| "не добавлено ни одного сообщества".to_string())
            }
        }
        OSM => {
            if s.osm.regions.is_empty() {
                Some("не добавлено ни одного региона".into())
            } else if s.osm.categories.iter().any(|c| c.enabled) {
                None
            } else {
                Some("не выбрано ни одной категории".into())
            }
        }
        _ => Some("неизвестный источник".into()),
    }
}

/// Приведение того, что вводит пользователь, к виду, который понимает источник.
pub mod input {
    use once_cell::sync::Lazy;
    use regex::Regex;

    static CHANNEL_RX: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z][A-Za-z0-9_]{3,31}$").unwrap());
    static VK_RX: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z0-9_.]{2,64}$").unwrap());

    fn strip_prefixes(mut s: String, prefixes: &[&str]) -> String {
        for p in prefixes {
            if s.to_lowercase().starts_with(p) {
                s = s[p.len()..].to_string();
            }
        }
        s
    }

    fn head(s: String) -> String {
        let s = s.strip_prefix('@').map(str::to_string).unwrap_or(s);
        match s.find(['/', '?']) {
            Some(i) => s[..i].to_string(),
            None => s,
        }
    }

    /// «@name», «t.me/name», «https://t.me/s/name» → «name».
    pub fn telegram_channel(raw: &str) -> Option<String> {
        let s = strip_prefixes(raw.trim().to_string(), &["https://", "http://"]);
        let s = strip_prefixes(s, &["www.", "t.me/s/", "t.me/", "telegram.me/"]);
        let s = head(s);
        CHANNEL_RX.is_match(&s).then_some(s)
    }

    /// «https://vk.com/name» → «name».
    pub fn vk_community(raw: &str) -> Option<String> {
        let s = strip_prefixes(raw.trim().to_string(), &["https://", "http://"]);
        let s = strip_prefixes(s, &["www.", "m.vk.com/", "vk.com/", "vk.ru/"]);
        let s = head(s);
        VK_RX.is_match(&s).then_some(s)
    }

    /// Адрес ленты: только публичный http(s).
    pub fn feed_url(raw: &str) -> Option<String> {
        let mut s = raw.trim().to_string();
        let low = s.to_lowercase();
        if !low.starts_with("http://") && !low.starts_with("https://") {
            s = format!("https://{s}");
        }
        crate::search::sources::is_public_http_url(&s).then_some(s)
    }

    pub fn keyword(raw: &str) -> Option<String> {
        let s = raw.trim().to_lowercase();
        (!s.is_empty()).then_some(s)
    }

    pub fn region(raw: &str) -> Option<String> {
        let s = raw.trim().replace('"', "");
        (!s.is_empty()).then_some(s)
    }

    /// Разбивает ввод на элементы: по запятым, точкам с запятой и строкам.
    pub fn split(text: &str) -> Vec<String> {
        text.split([',', ';', '\n', '\r', '\t']).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_has_original_eight_first() {
        let cats = osm_categories();
        assert!(cats.len() >= 40);
        let keys: Vec<&str> = cats.iter().take(8).map(|c| c.key.as_str()).collect();
        assert_eq!(keys, ["beauty", "dance", "restaurant", "cafe", "education", "medical", "fitness", "shops"]);
        assert!(cats.iter().take(8).all(|c| c.enabled));
        assert!(!cats.iter().skip(8).any(|c| c.enabled));
    }

    #[test]
    fn decode_keeps_user_choice_and_adds_new_categories() {
        let json = r#"{"osm":{"regions":["Тбилиси"],"categories":[{"key":"beauty","label":"Салоны","group":"beauty","filters":["[\"shop\"=\"beauty\"]"],"enabled":false,"weight":5}]}}"#;
        let s = SearchSettings::decode(json);
        assert_eq!(s.osm.regions, ["Тбилиси"]);
        assert!(!s.osm.categories[0].enabled);
        assert_eq!(s.osm.categories[0].weight, 5.0);
        assert!(s.osm.categories.len() > 40);
        assert_eq!(s.rss.feeds, ["https://www.fl.ru/rss/all.xml"]);
    }

    #[test]
    fn stored_blank_start_for_new_user() {
        let s = SearchSettings::stored(None);
        assert!(s.osm.regions.is_empty() && s.telegram.channels.is_empty() && s.telegram.keywords.is_empty());
        assert!(!SearchSettings::stored(Some("{}")).osm.regions.is_empty());
    }

    #[test]
    fn encoded_roundtrip_and_integer_numbers() {
        let s = SearchSettings::default();
        let text = s.encoded();
        assert!(text.contains("\"intervalHours\":2,") || text.contains("\"intervalHours\":2}"), "{text}");
        assert_eq!(SearchSettings::decode(&text), s);
    }

    #[test]
    fn input_normalizers() {
        assert_eq!(input::telegram_channel("https://t.me/s/free_tasks?before=5").as_deref(), Some("free_tasks"));
        assert_eq!(input::telegram_channel("@teleworko").as_deref(), Some("teleworko"));
        assert_eq!(input::telegram_channel("ab"), None);
        assert_eq!(input::vk_community("https://vk.com/some.club/wall").as_deref(), Some("some.club"));
        assert_eq!(input::feed_url("example.com/rss").as_deref(), Some("https://example.com/rss"));
        assert_eq!(input::feed_url("http://192.168.1.1/rss"), None);
        assert_eq!(input::split("a, b;c\nd"), ["a", "b", "c", "d"]);
        assert_eq!(input::region(" \"Ереван\" ").as_deref(), Some("Ереван"));
    }

    #[test]
    fn problems() {
        let secrets = SearchSecrets::default();
        let mut s = SearchSettings::default();
        assert_eq!(source_problem(VK, &s, &secrets).as_deref(), Some("нет сервисного ключа VK"));
        s.osm.regions.clear();
        assert!(source_problem(OSM, &s, &secrets).is_some());
        assert!(source_problem(RSS, &s, &secrets).is_none());
    }
}
