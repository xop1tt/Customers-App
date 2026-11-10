//! Ключи дедупликации компаний и контактов (docs/CRM_ARCHITECTURE.md §3): одинаковые на устройстве и на сервере,
//! хранятся в `dedupe_keys`. По ним до сохранения показываются «Похоже на: …» и находится запись при преобразовании лида.

use serde_json::{Map, Value};

const FREE_MAIL: [&str; 16] = [
    "gmail.com",
    "googlemail.com",
    "mail.ru",
    "bk.ru",
    "list.ru",
    "inbox.ru",
    "internet.ru",
    "yandex.ru",
    "ya.ru",
    "rambler.ru",
    "outlook.com",
    "hotmail.com",
    "yahoo.com",
    "icloud.com",
    "proton.me",
    "protonmail.com",
];

const LEGAL_FORMS: [&str; 12] = ["ооо", "оао", "зао", "пао", "ао", "ип", "нко", "llc", "ltd", "inc", "gmbh", "corp"];

/// Телефон в виде E.164 (`+79991234567`); российские 8… и 10 цифр приводятся к +7.
pub fn phone(raw: &str) -> Option<String> {
    let digits: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
    let d = match digits.len() {
        11 if digits.starts_with('8') => format!("7{}", &digits[1..]),
        10 if digits.starts_with('9') => format!("7{digits}"),
        7..=15 => digits,
        _ => return None,
    };
    Some(format!("+{d}"))
}

pub fn email(raw: &str) -> Option<String> {
    let e = raw.trim().trim_start_matches("mailto:").to_lowercase();
    let (user, host) = e.split_once('@')?;
    (!user.is_empty() && host.contains('.') && !host.contains(char::is_whitespace)).then_some(e)
}

/// Домен сайта: без схемы, `www.`, пути и порта.
pub fn domain(raw: &str) -> Option<String> {
    let s = raw.trim().to_lowercase();
    let s = s.split("://").last().unwrap_or(&s);
    let host = s.split(['/', '?', '#']).next()?.split(':').next()?.trim_start_matches("www.");
    (host.contains('.') && host.len() <= 253 && !host.contains(char::is_whitespace)).then(|| host.to_string())
}

/// Название без кавычек, организационной формы и знаков: «ООО "Ромашка"» → «ромашка».
pub fn name(raw: &str) -> Option<String> {
    let lower = raw.to_lowercase().replace('ё', "е");
    let words: Vec<String> = lower.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty() && !LEGAL_FORMS.contains(w)).map(String::from).collect();
    let n = words.join(" ");
    (n.chars().count() >= 2).then_some(n)
}

fn strings<'a>(row: &'a Map<String, Value>, key: &str) -> Vec<&'a str> {
    row.get(key).and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default()
}

fn text<'a>(row: &'a Map<String, Value>, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or("")
}

pub fn keys(table: &str, row: &Map<String, Value>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut add = |k: String| {
        if !out.contains(&k) && out.len() < 50 {
            out.push(k);
        }
    };
    for p in strings(row, "phones").into_iter().filter_map(phone) {
        add(format!("phone:{p}"));
    }
    match table {
        "companies" => {
            for d in [text(row, "domain"), text(row, "website")].into_iter().filter_map(domain) {
                add(format!("domain:{d}"));
            }
            for e in strings(row, "emails").into_iter().filter_map(email) {
                let host = e.split('@').nth(1).unwrap_or("").to_string();
                if !FREE_MAIL.contains(&host.as_str()) {
                    add(format!("domain:{host}"));
                }
            }
            let inn = text(row, "inn").trim();
            if !inn.is_empty() {
                add(format!("inn:{inn}"));
            }
            if let Some(n) = name(text(row, "name")) {
                add(format!("name:{n}"));
            }
        }
        "contacts" => {
            for e in strings(row, "emails").into_iter().filter_map(email) {
                add(format!("email:{e}"));
            }
            let full = format!("{} {}", text(row, "first_name"), text(row, "last_name"));
            if let Some(n) = name(&full) {
                add(format!("name:{n}:{}", text(row, "company_id")));
            }
        }
        _ => {}
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn normalizes_phones_emails_domains_and_names() {
        assert_eq!(phone("8 (999) 123-45-67").as_deref(), Some("+79991234567"));
        assert_eq!(phone("+7 999 123 45 67").as_deref(), Some("+79991234567"));
        assert_eq!(phone("9991234567").as_deref(), Some("+79991234567"));
        assert_eq!(phone("12"), None);
        assert_eq!(email(" Info@Romashka.RU ").as_deref(), Some("info@romashka.ru"));
        assert_eq!(domain("https://www.Romashka.ru/contacts?x=1").as_deref(), Some("romashka.ru"));
        assert_eq!(name("ООО «Ромашка»").as_deref(), Some("ромашка"));
        assert_eq!(name("\"Ромашка\", ООО").as_deref(), Some("ромашка"));
    }

    #[test]
    fn company_keys_skip_free_mail_domains() {
        let k = keys(
            "companies",
            &obj(json!({"name": "ООО Ромашка", "website": "romashka.ru", "inn": "7701234567",
                                                "emails": ["boss@gmail.com", "sale@romashka.ru"], "phones": ["8 999 123 45 67"]})),
        );
        assert_eq!(k, vec!["phone:+79991234567", "domain:romashka.ru", "inn:7701234567", "name:ромашка"]);
        let c = keys("contacts", &obj(json!({"first_name": "Анна", "last_name": "Ли", "emails": ["A@x.ru"], "company_id": "c1"})));
        assert_eq!(c, vec!["email:a@x.ru", "name:анна ли:c1"]);
    }
}
