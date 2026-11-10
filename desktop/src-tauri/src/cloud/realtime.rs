//! Supabase Realtime: личный закрытый канал `user:<id>` (протокол Phoenix поверх WebSocket).
//!
//! Сервер шлёт в канал только «толчок» без текста: в каком Workspace и обсуждении что-то изменилось.
//! Само содержимое приложение забирает обычным запросом с правами пользователя (RLS), поэтому через
//! Realtime не уходит ни текст сообщений, ни карточки CRM. Если Realtime недоступен (нет на сервере,
//! прокси, обрыв), чат продолжает работать на опросе — просто с задержкой.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;

use super::auth::CloudAuth;
use super::config::CloudConfig;

/// Пульс Phoenix: сервер закрывает соединение без него через ~60 с.
const HEARTBEAT: Duration = Duration::from_secs(25);
/// Проверка, не обновился ли токен доступа (его надо передать в канал до истечения).
const TOKEN_CHECK: Duration = Duration::from_secs(60);

/// Адрес сокета Realtime: https → wss, http (только локальный стенд) → ws.
pub fn socket_url(config: &CloudConfig) -> String {
    let base = config.url.trim_end_matches('/');
    let ws = if let Some(rest) = base.strip_prefix("https://") { format!("wss://{rest}") } else { base.replacen("http://", "ws://", 1) };
    let key = percent_encoding::utf8_percent_encode(&config.anon_key, percent_encoding::NON_ALPHANUMERIC);
    format!("{ws}/realtime/v1/websocket?apikey={key}&vsn=1.0.0")
}

pub fn user_topic(user_id: &str) -> String {
    format!("realtime:user:{user_id}")
}

/// Вход в закрытый канал: доступ проверяет политика RLS на `realtime.messages` по токену пользователя.
pub fn join_message(topic: &str, token: &str, r#ref: u64) -> String {
    json!({
        "topic": topic, "event": "phx_join", "ref": r#ref.to_string(), "join_ref": r#ref.to_string(),
        "payload": {
            "config": {"broadcast": {"self": false, "ack": false}, "presence": {"key": ""}, "postgres_changes": [], "private": true},
            "access_token": token
        }
    })
    .to_string()
}

pub fn heartbeat_message(r#ref: u64) -> String {
    json!({"topic": "phoenix", "event": "heartbeat", "payload": {}, "ref": r#ref.to_string()}).to_string()
}

pub fn token_message(topic: &str, token: &str, r#ref: u64) -> String {
    json!({"topic": topic, "event": "access_token", "payload": {"access_token": token}, "ref": r#ref.to_string()}).to_string()
}

#[derive(Debug, PartialEq)]
pub enum Incoming {
    /// Событие канала: имя (`chat`, `notify` …) и данные без содержимого.
    Broadcast {
        event: String,
        payload: Value,
    },
    Joined,
    /// Канал не открылся (нет прав, Realtime выключен) или сервер закрыл его.
    Refused(String),
    Other,
}

pub fn parse(text: &str, topic: &str, join_ref: &str) -> Incoming {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return Incoming::Other };
    if v["topic"].as_str() != Some(topic) {
        return Incoming::Other;
    }
    match v["event"].as_str() {
        Some("broadcast") => {
            let p = &v["payload"];
            Incoming::Broadcast { event: p["event"].as_str().unwrap_or_default().to_string(), payload: p["payload"].clone() }
        }
        Some("phx_reply") if v["ref"].as_str() == Some(join_ref) => {
            if v["payload"]["status"].as_str() == Some("ok") {
                Incoming::Joined
            } else {
                let r = &v["payload"]["response"];
                Incoming::Refused(r["reason"].as_str().or(r.as_str()).unwrap_or("join refused").to_string())
            }
        }
        Some("phx_error") | Some("phx_close") => Incoming::Refused(v["event"].as_str().unwrap_or_default().to_string()),
        Some("system") if v["payload"]["status"].as_str() == Some("error") => {
            Incoming::Refused(v["payload"]["message"].as_str().unwrap_or("system error").to_string())
        }
        _ => Incoming::Other,
    }
}

/// Пауза перед повторным подключением: 1, 2, 4 … до 60 с.
pub fn backoff(attempt: u32) -> Duration {
    Duration::from_secs(1u64 << attempt.min(6)).min(Duration::from_secs(60))
}

trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

async fn open(url: &str) -> Result<tokio_tungstenite::WebSocketStream<Box<dyn Io>>, String> {
    let u = url::Url::parse(url).map_err(|e| e.to_string())?;
    let host = u.host_str().ok_or("no host")?.to_string();
    let tls = u.scheme() == "wss";
    let port = u.port().unwrap_or(if tls { 443 } else { 80 });
    let tcp = tokio::time::timeout(Duration::from_secs(15), TcpStream::connect((host.as_str(), port)))
        .await
        .map_err(|_| "connect timeout".to_string())?
        .map_err(|e| e.to_string())?;
    let _ = tcp.set_nodelay(true);
    let stream: Box<dyn Io> = if tls {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let config = rustls::ClientConfig::builder().with_root_certificates(roots).with_no_client_auth();
        let name = rustls_pki_types::ServerName::try_from(host.clone()).map_err(|e| e.to_string())?;
        let s = tokio_rustls::TlsConnector::from(Arc::new(config)).connect(name, tcp).await.map_err(|e| e.to_string())?;
        Box::new(s)
    } else {
        Box::new(tcp)
    };
    let (ws, _) = tokio::time::timeout(Duration::from_secs(15), tokio_tungstenite::client_async(url, stream))
        .await
        .map_err(|_| "handshake timeout".to_string())?
        .map_err(|e| e.to_string())?;
    Ok(ws)
}

/// Одно соединение: вход в канал, пульс, обновление токена, события. Возвращается при обрыве.
/// `Ok(true)` — канал успел открыться (следующую попытку можно делать сразу, без долгой паузы).
async fn session(auth: &CloudAuth, user_id: &str, live: &AtomicBool, on_event: &(dyn Fn(String, Value) + Send + Sync)) -> Result<bool, String> {
    let token = auth.valid_session().await.map_err(|e| e.to_string())?.access_token;
    let mut ws = open(&socket_url(&auth.config)).await?;
    let topic = user_topic(user_id);
    let mut next_ref = 1u64;
    let join_ref = next_ref.to_string();
    ws.send(Message::text(join_message(&topic, &token, next_ref))).await.map_err(|e| e.to_string())?;
    let mut sent_token = token;
    let mut joined = false;
    let mut beat = tokio::time::interval(HEARTBEAT);
    beat.tick().await;
    let mut check = tokio::time::interval(TOKEN_CHECK);
    check.tick().await;
    loop {
        tokio::select! {
            msg = ws.next() => {
                let text = match msg {
                    Some(Ok(Message::Text(t))) => t.to_string(),
                    Some(Ok(Message::Close(_))) | None => return Ok(joined),
                    Some(Ok(_)) => continue,
                    Some(Err(e)) => return if joined { Ok(true) } else { Err(e.to_string()) },
                };
                match parse(&text, &topic, &join_ref) {
                    Incoming::Joined => {
                        joined = true;
                        live.store(true, Ordering::SeqCst);
                        // Пока не было соединения, что-то могло прийти: пусть приложение сверится с сервером.
                        on_event("resync".into(), Value::Null);
                    }
                    Incoming::Broadcast { event, payload } => on_event(event, payload),
                    Incoming::Refused(reason) => return if joined { Ok(true) } else { Err(reason) },
                    Incoming::Other => {}
                }
            }
            _ = beat.tick() => {
                next_ref += 1;
                ws.send(Message::text(heartbeat_message(next_ref))).await.map_err(|e| e.to_string())?;
            }
            _ = check.tick() => {
                if let Ok(s) = auth.valid_session().await {
                    if s.access_token != sent_token {
                        next_ref += 1;
                        ws.send(Message::text(token_message(&topic, &s.access_token, next_ref))).await.map_err(|e| e.to_string())?;
                        sent_token = s.access_token;
                    }
                }
            }
        }
    }
}

/// Держит канал открытым, пока задачу не отменят. `live` — открыт ли канал прямо сейчас:
/// пока он открыт, приложение опрашивает сервер редко, а при обрыве — снова часто.
pub async fn run(auth: Arc<CloudAuth>, user_id: String, live: Arc<AtomicBool>, on_event: Arc<dyn Fn(String, Value) + Send + Sync>) {
    let mut attempt = 0u32;
    loop {
        let result = session(&auth, &user_id, &live, on_event.as_ref()).await;
        live.store(false, Ordering::SeqCst);
        on_event("offline".into(), Value::Null);
        attempt = match result {
            Ok(true) => 0,
            _ => attempt.saturating_add(1),
        };
        tokio::time::sleep(backoff(attempt)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::auth::tests::{config, Server};
    use crate::cloud::auth::{CloudSession, MemorySessionStore, SessionStore};
    use std::sync::Mutex;

    #[test]
    fn socket_url_uses_wss_and_public_key() {
        let c = CloudConfig::new("https://abc.supabase.co/", "sb_publishable_x+y").unwrap();
        assert_eq!(socket_url(&c), "wss://abc.supabase.co/realtime/v1/websocket?apikey=sb%5Fpublishable%5Fx%2By&vsn=1.0.0");
        let local = CloudConfig::new("http://127.0.0.1:54321", "sb_publishable_k").unwrap();
        assert!(socket_url(&local).starts_with("ws://127.0.0.1:54321/realtime/v1/websocket?"));
    }

    #[test]
    fn join_is_private_and_carries_the_user_token() {
        let v: Value = serde_json::from_str(&join_message("realtime:user:u1", "jwt", 1)).unwrap();
        assert_eq!(v["event"], "phx_join");
        assert_eq!(v["payload"]["config"]["private"], true);
        assert_eq!(v["payload"]["access_token"], "jwt");
        assert_eq!(v["join_ref"], "1");
    }

    #[test]
    fn parses_replies_and_broadcasts_of_own_topic_only() {
        let t = "realtime:user:u1";
        assert_eq!(parse(r#"{"topic":"realtime:user:u1","event":"phx_reply","ref":"1","payload":{"status":"ok","response":{}}}"#, t, "1"), Incoming::Joined);
        assert_eq!(
            parse(r#"{"topic":"realtime:user:u1","event":"phx_reply","ref":"1","payload":{"status":"error","response":{"reason":"Unauthorized"}}}"#, t, "1"),
            Incoming::Refused("Unauthorized".into())
        );
        // ответ на пульс — не ответ на вход
        assert_eq!(parse(r#"{"topic":"realtime:user:u1","event":"phx_reply","ref":"2","payload":{"status":"ok"}}"#, t, "1"), Incoming::Other);
        assert_eq!(
            parse(
                r#"{"topic":"realtime:user:u1","event":"broadcast","payload":{"type":"broadcast","event":"chat","payload":{"conversation_id":"c"}}}"#,
                t,
                "1"
            ),
            Incoming::Broadcast { event: "chat".into(), payload: json!({"conversation_id": "c"}) }
        );
        assert_eq!(parse(r#"{"topic":"realtime:user:u2","event":"broadcast","payload":{"event":"chat"}}"#, t, "1"), Incoming::Other);
        assert_eq!(parse("not json", t, "1"), Incoming::Other);
    }

    #[test]
    fn backoff_grows_to_a_minute() {
        assert_eq!(backoff(0), Duration::from_secs(1));
        assert_eq!(backoff(3), Duration::from_secs(8));
        assert_eq!(backoff(20), Duration::from_secs(60));
    }

    /// Настоящий WebSocket на 127.0.0.1: вход с токеном пользователя, событие доходит, `live` следует за каналом.
    #[tokio::test]
    async fn delivers_events_from_a_local_socket() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let joined_with = Arc::new(Mutex::new(None::<Value>));
        let seen = joined_with.clone();
        tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            let Some(Ok(Message::Text(join))) = ws.next().await else { panic!("no join") };
            let v: Value = serde_json::from_str(join.as_str()).unwrap();
            *seen.lock().unwrap() = Some(v.clone());
            let topic = v["topic"].as_str().unwrap().to_string();
            ws.send(Message::text(json!({"topic": topic, "event": "phx_reply", "ref": "1", "payload": {"status": "ok", "response": {}}}).to_string()))
                .await
                .unwrap();
            let push = json!({"topic": topic, "event": "broadcast", "payload": {"type": "broadcast", "event": "chat", "payload": {"conversation_id": "c1"}}});
            ws.send(Message::text(push.to_string())).await.unwrap();
            tokio::time::sleep(Duration::from_millis(200)).await;
            let _ = ws.close(None).await;
        });

        // сессия с токеном, который не истекает в ближайший час
        let user = serde_json::from_value(json!({"id": "u1", "email": "me@example.com"})).unwrap();
        let session =
            CloudSession { access_token: "access-1".into(), refresh_token: "r".into(), expires_at: chrono::Utc::now() + chrono::Duration::hours(1), user };
        let store = Arc::new(MemorySessionStore::default());
        store.save(Some(&session));
        let mut cfg = config();
        cfg.url = format!("http://127.0.0.1:{port}");
        let auth = Arc::new(CloudAuth::new(cfg, Server::new(vec![]), store, "dev".into()));

        let events = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
        let sink = events.clone();
        let live = Arc::new(AtomicBool::new(false));
        let on_event: Arc<dyn Fn(String, Value) + Send + Sync> = Arc::new(move |e, p| sink.lock().unwrap().push((e, p)));
        let task = tokio::spawn(run(auth, "u1".into(), live.clone(), on_event));
        for _ in 0..50 {
            if events.lock().unwrap().iter().any(|(e, _)| e == "offline") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        task.abort();
        let join = joined_with.lock().unwrap().clone().expect("клиент вошёл в канал");
        assert_eq!(join["topic"], "realtime:user:u1");
        assert_eq!(join["payload"]["access_token"], "access-1");
        let got: Vec<String> = events.lock().unwrap().iter().map(|(e, _)| e.clone()).collect();
        assert_eq!(got, vec!["resync", "chat", "offline"]);
        assert_eq!(events.lock().unwrap()[1].1, json!({"conversation_id": "c1"}));
        assert!(!live.load(Ordering::SeqCst), "после обрыва канал не считается открытым");
    }
}
