//! Собственная оценка без AI: ключевые слова и веса. Это оценка системы, а не факт.

use crate::models::{LeadData, Relevance};
use crate::search::text::normalize;
use chrono::{DateTime, Utc};
use once_cell::sync::Lazy;
use regex::{Regex, RegexBuilder};
use std::collections::HashMap;

fn strs(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

/// Правила оценки. Значения по умолчанию совпадают с config.yaml Python-версии.
#[derive(Debug, Clone)]
pub struct OrderScoring {
    pub max_age_days: f64,
    pub min_budget_rub: f64,
    pub high: f64,
    pub medium: f64,
    pub low: f64,
    pub w_topic: f64,
    pub w_intent: f64,
    pub w_offer_penalty: f64,
    pub w_budget: f64,
    pub w_low_budget_penalty: f64,
    pub w_urgency: f64,
    pub w_completeness: f64,
    pub w_too_short_penalty: f64,
    pub w_customer_type: f64,
    pub w_feasibility: f64,
    pub w_feasibility_penalty: f64,
    pub w_spam_penalty: f64,
    pub w_freshness: f64,
    pub project_types: Vec<(String, Vec<String>)>,
    pub intent: Vec<String>,
    pub offers: Vec<String>,
    pub stop_words: Vec<String>,
    pub spam: Vec<String>,
    pub urgency: Vec<String>,
    pub business: Vec<String>,
    pub hard: Vec<String>,
}

impl Default for OrderScoring {
    fn default() -> Self {
        Self {
            max_age_days: 14.0,
            min_budget_rub: 3000.0,
            high: 65.0,
            medium: 45.0,
            low: 25.0,
            w_topic: 30.0,
            w_intent: 20.0,
            w_offer_penalty: 35.0,
            w_budget: 15.0,
            w_low_budget_penalty: 10.0,
            w_urgency: 5.0,
            w_completeness: 10.0,
            w_too_short_penalty: 10.0,
            w_customer_type: 5.0,
            w_feasibility: 5.0,
            w_feasibility_penalty: 15.0,
            w_spam_penalty: 40.0,
            w_freshness: 10.0,
            project_types: vec![
                ("site".into(), strs(&["сайт", "лендинг", "landing", "интернет-магазин", "wordpress", "tilda", "тильда", "битрикс", "верстк", "одностраничник"])),
                ("telegram_bot".into(), strs(&["телеграм бот", "telegram бот", "телеграм-бот", "telegram-бот", "бот для телеграм", "бот в телеграм", "чат-бот", "чат бот", "tg бот", "aiogram", "бота"])),
                ("mobile_app".into(), strs(&["мобильное приложение", "мобильного приложения", "приложение для ios", "приложение для android", "flutter", "react native", "android", "ios"])),
                ("web_app".into(), strs(&["веб-приложение", "веб приложение", "web-приложение", "веб-сервис", "личный кабинет", "react", "vue", "django", "fastapi", "nextjs", "next js"])),
                ("automation".into(), strs(&["автоматизац", "парсер", "парсинг", "скрипт", "интеграц", "api", "google таблиц", "google sheets", "webhook", "n8n", "zapier"])),
                ("crm".into(), strs(&["crm", "срм", "amocrm", "битрикс24", "учетн систем", "внутренн систем", "erp"])),
                ("support".into(), strs(&["доработ", "исправить", "баг", "модерниз", "редизайн", "поддержка сайта", "перенести сайт"])),
            ],
            intent: strs(&["ищу", "ищем", "нужен", "нужна", "нужно", "требуется", "требуются", "кто может", "кто сделает", "кто возьмется", "хочу заказать", "заказать", "техническое задание", "тз"]),
            offers: strs(&["сделаю", "разработаю", "создам", "предлагаю услуги", "мои услуги", "ищу заказы", "ищу заказчиков", "беру заказы", "возьму заказ", "мое портфолио", "моё портфолио"]),
            stop_words: strs(&["в штат", "оклад", "полный рабочий день", "резюме", "стажировк", "казино", "ставки на спорт", "букмекер", "закладк", "обнал", "накрутк", "без оплаты", "за отзыв", "даркнет", "взлом", "18+"]),
            spam: strs(&["заработок от", "доход от", "пассивный доход", "подписывайся", "розыгрыш", "промокод", "арбитраж трафика", "реферал"]),
            urgency: strs(&["срочно", "сегодня", "до завтра", "в кратчайшие сроки", "asap", "горит"]),
            business: strs(&["компания", "компании", "ооо", "бизнес", "магазин", "студия", "салон", "клиника", "ресторан", "школа", "агентство", "производство"]),
            hard: strs(&["1с", "1c", "unity", "unreal", "микроконтроллер", "arduino", "embedded", "fpga", "plc", "solidity", "смарт-контракт", "в офис"]),
        }
    }
}

#[derive(Debug, Clone)]
pub struct OrganizationScoring {
    pub high: f64,
    pub medium: f64,
    pub low: f64,
    pub base: f64,
    pub signals: Vec<(String, String, f64)>,
    pub has_contacts: f64,
    pub no_contacts_penalty: f64,
}

impl Default for OrganizationScoring {
    fn default() -> Self {
        let s = |a: &str, b: &str, w: f64| (a.to_string(), b.to_string(), w);
        Self {
            high: 60.0,
            medium: 40.0,
            low: 25.0,
            base: 10.0,
            signals: vec![
                s("no_website", "сайт не указан в источнике", 35.0),
                s("site_unreachable", "сайт недоступен", 30.0),
                s("no_https", "нет HTTPS", 10.0),
                s("no_viewport", "нет мобильной вёрстки (meta viewport)", 15.0),
                s("outdated", "сайт выглядит устаревшим", 15.0),
                s("no_booking", "нет онлайн-записи (предположение о потребности)", 10.0),
            ],
            has_contacts: 10.0,
            no_contacts_penalty: 20.0,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct Scorer {
    pub orders: OrderScoring,
    pub organizations: OrganizationScoring,
}

fn pts(v: f64) -> String {
    format!("{v:.0}")
}

fn classify(score: f64, high: f64, medium: f64, low: f64) -> Relevance {
    if score >= high {
        Relevance::High
    } else if score >= medium {
        Relevance::Medium
    } else if score >= low {
        Relevance::Low
    } else {
        Relevance::Rejected
    }
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Слова, найденные в нормализованном тексте (по началу слова).
pub fn contains_any(text: &str, words: &[String]) -> Vec<String> {
    words
        .iter()
        .filter(|w| {
            let wn = normalize(w);
            if wn.is_empty() {
                return false;
            }
            text.match_indices(&wn).any(|(i, _)| text[..i].chars().next_back().map(|c| !is_word_char(c)).unwrap_or(true))
        })
        .cloned()
        .collect()
}

fn round1(v: f64) -> f64 {
    (v.clamp(0.0, 100.0) * 10.0).round() / 10.0
}

impl Scorer {
    pub fn score_order(&self, lead: &mut LeadData, now: DateTime<Utc>) {
        let o = &self.orders;
        let text = normalize(&format!("{} {}", lead.title, lead.description));
        let mut reasons: Vec<String> = Vec::new();
        let mut total = 0.0;

        let stop = contains_any(&text, &o.stop_words);
        if !stop.is_empty() {
            lead.score = 0.0;
            lead.relevance = Relevance::Rejected;
            lead.score_reasons = vec![format!("стоп-слова: {}", stop.iter().take(3).cloned().collect::<Vec<_>>().join(", "))];
            return;
        }

        // 1. Тематика разработки и тип проекта
        let mut best: Option<(&str, usize)> = None;
        for (ty, words) in &o.project_types {
            let hits = contains_any(&text, words).len();
            if hits > best.map(|b| b.1).unwrap_or(0) {
                best = Some((ty.as_str(), hits));
            }
        }
        let Some((best_type, best_hits)) = best else {
            lead.score = 0.0;
            lead.relevance = Relevance::Rejected;
            lead.score_reasons = vec!["нет признаков разработки".into()];
            return;
        };
        if lead.project_type.is_none() {
            lead.project_type = Some(best_type.to_string());
        }
        let topic = o.w_topic * (0.6 + 0.2 * best_hits as f64).min(1.0);
        total += topic;
        reasons.push(format!("тематика «{best_type}» (+{})", pts(topic)));

        // 2. Конкретный запрос
        if let Some(first) = contains_any(&text, &o.intent).first() {
            total += o.w_intent;
            reasons.push(format!("явный запрос: «{first}» (+{})", pts(o.w_intent)));
        }
        if !contains_any(&text, &o.offers).is_empty() {
            total -= o.w_offer_penalty;
            reasons.push("похоже на предложение услуг, а не заказ".into());
        }

        // 3. Бюджет
        if lead.budget.is_none() {
            if let Some((v, c)) = Budget::parse(&format!("{} {}", lead.title, lead.description)) {
                lead.budget = Some(v);
                lead.currency = Some(c);
            }
        }
        if let Some(budget) = lead.budget.filter(|b| *b > 0.0) {
            total += o.w_budget;
            reasons.push(format!("указан бюджет (+{})", pts(o.w_budget)));
            if lead.currency.as_deref() == Some("RUB") && o.min_budget_rub > 0.0 && budget < o.min_budget_rub {
                total -= o.w_low_budget_penalty;
                reasons.push(format!("бюджет ниже {} ₽", pts(o.min_budget_rub)));
            }
        }

        // 4. Срочность
        if !contains_any(&text, &o.urgency).is_empty() {
            total += o.w_urgency;
            reasons.push("срочно".into());
        }

        // 5. Полнота описания
        let words = text.split_whitespace().count();
        if words >= 40 {
            total += o.w_completeness;
            reasons.push("подробное описание".into());
        } else if words < 8 {
            total -= o.w_too_short_penalty;
            reasons.push("слишком короткое описание".into());
        }

        // 6. Тип заказчика
        if !contains_any(&text, &o.business).is_empty() {
            total += o.w_customer_type;
            reasons.push("заказчик — бизнес".into());
        }

        // 7. Выполнимость силами одного разработчика
        if let Some(h) = contains_any(&text, &o.hard).first() {
            total -= o.w_feasibility_penalty;
            reasons.push(format!("сложно выполнить удалённо/в одиночку: {h}"));
        } else {
            total += o.w_feasibility;
        }

        // 8. Спам
        let links = lead.description.matches("http://").count() + lead.description.matches("https://").count();
        if !contains_any(&text, &o.spam).is_empty() || links > 5 {
            total -= o.w_spam_penalty;
            reasons.push("признаки спама".into());
        }

        // 9. Свежесть
        if let Some(published) = lead.published_at {
            let age = (now - published).num_milliseconds() as f64 / 1000.0;
            if age > o.max_age_days * 86400.0 {
                lead.score = 0.0;
                lead.relevance = Relevance::Rejected;
                reasons.push("устарело".into());
                lead.score_reasons = reasons;
                return;
            }
            if age <= 86400.0 {
                total += o.w_freshness;
                reasons.push("свежая публикация".into());
            }
        }

        lead.score = round1(total);
        lead.relevance = classify(lead.score, o.high, o.medium, o.low);
        lead.score_reasons = reasons;
    }

    /// Организация: опирается только на проверенные сигналы из проверки сайта.
    pub fn score_organization(&self, lead: &mut LeadData, category_weight: Option<f64>, signals: &HashMap<String, bool>) {
        let g = &self.organizations;
        let mut reasons = Vec::new();
        let mut total = category_weight.unwrap_or(g.base);
        reasons.push(format!("категория «{}» (+{})", lead.category.as_deref().unwrap_or("—"), pts(total)));
        for (key, label, w) in &g.signals {
            if signals.get(key) == Some(&true) {
                total += w;
                reasons.push(format!("{label} (+{})", pts(*w)));
            }
        }
        if !lead.phone.as_deref().unwrap_or("").is_empty() || !lead.contacts.is_empty() {
            total += g.has_contacts;
            reasons.push("есть публичный контакт".into());
        } else {
            total -= g.no_contacts_penalty;
            reasons.push("нет контактов".into());
        }
        lead.score = round1(total);
        lead.relevance = classify(lead.score, g.high, g.medium, g.low);
        lead.score_reasons = reasons;
    }
}

/// Бюджет в тексте заказа.
pub struct Budget;

const NUM: &str = r"(\d[\d\s.,]*\d|\d)";

static WITH_CURRENCY: Lazy<Regex> = Lazy::new(|| {
    RegexBuilder::new(&format!(r"{NUM}\s*(тыс\.?|тысяч|к|k|млн)?\s*(руб(?:лей|\.|ля)?|р\.|₽|rub|\$|usd|долл\w*|€|eur)")).case_insensitive(true).build().unwrap()
});
static WITH_PREFIX: Lazy<Regex> =
    Lazy::new(|| RegexBuilder::new(&format!(r"бюджет[:\s—-]*(?:до|от|около)?\s*{NUM}\s*(тыс\.?|тысяч|к|k|млн)?")).case_insensitive(true).build().unwrap());
static THOUSANDS: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\d{1,3}([.,]\d{3})+$").unwrap());

impl Budget {
    fn number(raw: &str, mult: Option<&str>) -> Option<f64> {
        let mut s: String = raw.chars().filter(|c| !c.is_whitespace() && *c != '\u{00a0}').collect();
        if THOUSANDS.is_match(&s) {
            s = s.replace(['.', ','], "");
        } else {
            s = s.replace(',', ".");
        }
        let mut value: f64 = s.parse().ok()?;
        let m = mult.unwrap_or("").to_lowercase();
        let m = m.trim_end_matches('.');
        if ["тыс", "тысяч", "к", "k"].contains(&m) {
            value *= 1000.0;
        } else if m == "млн" {
            value *= 1_000_000.0;
        }
        Some(value)
    }

    pub fn parse(text: &str) -> Option<(f64, String)> {
        if let Some(m) = WITH_CURRENCY.captures(text) {
            if let (Some(raw), Some(cur)) = (m.get(1), m.get(3)) {
                let cur = cur.as_str().to_lowercase();
                let currency = match cur.as_str() {
                    "$" | "usd" => "USD",
                    "€" | "eur" => "EUR",
                    c if c.starts_with("долл") => "USD",
                    _ => "RUB",
                };
                if let Some(v) = Self::number(raw.as_str(), m.get(2).map(|x| x.as_str())) {
                    if v > 0.0 && (v >= 100.0 || currency != "RUB") {
                        return Some((v, currency.into()));
                    }
                }
            }
        }
        if let Some(m) = WITH_PREFIX.captures(text) {
            if let Some(raw) = m.get(1) {
                if let Some(v) = Self::number(raw.as_str(), m.get(2).map(|x| x.as_str())) {
                    if v >= 100.0 {
                        return Some((v, "RUB".into()));
                    }
                }
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::LeadKind;
    use chrono::Duration;

    fn order(title: &str, desc: &str) -> LeadData {
        let mut l = LeadData::new(LeadKind::Order, "fl_ru", "1", title);
        l.description = desc.into();
        l
    }

    fn now() -> DateTime<Utc> {
        Utc::now()
    }

    #[test]
    fn clear_order_is_scored_high() {
        let mut l = order("Нужен сайт для компании", "Ищем разработчика интернет-магазина, срочно. Бюджет 50000 руб. ".repeat(3).as_str());
        l.published_at = Some(now() - Duration::hours(2));
        Scorer::default().score_order(&mut l, now());
        assert!(l.score >= 65.0, "{} {:?}", l.score, l.score_reasons);
        assert_eq!(l.relevance, Relevance::High);
        assert_eq!(l.project_type.as_deref(), Some("site"));
        assert_eq!(l.budget, Some(50000.0));
        assert_eq!(l.currency.as_deref(), Some("RUB"));
        assert!(l.score_reasons.iter().any(|r| r.contains("свежая")));
    }

    #[test]
    fn stop_words_reject() {
        let mut l = order("Нужен сайт", "ищем в штат программиста, оклад");
        Scorer::default().score_order(&mut l, now());
        assert_eq!(l.score, 0.0);
        assert_eq!(l.relevance, Relevance::Rejected);
        assert!(l.score_reasons[0].starts_with("стоп-слова"));
    }

    #[test]
    fn no_development_topic_is_rejected() {
        let mut l = order("Продам диван", "Хороший диван, самовывоз");
        Scorer::default().score_order(&mut l, now());
        assert_eq!(l.score_reasons, ["нет признаков разработки"]);
    }

    #[test]
    fn offers_are_penalised() {
        let mut order_l = order("Нужен лендинг", "Нужен лендинг для магазина, подробное тз пришлю");
        let mut offer = order("Сделаю лендинг", "Сделаю лендинг, мои услуги недорого");
        let s = Scorer::default();
        s.score_order(&mut order_l, now());
        s.score_order(&mut offer, now());
        assert!(order_l.score > offer.score);
        assert!(offer.score_reasons.iter().any(|r| r.contains("предложение услуг")));
    }

    #[test]
    fn old_posts_are_rejected() {
        let mut l = order("Нужен сайт", "Нужен сайт для компании");
        l.published_at = Some(now() - Duration::days(30));
        Scorer::default().score_order(&mut l, now());
        assert_eq!(l.score, 0.0);
        assert_eq!(l.score_reasons.last().map(String::as_str), Some("устарело"));
    }

    #[test]
    fn word_start_matching() {
        assert_eq!(contains_any("нужна разработка сайта", &["разработ".into()]), ["разработ"]);
        assert!(contains_any("подготовка", &["готов".into()]).is_empty());
    }

    #[test]
    fn budget_parsing() {
        assert_eq!(Budget::parse("бюджет 50 000 руб"), Some((50000.0, "RUB".into())));
        assert_eq!(Budget::parse("за 30 тыс. рублей"), Some((30000.0, "RUB".into())));
        assert_eq!(Budget::parse("до 500$"), Some((500.0, "USD".into())));
        assert_eq!(Budget::parse("100 EUR"), Some((100.0, "EUR".into())));
        assert_eq!(Budget::parse("1.500.000 ₽"), Some((1_500_000.0, "RUB".into())));
        assert_eq!(Budget::parse("бюджет: от 20к"), Some((20000.0, "RUB".into())));
        assert_eq!(Budget::parse("5 руб"), None);
        assert_eq!(Budget::parse("без бюджета"), None);
    }

    #[test]
    fn organization_scoring_uses_verified_signals() {
        let mut l = LeadData::new(LeadKind::Organization, "osm_organizations", "node/1", "Салон");
        l.category = Some("Салоны красоты".into());
        l.phone = Some("+37400000000".into());
        let mut signals = HashMap::new();
        signals.insert("no_website".to_string(), true);
        Scorer::default().score_organization(&mut l, Some(20.0), &signals);
        assert_eq!(l.score, 65.0);
        assert_eq!(l.relevance, Relevance::High);
        let mut bare = LeadData::new(LeadKind::Organization, "osm_organizations", "node/2", "Кафе");
        Scorer::default().score_organization(&mut bare, None, &HashMap::new());
        assert_eq!(bare.score, 0.0);
        assert!(bare.score_reasons.iter().any(|r| r == "нет контактов"));
    }
}
