//! Ошибки облака с понятными сообщениями. Текст не раскрывает, существует ли аккаунт.

use crate::cloud::validation;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub enum CloudError {
    NotConfigured,
    Network(String),
    InvalidEmail,
    WeakPassword(Option<String>),
    PasswordsDiffer,
    InvalidCredentials,
    EmailNotConfirmed,
    EmailExists,
    InvalidCode,
    SamePassword,
    RateLimited(String),
    MailUnavailable,
    SessionExpired,
    ReauthRequired,
    Server(String),
}

impl std::fmt::Display for CloudError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        use CloudError::*;
        let s = match self {
            NotConfigured => "Облако не настроено: в этой сборке нет адреса сервера.".to_string(),
            Network(_) => "Нет соединения с сервером. Проверьте интернет — данные на этом компьютере доступны и без сети.".to_string(),
            InvalidEmail => "Проверьте адрес электронной почты.".to_string(),
            WeakPassword(m) => m.clone().unwrap_or_else(|| validation::PASSWORD_RULES.to_string()),
            PasswordsDiffer => "Пароли не совпадают.".to_string(),
            InvalidCredentials => "Неверный адрес почты или пароль.".to_string(),
            EmailNotConfirmed => "Адрес почты ещё не подтверждён. Введите код из письма.".to_string(),
            EmailExists => "Этот адрес уже используется другой учётной записью.".to_string(),
            InvalidCode => "Код неверный или устарел. Запросите новое письмо.".to_string(),
            SamePassword => "Новый пароль совпадает с текущим.".to_string(),
            RateLimited(m) => m.clone(),
            MailUnavailable => "Не удалось отправить письмо: почтовый сервис недоступен или исчерпан лимит. Попробуйте позже.".to_string(),
            SessionExpired => "Сессия завершена. Войдите снова.".to_string(),
            ReauthRequired => "Введите пароль ещё раз.".to_string(),
            Server(m) => format!("Ошибка сервера: {m}"),
        };
        f.write_str(&s)
    }
}

impl std::error::Error for CloudError {}

pub type CloudResult<T> = Result<T, CloudError>;

impl CloudError {
    /// Разбор ответа Supabase Auth: {"code":400,"error_code":"…","msg":"…"} или {"error":"…","error_description":"…"}.
    pub fn from_auth(status: u16, data: &[u8]) -> CloudError {
        let obj: Value = serde_json::from_slice(data).unwrap_or(Value::Null);
        let text = |k: &str| obj.get(k).and_then(Value::as_str).map(str::to_string);
        let code = text("error_code").or_else(|| text("error")).unwrap_or_default();
        let msg = text("msg").or_else(|| text("error_description")).or_else(|| text("message")).unwrap_or_default();
        match code.as_str() {
            "invalid_credentials" => return CloudError::InvalidCredentials,
            "invalid_grant" if msg.to_lowercase().contains("credentials") => return CloudError::InvalidCredentials,
            "email_not_confirmed" => return CloudError::EmailNotConfirmed,
            "weak_password" => return CloudError::WeakPassword(None),
            "email_exists" | "user_already_exists" | "conflict" => return CloudError::EmailExists,
            "email_address_invalid" | "validation_failed" => return CloudError::InvalidEmail,
            "otp_expired" | "otp_disabled" | "bad_code_verifier" => return CloudError::InvalidCode,
            "same_password" => return CloudError::SamePassword,
            "over_email_send_rate_limit" | "over_request_rate_limit" => {
                return CloudError::RateLimited("Слишком много попыток. Подождите немного и повторите.".into())
            }
            "refresh_token_not_found"
            | "refresh_token_already_used"
            | "session_not_found"
            | "session_expired"
            | "user_not_found"
            | "bad_jwt"
            | "no_authorization" => return CloudError::SessionExpired,
            "reauthentication_needed" | "reauthentication_not_valid" => return CloudError::ReauthRequired,
            _ => {}
        }
        if status == 429 {
            return CloudError::RateLimited("Слишком много попыток. Подождите немного и повторите.".into());
        }
        if msg.contains("hook") {
            return CloudError::MailUnavailable;
        }
        if status == 401 || status == 403 {
            return CloudError::SessionExpired;
        }
        CloudError::Server(if msg.is_empty() { format!("HTTP {status}") } else { msg.chars().take(200).collect() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(status: u16, body: &str) -> CloudError {
        CloudError::from_auth(status, body.as_bytes())
    }

    #[test]
    fn maps_known_codes() {
        assert_eq!(parse(400, r#"{"error_code":"invalid_credentials","msg":"x"}"#), CloudError::InvalidCredentials);
        assert_eq!(parse(400, r#"{"error":"invalid_grant","error_description":"Invalid login credentials"}"#), CloudError::InvalidCredentials);
        assert_eq!(parse(400, r#"{"error_code":"email_not_confirmed"}"#), CloudError::EmailNotConfirmed);
        assert_eq!(parse(422, r#"{"error_code":"user_already_exists"}"#), CloudError::EmailExists);
        assert_eq!(parse(403, r#"{"error_code":"otp_expired"}"#), CloudError::InvalidCode);
        assert_eq!(parse(400, r#"{"error_code":"refresh_token_already_used"}"#), CloudError::SessionExpired);
        assert_eq!(parse(422, r#"{"error_code":"same_password"}"#), CloudError::SamePassword);
        assert_eq!(parse(429, "{}"), CloudError::RateLimited("Слишком много попыток. Подождите немного и повторите.".into()));
        assert_eq!(parse(500, r#"{"msg":"Error running hook URL"}"#), CloudError::MailUnavailable);
        assert_eq!(parse(401, ""), CloudError::SessionExpired);
        assert_eq!(parse(500, ""), CloudError::Server("HTTP 500".into()));
    }

    #[test]
    fn messages_do_not_reveal_accounts() {
        assert_eq!(CloudError::InvalidCredentials.to_string(), "Неверный адрес почты или пароль.");
        assert!(CloudError::Network("x".into()).to_string().starts_with("Нет соединения"));
        assert!(CloudError::Server("a".repeat(500)).to_string().len() < 700);
    }
}
