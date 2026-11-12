//! Адрес проекта Supabase и публичный (anon / publishable) ключ. Оба значения публичные: они
//! встраиваются в приложение при сборке и дают только то, что разрешают политики RLS.

use base64::Engine;

#[derive(Debug, Clone, PartialEq)]
pub struct CloudConfig {
    pub url: String,
    pub anon_key: String,
    /// Адрес возврата из писем: схема ссылок приложения (leadgenerator://).
    pub redirect: &'static str,
}

pub const REDIRECT_URL: &str = "leadgenerator://auth/callback";

impl CloudConfig {
    pub fn new(url: &str, anon_key: &str) -> Option<Self> {
        let trimmed = url.trim().trim_matches('/');
        let key = anon_key.trim();
        let u = url::Url::parse(trimmed).ok()?;
        let host = u.host_str()?;
        let ok_scheme = u.scheme() == "https" || (u.scheme() == "http" && ["127.0.0.1", "localhost"].contains(&host));
        if !ok_scheme || key.is_empty() || !Self::is_public_key(key) {
            return None;
        }
        Some(Self { url: trimmed.to_string(), anon_key: key.to_string(), redirect: REDIRECT_URL })
    }

    /// Публичный ключ: publishable (sb_publishable_…) или JWT с ролью anon. Секретный ключ
    /// (sb_secret_… или JWT с другой ролью) отклоняется, чтобы его нельзя было встроить по ошибке.
    pub fn is_public_key(key: &str) -> bool {
        if key.starts_with("sb_publishable_") {
            return true;
        }
        if key.starts_with("sb_secret_") {
            return false;
        }
        let parts: Vec<&str> = key.split('.').collect();
        if parts.len() != 3 {
            return false;
        }
        let Ok(bytes) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(parts[1].trim_end_matches('=')) else { return false };
        serde_json::from_slice::<serde_json::Value>(&bytes).ok().and_then(|v| v.get("role").and_then(|r| r.as_str().map(|s| s == "anon"))).unwrap_or(false)
    }

    /// Облако, встроенное при сборке: переменные окружения SUPABASE_URL и SUPABASE_ANON_KEY (рабочий проект).
    /// Без них приложение собирается без облака.
    pub fn embedded() -> Option<Self> {
        Self::new(option_env!("SUPABASE_URL").unwrap_or(""), option_env!("SUPABASE_ANON_KEY").unwrap_or(""))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_from_emails_return_to_the_app() {
        let c = CloudConfig::new("https://example.supabase.co", &format!("sb_publishable_{}", "a".repeat(30))).unwrap();
        assert_eq!(c.redirect, REDIRECT_URL);
        assert!(c.redirect.starts_with(&format!("{}://", crate::identity::APP.url_scheme)));
    }

    fn jwt(role: &str) -> String {
        let e = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        format!("{}.{}.sig", e.encode(r#"{"alg":"HS256"}"#), e.encode(format!(r#"{{"role":"{role}"}}"#)))
    }

    #[test]
    fn accepts_publishable_and_anon_jwt_only() {
        assert!(CloudConfig::new("https://x.supabase.co/", "sb_publishable_abc").is_some());
        assert!(CloudConfig::new("https://x.supabase.co", &jwt("anon")).is_some());
        assert!(CloudConfig::new("https://x.supabase.co", &jwt("service_role")).is_none());
        assert!(CloudConfig::new("https://x.supabase.co", "sb_secret_abc").is_none());
        assert!(CloudConfig::new("https://x.supabase.co", "").is_none());
    }

    #[test]
    fn url_rules() {
        assert_eq!(CloudConfig::new(" https://x.supabase.co// ", "sb_publishable_a").unwrap().url, "https://x.supabase.co");
        assert!(CloudConfig::new("http://127.0.0.1:54321", "sb_publishable_a").is_some());
        assert!(CloudConfig::new("http://evil.example", "sb_publishable_a").is_none());
        assert!(CloudConfig::new("not a url", "sb_publishable_a").is_none());
    }
}
