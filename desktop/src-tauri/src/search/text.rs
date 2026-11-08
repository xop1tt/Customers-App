//! Разбор текста: нормализация, HTML, контакты, отпечатки.

use crate::models::LeadData;
use crate::util::{prefix_chars, short_hash};
use fancy_regex::Regex as FRegex;
use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::{BTreeMap, HashMap};

static URL_RX: Lazy<Regex> = Lazy::new(|| Regex::new(r"https?://\S+").unwrap());
static PUNCT_RX: Lazy<Regex> = Lazy::new(|| Regex::new(r"[^\w\s]").unwrap());
static SPACE_RX: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s+").unwrap());

/// Регистр, «ё», без ссылок и пунктуации.
pub fn normalize(text: &str) -> String {
    let t = text.to_lowercase().replace('ё', "е");
    let t = URL_RX.replace_all(&t, " ");
    let t = PUNCT_RX.replace_all(&t, " ");
    let t = SPACE_RX.replace_all(&t, " ");
    t.trim().to_string()
}

/// Быстрый предфильтр по ключевым словам (подстрока). Пустой список пропускает всё.
pub fn prefilter(text: &str, keywords: &[String]) -> bool {
    let words: Vec<String> = keywords.iter().map(|k| k.trim().to_lowercase().replace('ё', "е")).filter(|k| !k.is_empty()).collect();
    if words.is_empty() {
        return true;
    }
    let low = text.to_lowercase().replace('ё', "е");
    words.iter().any(|w| low.contains(w))
}

static SCRIPT_RX: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?is)<(script|style)\b[^>]*>.*?</(?:script|style)\s*>").unwrap());
static BR_RX: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)<br\s*/?>|</p\s*>|</div\s*>|</li\s*>").unwrap());
static TAG_RX: Lazy<Regex> = Lazy::new(|| Regex::new(r"<[^>]*>").unwrap());
static ENTITY_RX: Lazy<Regex> = Lazy::new(|| Regex::new(r"&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);").unwrap());

/// HTML в текст. `lines` — переносы строк сохраняются (посты Telegram), иначе всё в одну строку (RSS).
pub fn html_to_text(html: &str, lines: bool) -> String {
    let s = SCRIPT_RX.replace_all(html, " ");
    let s = BR_RX.replace_all(&s, if lines { "\n" } else { " " });
    let s = TAG_RX.replace_all(&s, if lines { "" } else { " " });
    let s = decode_entities(&s);
    if lines {
        return s
            .split('\n')
            .map(|l| SPACE_RX.replace_all(l, " ").trim().to_string())
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
    }
    SPACE_RX.replace_all(&s, " ").trim().to_string()
}

static NAMED: Lazy<HashMap<&'static str, &'static str>> = Lazy::new(|| {
    [
        ("amp", "&"), ("lt", "<"), ("gt", ">"), ("quot", "\""), ("apos", "'"), ("nbsp", " "), ("laquo", "«"), ("raquo", "»"),
        ("mdash", "—"), ("ndash", "–"), ("hellip", "…"), ("copy", "©"), ("reg", "®"), ("trade", "™"), ("bull", "•"),
        ("rsquo", "’"), ("lsquo", "‘"), ("rdquo", "”"), ("ldquo", "“"), ("bdquo", "„"), ("times", "×"), ("deg", "°"),
    ]
    .into_iter()
    .collect()
});

pub fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    ENTITY_RX
        .replace_all(s, |c: &regex::Captures| {
            let body = &c[1];
            let rep: Option<String> = if let Some(hex) = body.strip_prefix("#x").or_else(|| body.strip_prefix("#X")) {
                u32::from_str_radix(hex, 16).ok().and_then(char::from_u32).map(String::from)
            } else if let Some(dec) = body.strip_prefix('#') {
                dec.parse::<u32>().ok().and_then(char::from_u32).map(String::from)
            } else {
                NAMED.get(body.to_lowercase().as_str()).map(|s| s.to_string())
            };
            rep.unwrap_or_else(|| c[0].to_string())
        })
        .into_owned()
}

static EMAIL_RX: Lazy<Regex> = Lazy::new(|| Regex::new(r"[\w.+-]+@[\w-]+\.[\w.-]+").unwrap());
static PHONE_RX: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}").unwrap());
static TG_RX: Lazy<FRegex> = Lazy::new(|| FRegex::new(r"(?<![\w/])@([A-Za-z][A-Za-z0-9_]{4,31})\b|t\.me/([A-Za-z][A-Za-z0-9_]{4,31})").unwrap());

/// Только контакты, опубликованные в самом тексте. Ничего не додумываем.
pub fn contacts(text: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    if let Some(m) = EMAIL_RX.find(text) {
        out.insert("email".into(), m.as_str().trim_end_matches('.').to_string());
    }
    if let Some(m) = PHONE_RX.find(text) {
        out.insert("phone".into(), m.as_str().chars().filter(|c| c.is_numeric() || *c == '+').collect());
    }
    if let Ok(Some(c)) = TG_RX.captures(text) {
        if let Some(name) = c.get(1).or_else(|| c.get(2)) {
            out.insert("telegram".into(), format!("@{}", name.as_str()));
        }
    }
    out
}

pub fn lead_id(source: &str, external_id: &str) -> String {
    short_hash(&format!("{source}|{external_id}"))
}

static WWW_RX: Lazy<Regex> = Lazy::new(|| Regex::new(r"^(https?://)?(www\.)?").unwrap());

/// Отпечаток содержимого: одна и та же заявка или организация из разных мест.
pub fn fingerprint(d: &LeadData) -> String {
    if d.is_organization() {
        let mut domain = String::new();
        if let Some(w) = d.website.as_deref().filter(|w| !w.is_empty()) {
            domain = WWW_RX.replace(&w.to_lowercase(), "").split('/').next().unwrap_or("").to_string();
        }
        let digits: String = d.phone.clone().unwrap_or_default().chars().filter(|c| c.is_numeric()).collect();
        let phone: String = digits.chars().rev().take(10).collect::<Vec<_>>().into_iter().rev().collect();
        let key = if !domain.is_empty() {
            domain
        } else if !phone.is_empty() {
            phone
        } else {
            format!("{}|{}", normalize(&d.title), normalize(d.address.as_deref().unwrap_or("")))
        };
        return short_hash(&format!("org|{key}"));
    }
    let body = prefix_chars(&normalize(&format!("{} {}", d.title, d.description)), 400);
    short_hash(&format!("order|{body}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_text() {
        assert_eq!(normalize("Нужен САЙТ, ёлка! https://x.ru/a"), "нужен сайт елка");
    }

    #[test]
    fn prefilter_rules() {
        assert!(prefilter("любой текст", &[]));
        assert!(prefilter("Разработка сайта", &["САЙТ".into()]));
        assert!(!prefilter("дизайн логотипа", &["сайт".into()]));
    }

    #[test]
    fn html_modes() {
        let h = "<p>Привет&nbsp;мир</p><p>Вторая&amp;строка</p><script>x()</script>";
        assert_eq!(html_to_text(h, true), "Привет мир\nВторая&строка");
        assert_eq!(html_to_text(h, false), "Привет мир Вторая&строка");
    }

    #[test]
    fn entities() {
        assert_eq!(decode_entities("&#65;&#x42;&laquo;x&raquo;&unknown;"), "AB«x»&unknown;");
    }

    #[test]
    fn finds_contacts() {
        let c = contacts("Пишите test.user@mail.ru. Тел +7 (999) 123-45-67, tg @fast_dev");
        assert_eq!(c["email"], "test.user@mail.ru");
        assert_eq!(c["phone"], "+79991234567");
        assert_eq!(c["telegram"], "@fast_dev");
        assert!(contacts("a@b.c/@short").get("telegram").is_none());
    }

    #[test]
    fn ids_are_stable() {
        assert_eq!(lead_id("fl_ru", "1").len(), 24);
        assert_eq!(lead_id("fl_ru", "1"), lead_id("fl_ru", "1"));
        assert_ne!(lead_id("fl_ru", "1"), lead_id("fl_ru", "2"));
    }
}
