//! Источники лидов: RSS/Atom, публичные каналы Telegram, сообщества VK, организации OpenStreetMap
//! и проверка сайтов. Источник возвращает кандидатов, оценивает и сохраняет их движок.

use crate::models::{LeadData, LeadKind};
use crate::search::http::{HttpResponse, SearchError, SourceHttp};
use crate::search::settings::{self as cfg, FeedSourceSettings, OsmCategory, OsmSourceSettings, TelegramSourceSettings, VkSourceSettings};
use crate::search::text::{contacts, html_to_text};
use crate::util::{normalize, parse_date, prefix_chars, short_hash};
use chrono::{DateTime, Datelike, Local, NaiveDateTime, TimeZone, Utc};
use once_cell::sync::Lazy;
use quick_xml::events::Event;
use quick_xml::Reader;
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};

/// Найденный, но ещё не оценённый лид.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub data: LeadData,
    /// Для организаций: проверенные сигналы и вес категории.
    pub signals: HashMap<String, bool>,
    pub category_weight: Option<f64>,
}

impl Candidate {
    pub fn order(data: LeadData) -> Self {
        Self { data, signals: HashMap::new(), category_weight: None }
    }
}

/// Итог опроса одного источника.
#[derive(Debug, Clone)]
pub struct FetchResult {
    pub candidates: Vec<Candidate>,
    pub cursor: Option<String>,
    pub warnings: Vec<String>,
    /// Ошибки отдельных лент, каналов и сообществ.
    pub partial_errors: Vec<String>,
    /// Сколько независимых подзапросов было (чтобы отличить частичный сбой от полного).
    pub items: usize,
}

impl Default for FetchResult {
    fn default() -> Self {
        Self { candidates: vec![], cursor: None, warnings: vec![], partial_errors: vec![], items: 1 }
    }
}

/// Хранилище служебного состояния поиска (история запросов OSM, проверенные объекты).
pub trait SearchMemory: Send + Sync {
    fn query_last_run(&self, hash: &str) -> Option<DateTime<Utc>>;
    fn record_query(&self, hash: &str, source: &str, label: &str, results: i64);
    fn forget_query(&self, hash: &str);
    fn object_checked_at(&self, source: &str, object_id: &str) -> Option<DateTime<Utc>>;
    fn mark_object_checked(&self, source: &str, object_id: &str);
}

fn encode_cursor<T: Serialize>(v: &T) -> Option<String> {
    serde_json::to_value(v).ok().map(|v| crate::cloud::types::canonical_json(&v))
}

fn decode_cursor<T: for<'de> Deserialize<'de>>(s: Option<&str>) -> Option<T> {
    s.and_then(|s| serde_json::from_str(s).ok())
}

// ------------------------------------------------------------------ RSS

#[derive(Debug, Clone, PartialEq, Default)]
pub struct FeedEntry {
    pub id: String,
    pub title: String,
    pub link: String,
    pub summary: String,
    pub published: Option<DateTime<Utc>>,
    pub category: Option<String>,
}

fn local_name(name: &[u8]) -> String {
    let s = String::from_utf8_lossy(name);
    s.rsplit(':').next().unwrap_or(&s).to_lowercase()
}

fn parse_feed_date(raw: Option<&String>) -> Option<DateTime<Utc>> {
    let raw = raw?.trim();
    if raw.is_empty() {
        return None;
    }
    if let Some(d) = parse_date(raw) {
        return Some(d);
    }
    if let Ok(d) = DateTime::parse_from_rfc2822(raw) {
        return Some(d.with_timezone(&Utc));
    }
    for f in ["%a, %d %b %Y %H:%M:%S %z", "%a, %d %b %Y %H:%M:%S %Z", "%d %b %Y %H:%M:%S %z", "%a, %d %b %Y %H:%M %z"] {
        if let Ok(d) = DateTime::parse_from_str(raw, f) {
            return Some(d.with_timezone(&Utc));
        }
    }
    for f in ["%a, %d %b %Y %H:%M:%S", "%d %b %Y %H:%M:%S"] {
        if let Ok(d) = NaiveDateTime::parse_from_str(raw, f) {
            return Some(Utc.from_utc_datetime(&d));
        }
    }
    None
}

/// Разбор RSS 2.0 и Atom. `None` — разобрать не удалось совсем.
pub fn parse_feed(data: &[u8]) -> Option<Vec<FeedEntry>> {
    let mut reader = Reader::from_reader(data);
    let c = reader.config_mut();
    c.expand_empty_elements = true;
    c.check_end_names = false;
    let mut entries = Vec::new();
    let mut current: Option<HashMap<String, String>> = None;
    let mut text = String::new();
    let mut buf = Vec::new();
    let mut failed = false;
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = local_name(e.name().as_ref());
                if name == "item" || name == "entry" {
                    current = Some(HashMap::new());
                } else if let Some(cur) = current.as_mut() {
                    let attr = |k: &str| e.attributes().flatten().find(|a| a.key.as_ref() == k.as_bytes()).and_then(|a| a.unescape_value().ok().map(|v| v.into_owned()));
                    if name == "link" {
                        if let Some(href) = attr("href") {
                            let rel = attr("rel").unwrap_or_else(|| "alternate".into());
                            if rel == "alternate" && !cur.contains_key("link") {
                                cur.insert("link".into(), href);
                            }
                        }
                    } else if name == "category" {
                        if let Some(term) = attr("term") {
                            cur.entry("category".into()).or_insert(term);
                        }
                    }
                }
                text.clear();
            }
            Ok(Event::Text(t)) => match t.unescape() {
                Ok(s) => text.push_str(&s),
                Err(_) => text.push_str(&String::from_utf8_lossy(&t)),
            },
            Ok(Event::CData(t)) => text.push_str(&String::from_utf8_lossy(&t)),
            Ok(Event::End(e)) => {
                let name = local_name(e.name().as_ref());
                if let Some(mut cur) = current.take() {
                    let value = text.trim().to_string();
                    match name.as_str() {
                        "item" | "entry" => {
                            let id = ["guid", "id", "link", "title"].iter().find_map(|k| cur.get(*k).cloned()).unwrap_or_default();
                            let summary = ["description", "summary", "encoded", "content"].iter().find_map(|k| cur.get(*k).cloned()).unwrap_or_default();
                            let date = ["pubdate", "published", "updated", "date"].iter().find_map(|k| cur.get(*k)).cloned();
                            entries.push(FeedEntry {
                                id,
                                title: cur.get("title").cloned().unwrap_or_default(),
                                link: cur.get("link").cloned().unwrap_or_default(),
                                summary,
                                published: parse_feed_date(date.as_ref()),
                                category: cur.get("category").cloned(),
                            });
                            text.clear();
                            continue;
                        }
                        "title" | "guid" | "id" | "description" | "summary" | "encoded" | "content" | "pubdate" | "published" | "updated" | "date" | "link" | "category" => {
                            if !value.is_empty() {
                                cur.entry(name).or_insert(value);
                            }
                        }
                        _ => {}
                    }
                    current = Some(cur);
                    text.clear();
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => {
                failed = true;
                break;
            }
            _ => {}
        }
        buf.clear();
    }
    if failed && entries.is_empty() {
        return None;
    }
    Some(entries)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FeedCursor {
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    #[serde(default)]
    pub seen: Vec<String>,
}

const MAX_SEEN: usize = 500;

pub async fn fetch_rss(cfg: &FeedSourceSettings, cursor: Option<&str>, http: &SourceHttp) -> Result<FetchResult, SearchError> {
    let mut res = FetchResult::default();
    let mut cursors: BTreeMap<String, FeedCursor> = decode_cursor(cursor).unwrap_or_default();
    res.items = cfg.feeds.len().max(1);
    for feed in &cfg.feeds {
        if http.is_cancelled() {
            return Err(SearchError::Cancelled);
        }
        if url::Url::parse(feed).is_err() {
            res.partial_errors.push(format!("{feed}: некорректный адрес"));
            continue;
        }
        let mut fc = cursors.get(feed).cloned().unwrap_or_default();
        let mut headers: Vec<(&str, &str)> = vec![];
        if let Some(e) = &fc.etag {
            headers.push(("If-None-Match", e));
        }
        if let Some(m) = &fc.last_modified {
            headers.push(("If-Modified-Since", m));
        }
        let resp = match http.get(feed, &headers).await {
            Ok(r) => r,
            Err(SearchError::Http { message, .. }) => {
                res.partial_errors.push(format!("{feed}: {message}"));
                continue;
            }
            Err(e) => return Err(e),
        };
        if resp.status == 304 {
            continue;
        }
        let Some(entries) = parse_feed(&resp.data) else {
            res.partial_errors.push(format!("{feed}: не удалось разобрать ленту"));
            continue;
        };
        let seen: HashSet<&String> = fc.seen.iter().collect();
        let mut new_ids: Vec<String> = Vec::new();
        for e in &entries {
            if e.id.is_empty() || seen.contains(&e.id) {
                continue;
            }
            new_ids.push(e.id.clone());
            let title = prefix_chars(&html_to_text(&e.title, false), 300);
            let desc = html_to_text(&e.summary, false);
            if !crate::search::text::prefilter(&format!("{title} {desc}"), &cfg.keywords) {
                continue;
            }
            // GUID-ссылка уникальна сама по себе; короткий GUID вроде «1» может совпасть у разных лент,
            // поэтому к нему добавляется адрес ленты.
            let low = e.id.to_lowercase();
            let external_id = if low.starts_with("http://") || low.starts_with("https://") { e.id.clone() } else { format!("{feed}#{}", e.id) };
            let mut d = LeadData::new(LeadKind::Order, cfg::RSS, &external_id, &title);
            d.url = e.link.clone();
            d.description = prefix_chars(&desc, 4000);
            d.published_at = e.published;
            d.contacts = contacts(&desc);
            d.category = e.category.clone();
            res.candidates.push(Candidate::order(d));
        }
        // Ни одной уже виденной записи: лента короче пропущенного периода.
        if !seen.is_empty() && !entries.is_empty() && entries.iter().all(|e| !seen.contains(&e.id)) {
            res.warnings.push(format!("{feed}: лента короче пропущенного периода, часть заявок могла не попасть"));
        }
        let mut merged = new_ids.clone();
        merged.extend(fc.seen.iter().filter(|s| !new_ids.contains(s)).cloned());
        merged.truncate(MAX_SEEN);
        fc.seen = merged;
        fc.etag = resp.headers.get("etag").cloned();
        fc.last_modified = resp.headers.get("last-modified").cloned();
        cursors.insert(feed.clone(), fc);
    }
    res.cursor = encode_cursor(&cursors);
    Ok(res)
}

// ------------------------------------------------------------------ Telegram

#[derive(Debug, Clone, PartialEq)]
pub struct TelegramPost {
    pub channel: String,
    pub id: i64,
    pub text: String,
    pub published: Option<DateTime<Utc>>,
}

impl TelegramPost {
    pub fn url(&self) -> String {
        format!("https://t.me/{}/{}", self.channel, self.id)
    }
}

static POST_RX: Lazy<Regex> = Lazy::new(|| Regex::new(r#"data-post="([^"/]+)/(\d+)""#).unwrap());
static MAIN_TEXT_RX: Lazy<Regex> =
    Lazy::new(|| RegexBuilder::new(r#"<div class="tgme_widget_message_text js-message_text[^"]*"[^>]*>(.*?)</div>"#).dot_matches_new_line(true).build().unwrap());
static TEXT_RX: Lazy<Regex> = Lazy::new(|| RegexBuilder::new(r#"<div class="tgme_widget_message_text[^"]*"[^>]*>(.*?)</div>"#).dot_matches_new_line(true).build().unwrap());
static TIME_RX: Lazy<Regex> = Lazy::new(|| Regex::new(r#"<time[^>]*datetime="([^"]+)""#).unwrap());

/// Разбор страницы https://t.me/s/<канал>.
pub fn parse_telegram(html: &str) -> Vec<TelegramPost> {
    let marks: Vec<_> = POST_RX.captures_iter(html).collect();
    let mut posts = Vec::new();
    for (i, m) in marks.iter().enumerate() {
        let start = m.get(0).unwrap().start();
        let end = marks.get(i + 1).map(|n| n.get(0).unwrap().start()).unwrap_or(html.len());
        let chunk = &html[start..end];
        let Ok(id) = m[2].parse::<i64>() else { continue };
        let text = MAIN_TEXT_RX
            .captures(chunk)
            .or_else(|| TEXT_RX.captures(chunk))
            .map(|c| html_to_text(&c[1], true))
            .unwrap_or_default();
        let published = TIME_RX.captures(chunk).and_then(|c| parse_date(&c[1]));
        posts.push(TelegramPost { channel: m[1].to_string(), id, text, published });
    }
    posts
}

fn first_line(text: &str, n: usize) -> String {
    prefix_chars(text.split('\n').find(|l| !l.is_empty()).unwrap_or(text), n)
}

pub async fn fetch_telegram(cfg: &TelegramSourceSettings, cursor: Option<&str>, http: &SourceHttp) -> Result<FetchResult, SearchError> {
    let mut res = FetchResult::default();
    let mut cursors: BTreeMap<String, i64> = decode_cursor(cursor).unwrap_or_default();
    res.items = cfg.channels.len().max(1);
    for channel in &cfg.channels {
        if http.is_cancelled() {
            return Err(SearchError::Cancelled);
        }
        let last_id = cursors.get(channel).copied().unwrap_or(0);
        let mut newest = last_id;
        let mut before: Option<i64> = None;
        let mut reached = last_id == 0; // первый запуск: только первая страница
        for page in 0..cfg.max_pages.max(1) {
            let url = format!("https://t.me/s/{channel}{}", before.map(|b| format!("?before={b}")).unwrap_or_default());
            let resp = match http.get(&url, &[]).await {
                Ok(r) => r,
                Err(SearchError::Http { message, .. }) => {
                    res.partial_errors.push(format!("{channel}: {message}"));
                    break;
                }
                Err(e) => return Err(e),
            };
            let posts = parse_telegram(&resp.text());
            if posts.is_empty() {
                if page == 0 {
                    res.partial_errors.push(format!("{channel}: нет публичного превью или канал не найден"));
                }
                break;
            }
            for p in &posts {
                if p.id <= last_id {
                    reached = true;
                    continue;
                }
                newest = newest.max(p.id);
                if p.text.is_empty() || !crate::search::text::prefilter(&p.text, &cfg.keywords) {
                    continue;
                }
                let mut d = LeadData::new(LeadKind::Order, cfg::TELEGRAM, &format!("{channel}/{}", p.id), &first_line(&p.text, 200));
                d.url = p.url();
                d.description = prefix_chars(&p.text, 4000);
                d.published_at = p.published;
                d.contacts = contacts(&p.text);
                res.candidates.push(Candidate::order(d));
            }
            let min_id = posts.iter().map(|p| p.id).min().unwrap_or(0);
            if reached || min_id <= last_id + 1 {
                reached = true;
                break;
            }
            before = Some(min_id);
        }
        if !reached {
            res.warnings.push(format!("{channel}: за {} стр. не дошли до последнего обработанного поста — возможен пропуск", cfg.max_pages));
        }
        cursors.insert(channel.clone(), newest);
    }
    res.cursor = encode_cursor(&cursors);
    Ok(res)
}

// ------------------------------------------------------------------ ВКонтакте

const VK_API: &str = "https://api.vk.com/method/wall.get";
const VK_VERSION: &str = "5.199";

pub async fn fetch_vk(cfg: &VkSourceSettings, token: &str, cursor: Option<&str>, http: &SourceHttp) -> Result<FetchResult, SearchError> {
    let mut res = FetchResult::default();
    let mut cursors: BTreeMap<String, i64> = decode_cursor(cursor).unwrap_or_default();
    res.items = cfg.communities.len().max(1);
    for domain in &cfg.communities {
        if http.is_cancelled() {
            return Err(SearchError::Cancelled);
        }
        let last_id = cursors.get(domain).copied().unwrap_or(0);
        let mut newest = last_id;
        let mut reached = last_id == 0;
        for page in 0..cfg.max_pages.max(1) {
            let mut url = url::Url::parse(VK_API).unwrap();
            url.query_pairs_mut()
                .append_pair("domain", domain)
                .append_pair("count", &cfg.page_size.to_string())
                .append_pair("offset", &(page * cfg.page_size).to_string())
                .append_pair("access_token", token)
                .append_pair("v", VK_VERSION);
            let json: Value = match http.get(url.as_str(), &[]).await {
                Ok(r) => match serde_json::from_slice::<Value>(&r.data) {
                    Ok(v) if v.is_object() => v,
                    Ok(_) => {
                        res.partial_errors.push(format!("{domain}: неожиданный ответ VK"));
                        break;
                    }
                    Err(_) => {
                        res.partial_errors.push(format!("{domain}: ответ VK не разобран"));
                        break;
                    }
                },
                Err(SearchError::Http { message, .. }) => {
                    res.partial_errors.push(format!("{domain}: {message}"));
                    break;
                }
                Err(e) => return Err(e),
            };
            if let Some(err) = json.get("error") {
                let code = err.get("error_code").map(|c| c.to_string()).unwrap_or_else(|| "?".into());
                let msg = err.get("error_msg").and_then(Value::as_str).unwrap_or("");
                res.partial_errors.push(format!("{domain}: VK API {code}: {msg}"));
                break;
            }
            let response = json.get("response").cloned().unwrap_or(Value::Null);
            let items = response.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
            if items.is_empty() {
                break;
            }
            for it in &items {
                let Some(pid) = it.get("id").and_then(Value::as_i64) else { continue };
                if pid <= last_id {
                    if it.get("is_pinned").and_then(Value::as_i64).unwrap_or(0) != 1 && it.get("is_pinned").and_then(Value::as_bool) != Some(true) {
                        reached = true;
                    }
                    continue;
                }
                newest = newest.max(pid);
                let text = it.get("text").and_then(Value::as_str).unwrap_or("");
                if text.is_empty() || !crate::search::text::prefilter(text, &cfg.keywords) {
                    continue;
                }
                let owner = it.get("owner_id").and_then(Value::as_i64).unwrap_or(0);
                let mut d = LeadData::new(LeadKind::Order, cfg::VK, &format!("{owner}_{pid}"), &first_line(text, 200));
                d.url = format!("https://vk.com/wall{owner}_{pid}");
                d.description = prefix_chars(text, 4000);
                d.published_at = it.get("date").and_then(Value::as_i64).and_then(|s| Utc.timestamp_opt(s, 0).single());
                d.contacts = contacts(text);
                res.candidates.push(Candidate::order(d));
            }
            let count = response.get("count").and_then(Value::as_i64).unwrap_or(0);
            if reached || (cfg.page_size as i64) * (page as i64 + 1) >= count {
                reached = true;
                break;
            }
        }
        if !reached {
            res.warnings.push(format!("{domain}: возможен пропуск постов (увеличьте число страниц)"));
        }
        cursors.insert(domain.clone(), newest);
    }
    res.cursor = encode_cursor(&cursors);
    Ok(res)
}

// ------------------------------------------------------------------ OpenStreetMap

const NEEDS_BOOKING: [&str; 6] = ["beauty", "dance", "fitness", "medical", "education", "restaurant"];

/// Запрос Overpass: город ищется по name, name:ru и name:en (Ереван в OSM — «Երևան»).
pub fn build_overpass_query(region: &str, filters: &[String], timeout: u32) -> String {
    let name = region.replace('"', "");
    let body: String = filters.iter().map(|f| format!("nwr{f}(area.a);")).collect();
    let alt: String = ["name", "name:ru", "name:en"]
        .iter()
        .enumerate()
        .map(|(i, k)| format!("area[\"{k}\"=\"{name}\"][\"boundary\"=\"administrative\"]->.a{i};"))
        .collect();
    format!("[out:json][timeout:{timeout}];{alt}(.a0;.a1;.a2;)->.a;({body});out center tags;")
}

pub async fn fetch_osm(
    cfg: &OsmSourceSettings,
    memory: &dyn SearchMemory,
    http: &SourceHttp,
    site_http: Option<&SourceHttp>,
    now: DateTime<Utc>,
) -> Result<FetchResult, SearchError> {
    let mut res = FetchResult::default();
    let cats: Vec<&OsmCategory> = cfg.categories.iter().filter(|c| c.enabled && !c.filters.is_empty()).collect();
    res.items = (cfg.regions.len() * cats.len()).max(1);
    if url::Url::parse(&cfg.endpoint).is_err() {
        res.partial_errors.push("некорректный адрес Overpass API".into());
        return Ok(res);
    }
    let mut added = 0u32;
    let mut site_cache: HashMap<String, SiteCheck> = HashMap::new();
    for region in &cfg.regions {
        for cat in &cats {
            // Остановка: возвращаем уже найденное, чтобы движок успел его сохранить.
            if http.is_cancelled() {
                return Ok(res);
            }
            let query = build_overpass_query(region, &cat.filters, 90);
            let qhash = short_hash(&query);
            if let Some(last) = memory.query_last_run(&qhash) {
                if (now - last).num_seconds() as f64 <= cfg.refresh_days * 86400.0 && (now - last).num_seconds() >= 0 {
                    continue; // этот запрос недавно выполнялся — не тратим квоту
                }
            }
            let elements: Vec<Value> = match http.post_form(&cfg.endpoint, &[("data", &query)]).await {
                Ok(r) => match serde_json::from_slice::<Value>(&r.data) {
                    Ok(v) if v.is_object() => v.get("elements").and_then(Value::as_array).cloned().unwrap_or_default(),
                    Ok(_) => {
                        res.partial_errors.push(format!("{region}/{}: неожиданный ответ Overpass", cat.label));
                        continue;
                    }
                    Err(_) => {
                        res.partial_errors.push(format!("{region}/{}: ответ не разобран", cat.label));
                        continue;
                    }
                },
                Err(SearchError::Budget(m)) => {
                    res.warnings.push(m);
                    return Ok(res);
                }
                Err(SearchError::Http { message, .. }) => {
                    res.partial_errors.push(format!("{region}/{}: {message}", cat.label));
                    continue;
                }
                Err(SearchError::Cancelled) => return Err(SearchError::Cancelled),
                Err(e) => {
                    res.partial_errors.push(format!("{region}/{}: {e}", cat.label));
                    continue;
                }
            };
            memory.record_query(&qhash, cfg::OSM, &format!("{region}|{}", cat.key), elements.len() as i64);
            for el in &elements {
                if added >= cfg.max_new_per_run {
                    res.warnings.push(format!("достигнут лимит {} новых организаций за запуск, остальные — в следующий раз", cfg.max_new_per_run));
                    // Запрос обработан частично: забываем его, чтобы дочитать в следующий раз.
                    memory.forget_query(&qhash);
                    return Ok(res);
                }
                match osm_candidate(el, cat, region, cfg, memory, site_http, &mut site_cache, now).await {
                    Ok(Some(c)) => {
                        res.candidates.push(c);
                        added += 1;
                    }
                    Ok(None) => {}
                    Err(_) => {
                        // Запрос обработан не до конца: забываем его, а найденное возвращаем на сохранение.
                        memory.forget_query(&qhash);
                        return Ok(res);
                    }
                }
            }
        }
    }
    Ok(res)
}

#[allow(clippy::too_many_arguments)]
async fn osm_candidate(
    el: &Value,
    cat: &OsmCategory,
    region: &str,
    cfg: &OsmSourceSettings,
    memory: &dyn SearchMemory,
    site_http: Option<&SourceHttp>,
    cache: &mut HashMap<String, SiteCheck>,
    now: DateTime<Utc>,
) -> Result<Option<Candidate>, SearchError> {
    let tags: HashMap<String, String> = el
        .get("tags")
        .and_then(Value::as_object)
        .map(|o| o.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
        .unwrap_or_default();
    let Some(name) = tags.get("name").filter(|n| !n.is_empty()).cloned() else { return Ok(None) };
    let oid = format!("{}/{}", el.get("type").and_then(Value::as_str).unwrap_or("node"), el.get("id").and_then(Value::as_i64).unwrap_or(0));
    if let Some(checked) = memory.object_checked_at(cfg::OSM, &oid) {
        if ((now - checked).num_seconds() as f64) < cfg.recheck_days * 86400.0 {
            return Ok(None); // уже обработан, перепроверять рано
        }
    }
    let pick = |keys: &[&str]| keys.iter().find_map(|k| tags.get(*k).cloned());
    let website = pick(&["website", "contact:website", "url"]);
    let phone = pick(&["phone", "contact:phone"]);
    let mut contacts_map = BTreeMap::new();
    for (k, v) in [("phone", phone.clone()), ("email", pick(&["email", "contact:email"])), ("vk", tags.get("contact:vk").cloned()), ("telegram", tags.get("contact:telegram").cloned())] {
        if let Some(v) = v.filter(|v| !v.is_empty()) {
            contacts_map.insert(k.to_string(), v);
        }
    }
    let mut signals: HashMap<String, bool> = HashMap::new();
    let mut facts = vec!["Данные © участники OpenStreetMap (ODbL)".to_string()];
    let mut assumptions: Vec<String> = Vec::new();
    let needs_booking = NEEDS_BOOKING.contains(&cat.group.as_str());
    match website.as_deref().filter(|w| !w.is_empty()) {
        None => {
            signals.insert("no_website".into(), true);
            facts.push("В OpenStreetMap у организации не указан сайт (сам сайт при этом может существовать)".into());
            if needs_booking {
                assumptions.push("Возможно, пригодится сайт с онлайн-записью".into());
            }
        }
        Some(site) if cfg.check_websites && site_http.is_some() => {
            let key = normalize::domain(site);
            let mut chk = cache.get(&key).cloned();
            if chk.is_none() {
                match check_site(site, site_http.unwrap(), now).await {
                    Ok(c) => {
                        cache.insert(key, c.clone());
                        chk = Some(c);
                    }
                    Err(SearchError::Budget(_)) => assumptions.push("Сайт не проверен: исчерпан лимит проверок на этот запуск".into()),
                    Err(SearchError::Cancelled) => return Err(SearchError::Cancelled),
                    Err(_) => {}
                }
            }
            if let Some(chk) = chk {
                facts.extend(chk.facts.iter().cloned());
                signals.insert("site_unreachable".into(), !chk.reachable);
                if chk.reachable {
                    signals.insert("no_https".into(), !chk.https);
                    signals.insert("no_viewport".into(), !chk.viewport);
                    if chk.copyright_year.map(|y| y <= now.year() - 4).unwrap_or(false) {
                        signals.insert("outdated".into(), true);
                    }
                    if !chk.has_booking && needs_booking {
                        signals.insert("no_booking".into(), true);
                        assumptions.push("Возможно, нужна онлайн-запись (на сайте её признаков не найдено)".into());
                    }
                }
            }
        }
        Some(_) => {}
    }
    memory.mark_object_checked(cfg::OSM, &oid);
    let address = ["addr:city", "addr:street", "addr:housenumber"].iter().filter_map(|k| tags.get(*k)).filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join(", ");
    let mut d = LeadData::new(LeadKind::Organization, cfg::OSM, &oid, &name);
    d.url = format!("https://www.openstreetmap.org/{oid}");
    d.description = format!("{} · {region}", cat.label);
    d.region = Some(region.to_string());
    d.contacts = contacts_map;
    d.category = Some(cat.label.clone());
    d.customer_name = Some(name);
    d.address = (!address.is_empty()).then_some(address);
    d.phone = phone;
    d.website = website;
    d.facts = facts;
    d.assumptions = assumptions;
    Ok(Some(Candidate { data: d, signals, category_weight: Some(cat.weight) }))
}

// ------------------------------------------------------------------ Проверка сайта

#[derive(Debug, Clone, Default)]
pub struct SiteCheck {
    pub url: String,
    pub reachable: bool,
    pub status: Option<u16>,
    pub https: bool,
    pub viewport: bool,
    pub copyright_year: Option<i32>,
    pub has_booking: bool,
    pub facts: Vec<String>,
}

const BOOKING_MARKERS: [&str; 12] = [
    "онлайн-запис", "онлайн запис", "записаться", "запись онлайн", "yclients", "dikidi", "sonline", "booking", "забронировать", "бронирование", "arnica", "altegio",
];
static YEAR_RX: Lazy<Regex> = Lazy::new(|| RegexBuilder::new(r"(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–—]\s*)?(20\d{2}|19\d{2})").case_insensitive(true).build().unwrap());
static VIEWPORT_RX: Lazy<Regex> = Lazy::new(|| RegexBuilder::new(r#"<meta\b[^>]*\bname\s*=\s*["']?viewport\b"#).case_insensitive(true).build().unwrap());
static PRIVATE_RX: Lazy<Regex> = Lazy::new(|| Regex::new(r"^(127|10|192\.168|169\.254|0)\.").unwrap());
static PRIVATE172_RX: Lazy<Regex> = Lazy::new(|| Regex::new(r"^172\.(1[6-9]|2\d|3[01])\.").unwrap());

pub fn normalize_site_url(raw: &str) -> String {
    let s = raw.trim();
    let low = s.to_lowercase();
    if low.starts_with("http://") || low.starts_with("https://") {
        s.to_string()
    } else {
        format!("http://{s}")
    }
}

/// Только http(s) и не локальные адреса.
pub fn is_public_http_url(s: &str) -> bool {
    let Ok(u) = url::Url::parse(s) else { return false };
    if !["http", "https"].contains(&u.scheme()) {
        return false;
    }
    let Some(host) = u.host_str().map(str::to_lowercase) else { return false };
    if host.is_empty() || !host.contains('.') {
        return false;
    }
    !(host == "localhost" || host.ends_with(".local") || PRIVATE_RX.is_match(&host) || PRIVATE172_RX.is_match(&host))
}

/// Один запрос к главной странице. Возвращает только проверенные факты.
pub async fn check_site(raw: &str, http: &SourceHttp, now: DateTime<Utc>) -> Result<SiteCheck, SearchError> {
    let url = normalize_site_url(raw);
    let day = now.with_timezone(&Local).format("%d.%m.%Y").to_string();
    if !is_public_http_url(&url) {
        return Ok(SiteCheck { url, reachable: false, facts: vec!["В источнике указан некорректный адрес сайта".into()], ..Default::default() });
    }
    let resp: HttpResponse = match http.get(&url, &[]).await {
        Ok(r) => r,
        Err(SearchError::Http { message, status, .. }) => {
            return Ok(SiteCheck { url, reachable: false, status, facts: vec![format!("Сайт не открылся при проверке {day}: {message}")], ..Default::default() })
        }
        Err(e) => return Err(e),
    };
    let final_url = resp.url.clone().unwrap_or_else(|| url.clone());
    let html = prefix_chars(&resp.text(), 500_000);
    let mut chk = SiteCheck {
        url: final_url.clone(),
        reachable: true,
        status: Some(resp.status),
        https: final_url.to_lowercase().starts_with("https://"),
        viewport: VIEWPORT_RX.is_match(&html),
        ..Default::default()
    };
    chk.copyright_year = YEAR_RX.captures_iter(&html).filter_map(|c| c[1].parse::<i32>().ok()).max();
    let low = html.to_lowercase();
    chk.has_booking = BOOKING_MARKERS.iter().any(|m| low.contains(m));
    chk.facts.push(format!("Сайт открылся ({}) при проверке {day}", resp.status));
    if !chk.https {
        chk.facts.push("Сайт работает без HTTPS".into());
    }
    if !chk.viewport {
        chk.facts.push("На главной нет meta viewport — мобильная вёрстка вероятно не адаптивна".into());
    }
    if let Some(y) = chk.copyright_year {
        chk.facts.push(format!("Последний год в копирайте: {y}"));
    }
    if !chk.has_booking {
        chk.facts.push("На главной не найдено признаков онлайн-записи/бронирования".into());
    }
    Ok(chk)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::http::testing::*;
    use crate::search::http::HttpResponse;
    use std::sync::Mutex;

    const RSS_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>FL</title>
<item><title>Нужен сайт &amp; бот</title><link>https://fl.ru/p/1</link><guid>https://fl.ru/p/1</guid>
<description><![CDATA[<p>Ищем разработчика сайта, тел. +7 999 123-45-67</p>]]></description><pubDate>Wed, 04 Nov 2026 10:00:00 +0300</pubDate><category>Сайты</category></item>
<item><title>Дизайн логотипа</title><link>https://fl.ru/p/2</link><guid>2</guid><description>Логотип</description></item>
</channel></rss>"#;

    const ATOM_XML: &str = r#"<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>tag:x,1</id><title>Заказ</title>
<link rel="alternate" href="https://a.ru/1"/><link rel="self" href="https://a.ru/self"/><summary>Текст</summary><updated>2026-11-04T10:00:00Z</updated><category term="web"/></entry></feed>"#;

    #[test]
    fn parses_rss_and_atom() {
        let e = parse_feed(RSS_XML.as_bytes()).unwrap();
        assert_eq!(e.len(), 2);
        assert_eq!(e[0].title, "Нужен сайт & бот");
        assert_eq!(e[0].link, "https://fl.ru/p/1");
        assert_eq!(e[0].category.as_deref(), Some("Сайты"));
        assert!(e[0].summary.contains("<p>Ищем"));
        assert_eq!(e[0].published, parse_date("2026-11-04T07:00:00Z"));
        assert_eq!(e[1].id, "2");
        let a = parse_feed(ATOM_XML.as_bytes()).unwrap();
        assert_eq!(a[0].link, "https://a.ru/1");
        assert_eq!(a[0].id, "tag:x,1");
        assert_eq!(a[0].category.as_deref(), Some("web"));
        assert!(a[0].published.is_some());
        assert!(parse_feed(b"<<<").is_none());
    }

    fn feed_cfg(keywords: &[&str]) -> FeedSourceSettings {
        FeedSourceSettings { feeds: vec!["https://fl.ru/rss".into()], keywords: keywords.iter().map(|s| s.to_string()).collect(), ..Default::default() }
    }

    #[tokio::test]
    async fn rss_fetch_filters_remembers_seen_and_uses_etag() {
        let t = FakeTransport::new(vec![
            Ok(HttpResponse::new(200, RSS_XML).with_headers(&[("ETag", "v1")])),
            Ok(HttpResponse::new(304, "")),
        ]);
        let http = http_for(t.clone());
        let r = fetch_rss(&feed_cfg(&["сайт"]), None, &http).await.unwrap();
        assert_eq!(r.candidates.len(), 1);
        let d = &r.candidates[0].data;
        assert_eq!(d.source, "fl_ru");
        assert_eq!(d.title, "Нужен сайт & бот");
        assert_eq!(d.contacts["phone"], "+79991234567");
        assert_eq!(d.external_id, "https://fl.ru/p/1");
        let second = fetch_rss(&feed_cfg(&["сайт"]), r.cursor.as_deref(), &http).await.unwrap();
        assert!(second.candidates.is_empty());
        assert_eq!(t.requests.lock().unwrap()[1].headers.iter().find(|h| h.0 == "If-None-Match").map(|h| h.1.clone()), Some("v1".into()));
    }

    #[tokio::test]
    async fn rss_short_guid_gets_feed_prefix_and_bad_feed_is_partial_error() {
        let t = FakeTransport::new(vec![Ok(HttpResponse::new(200, RSS_XML))]);
        let r = fetch_rss(&feed_cfg(&[]), None, &http_for(t)).await.unwrap();
        assert_eq!(r.candidates.len(), 2);
        assert_eq!(r.candidates[1].data.external_id, "https://fl.ru/rss#2");
        let t = FakeTransport::new(vec![Ok(HttpResponse::new(200, "<<<"))]);
        let r = fetch_rss(&feed_cfg(&[]), None, &http_for(t)).await.unwrap();
        assert_eq!(r.partial_errors.len(), 1);
    }

    #[tokio::test]
    async fn rss_warns_when_feed_is_shorter_than_gap() {
        let t = FakeTransport::new(vec![Ok(HttpResponse::new(200, RSS_XML))]);
        let cursor = encode_cursor(&BTreeMap::from([("https://fl.ru/rss".to_string(), FeedCursor { seen: vec!["old".into()], ..Default::default() })]));
        let r = fetch_rss(&feed_cfg(&[]), cursor.as_deref(), &http_for(t)).await.unwrap();
        assert_eq!(r.warnings.len(), 1);
    }

    const TG_HTML: &str = r#"
<div class="tgme_widget_message" data-post="chan/101"><div class="tgme_widget_message_text js-message_text" dir="auto">Нужен сайт<br/>для кафе, тел @cafe_owner</div><time datetime="2026-11-04T10:00:00+00:00"></time></div>
<div class="tgme_widget_message" data-post="chan/102"><div class="tgme_widget_message_reply"><div class="tgme_widget_message_text">цитата</div></div><div class="tgme_widget_message_text js-message_text">Продам гараж</div></div>
<div class="tgme_widget_message" data-post="chan/103"><div class="tgme_widget_message_photo"></div></div>"#;

    #[test]
    fn parses_telegram_page() {
        let p = parse_telegram(TG_HTML);
        assert_eq!(p.len(), 3);
        assert_eq!(p[0].id, 101);
        assert_eq!(p[0].text, "Нужен сайт\nдля кафе, тел @cafe_owner");
        assert!(p[0].published.is_some());
        assert_eq!(p[0].url(), "https://t.me/chan/101");
        assert_eq!(p[1].text, "Продам гараж");
        assert_eq!(p[2].text, "");
    }

    #[tokio::test]
    async fn telegram_first_run_reads_one_page_and_stores_cursor() {
        let t = FakeTransport::new(vec![Ok(HttpResponse::new(200, TG_HTML))]);
        let cfg = TelegramSourceSettings { channels: vec!["chan".into()], keywords: vec!["сайт".into()], ..Default::default() };
        let r = fetch_telegram(&cfg, None, &http_for(t.clone())).await.unwrap();
        assert_eq!(r.candidates.len(), 1);
        assert_eq!(r.candidates[0].data.external_id, "chan/101");
        assert_eq!(r.candidates[0].data.contacts["telegram"], "@cafe_owner");
        assert_eq!(t.urls().len(), 1);
        assert_eq!(r.cursor.as_deref(), Some(r#"{"chan":103}"#));
        assert!(r.warnings.is_empty());
    }

    #[tokio::test]
    async fn telegram_walks_back_until_last_post_or_warns() {
        let page = |ids: &[i64]| {
            let body: String = ids.iter().map(|i| format!(r#"<div data-post="chan/{i}"><div class="tgme_widget_message_text js-message_text">пост {i} сайт</div></div>"#)).collect();
            Ok(HttpResponse::new(200, body))
        };
        let cfg = TelegramSourceSettings { channels: vec!["chan".into()], keywords: vec![], max_pages: 3, ..Default::default() };
        let t = FakeTransport::new(vec![page(&[110, 111, 112]), page(&[105, 106, 107, 108, 109]), page(&[100, 101, 102])]);
        let r = fetch_telegram(&cfg, Some(r#"{"chan":103}"#), &http_for(t.clone())).await.unwrap();
        assert_eq!(r.candidates.len(), 3 + 5 + 0);
        assert!(r.warnings.is_empty());
        assert!(t.urls()[1].ends_with("?before=110"));
        // не дошли до последнего поста за max_pages страниц
        let t = FakeTransport::new(vec![page(&[210, 211]), page(&[205, 206]), page(&[200, 201])]);
        let r = fetch_telegram(&cfg, Some(r#"{"chan":103}"#), &http_for(t)).await.unwrap();
        assert_eq!(r.warnings.len(), 1);
    }

    #[tokio::test]
    async fn telegram_missing_channel_is_partial_error() {
        let t = FakeTransport::new(vec![Ok(HttpResponse::new(200, "<html></html>"))]);
        let cfg = TelegramSourceSettings { channels: vec!["nochan".into()], ..Default::default() };
        let r = fetch_telegram(&cfg, None, &http_for(t)).await.unwrap();
        assert_eq!(r.partial_errors.len(), 1);
        assert_eq!(r.items, 1);
    }

    #[tokio::test]
    async fn vk_reads_wall_and_reports_api_errors() {
        let body = r#"{"response":{"count":2,"items":[{"id":7,"owner_id":-5,"date":1762250000,"text":"Нужен бот для магазина\nпишите"},{"id":6,"owner_id":-5,"text":"Погода"}]}}"#;
        let t = FakeTransport::new(vec![Ok(HttpResponse::new(200, body))]);
        let cfg = VkSourceSettings { communities: vec!["club".into()], keywords: vec!["бот".into()], ..Default::default() };
        let r = fetch_vk(&cfg, "tok", None, &http_for(t.clone())).await.unwrap();
        assert_eq!(r.candidates.len(), 1);
        let d = &r.candidates[0].data;
        assert_eq!(d.external_id, "-5_7");
        assert_eq!(d.url, "https://vk.com/wall-5_7");
        assert_eq!(d.title, "Нужен бот для магазина");
        assert!(t.urls()[0].contains("domain=club") && t.urls()[0].contains("v=5.199"));
        assert_eq!(r.cursor.as_deref(), Some(r#"{"club":7}"#));
        let t = FakeTransport::new(vec![Ok(HttpResponse::new(200, r#"{"error":{"error_code":5,"error_msg":"bad token"}}"#))]);
        let r = fetch_vk(&cfg, "tok", None, &http_for(t)).await.unwrap();
        assert_eq!(r.partial_errors, ["club: VK API 5: bad token"]);
    }

    #[tokio::test]
    async fn vk_pinned_old_post_does_not_stop_reading() {
        let body = r#"{"response":{"count":100,"items":[{"id":1,"is_pinned":1,"text":"закреп"},{"id":9,"text":"бот нужен"}]}}"#;
        let t = FakeTransport::new(vec![Ok(HttpResponse::new(200, body)), Ok(HttpResponse::new(200, r#"{"response":{"count":100,"items":[]}}"#))]);
        let cfg = VkSourceSettings { communities: vec!["club".into()], keywords: vec![], max_pages: 2, ..Default::default() };
        let r = fetch_vk(&cfg, "t", Some(r#"{"club":5}"#), &http_for(t.clone())).await.unwrap();
        assert_eq!(t.urls().len(), 2);
        assert_eq!(r.candidates.len(), 1);
    }

    #[test]
    fn overpass_query_covers_name_variants() {
        let q = build_overpass_query("Ере\"ван", &["[\"shop\"=\"beauty\"]".into()], 90);
        assert!(q.starts_with("[out:json][timeout:90];"));
        assert!(q.contains("area[\"name\"=\"Ереван\"][\"boundary\"=\"administrative\"]->.a0;"));
        assert!(q.contains("area[\"name:ru\"=\"Ереван\"][\"boundary\"=\"administrative\"]->.a1;"));
        assert!(q.contains("(.a0;.a1;.a2;)->.a;(nwr[\"shop\"=\"beauty\"](area.a););out center tags;"));
    }

    #[derive(Default)]
    pub struct MemoryStub {
        queries: Mutex<HashMap<String, DateTime<Utc>>>,
        objects: Mutex<HashMap<String, DateTime<Utc>>>,
    }

    impl SearchMemory for MemoryStub {
        fn query_last_run(&self, h: &str) -> Option<DateTime<Utc>> {
            self.queries.lock().unwrap().get(h).copied()
        }
        fn record_query(&self, h: &str, _: &str, _: &str, _: i64) {
            self.queries.lock().unwrap().insert(h.into(), Utc::now());
        }
        fn forget_query(&self, h: &str) {
            self.queries.lock().unwrap().remove(h);
        }
        fn object_checked_at(&self, s: &str, o: &str) -> Option<DateTime<Utc>> {
            self.objects.lock().unwrap().get(&format!("{s}|{o}")).copied()
        }
        fn mark_object_checked(&self, s: &str, o: &str) {
            self.objects.lock().unwrap().insert(format!("{s}|{o}"), Utc::now());
        }
    }

    fn osm_cfg() -> OsmSourceSettings {
        let mut c = OsmSourceSettings::default();
        c.regions = vec!["Ереван".into()];
        c.categories = cfg::osm_categories().into_iter().filter(|c| c.key == "beauty").collect();
        c
    }

    const OVERPASS: &str = r#"{"elements":[
      {"type":"node","id":1,"tags":{"name":"Салон А","phone":"+37411111111","addr:street":"Абовяна","addr:housenumber":"5"}},
      {"type":"way","id":2,"tags":{"name":"Салон Б","website":"https://salon-b.am"}},
      {"type":"node","id":3,"tags":{"shop":"beauty"}}]}"#;

    #[tokio::test]
    async fn osm_builds_organizations_with_verified_signals() {
        let t = FakeTransport::routes(vec![
            ("https://overpass-api.de/api/interpreter", Ok(HttpResponse::new(200, OVERPASS))),
            ("https://salon-b.am", Ok(HttpResponse::new(200, "<html><head><title>x</title></head><body>© 2015 Салон</body></html>"))),
        ]);
        let mem = MemoryStub::default();
        let http = http_for(t.clone());
        let site = http_for(t.clone());
        let r = fetch_osm(&osm_cfg(), &mem, &http, Some(&site), Utc::now()).await.unwrap();
        assert_eq!(r.candidates.len(), 2);
        let a = &r.candidates[0];
        assert_eq!(a.data.external_id, "node/1");
        assert_eq!(a.data.address.as_deref(), Some("Абовяна, 5"));
        assert_eq!(a.data.phone.as_deref(), Some("+37411111111"));
        assert_eq!(a.signals.get("no_website"), Some(&true));
        assert_eq!(a.category_weight, Some(20.0));
        assert!(a.data.assumptions.iter().any(|s| s.contains("онлайн-записью")));
        let b = &r.candidates[1];
        assert_eq!(b.data.external_id, "way/2");
        assert_eq!(b.signals.get("no_https"), Some(&false));
        assert_eq!(b.signals.get("no_viewport"), Some(&true));
        assert_eq!(b.signals.get("outdated"), Some(&true));
        assert_eq!(b.signals.get("no_booking"), Some(&true));
        assert_eq!(b.signals.get("site_unreachable"), Some(&false));
        // повторный запуск: запрос недавно выполнялся, организации уже проверены
        let t2 = FakeTransport::new(vec![]);
        let again = fetch_osm(&osm_cfg(), &mem, &http_for(t2.clone()), None, Utc::now()).await.unwrap();
        assert!(again.candidates.is_empty());
        assert!(t2.urls().is_empty());
    }

    #[tokio::test]
    async fn osm_respects_per_run_limit_and_forgets_partial_query() {
        let t = FakeTransport::routes(vec![("https://overpass-api.de/api/interpreter", Ok(HttpResponse::new(200, OVERPASS)))]);
        let mut cfg = osm_cfg();
        cfg.max_new_per_run = 1;
        cfg.check_websites = false;
        let mem = MemoryStub::default();
        let r = fetch_osm(&cfg, &mem, &http_for(t), None, Utc::now()).await.unwrap();
        assert_eq!(r.candidates.len(), 1);
        assert_eq!(r.warnings.len(), 1);
        let q = build_overpass_query("Ереван", &cfg.categories[0].filters, 90);
        assert!(mem.query_last_run(&short_hash(&q)).is_none());
    }

    #[tokio::test]
    async fn osm_http_failure_is_partial_error() {
        let t = FakeTransport::new(vec![Ok(HttpResponse::new(404, ""))]);
        let r = fetch_osm(&osm_cfg(), &MemoryStub::default(), &http_for(t), None, Utc::now()).await.unwrap();
        assert_eq!(r.partial_errors.len(), 1);
        assert_eq!(r.items, 1);
    }

    #[test]
    fn public_url_rules() {
        assert!(is_public_http_url("https://example.com/a"));
        for bad in ["ftp://example.com", "http://localhost/x", "http://127.0.0.1/", "http://10.0.0.5/", "http://192.168.0.1/", "http://172.16.0.1/", "http://169.254.1.1/", "http://printer.local/", "http://intranet/", "javascript:alert(1)"] {
            assert!(!is_public_http_url(bad), "{bad}");
        }
        assert!(is_public_http_url("http://172.32.0.1/"));
        assert_eq!(normalize_site_url(" salon.am "), "http://salon.am");
    }

    #[tokio::test]
    async fn site_check_reports_only_observed_facts() {
        let t = FakeTransport::routes(vec![(
            "https://good.am/",
            Ok(HttpResponse::new(200, r#"<meta name="viewport" content="width=device-width"> © 2012-2026 <a>Записаться онлайн</a>"#)),
        )]);
        let c = check_site("https://good.am/", &http_for(t), Utc::now()).await.unwrap();
        assert!(c.reachable && c.https && c.viewport && c.has_booking);
        assert_eq!(c.copyright_year, Some(2026));
        assert!(!c.facts.iter().any(|f| f.contains("без HTTPS")));
        let bad = check_site("http://127.0.0.1/", &http_for(FakeTransport::new(vec![])), Utc::now()).await.unwrap();
        assert!(!bad.reachable);
        assert!(bad.facts[0].contains("некорректный адрес"));
        let down = check_site("https://down.am", &http_for(FakeTransport::new(vec![Ok(HttpResponse::new(404, ""))])), Utc::now()).await.unwrap();
        assert!(!down.reachable);
        assert_eq!(down.status, Some(404));
    }
}
