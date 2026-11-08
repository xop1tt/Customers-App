//! Двусторонняя синхронизация: сначала выгрузка журнала изменений, затем загрузка всего, что новее
//! локальных курсоров. Конфликты решает сервер по времени изменения каждого поля.

use crate::cloud::auth::CloudAuth;
use crate::cloud::error::{CloudError, CloudResult};
use crate::cloud::types::*;
use crate::store::LeadStore;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, PartialEq, Default, serde::Serialize)]
pub struct SyncReport {
    pub pushed: usize,
    pub pulled: usize,
}

pub struct SyncEngine {
    auth: Arc<CloudAuth>,
    store: Arc<Mutex<LeadStore>>,
    device_id: String,
    batch: i64,
    page_size: usize,
}

fn rest_error(status: u16, data: &[u8]) -> CloudError {
    if status == 401 || status == 403 {
        return CloudError::SessionExpired;
    }
    let msg = serde_json::from_slice::<Value>(data).ok().and_then(|v| v.get("message").and_then(Value::as_str).map(|s| s.chars().take(200).collect::<String>()));
    CloudError::Server(msg.unwrap_or_else(|| format!("HTTP {status}")))
}

impl SyncEngine {
    pub fn new(auth: Arc<CloudAuth>, store: Arc<Mutex<LeadStore>>, device_id: String) -> Self {
        Self { auth, store, device_id, batch: 200, page_size: 500 }
    }

    pub fn with_sizes(mut self, batch: i64, page_size: usize) -> Self {
        self.batch = batch;
        self.page_size = page_size;
        self
    }

    fn db<T>(&self, f: impl FnOnce(&LeadStore) -> T) -> T {
        f(&self.store.lock().unwrap())
    }

    pub async fn sync(&self) -> CloudResult<SyncReport> {
        let mut report = SyncReport { pushed: self.push().await?, ..Default::default() };
        report.pulled = self.pull().await?;
        // Изменения, сделанные во время загрузки, уходят сразу же.
        report.pushed += self.push().await?;
        Ok(report)
    }

    pub async fn push(&self) -> CloudResult<usize> {
        let mut total = 0;
        for _ in 0..1000 {
            // защита от бесконечного цикла
            let pending = self.db(|s| s.pending_changes(self.batch)).map_err(|e| CloudError::Server(e.to_string()))?;
            if pending.is_empty() {
                break;
            }
            let body = json!({
                "p_device": self.device_id,
                "p_changes": {
                    "leads": pending.leads,
                    "exclusions": pending.exclusions,
                    "settings": pending.settings,
                },
            });
            let (status, data) = self.auth.authorized("POST", "/rest/v1/rpc/sync_push", Some(&body), &[]).await?;
            if !(200..300).contains(&status) {
                return Err(rest_error(status, &data));
            }
            self.db(|s| s.mark_pushed(&pending)).map_err(|e| CloudError::Server(e.to_string()))?;
            total += pending.count();
            if (pending.count() as i64) < self.batch {
                break;
            }
        }
        Ok(total)
    }

    pub async fn pull(&self) -> CloudResult<usize> {
        let mut total = 0;
        total += self.pull_table::<RemoteLead>("leads", |s, rows| s.apply_remote(rows, &[], &[]), |r| r.server_seq).await?;
        total += self.pull_table::<RemoteExclusion>("exclusions", |s, rows| s.apply_remote(&[], rows, &[]), |r| r.server_seq).await?;
        total += self.pull_table::<RemoteSetting>("user_settings", |s, rows| s.apply_remote(&[], &[], rows), |r| r.server_seq).await?;
        Ok(total)
    }

    async fn pull_table<T: DeserializeOwned>(
        &self,
        table: &str,
        apply: impl Fn(&LeadStore, &[T]) -> crate::error::AppResult<()>,
        seq: impl Fn(&T) -> i64,
    ) -> CloudResult<usize> {
        let mut total = 0;
        for _ in 0..10_000 {
            let cursor = self.db(|s| s.sync_cursor(table));
            let path = format!("/rest/v1/{table}?select=*&server_seq=gt.{cursor}&order=server_seq.asc&limit={}", self.page_size);
            let (status, data) = self.auth.authorized("GET", &path, None, &[]).await?;
            if !(200..300).contains(&status) {
                return Err(rest_error(status, &data));
            }
            let rows: Vec<T> = serde_json::from_slice(&data).map_err(|e| CloudError::Server(format!("ответ сервера не разобран: {e}")))?;
            if rows.is_empty() {
                break;
            }
            let max = rows.iter().map(&seq).max().unwrap_or(cursor);
            self.db(|s| apply(s, &rows).and_then(|_| s.set_sync_cursor(table, max))).map_err(|e| CloudError::Server(e.to_string()))?;
            total += rows.len();
            if rows.len() < self.page_size {
                break;
            }
        }
        Ok(total)
    }

    /// Сводка в облаке — для проверки первоначального переноса.
    pub async fn remote_stats(&self) -> CloudResult<BTreeMap<String, i64>> {
        let (status, data) = self.auth.authorized("POST", "/rest/v1/rpc/sync_stats", Some(&json!({})), &[]).await?;
        if !(200..300).contains(&status) {
            return Err(rest_error(status, &data));
        }
        let obj: Value = serde_json::from_slice(&data).unwrap_or(Value::Null);
        Ok(obj.as_object().map(|o| o.iter().filter_map(|(k, v)| v.as_i64().map(|n| (k.clone(), n))).collect()).unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::auth::tests::*;
    use crate::cloud::auth::{CloudSession, CloudUser, MemorySessionStore, SessionStore};
    use crate::models::{LeadData, LeadKind};
    use chrono::{Duration, Utc};

    fn engine(server: Arc<Server>, store: Arc<Mutex<LeadStore>>) -> SyncEngine {
        let sessions = Arc::new(MemorySessionStore::default());
        sessions.save(Some(&CloudSession {
            access_token: "a".into(),
            refresh_token: "r".into(),
            expires_at: Utc::now() + Duration::hours(1),
            user: CloudUser { id: "u".into(), email: "me@example.com".into(), ..Default::default() },
        }));
        let auth = Arc::new(CloudAuth::new(config(), server, sessions, "dev-1".into()));
        SyncEngine::new(auth, store, "dev-1".into())
    }

    fn tracked_store() -> (tempfile::TempDir, Arc<Mutex<LeadStore>>) {
        let dir = tempfile::tempdir().unwrap();
        let mut s = LeadStore::open(&dir.path().join("leads.db"), None).unwrap();
        s.enable_sync_tracking().unwrap();
        (dir, Arc::new(Mutex::new(s)))
    }

    #[tokio::test]
    async fn pushes_journal_in_batches_and_clears_it() {
        let (_d, store) = tracked_store();
        {
            let s = store.lock().unwrap();
            for i in 0..5 {
                let l = LeadData::new(LeadKind::Order, "fl_ru", &i.to_string(), &format!("Заказ {i}"));
                s.save(&l, &format!("id{i}"), &format!("fp{i}")).unwrap();
            }
        }
        let server = Server::new(vec![(200, "{}"), (200, "{}"), (200, "{}")]);
        let e = engine(server.clone(), store.clone()).with_sizes(2, 500);
        assert_eq!(e.push().await.unwrap(), 5);
        assert_eq!(server.paths(), vec!["POST /rest/v1/rpc/sync_push"; 3]);
        assert_eq!(server.body(0)["p_device"], "dev-1");
        assert_eq!(server.body(0)["p_changes"]["leads"].as_array().unwrap().len(), 2);
        assert_eq!(store.lock().unwrap().pending_sync_count(), 0);
    }

    #[tokio::test]
    async fn failed_push_keeps_journal() {
        let (_d, store) = tracked_store();
        store.lock().unwrap().save(&LeadData::new(LeadKind::Order, "fl_ru", "1", "x"), "id1", "fp1").unwrap();
        let server = Server::new(vec![(500, r#"{"message":"boom"}"#)]);
        let err = engine(server, store.clone()).push().await.unwrap_err();
        assert_eq!(err, CloudError::Server("boom".into()));
        assert_eq!(store.lock().unwrap().pending_sync_count(), 1);
    }

    fn remote_lead(id: &str, seq: i64, favorite: bool) -> Value {
        json!({"lead_id": id, "fingerprint": format!("fp-{id}"), "kind": "order", "source": "fl_ru", "title": "Из облака",
               "score": 50.0, "relevance": "medium", "discovered_at": "2026-11-01T10:00:00Z", "data": {"kind":"order","source":"fl_ru","externalId":"1","title":"Из облака"},
               "favorite": favorite, "archived": false, "deleted": false, "seen": true, "note": "", "field_ts": {"favorite": "2026-11-02T10:00:00.000Z"}, "server_seq": seq})
    }

    #[tokio::test]
    async fn pulls_pages_until_short_page_and_moves_cursor() {
        let (_d, store) = tracked_store();
        let page1 = json!([remote_lead("a", 1, true), remote_lead("b", 2, false)]).to_string();
        let page2 = json!([remote_lead("c", 3, false)]).to_string();
        let server = Server::new(vec![(200, &page1), (200, &page2), (200, "[]"), (200, "[]")]);
        let e = engine(server.clone(), store.clone()).with_sizes(200, 2);
        assert_eq!(e.pull().await.unwrap(), 3);
        let paths = server.paths();
        assert!(paths[0].contains("/rest/v1/leads?select=*&server_seq=gt.0&order=server_seq.asc&limit=2"));
        assert!(paths[1].contains("server_seq=gt.2"));
        let s = store.lock().unwrap();
        assert_eq!(s.sync_cursor("leads"), 3);
        let leads = s.all_leads(true).unwrap();
        assert_eq!(leads.len(), 3);
        assert!(leads.iter().find(|l| l.id == "a").unwrap().favorite);
        // применённое из облака не возвращается в журнал
        assert_eq!(s.pending_sync_count(), 0);
    }

    #[tokio::test]
    async fn unauthorized_pull_reports_expired_session() {
        let (_d, store) = tracked_store();
        let server = Server::new(vec![(403, "{}")]);
        assert_eq!(engine(server, store).pull().await.unwrap_err(), CloudError::SessionExpired);
    }

    #[tokio::test]
    async fn remote_stats_reads_counts() {
        let (_d, store) = tracked_store();
        let server = Server::new(vec![(200, r#"{"leads":12,"exclusions":3,"settings":1}"#)]);
        let stats = engine(server, store).remote_stats().await.unwrap();
        assert_eq!(stats["leads"], 12);
        assert_eq!(stats.len(), 3);
    }
}
