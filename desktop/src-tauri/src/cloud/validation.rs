//! Проверки на клиенте — для быстрых подсказок. Те же правила проверяет сервер.

use once_cell::sync::Lazy;
use regex::Regex;

pub const PASSWORD_RULES: &str = "Пароль: не короче 8 символов, строчные и заглавные буквы и цифры.";

static EMAIL_RX: Lazy<Regex> = Lazy::new(|| Regex::new(r#"^[^@\s<>()",;:]+@[^@\s<>()",;:]+\.[^@\s<>()",;:.]{2,}$"#).unwrap());

pub fn normalized_email(raw: &str) -> Option<String> {
    let e = raw.trim().to_lowercase();
    (e.chars().count() <= 254 && EMAIL_RX.is_match(&e)).then_some(e)
}

/// None — пароль подходит, иначе — что исправить.
pub fn password_problem(p: &str) -> Option<String> {
    let len = p.chars().count();
    if len > 72 {
        return Some("Пароль не длиннее 72 символов.".into());
    }
    let mut missing = vec![];
    if len < 8 {
        missing.push("не короче 8 символов");
    }
    if !p.chars().any(char::is_lowercase) {
        missing.push("строчная буква");
    }
    if !p.chars().any(char::is_uppercase) {
        missing.push("заглавная буква");
    }
    if !p.chars().any(char::is_numeric) {
        missing.push("цифра");
    }
    (!missing.is_empty()).then(|| format!("В пароле нужно: {}.", missing.join(", ")))
}

pub fn code(raw: &str) -> Option<String> {
    let digits: String = raw.chars().filter(|c| c.is_numeric()).collect();
    (6..=10).contains(&digits.len()).then_some(digits)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emails() {
        assert_eq!(normalized_email("  User@Example.COM ").as_deref(), Some("user@example.com"));
        for bad in ["", "a@b", "a b@c.de", "a@b.c", "@x.com", "a@@x.com", "a@x.com."] {
            assert!(normalized_email(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn passwords() {
        assert_eq!(password_problem("Abcdefg1"), None);
        assert_eq!(password_problem("abc").unwrap(), "В пароле нужно: не короче 8 символов, заглавная буква, цифра.");
        assert!(password_problem(&"Aa1".repeat(30)).unwrap().contains("72"));
    }

    #[test]
    fn codes() {
        assert_eq!(code(" 123 456 ").as_deref(), Some("123456"));
        assert!(code("12345").is_none());
        assert!(code("12345678901").is_none());
    }
}
