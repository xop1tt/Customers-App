//! Экспорт лидов в файл (CSV, JSON) и черновики первого обращения по шаблону (без AI).

use crate::csvfmt;
use crate::models::{LeadData, LeadItem, LeadKind};
use crate::util::{format_date, source_title};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum ExportField {
    Id,
    Kind,
    Title,
    Source,
    Score,
    Relevance,
    Region,
    Category,
    Address,
    Phone,
    Website,
    Emails,
    Url,
    DiscoveredAt,
    Budget,
    Reasons,
    Facts,
    Assumptions,
    Favorite,
    Note,
    Description,
}

impl ExportField {
    pub const ALL: [ExportField; 21] = [
        ExportField::Id, ExportField::Kind, ExportField::Title, ExportField::Source, ExportField::Score,
        ExportField::Relevance, ExportField::Region, ExportField::Category, ExportField::Address, ExportField::Phone,
        ExportField::Website, ExportField::Emails, ExportField::Url, ExportField::DiscoveredAt, ExportField::Budget,
        ExportField::Reasons, ExportField::Facts, ExportField::Assumptions, ExportField::Favorite, ExportField::Note,
        ExportField::Description,
    ];

    pub const DEFAULTS: [ExportField; 14] = [
        ExportField::Title, ExportField::Kind, ExportField::Source, ExportField::Score, ExportField::Relevance,
        ExportField::Region, ExportField::Category, ExportField::Address, ExportField::Phone, ExportField::Website,
        ExportField::Emails, ExportField::Url, ExportField::DiscoveredAt, ExportField::Reasons,
    ];

    /// Ключ поля в JSON и в интерфейсе (совпадает с rawValue прежних версий).
    pub fn key(self) -> &'static str {
        match self {
            ExportField::Id => "id",
            ExportField::Kind => "kind",
            ExportField::Title => "title",
            ExportField::Source => "source",
            ExportField::Score => "score",
            ExportField::Relevance => "relevance",
            ExportField::Region => "region",
            ExportField::Category => "category",
            ExportField::Address => "address",
            ExportField::Phone => "phone",
            ExportField::Website => "website",
            ExportField::Emails => "emails",
            ExportField::Url => "url",
            ExportField::DiscoveredAt => "discoveredAt",
            ExportField::Budget => "budget",
            ExportField::Reasons => "reasons",
            ExportField::Facts => "facts",
            ExportField::Assumptions => "assumptions",
            ExportField::Favorite => "favorite",
            ExportField::Note => "note",
            ExportField::Description => "description",
        }
    }

    pub fn from_key(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|f| f.key() == key)
    }

    pub fn title(self) -> &'static str {
        match self {
            ExportField::Id => "ID",
            ExportField::Kind => "Тип",
            ExportField::Title => "Название",
            ExportField::Source => "Источник",
            ExportField::Score => "Оценка",
            ExportField::Relevance => "Релевантность",
            ExportField::Region => "Регион",
            ExportField::Category => "Категория",
            ExportField::Address => "Адрес",
            ExportField::Phone => "Телефон",
            ExportField::Website => "Сайт",
            ExportField::Emails => "Email",
            ExportField::Url => "Ссылка",
            ExportField::DiscoveredAt => "Обнаружен",
            ExportField::Budget => "Бюджет",
            ExportField::Reasons => "Причины оценки",
            ExportField::Facts => "Факты",
            ExportField::Assumptions => "Предположения",
            ExportField::Favorite => "Избранное",
            ExportField::Note => "Заметка",
            ExportField::Description => "Описание",
        }
    }

    pub fn value(self, l: &LeadItem) -> String {
        let d = &l.data;
        match self {
            ExportField::Id => l.id.clone(),
            ExportField::Kind => d.kind.title().into(),
            ExportField::Title => d.title.clone(),
            ExportField::Source => source_title(&d.source),
            ExportField::Score => format!("{}", d.score.round() as i64),
            ExportField::Relevance => d.relevance.title().into(),
            ExportField::Region => d.region.clone().unwrap_or_default(),
            ExportField::Category => d.category.clone().or_else(|| d.project_type.clone()).unwrap_or_default(),
            ExportField::Address => d.address.clone().unwrap_or_default(),
            ExportField::Phone => d.phones().join(", "),
            ExportField::Website => d.website.clone().unwrap_or_default(),
            ExportField::Emails => d.emails().join(", "),
            ExportField::Url => d.url.clone(),
            ExportField::DiscoveredAt => format_date(&l.discovered_at),
            ExportField::Budget => d
                .budget
                .map(|b| format!("{} {}", b as i64, d.currency.clone().unwrap_or_default()).trim().to_string())
                .unwrap_or_default(),
            ExportField::Reasons => d.score_reasons.join("; "),
            ExportField::Facts => d.facts.join("; "),
            ExportField::Assumptions => d.assumptions.join("; "),
            ExportField::Favorite => if l.favorite { "да".into() } else { String::new() },
            ExportField::Note => l.note.clone(),
            ExportField::Description => d.description.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Csv,
    Json,
}

impl ExportFormat {
    pub fn extension(self) -> &'static str {
        match self {
            ExportFormat::Csv => "csv",
            ExportFormat::Json => "json",
        }
    }
}

/// CSV с BOM, чтобы Excel правильно открыл кириллицу.
pub fn csv(leads: &[LeadItem], fields: &[ExportField]) -> Vec<u8> {
    let mut lines = vec![fields.iter().map(|f| csvfmt::escape(f.title())).collect::<Vec<_>>().join(",")];
    for l in leads {
        lines.push(fields.iter().map(|f| csvfmt::escape(&f.value(l))).collect::<Vec<_>>().join(","));
    }
    let mut out = vec![0xEF, 0xBB, 0xBF];
    out.extend((lines.join("\r\n") + "\r\n").into_bytes());
    out
}

pub fn json(leads: &[LeadItem], fields: &[ExportField]) -> Result<Vec<u8>, serde_json::Error> {
    let rows: Vec<BTreeMap<&str, String>> =
        leads.iter().map(|l| fields.iter().map(|f| (f.key(), f.value(l))).collect()).collect();
    serde_json::to_vec_pretty(&rows)
}

pub fn export(leads: &[LeadItem], format: ExportFormat, fields: &[ExportField]) -> Result<Vec<u8>, serde_json::Error> {
    match format {
        ExportFormat::Csv => Ok(csv(leads, fields)),
        ExportFormat::Json => json(leads, fields),
    }
}

// ---------------------------------------------------------------- черновики обращений

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Message,
    Email,
    Call,
}

fn service_name(project_type: &str) -> Option<&'static str> {
    Some(match project_type {
        "site" => "сайт",
        "telegram_bot" => "Telegram-бот",
        "mobile_app" => "мобильное приложение",
        "web_app" => "веб-приложение",
        "automation" => "автоматизацию",
        "crm" => "CRM-систему",
        "support" => "доработку существующего проекта",
        _ => return None,
    })
}

/// Черновик первого обращения по шаблону, без AI. Отправка только вручную.
pub fn draft(lead: &LeadData, channel: Channel, signature: &str) -> String {
    let sign = signature.trim();
    let greeting = if channel == Channel::Call {
        format!("Добрый день! Меня зовут {}, я разработчик.", if sign.is_empty() { "…" } else { sign })
    } else {
        "Здравствуйте!".to_string()
    };
    let body = match lead.kind {
        LeadKind::Order => {
            let what = lead.project_type.as_deref().and_then(service_name).unwrap_or("этот проект");
            let mut b = format!(
                "Увидел вашу заявку «{}». Делаю {} под ключ: могу коротко рассказать, как бы я это реализовал, и назвать срок и стоимость после пары уточняющих вопросов.",
                lead.title, what
            );
            if lead.budget.is_some() {
                b.push_str(" Бюджет вижу, предложение уложу в него.");
            }
            b
        }
        LeadKind::Organization => {
            let name = lead.customer_name.clone().unwrap_or_else(|| lead.title.clone());
            let facts: Vec<String> = lead.facts.iter().map(|f| f.to_lowercase()).collect();
            let any = |p: &dyn Fn(&str) -> bool| facts.iter().any(|f| p(f));
            let problem = if lead.website.as_deref().map(str::is_empty).unwrap_or(true) || any(&|f| f.contains("не указан сайт")) {
                format!("не нашёл у «{name}» сайта, где можно посмотреть услуги и записаться онлайн")
            } else if any(&|f| f.contains("не открылся") || (f.contains("http") && f.contains('5'))) {
                format!("сайт «{name}» сейчас не открывается")
            } else if any(&|f| f.contains("viewport") || f.contains("мобильн")) {
                format!("сайт «{name}» неудобно открывается с телефона")
            } else if any(&|f| f.contains("запис")) {
                format!("на сайте «{name}» нет онлайн-записи")
            } else {
                format!("у «{name}» можно упростить работу с клиентами")
            };
            format!("Обратил внимание, что {problem}. Я делаю небольшие сайты, онлайн-запись и Telegram-ботов для бизнеса. Могу бесплатно показать, как это выглядело бы у вас, — займёт пять минут.")
        }
    };
    let mut text = if channel == Channel::Call { format!("{greeting} {body}") } else { format!("{greeting}\n\n{body}") };
    if channel != Channel::Call && !sign.is_empty() {
        text.push_str(&format!("\n\n{sign}"));
    }
    if channel == Channel::Email {
        let subject = if lead.kind == LeadKind::Order {
            format!("Ваша заявка: {}", lead.title)
        } else {
            format!("Предложение для {}", lead.customer_name.clone().unwrap_or_else(|| lead.title.clone()))
        };
        text = format!("Тема: {subject}\n\n{text}");
    }
    text
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EmailDraft {
    pub subject: String,
    pub body: String,
}

/// Делит текст «Тема: …\n\nТекст» на тему и текст. Без строки темы тема пустая.
pub fn split_email(text: &str) -> EmailDraft {
    let prefix = "Тема:";
    let Some(rest) = text.strip_prefix(prefix) else {
        return EmailDraft { subject: String::new(), body: text.to_string() };
    };
    let (first, tail) = match rest.split_once('\n') {
        Some((a, b)) => (a, b),
        None => (rest, ""),
    };
    EmailDraft { subject: first.trim().to_string(), body: tail.trim_matches('\n').to_string() }
}

pub fn email_draft(lead: &LeadData, signature: &str) -> EmailDraft {
    split_email(&draft(lead, Channel::Email, signature))
}

/// Для интерфейса: список полей экспорта с названиями.
pub fn fields_for_ui() -> Value {
    Value::Array(
        ExportField::ALL
            .iter()
            .map(|f| serde_json::json!({"key": f.key(), "title": f.title(), "default": ExportField::DEFAULTS.contains(f)}))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Relevance;
    use chrono::TimeZone;

    fn item(title: &str) -> LeadItem {
        let mut d = LeadData::new(LeadKind::Order, "fl_ru", "1", title);
        d.score = 71.4;
        d.relevance = Relevance::High;
        d.contacts.insert("phone".into(), "+7 843 000-00-00".into());
        LeadItem {
            id: "abc".into(),
            data: d,
            discovered_at: chrono::Utc.with_ymd_and_hms(2026, 11, 5, 9, 42, 0).unwrap(),
            favorite: true,
            archived: false,
            excluded: false,
            seen: false,
            note: String::new(),
        }
    }

    #[test]
    fn csv_has_bom_header_and_crlf() {
        let out = csv(&[item("Сайт для салона")], &[ExportField::Title, ExportField::Score, ExportField::Favorite, ExportField::Phone]);
        assert_eq!(&out[..3], &[0xEF, 0xBB, 0xBF]);
        let text = String::from_utf8(out[3..].to_vec()).unwrap();
        assert_eq!(text, "Название,Оценка,Избранное,Телефон\r\nСайт для салона,71,да,+7 843 000-00-00\r\n");
    }

    #[test]
    fn csv_neutralizes_formulas() {
        let out = csv(&[item("=1+1")], &[ExportField::Title]);
        assert!(String::from_utf8(out).unwrap().contains("'=1+1"));
    }

    #[test]
    fn json_has_sorted_keys_and_no_escaped_slashes() {
        let mut it = item("t");
        it.data.url = "https://x.ru/a".into();
        let out = String::from_utf8(json(&[it], &[ExportField::Url, ExportField::Title]).unwrap()).unwrap();
        assert!(out.contains("https://x.ru/a"));
        assert!(out.find("\"title\"").unwrap() < out.find("\"url\"").unwrap());
    }

    #[test]
    fn email_draft_has_subject() {
        let it = item("Нужен бот");
        let d = email_draft(&it.data, "Максим");
        assert_eq!(d.subject, "Ваша заявка: Нужен бот");
        assert!(d.body.starts_with("Здравствуйте!"));
        assert!(d.body.ends_with("Максим"));
        assert_eq!(split_email("без темы").subject, "");
    }

    #[test]
    fn organization_draft_picks_the_right_problem() {
        let mut d = LeadData::new(LeadKind::Organization, "osm_organizations", "n/1", "Лаванда");
        let t = draft(&d, Channel::Message, "");
        assert!(t.contains("не нашёл у «Лаванда» сайта"));
        d.website = Some("https://x.ru".into());
        d.facts = vec!["На главной нет meta viewport — мобильная вёрстка вероятно не адаптивна".into()];
        assert!(draft(&d, Channel::Message, "").contains("неудобно открывается с телефона"));
        assert!(draft(&d, Channel::Call, "Максим").starts_with("Добрый день! Меня зовут Максим"));
    }
}
