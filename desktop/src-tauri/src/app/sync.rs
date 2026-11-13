//! Фоновая синхронизация открытой облачной учётной записи.
//!
//! Запускается после входа, после каждого локального изменения (с задержкой 3 с, чтобы собрать пачку),
//! раз в минуту (это же возвращает связь после обрыва сети). Одновременно идёт не больше одной
//! синхронизации; изменения во время неё запускают ещё одну.

use super::session::{Core, Session};
use crate::cloud::error::CloudError;
use crate::cloud::sync::SyncEngine;
use crate::util::{format_date, parse_date};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncKind {
    Idle,
    Syncing,
    Offline,
    Failed,
}

pub struct SyncState {
    pub kind: SyncKind,
    pub message: Option<String>,
    pub last_sync: Option<DateTime<Utc>>,
    pub pending: i64,
    /// Итоги последней удачной синхронизации: сколько изменений отправлено и получено.
    pub last_pushed: usize,
    pub last_pulled: usize,
    running: bool,
    again: bool,
    debounce: u64,
    pub cancel: CancellationToken,
}

impl SyncState {
    pub fn new() -> Self {
        Self {
            kind: SyncKind::Idle,
            message: None,
            last_sync: None,
            pending: 0,
            last_pushed: 0,
            last_pulled: 0,
            running: false,
            again: false,
            debounce: 0,
            cancel: CancellationToken::new(),
        }
    }
}

impl Default for SyncState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub enabled: bool,
    pub kind: SyncKind,
    pub message: Option<String>,
    pub last_sync: Option<String>,
    pub pending: i64,
    pub last_pushed: usize,
    pub last_pulled: usize,
}

impl Session {
    pub fn sync_status(&self) -> SyncStatus {
        let st = self.sync.lock().unwrap();
        SyncStatus {
            enabled: true,
            kind: st.kind,
            message: st.message.clone(),
            last_sync: st.last_sync.as_ref().map(format_date),
            pending: st.pending,
            last_pushed: st.last_pushed,
            last_pulled: st.last_pulled,
        }
    }
}

impl Core {
    fn emit_sync(&self, s: &Session) {
        self.env.emit("sync-state", serde_json::to_value(s.sync_status()).unwrap_or(Value::Null));
    }

    fn refresh_pending(&self, s: &Session) {
        let n = s.with_store(|st| st.pending_sync_count());
        s.sync.lock().unwrap().pending = n;
    }

    pub fn sync_status(&self) -> super::CmdResult<SyncStatus> {
        let s = self.require()?;
        self.refresh_pending(&s);
        Ok(s.sync_status())
    }

    pub(crate) fn start_sync(self: &Arc<Self>, s: &Arc<Session>) {
        s.sync.lock().unwrap().last_sync = s.with_store(|st| st.value("sync.last_at")).as_deref().and_then(parse_date);
        let (core, session) = (self.clone(), s.clone());
        let handle = tokio::spawn(async move {
            let mut tick = 0u32;
            loop {
                core.sync_now(&session);
                // Список Workspace и участники: созданное или изменённое на другом устройстве появляется без перезапуска.
                if tick % 2 == 1 {
                    let _ = core.ws_refresh().await;
                }
                tick = tick.wrapping_add(1);
                tokio::time::sleep(Duration::from_secs(60)).await;
            }
        });
        s.tasks.lock().unwrap().push(handle);
    }

    /// После локального изменения: отправить через 3 секунды (изменения за это время уходят одной пачкой).
    pub fn sync_soon(self: &Arc<Self>, s: &Arc<Session>) {
        if self.env.cloud.is_none() {
            return;
        }
        self.refresh_pending(s);
        self.emit_sync(s);
        let generation = {
            let mut st = s.sync.lock().unwrap();
            st.debounce += 1;
            st.debounce
        };
        let (core, session) = (self.clone(), s.clone());
        let handle = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(3)).await;
            if session.sync.lock().unwrap().debounce == generation {
                core.sync_now(&session);
            }
        });
        s.tasks.lock().unwrap().push(handle);
    }

    pub fn sync_now_command(self: &Arc<Self>) -> super::CmdResult<()> {
        let s = self.require()?;
        self.sync_now(&s);
        Ok(())
    }

    /// Кнопка «Синхронизировать»: настройки и лиды, затем Workspace (список, участники, CRM-данные).
    pub async fn sync_everything_command(self: &Arc<Self>) -> super::CmdResult<()> {
        self.sync_now_command()?;
        let _ = self.ws_refresh().await;
        Ok(())
    }

    pub(crate) fn sync_now(self: &Arc<Self>, s: &Arc<Session>) {
        let Some(cloud) = self.env.cloud.clone() else { return };
        {
            let mut st = s.sync.lock().unwrap();
            if st.running {
                st.again = true;
                return;
            }
            st.running = true;
            st.kind = SyncKind::Syncing;
        }
        self.emit_sync(s);
        let (core, session) = (self.clone(), s.clone());
        tokio::spawn(async move {
            // Свой набор запросов не мешает интерфейсу и поиску: база блокируется только на время отдельных операций.
            let engine = SyncEngine::new(cloud, session.store.clone(), core.env.device_id.clone());
            let result = engine.sync().await;
            core.finish_sync(&session, result);
        });
    }

    fn finish_sync(self: &Arc<Self>, s: &Arc<Session>, result: Result<crate::cloud::sync::SyncReport, CloudError>) {
        let mut again = false;
        let mut pulled = 0;
        let mut expired = false;
        {
            let mut st = s.sync.lock().unwrap();
            st.running = false;
            match &result {
                Ok(r) => {
                    st.kind = SyncKind::Idle;
                    st.message = None;
                    st.last_sync = Some(Utc::now());
                    pulled = r.pulled;
                    st.last_pushed = r.pushed;
                    st.last_pulled = r.pulled;
                }
                Err(CloudError::SessionExpired) => {
                    st.kind = SyncKind::Failed;
                    st.message = Some(CloudError::SessionExpired.to_string());
                    expired = true;
                }
                Err(CloudError::Network(_)) => {
                    st.kind = SyncKind::Offline;
                    st.message = None;
                }
                Err(e) => {
                    st.kind = SyncKind::Failed;
                    st.message = Some(e.to_string());
                }
            }
            if !expired && st.again {
                st.again = false;
                again = true;
            }
        }
        if expired {
            self.session_expired();
            return;
        }
        if result.is_ok() {
            let _ = s.with_store(|st| st.set_value("sync.last_at", &crate::util::now_string()));
            let (core, session) = (self.clone(), s.clone());
            tokio::spawn(async move { core.pull_own_profile(&session).await });
        }
        if pulled > 0 {
            self.env.emit("data-changed", Value::Null);
            self.reload_synced_settings(s);
            // Имя и аватар тоже приходят из облака.
            self.env.emit("session-changed", serde_json::to_value(self.info()).unwrap_or(Value::Null));
        }
        if let Err(e) = &result {
            if !matches!(e, CloudError::Network(_)) {
                self.env.log_error(&format!("Синхронизация: {e}"));
            }
            if matches!(e, CloudError::Server(_)) && s.account_prefs().notify_errors {
                self.env.emit("notify", serde_json::json!({"kind": "error", "title": "Ошибка синхронизации", "body": e.to_string()}));
            }
        } else if pulled > 0 && s.account_prefs().notify_sync {
            self.env.emit("notify", serde_json::json!({"kind": "sync", "title": "Синхронизация", "body": format!("Получено изменений: {pulled}")}));
        }
        self.refresh_pending(s);
        self.emit_sync(s);
        if again {
            self.sync_now(s);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::testing::fixture;
    use super::*;
    use crate::search::http::{HttpResponse, SearchError};

    const SESSION: &str = r#"{"access_token":"AT","refresh_token":"RT","expires_in":3600,"user":{"id":"U-1","email":"me@example.com","email_confirmed_at":"2026-11-05T00:00:00Z"}}"#;

    async fn wait_idle(core: &Arc<Core>) {
        for _ in 0..200 {
            let running = core.session().map(|s| s.sync.lock().unwrap().running).unwrap_or(false);
            if !running {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("синхронизация не завершилась");
    }

    #[tokio::test]
    async fn sync_goes_offline_on_network_error_and_recovers() {
        let f = fixture(true, vec![Ok(HttpResponse::new(200, SESSION)), Err(SearchError::http("нет сети", None, true))]);
        let core = Core::new(f.env.clone());
        core.cloud_sign_in("me@example.com", "Password-1").await.unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        wait_idle(&core).await;
        let st = core.sync_status().unwrap();
        assert!(st.enabled);
        assert_eq!(st.kind, SyncKind::Offline, "{st:?}");
        // сервер снова доступен: пустой ответ push (нечего отправлять) и пустая выдача pull
        for _ in 0..4 {
            f.transport.responses.lock().unwrap().push_back(Ok(HttpResponse::new(200, "[]")));
        }
        core.sync_now_command().unwrap();
        wait_idle(&core).await;
        assert_eq!(core.sync_status().unwrap().kind, SyncKind::Idle);
        assert!(core.sync_status().unwrap().last_sync.is_some());
    }

    #[tokio::test]
    async fn revoked_session_ends_the_cloud_session() {
        let f = fixture(
            true,
            vec![
                Ok(HttpResponse::new(200, SESSION)),
                Ok(HttpResponse::new(401, r#"{"message":"JWT expired"}"#)),
                Ok(HttpResponse::new(401, "{}")),
                Ok(HttpResponse::new(400, r#"{"error":"invalid_grant"}"#)),
            ],
        );
        let core = Core::new(f.env.clone());
        core.cloud_sign_in("me@example.com", "Password-1").await.unwrap();
        for _ in 0..100 {
            if core.session().is_none() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        assert!(core.session().is_none(), "после отзыва сессии запись закрыта");
        assert!(f.events.count("session-ended") >= 1);
    }
}
