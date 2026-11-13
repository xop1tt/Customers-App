//! «Что нового?»: превращает описание релиза (то, что разработчик пишет для себя) в короткий список полезных
//! пользователю изменений для одной платформы, и решает, когда показывать экран после обновления.

use crate::updates::Platform;
use crate::util::AppVersion;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Тема группы изменений.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Topic {
    Interface,
    Search,
    Data,
    Updates,
    Power,
    Other,
}

impl Topic {
    pub const ALL: [Topic; 6] = [Topic::Interface, Topic::Search, Topic::Data, Topic::Updates, Topic::Power, Topic::Other];

    pub fn title(self) -> &'static str {
        match self {
            Topic::Interface => "Улучшили и доработали интерфейс",
            Topic::Search => "Стало удобнее искать лиды",
            Topic::Data => "Данные, облако и интеграции",
            Topic::Updates => "Запуск и обновления",
            Topic::Power => "Экономия энергии",
            Topic::Other => "Другие улучшения",
        }
    }
}

/// Что показывает анимированное превью рядом с группой изменений.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Preview {
    Sidebar,
    Settings,
    Adaptive,
    Exclusions,
    Categories,
    Power,
    Update,
    Cloud,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Feature {
    pub topic: Topic,
    pub title: &'static str,
    pub items: Vec<String>,
    pub preview: Option<Preview>,
}

pub const MAX_ITEMS_PER_TOPIC: usize = 4;
pub const MAX_ITEM_LENGTH: usize = 110;

static RE_BULLET: Lazy<Regex> = Lazy::new(|| Regex::new(r"^(?:[-*+•]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$").unwrap());
static RE_BOLD_LEAD: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\*\*(.+?)\*\*(\s*[:.—–-]+\s*)?(.*)$").unwrap());
static RE_BY: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s+by\s+@\S+\s+in\s+\S+").unwrap());
static RE_LINK: Lazy<Regex> = Lazy::new(|| Regex::new(r"\[([^\]]*)\]\([^)]*\)").unwrap());
static RE_URL: Lazy<Regex> = Lazy::new(|| Regex::new(r"https?://\S+").unwrap());
static RE_PR: Lazy<Regex> = Lazy::new(|| Regex::new(r"\(?#\d+\)?").unwrap());
static RE_SPACES: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s+").unwrap());
static RE_SENTENCE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[.!?](\s|$)").unwrap());

fn trim_ws(s: &str) -> &str {
    s.trim_matches(|c: char| c == ' ' || c == '\t' || c == '\u{a0}')
}

fn fold(s: &str) -> String {
    s.to_lowercase().replace('ё', "е")
}

struct Bullet {
    lead: Option<String>,
    rest: String,
    full: String,
}

fn bullet(line: &str) -> Option<Bullet> {
    let m = RE_BULLET.captures(line)?;
    let body = m.get(1).map(|b| b.as_str()).unwrap_or("");
    // «**Название.** Описание»: жирное начало с точкой или двоеточием — заголовок пункта.
    // Жирное слово посреди фразы («**Быстрее** запуск») — просто выделение, фраза остаётся целой.
    if let Some(b) = RE_BOLD_LEAD.captures(body) {
        let head = b.get(1).map(|x| x.as_str()).unwrap_or("");
        let sep = b.get(2).map(|x| x.as_str()).unwrap_or("");
        let title_style = !trim_ws(sep).is_empty() || head.chars().last().map(|c| ".:—".contains(c)).unwrap_or(false);
        if title_style {
            let lead = clean(head);
            let lead = lead.trim_matches(|c: char| ".:— ".contains(c)).to_string();
            let rest = clean(b.get(3).map(|x| x.as_str()).unwrap_or(""));
            return Some(Bullet { lead: (!lead.is_empty()).then_some(lead), rest, full: clean(body) });
        }
    }
    let c = clean(body);
    (!c.is_empty()).then(|| Bullet { lead: None, rest: c.clone(), full: c })
}

/// Убирает разметку, ссылки, адреса и подписи «by @автор in …» из автоматических заметок GitHub.
pub fn clean(s: &str) -> String {
    let mut t = RE_BY.replace_all(s, "").into_owned();
    t = RE_LINK.replace_all(&t, "$1").into_owned();
    t = RE_URL.replace_all(&t, "").into_owned();
    t = RE_PR.replace_all(&t, "").into_owned();
    t = t.replace("**", "").replace("__", "").replace('`', "");
    t = RE_SPACES.replace_all(&t, " ").into_owned();
    trim_ws(&t).to_string()
}

fn first_sentence(s: &str) -> &str {
    match RE_SENTENCE.find(s) {
        Some(m) => &s[..m.start()],
        None => s,
    }
}

/// Одна короткая фраза: начало описания до первой точки, при необходимости с заголовком пункта.
fn shorten(b: &Bullet) -> String {
    let phrase = match &b.lead {
        // Короткий заголовок вроде «Название» без описания беден: добавляем первое предложение описания.
        Some(lead) => {
            let sentence = first_sentence(&b.rest);
            if sentence.is_empty() {
                lead.clone()
            } else if lead.chars().count() <= 14 {
                sentence.to_string()
            } else {
                lead.clone()
            }
        }
        None => first_sentence(&b.rest).to_string(),
    };
    let mut phrase = phrase.trim_matches(|c: char| " .;:".contains(c)).to_string();
    if phrase.chars().count() < 4 {
        return String::new();
    }
    if phrase.chars().count() > MAX_ITEM_LENGTH {
        let cut: String = phrase.chars().take(MAX_ITEM_LENGTH).collect();
        let at_space = cut.rfind(' ').map(|i| cut[..i].to_string()).unwrap_or(cut);
        phrase = format!("{at_space}…");
    }
    let mut chars = phrase.chars();
    let first: String = chars.next().map(|c| c.to_uppercase().collect()).unwrap_or_default();
    first + chars.as_str()
}

fn is_service_section(head: &str) -> bool {
    ["установк", "install", "контрольн", "checksum", "sha", "full changelog", "new contributors", "новые участники", "скачать", "файлы", "assets"]
        .iter()
        .any(|k| head.contains(k))
}

/// Пункты для разработчиков: документация, CI, тесты, зависимости, внутренняя перестройка.
const TECHNICAL: &[&str] = &[
    "readme",
    "wiki",
    "вики",
    "рефактор",
    "refactor",
    "workflow",
    "github actions",
    "ci:",
    " ci ",
    "dependabot",
    "bump",
    "зависимост",
    "автотест",
    "тесты",
    "тестов",
    "тестир",
    "unit",
    "test",
    "lint",
    "codeql",
    "swiftpm",
    "dotnet",
    ".yml",
    "pull request",
    "коммит",
    "commit",
    "опечатк",
    "typo",
    "full changelog",
    "changelog",
    "sha-256",
    "sha256",
    "контрольн",
    "sqlite",
    "миграци базы",
    "ci/cd",
    "документаци",
    "покрыти",
    "сборк",
    "xcode",
    "winui",
    "inno setup",
];

fn is_technical(low: &str) -> bool {
    TECHNICAL.iter().any(|m| low.contains(m))
}

/// Платформа, о которой говорит только этот текст; None, если не названа или названы обе.
fn only(low: &str) -> Option<Platform> {
    let padded = format!(" {low} ");
    let mac = ["macos", "mac os", " mac ", "dock", "связк", "liquid glass", "строк меню", "строке меню", "dmg"].iter().any(|k| padded.contains(k));
    let win = ["windows", "винд", "winui", "трей", "проводник"].iter().any(|k| low.contains(k));
    match (mac, win) {
        (true, false) => Some(Platform::MacOs),
        (false, true) => Some(Platform::Windows),
        _ => None,
    }
}

fn topic_of(low: &str) -> Topic {
    let has = |words: &[&str]| words.iter().any(|w| low.contains(w));
    if has(&["энергосбереж", "заряд", "батаре", "облегчен"]) {
        Topic::Power
    } else if has(&["что нового", "мастер", "первый запуск", "первоначальн", "автообновлен", "обновление приложени"])
    {
        Topic::Updates
    } else if has(&["поиск", "источник", "лид", "категори", "openstreetmap", "osm", "telegram", "телеграм", "регион", "ключев", "исключен"])
    {
        Topic::Search
    } else if has(&["облак", "синхрон", "резервн", "диск", "экспорт", "импорт", "crm", "интеграц", "почт", "звонк"])
    {
        Topic::Data
    } else if has(&[
        "интерфейс",
        "окн",
        "панел",
        "дизайн",
        "оформлен",
        "темн",
        "светл",
        "тема",
        "темы",
        "тему",
        "цвет",
        "адаптив",
        "масштаб",
        "анимац",
        "кнопк",
        "меню",
        "настройк",
    ]) {
        Topic::Interface
    } else {
        Topic::Other
    }
}

fn preview_for(topic: Topic, items: &[String]) -> Option<Preview> {
    let low = fold(&items.join(" "));
    let has = |words: &[&str]| words.iter().any(|w| low.contains(w));
    if has(&["энергосбереж", "заряд", "батаре", "облегчен"]) {
        return Some(Preview::Power);
    }
    if has(&["исключен"]) {
        return Some(Preview::Exclusions);
    }
    if has(&["категори", "openstreetmap", "osm"]) {
        return Some(Preview::Categories);
    }
    if has(&["панел"]) {
        return Some(Preview::Sidebar);
    }
    if has(&["адаптив"]) {
        return Some(Preview::Adaptive);
    }
    if has(&["окно настроек", "окна настроек", "настройк"]) {
        return Some(Preview::Settings);
    }
    if has(&["кнопк", "обновить"]) && topic == Topic::Updates {
        return Some(Preview::Update);
    }
    match topic {
        Topic::Interface => Some(Preview::Settings),
        Topic::Search => Some(Preview::Categories),
        Topic::Data => Some(Preview::Cloud),
        Topic::Updates => Some(Preview::Update),
        Topic::Power => Some(Preview::Power),
        Topic::Other => None,
    }
}

/// Список полезных пользователю изменений из описания релиза: без README, вики, рефакторинга, CI, ссылок на GitHub
/// и изменений другой платформы, со сгруппированными и переформулированными пунктами.
pub fn build(markdown: &str, platform: Platform) -> Vec<Feature> {
    let mut by_topic: HashMap<Topic, Vec<String>> = HashMap::new();
    let mut seen = HashSet::new();
    let mut section_ok = true;
    let mut section_platform = None;
    let mut section_title = String::new();

    let text = markdown.replace("\r\n", "\n").replace('\r', "\n");
    for raw in text.split('\n') {
        let trimmed = trim_ws(raw);
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with('#') {
            let head = clean(trimmed.trim_start_matches(['#', ' '])).to_lowercase();
            section_ok = !is_service_section(&head);
            section_platform = only(&head);
            section_title = head;
            continue;
        }
        let Some(item) = (if section_ok { bullet(trimmed) } else { None }) else { continue };
        let low = fold(&format!("{section_title} {}", item.full));
        // Чужая платформа: либо заголовок раздела, либо сам пункт говорят только о ней.
        if let Some(p) = only(&item.full.to_lowercase()).or(section_platform) {
            if p != platform {
                continue;
            }
        }
        if is_technical(&fold(&item.full)) {
            continue;
        }
        let short = shorten(&item);
        if short.is_empty() || !seen.insert(short.to_lowercase()) {
            continue;
        }
        by_topic.entry(topic_of(&low)).or_default().push(short);
    }

    Topic::ALL
        .into_iter()
        .filter_map(|topic| {
            let items = by_topic.remove(&topic).filter(|i| !i.is_empty())?;
            let kept: Vec<String> = items.into_iter().take(MAX_ITEMS_PER_TOPIC).collect();
            let preview = preview_for(topic, &kept);
            Some(Feature { topic, title: topic.title(), items: kept, preview })
        })
        .collect()
}

// ------------------------------------------------------------------ когда показывать

/// Что делать с экраном «Что нового» при запуске.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Decision {
    /// Для этой версии экран уже показан.
    None,
    /// Приложение обновилось: показать.
    Show,
    /// Не показывать, только запомнить версию: первая установка (её встречает мастер) или возврат на старую версию.
    RecordOnly,
}

/// `last_seen` — версия, для которой экран уже показывали; `has_existing_data` — пользователь уже вошёл в
/// учётную запись, то есть это не первая установка.
pub fn decide(last_seen: Option<&str>, current: &AppVersion, has_existing_data: bool) -> Decision {
    let Some(seen) = last_seen.and_then(AppVersion::parse) else {
        return if has_existing_data { Decision::Show } else { Decision::RecordOnly };
    };
    if &seen < current {
        Decision::Show
    } else if &seen > current {
        Decision::RecordOnly
    } else {
        Decision::None
    }
}

/// Описание только что установленной версии. Записывается перед установкой, чтобы после перезапуска
/// «Что нового» показалось без сети.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InstalledNotes {
    pub version: String,
    pub title: String,
    pub notes: String,
}

impl InstalledNotes {
    pub fn encoded(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    /// Запись нужной версии или None (другая версия, пустая или испорченная запись).
    pub fn decode(text: Option<&str>, version: &AppVersion) -> Option<Self> {
        let n: InstalledNotes = serde_json::from_str(text?).ok()?;
        (AppVersion::parse(&n.version).as_ref() == Some(version)).then_some(n)
    }
}

/// Сколько места нужно на диске для загрузки обновления: установщик + его копия при распаковке + само приложение.
pub mod space {
    pub const MARGIN: u64 = 200 * 1024 * 1024;
    pub const ASSUMED_SIZE: u64 = 150 * 1024 * 1024;

    pub fn required(installer_size: Option<u64>) -> u64 {
        installer_size.unwrap_or(ASSUMED_SIZE) * 3 + MARGIN
    }

    pub fn is_enough(available: u64, installer_size: Option<u64>) -> bool {
        available >= required(installer_size)
    }

    pub fn message(available: u64, installer_size: Option<u64>) -> String {
        let mb = |v: u64| v.div_ceil(1_048_576);
        format!(
            "Недостаточно места на диске: для обновления нужно около {} МБ, свободно {} МБ. Освободите место и повторите.",
            mb(required(installer_size)),
            mb(available)
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(f: &[Feature]) -> Vec<String> {
        f.iter().flat_map(|x| x.items.clone()).collect()
    }
    fn mac(md: &str) -> Vec<Feature> {
        build(md, Platform::MacOs)
    }
    fn win(md: &str) -> Vec<Feature> {
        build(md, Platform::Windows)
    }

    #[test]
    fn technical_and_service_lines_are_dropped() {
        let md = "## Что изменилось\n- Обновили README и вики\n- Рефакторинг модуля поиска\n- Исправили тесты CI\n- Bump pillow from 12 to 13 by @dependabot in https://github.com/x/y/pull/42\n- Новое окно настроек с поиском по разделам\n\n**Full Changelog**: https://github.com/x/y/compare/v1...v2";
        let items = texts(&mac(md));
        assert_eq!(items, ["Новое окно настроек с поиском по разделам"]);
        assert!(!items.join("").contains("github"));
    }

    #[test]
    fn other_platform_changes_are_hidden() {
        let md = "- Windows: значок в области уведомлений\n- macOS: боковая панель выезжает при наведении\n- Общий поиск стал быстрее\n- Мастер на Windows и macOS спрашивает регион";
        let (m, w) = (texts(&mac(md)), texts(&win(md)));
        assert!(!m.iter().any(|i| i.to_lowercase().contains("значок в области")));
        assert!(
            m.iter().any(|i| i.contains("боковая панель"))
                && m.iter().any(|i| i.contains("Общий поиск"))
                && m.iter().any(|i| i.contains("Мастер на Windows и macOS"))
        );
        assert!(
            w.iter().any(|i| i.contains("значок в области"))
                && !w.iter().any(|i| i.contains("боковая панель"))
                && w.iter().any(|i| i.contains("Мастер на Windows и macOS"))
        );
    }

    #[test]
    fn platform_section_heading_scopes_its_bullets() {
        let md = "## Windows\n- Адаптивная сетка карточек\n## macOS\n- Новая иконка в строке меню";
        assert_eq!(texts(&mac(md)), ["Новая иконка в строке меню"]);
        assert_eq!(texts(&win(md)), ["Адаптивная сетка карточек"]);
    }

    #[test]
    fn installation_sections_are_service_information() {
        let md = "## Изменилось\n- Облегчённый режим при низком заряде\n## Установка\n- Скачайте Customers-v1.dmg и перетащите в Программы";
        let items = texts(&mac(md));
        assert_eq!(items.len(), 1);
        assert!(items[0].contains("Облегчённый"));
    }

    #[test]
    fn bold_lead_becomes_short_phrase_without_markup() {
        let f = mac("- **Исключения.** Одно поле для домена, телефона и почты, формат определяется сам. Старые правила сохранены.");
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].items, ["Одно поле для домена, телефона и почты, формат определяется сам"]);
        assert!(!f[0].items[0].contains('*'));
    }

    #[test]
    fn bold_word_inside_sentence_keeps_whole_phrase() {
        let items = texts(&mac("- **Быстрее** запуск приложения\n- **Окно.** Новое окно настроек"));
        assert!(items.contains(&"Быстрее запуск приложения".to_string()), "{items:?}");
        assert!(items.contains(&"Новое окно настроек".to_string()), "{items:?}");
    }

    #[test]
    fn related_changes_are_grouped_under_one_topic() {
        let md = "- Адаптивное расположение элементов\n- Обновлённое окно настроек\n- Улучшенное поведение боковых панелей\n- Поиск по категориям OpenStreetMap стал богаче";
        let features = mac(md);
        let ui = features.iter().find(|f| f.topic == Topic::Interface).unwrap();
        assert_eq!(ui.items.len(), 3);
        assert_eq!(ui.title, "Улучшили и доработали интерфейс");
        assert_eq!(features.iter().find(|f| f.topic == Topic::Search).unwrap().items.len(), 1);
    }

    #[test]
    fn topics_keep_fixed_order_and_limited_items() {
        let mut md = "- Энергосбережение: облегчённый режим при низком заряде\n".to_string();
        for i in 1..=9 {
            md += &format!("- Окно {i} стало удобнее\n");
        }
        let features = mac(&md);
        assert_eq!(features.iter().map(|f| f.topic).collect::<Vec<_>>(), [Topic::Interface, Topic::Power]);
        assert_eq!(features[0].items.len(), MAX_ITEMS_PER_TOPIC);
    }

    #[test]
    fn duplicates_are_merged_and_long_text_is_shortened() {
        let long = "очень длинное описание ".repeat(20);
        let items = texts(&mac(&format!("- Поиск стал быстрее\n- поиск стал быстрее\n- {long}")));
        assert_eq!(items.iter().filter(|i| i.to_lowercase() == "поиск стал быстрее").count(), 1);
        assert!(items.iter().all(|i| i.chars().count() <= MAX_ITEM_LENGTH + 1));
    }

    #[test]
    fn preview_matches_what_the_feature_does() {
        let p = |line: &str| mac(&format!("- {line}")).first().and_then(|f| f.preview);
        assert_eq!(p("Одно поле для исключений"), Some(Preview::Exclusions));
        assert_eq!(p("Облегчённый режим при низком заряде"), Some(Preview::Power));
        assert_eq!(p("Больше категорий организаций на карте"), Some(Preview::Categories));
        assert_eq!(p("Боковая панель раскрывается при наведении"), Some(Preview::Sidebar));
        assert_eq!(p("Новое окно настроек"), Some(Preview::Settings));
    }

    #[test]
    fn empty_or_only_technical_notes_give_nothing() {
        assert!(mac("").is_empty());
        assert!(win("- Обновили wiki\n- Рефакторинг").is_empty());
    }

    #[test]
    fn auto_generated_github_notes_are_cleaned() {
        let md = "## What's Changed\n* Новая кнопка обновления с прогрессом by @xop1tt in https://github.com/xop1tt/Customers-App/pull/63\n**Full Changelog**: https://github.com/xop1tt/Customers-App/compare/v1.0.9...v1.1.0";
        assert_eq!(texts(&mac(md)), ["Новая кнопка обновления с прогрессом"]);
    }

    fn v(s: &str) -> AppVersion {
        AppVersion::parse(s).unwrap()
    }

    #[test]
    fn whats_new_policy() {
        assert_eq!(decide(None, &v("1.0.0"), false), Decision::RecordOnly);
        assert_eq!(decide(None, &v("1.0.0"), true), Decision::Show);
        assert_eq!(decide(Some("1.0.0"), &v("1.1.0"), false), Decision::Show);
        assert_eq!(decide(Some("1.1.0"), &v("1.1.0"), true), Decision::None);
        assert_eq!(decide(Some("1.2.0"), &v("1.1.0"), true), Decision::RecordOnly);
        assert_eq!(decide(Some("мусор"), &v("1.1.0"), false), Decision::RecordOnly);
        assert_eq!(decide(Some("мусор"), &v("1.1.0"), true), Decision::Show);
        assert_eq!(decide(Some("1.0.9"), &v("1.0.10"), false), Decision::Show);
    }

    #[test]
    fn installed_notes_roundtrip_and_version_match() {
        let n = InstalledNotes { version: "1.3.0".into(), title: "Customers 1.3.0".into(), notes: "## Новое\n- быстрее".into() };
        assert_eq!(InstalledNotes::decode(Some(&n.encoded()), &v("1.3")), Some(n.clone()));
        assert!(InstalledNotes::decode(Some(&n.encoded()), &v("1.4")).is_none());
        assert!(InstalledNotes::decode(Some("{"), &v("1.3")).is_none());
        assert!(InstalledNotes::decode(None, &v("1.3")).is_none());
    }

    #[test]
    fn update_space_requirements() {
        assert_eq!(space::required(Some(100 * 1024 * 1024)), 500 * 1024 * 1024);
        assert_eq!(space::required(None), 650 * 1024 * 1024);
        assert!(space::is_enough(500 * 1024 * 1024, Some(100 * 1024 * 1024)) && !space::is_enough(499 * 1024 * 1024, Some(100 * 1024 * 1024)));
        assert!(space::message(100 * 1024 * 1024, Some(100 * 1024 * 1024)).contains("около 500 МБ, свободно 100 МБ"));
    }
}
