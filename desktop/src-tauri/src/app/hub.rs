//! «Интеграции» и «Ai»: настройки встроенных интеграций (Slack, Telegram, Discord, Teams) и локальной модели.
//! Всё лежит в защищённом хранилище одной записью на пользователя (адреса вебхуков и токены — секретны),
//! запросы наружу делает ядро, а не окно: так проверяются адреса и работают локальные серверы моделей.

use super::session::{Core, Session};
use super::{CmdError, CmdResult};
use crate::search::http::HttpRequest;
use crate::secrets;
use serde_json::{json, Map, Value};

const MAX_BLOB: usize = 64 * 1024;

fn hub_secret_name(s: &Session) -> String {
    format!("hub.{}", s.key())
}

fn text_of(cfg: &Value, key: &str) -> String {
    cfg.get(key).and_then(Value::as_str).unwrap_or("").trim().to_string()
}

fn cut(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut s: String = text.chars().take(max.saturating_sub(1)).collect();
    s.push('…');
    s
}

fn json_post(url: String, body: &Value, headers: Vec<(String, String)>, timeout: f64) -> HttpRequest {
    let mut h = vec![("Content-Type".to_string(), "application/json".to_string()), ("Accept".to_string(), "application/json".to_string())];
    h.extend(headers);
    HttpRequest { method: "POST".into(), url, headers: h, body: Some(serde_json::to_vec(body).unwrap_or_default()), timeout }
}

fn https_url(raw: &str) -> Option<url::Url> {
    let u = url::Url::parse(raw.trim()).ok()?;
    (u.scheme() == "https" && u.username().is_empty() && u.password().is_none() && u.port().is_none() && u.host_str().is_some()).then_some(u)
}

/// Запрос на отправку сообщения в мессенджер. Проверяет адрес: вебхук должен вести на сам сервис.
pub fn message_request(service: &str, cfg: &Value, text: &str) -> CmdResult<HttpRequest> {
    let bad = |m: &str| CmdError::msg(m.to_string());
    match service {
        "slack" => {
            let u = https_url(&text_of(cfg, "webhook")).filter(|u| u.host_str() == Some("hooks.slack.com") && u.path().starts_with("/services/"));
            let u = u.ok_or_else(|| bad("Нужен адрес входящего вебхука Slack: https://hooks.slack.com/services/…"))?;
            Ok(json_post(u.to_string(), &json!({"text": cut(text, 3000)}), vec![], 20.0))
        }
        "discord" => {
            let u = https_url(&text_of(cfg, "webhook")).filter(|u| {
                matches!(u.host_str(), Some("discord.com" | "discordapp.com" | "canary.discord.com" | "ptb.discord.com"))
                    && u.path().starts_with("/api/webhooks/")
            });
            let u = u.ok_or_else(|| bad("Нужен адрес вебхука Discord: https://discord.com/api/webhooks/…"))?;
            Ok(json_post(u.to_string(), &json!({"content": cut(text, 1900), "allowed_mentions": {"parse": []}}), vec![], 20.0))
        }
        "teams" => {
            let u = https_url(&text_of(cfg, "webhook")).filter(|u| {
                let h = u.host_str().unwrap_or("");
                h.ends_with(".webhook.office.com")
                    || h.ends_with(".logic.azure.com")
                    || h.ends_with(".powerplatform.com")
                    || h.ends_with(".environment.api.powerplatform.com")
            });
            let u = u.ok_or_else(|| bad("Нужен адрес вебхука Teams (Workflows: «Когда получен веб-запрос Teams»), он начинается с https://"))?;
            let card = json!({
                "type": "message",
                "attachments": [{
                    "contentType": "application/vnd.microsoft.card.adaptive",
                    "content": {"$schema": "http://adaptivecards.io/schemas/adaptive-card.json", "type": "AdaptiveCard", "version": "1.4",
                        "body": [{"type": "TextBlock", "text": cut(text, 3000), "wrap": true}]}
                }]
            });
            Ok(json_post(u.to_string(), &card, vec![], 20.0))
        }
        "telegram" => {
            let token = text_of(cfg, "token");
            let chat = text_of(cfg, "chat");
            let token_ok = token
                .split_once(':')
                .map(|(a, b)| {
                    !a.is_empty()
                        && a.chars().all(|c| c.is_ascii_digit())
                        && b.len() >= 20
                        && b.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                })
                .unwrap_or(false);
            if !token_ok {
                return Err(bad("Токен бота Telegram выглядит так: 123456789:AA… (его выдаёт @BotFather)."));
            }
            let chat_ok = !chat.is_empty()
                && (chat.strip_prefix('-').unwrap_or(&chat).chars().all(|c| c.is_ascii_digit())
                    || (chat.starts_with('@') && chat.len() > 2 && chat[1..].chars().all(|c| c.is_ascii_alphanumeric() || c == '_')));
            if !chat_ok {
                return Err(bad("Чат Telegram: число (например, -1001234567890) или @имя_канала."));
            }
            Ok(json_post(
                format!("https://api.telegram.org/bot{token}/sendMessage"),
                &json!({"chat_id": chat, "text": cut(text, 3800), "disable_web_page_preview": true}),
                vec![],
                20.0,
            ))
        }
        _ => Err(bad("Неизвестная интеграция")),
    }
}

/// Базовый адрес сервера модели: только http(s), без логина в адресе; «/» на конце убирается.
pub fn ai_base(raw: &str) -> CmdResult<String> {
    let u = url::Url::parse(raw.trim()).map_err(|_| CmdError::msg("Адрес сервера модели: например, http://localhost:1234/v1"))?;
    if !["http", "https"].contains(&u.scheme()) || u.host_str().is_none() || !u.username().is_empty() || u.password().is_some() || u.query().is_some() {
        return Err(CmdError::msg("Адрес сервера модели: например, http://localhost:1234/v1"));
    }
    Ok(u.to_string().trim_end_matches('/').to_string())
}

fn ai_headers(key: &str) -> Vec<(String, String)> {
    if key.trim().is_empty() {
        vec![]
    } else {
        vec![("Authorization".to_string(), format!("Bearer {}", key.trim()))]
    }
}

fn api_error(status: u16, body: &[u8]) -> CmdError {
    let v: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let detail = v.pointer("/error/message").or_else(|| v.get("error")).and_then(Value::as_str).unwrap_or("");
    let base = match status {
        401 | 403 => "Сервер модели не принял ключ доступа",
        404 => "Сервер ответил «не найдено»: проверьте адрес (обычно он оканчивается на /v1) и название модели",
        _ => "Сервер модели вернул ошибку",
    };
    if detail.is_empty() {
        CmdError::msg(format!("{base} (код {status})."))
    } else {
        CmdError::msg(format!("{base} (код {status}): {}", cut(detail, 300)))
    }
}

impl Core {
    fn hub_blob(&self, s: &Session) -> Value {
        let raw = secrets::get_or_empty(self.env.secrets.as_ref(), &hub_secret_name(s));
        serde_json::from_str::<Value>(&raw).ok().filter(Value::is_object).unwrap_or_else(|| Value::Object(Map::new()))
    }

    /// Все настройки интеграций и модели этого пользователя.
    pub fn hub_load(&self) -> CmdResult<Value> {
        let s = self.require()?;
        Ok(self.hub_blob(&s))
    }

    pub fn hub_save(&self, value: Value) -> CmdResult<()> {
        let s = self.require()?;
        if !value.is_object() {
            return Err(CmdError::msg("Настройки интеграций повреждены."));
        }
        let text = value.to_string();
        if text.len() > MAX_BLOB {
            return Err(CmdError::msg("Слишком много настроек интеграций."));
        }
        secrets::put(self.env.secrets.as_ref(), &hub_secret_name(&s), &text)?;
        Ok(())
    }

    /// Отправляет сообщение в мессенджер. Без `config` берутся сохранённые настройки.
    pub async fn hub_send(&self, service: &str, text: &str, config: Option<Value>) -> CmdResult<String> {
        let s = self.require()?;
        let cfg = match config {
            Some(c) => c,
            None => {
                let blob = self.hub_blob(&s);
                let one = blob.pointer(&format!("/integrations/{service}")).cloned().unwrap_or(Value::Null);
                if one.get("enabled").and_then(Value::as_bool) != Some(true) {
                    return Err(CmdError::msg("Интеграция не подключена."));
                }
                one
            }
        };
        let req = message_request(service, &cfg, text)?;
        let r = self.env.transport.send(req).await.map_err(|e| CmdError::msg(format!("Сообщение не отправлено: {}", e.message())))?;
        let ok = (200..300).contains(&r.status)
            && (service != "telegram" || serde_json::from_slice::<Value>(&r.data).ok().and_then(|v| v.get("ok").and_then(Value::as_bool)) == Some(true));
        if ok {
            return Ok("Сообщение отправлено.".into());
        }
        let reason = match r.status {
            400 | 404 => "адрес или чат не найден, проверьте настройки",
            401 | 403 => "доступ отклонён, проверьте токен или адрес вебхука",
            429 => "слишком много сообщений, повторите позже",
            _ => "сервис вернул ошибку",
        };
        Err(CmdError::msg(format!("Сообщение не отправлено: {reason} (код {}).", r.status)))
    }

    /// Названия моделей, которые отдаёт сервер (`GET /models`). Заодно проверка соединения.
    pub async fn ai_models(&self, base_url: &str, api_key: &str) -> CmdResult<Vec<String>> {
        self.require()?;
        let base = ai_base(base_url)?;
        let req = HttpRequest { method: "GET".into(), url: format!("{base}/models"), headers: ai_headers(api_key), body: None, timeout: 15.0 };
        let r = self
            .env
            .transport
            .send(req)
            .await
            .map_err(|e| CmdError::msg(format!("Сервер модели недоступен: {}. Запущен ли он и включён ли локальный сервер?", e.message())))?;
        if !(200..300).contains(&r.status) {
            return Err(api_error(r.status, &r.data));
        }
        let v: Value = serde_json::from_slice(&r.data).map_err(|_| CmdError::msg("Сервер ответил не так, как ожидается от OpenAI-совместимого API."))?;
        let list = v
            .get("data")
            .and_then(Value::as_array)
            .or_else(|| v.get("models").and_then(Value::as_array))
            .ok_or_else(|| CmdError::msg("Сервер не вернул список моделей."))?;
        let mut names: Vec<String> = list.iter().filter_map(|m| m.get("id").or_else(|| m.get("name")).and_then(Value::as_str).map(str::to_string)).collect();
        names.sort();
        names.dedup();
        Ok(names)
    }

    /// Один запрос `POST /chat/completions` без потока. Тело (модель, сообщения, инструменты) собирает интерфейс.
    pub async fn ai_chat(&self, base_url: &str, api_key: &str, body: Value) -> CmdResult<Value> {
        self.require()?;
        let base = ai_base(base_url)?;
        if !body.is_object() {
            return Err(CmdError::msg("Запрос к модели повреждён."));
        }
        let mut body = body;
        body["stream"] = json!(false);
        let req = json_post(format!("{base}/chat/completions"), &body, ai_headers(api_key), 170.0);
        let r = self.env.transport.send(req).await.map_err(|e| CmdError::msg(format!("Сервер модели недоступен: {}.", e.message())))?;
        if !(200..300).contains(&r.status) {
            return Err(api_error(r.status, &r.data));
        }
        serde_json::from_slice(&r.data).map_err(|_| CmdError::msg("Сервер ответил не так, как ожидается от OpenAI-совместимого API."))
    }
}

#[cfg(test)]
mod tests {
    use super::super::testing::fixture;
    use super::*;
    use crate::search::http::HttpResponse;
    use std::sync::Arc;

    fn signed_in(f: &super::super::testing::Fixture) -> Arc<Core> {
        let core = Core::new(f.env.clone());
        let pw = uuid::Uuid::new_v4().to_string();
        core.register("anna", &pw, &pw, false).unwrap();
        core
    }

    #[test]
    fn messenger_addresses_must_lead_to_the_service() {
        let ok = |s: &str, c: Value| message_request(s, &c, "привет").unwrap();
        assert_eq!(ok("slack", json!({"webhook": "https://hooks.slack.com/services/T0/B0/xx"})).url, "https://hooks.slack.com/services/T0/B0/xx");
        assert!(ok("discord", json!({"webhook": "https://discord.com/api/webhooks/1/abc"})).url.contains("/api/webhooks/"));
        assert!(ok("teams", json!({"webhook": "https://prod-1.westeurope.logic.azure.com/workflows/abc"})).body.is_some());
        let tg = ok("telegram", json!({"token": "123456789:AAH-abcdefghijklmnopqrstuvwxyz_0123", "chat": "-1001234567890"}));
        assert!(tg.url.starts_with("https://api.telegram.org/bot123456789:") && tg.url.ends_with("/sendMessage"));
        for (s, c) in [
            ("slack", json!({"webhook": "http://hooks.slack.com/services/a"})),
            ("slack", json!({"webhook": "https://evil.example/services/a"})),
            ("slack", json!({"webhook": "https://hooks.slack.com.evil.example/services/a"})),
            ("slack", json!({"webhook": "https://user:pw@hooks.slack.com/services/a"})),
            ("discord", json!({"webhook": "https://discord.com/other"})),
            ("teams", json!({"webhook": "https://example.com/hook"})),
            ("telegram", json!({"token": "плохой", "chat": "1"})),
            ("telegram", json!({"token": "123456789:AAH-abcdefghijklmnopqrstuvwxyz_0123", "chat": "не чат"})),
            ("nope", json!({})),
        ] {
            assert!(message_request(s, &c, "x").is_err(), "{s} {c}");
        }
    }

    #[test]
    fn long_messages_are_cut_and_discord_cannot_ping_everyone() {
        let long = "я".repeat(5000);
        let r = message_request("discord", &json!({"webhook": "https://discord.com/api/webhooks/1/abc"}), &long).unwrap();
        let v: Value = serde_json::from_slice(&r.body.unwrap()).unwrap();
        assert!(v["content"].as_str().unwrap().chars().count() <= 1900);
        assert_eq!(v["allowed_mentions"]["parse"], json!([]));
    }

    #[test]
    fn ai_base_accepts_local_servers_only_with_http_or_https() {
        assert_eq!(ai_base("http://localhost:1234/v1/").unwrap(), "http://localhost:1234/v1");
        assert_eq!(ai_base(" http://127.0.0.1:11434/v1 ").unwrap(), "http://127.0.0.1:11434/v1");
        for bad in ["", "localhost:1234", "ftp://x/v1", "http://u:p@host/v1", "http://host/v1?key=1", "javascript:alert(1)"] {
            assert!(ai_base(bad).is_err(), "{bad}");
        }
    }

    #[tokio::test]
    async fn settings_are_stored_per_user_and_sending_needs_a_connected_service() {
        let f = fixture(false, vec![Ok(HttpResponse::new(200, "ok"))]);
        let core = signed_in(&f);
        assert_eq!(core.hub_load().unwrap(), json!({}));
        assert!(core.hub_send("slack", "x", None).await.is_err(), "не подключена");
        assert!(core.hub_save(json!([1])).is_err());
        let blob = json!({"integrations": {"slack": {"enabled": true, "webhook": "https://hooks.slack.com/services/T/B/x"}}, "ai": {"baseUrl": "http://localhost:1234/v1"}});
        core.hub_save(blob.clone()).unwrap();
        assert_eq!(core.hub_load().unwrap(), blob);
        assert_eq!(core.hub_send("slack", "Новый лид", None).await.unwrap(), "Сообщение отправлено.");
        let sent = f.transport.requests.lock().unwrap().last().cloned().unwrap();
        assert_eq!(sent.url, "https://hooks.slack.com/services/T/B/x");
        assert!(String::from_utf8(sent.body.unwrap()).unwrap().contains("Новый лид"));
        assert!(core.hub_save(json!({"x": "я".repeat(MAX_BLOB)})).is_err());
    }

    #[tokio::test]
    async fn failed_messages_do_not_leak_the_secret_address() {
        let f = fixture(false, vec![Ok(HttpResponse::new(404, "no_service"))]);
        let core = signed_in(&f);
        let cfg = json!({"webhook": "https://hooks.slack.com/services/T/B/SECRET"});
        let e = core.hub_send("slack", "x", Some(cfg)).await.unwrap_err();
        assert!(e.message.contains("404") && !e.message.contains("SECRET"));
        let f = fixture(false, vec![Ok(HttpResponse::new(200, r#"{"ok":false}"#))]);
        let core = signed_in(&f);
        let cfg = json!({"token": "123456789:AAH-abcdefghijklmnopqrstuvwxyz_0123", "chat": "@news"});
        assert!(core.hub_send("telegram", "x", Some(cfg)).await.is_err(), "Telegram отвечает 200 с ok:false");
    }

    #[tokio::test]
    async fn local_model_lists_models_and_answers() {
        let models = r#"{"data":[{"id":"qwen2.5-7b"},{"id":"llama3.1"},{"id":"llama3.1"}]}"#;
        let answer = r#"{"choices":[{"message":{"role":"assistant","content":"Готово"}}]}"#;
        let f = fixture(
            false,
            vec![Ok(HttpResponse::new(200, models)), Ok(HttpResponse::new(200, answer)), Ok(HttpResponse::new(401, r#"{"error":{"message":"bad key"}}"#))],
        );
        let core = signed_in(&f);
        assert_eq!(core.ai_models("http://localhost:1234/v1", "").await.unwrap(), vec!["llama3.1", "qwen2.5-7b"]);
        let r = core.ai_chat("http://localhost:1234/v1", "k", json!({"model": "llama3.1", "messages": [], "stream": true})).await.unwrap();
        assert_eq!(r["choices"][0]["message"]["content"], "Готово");
        let reqs = f.transport.requests.lock().unwrap().clone();
        assert_eq!(reqs[0].url, "http://localhost:1234/v1/models");
        assert_eq!(reqs[1].url, "http://localhost:1234/v1/chat/completions");
        assert!(reqs[1].headers.iter().any(|(k, v)| k == "Authorization" && v == "Bearer k"));
        assert!(String::from_utf8(reqs[1].body.clone().unwrap()).unwrap().contains("\"stream\":false"));
        let e = core.ai_models("http://localhost:1234/v1", "x").await.unwrap_err();
        assert!(e.message.contains("401") && e.message.contains("bad key"));
        assert!(core.ai_chat("not a url", "", json!({})).await.is_err());
    }
}
