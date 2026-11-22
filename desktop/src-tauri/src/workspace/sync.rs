//! Синхронизация базы Workspace с Supabase (docs/SYNC_ARCHITECTURE.md §2): выгрузка очереди через `crm_push`
//! пакетами до 500 операций, затем загрузка по курсорам `server_seq` каждой таблицы. База блокируется только
//! на время отдельных шагов, сеть — без блокировки.

use super::catalog::WorkspaceInfo;
use super::schema::{Class, ENTITIES};
use super::store::{Member, WorkspaceStore};
use crate::cloud::auth::CloudAuth;
use crate::cloud::error::{CloudError, CloudResult};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

pub const PAGE: usize = 500;
const SCOPE_EVENTS: &str = "crm_scope_events";

/// Что изменилось в видимости записей с прошлой загрузки.
#[derive(Debug, Default)]
struct Scope {
    last: i64,
    full: bool,
    moved: std::collections::BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrmSyncReport {
    pub pushed: usize,
    pub rejected: usize,
    pub conflicts: usize,
    pub pulled: usize,
}

/// Ошибка с кодом PostgreSQL из ответа PostgREST.
fn rest_error(status: u16, data: &[u8]) -> CloudError {
    let v: Value = serde_json::from_slice(data).unwrap_or(Value::Null);
    let msg: String = v["message"].as_str().unwrap_or("").chars().take(200).collect();
    if status == 401 || (status == 403 && v["code"].as_str() != Some("42501")) {
        return CloudError::SessionExpired;
    }
    if v["code"].as_str() == Some("42501") && msg.contains("not a member") {
        return CloudError::Server("not a member".into());
    }
    CloudError::Server(if msg.is_empty() { format!("HTTP {status}") } else { msg })
}

pub fn is_not_member(e: &CloudError) -> bool {
    matches!(e, CloudError::Server(m) if m == "not a member")
}

async fn call(auth: &CloudAuth, method: &str, path: &str, body: Option<&Value>, headers: &[(&str, &str)]) -> CloudResult<Value> {
    let (status, data) = auth.authorized(method, path, body, headers).await?;
    if !(200..300).contains(&status) {
        return Err(rest_error(status, &data));
    }
    if data.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&data).map_err(|e| CloudError::Server(format!("ответ сервера: {e}")))
}

pub async fn rpc(auth: &CloudAuth, name: &str, args: Value) -> CloudResult<Value> {
    call(auth, "POST", &format!("/rest/v1/rpc/{name}"), Some(&args), &[]).await
}

/// Чтение таблицы через PostgREST (`path` — часть после `/rest/v1/`).
pub async fn select(auth: &CloudAuth, path: &str) -> CloudResult<Value> {
    call(auth, "GET", &format!("/rest/v1/{path}"), None, &[]).await
}

/// Список своих Workspace; при первом входе 2.0 создаётся личный (идемпотентно).
pub async fn workspaces(auth: &CloudAuth) -> CloudResult<Vec<WorkspaceInfo>> {
    rpc(auth, "ensure_personal_workspace", json!({})).await?;
    let list = rpc(auth, "my_workspaces", json!({})).await?;
    Ok(list
        .as_array()
        .map(|a| {
            a.iter()
                .map(|w| WorkspaceInfo {
                    id: w["id"].as_str().unwrap_or_default().to_string(),
                    name: w["name"].as_str().unwrap_or_default().to_string(),
                    personal: w["personal"].as_bool().unwrap_or(false),
                    role: w["role"].as_str().unwrap_or("viewer").to_string(),
                    role_name: w["role_name"].as_str().unwrap_or_default().to_string(),
                    rank: w["rank"].as_i64().unwrap_or(0),
                    permissions: w["permissions"].as_array().map(|p| p.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default(),
                    members: w["members"].as_i64().unwrap_or(1),
                    remote: true,
                    default_currency: w["default_currency"].as_str().unwrap_or("RUB").trim().to_string(),
                })
                .filter(|w| !w.id.is_empty())
                .collect()
        })
        .unwrap_or_default())
}

pub async fn members(auth: &CloudAuth, workspace: &str) -> CloudResult<Vec<Member>> {
    let list = rpc(auth, "workspace_members_list", json!({"p_workspace": workspace})).await?;
    Ok(list
        .as_array()
        .map(|a| {
            a.iter()
                .map(|m| Member {
                    user_id: m["user_id"].as_str().unwrap_or_default().to_string(),
                    display_name: m["display_name"].as_str().unwrap_or_default().to_string(),
                    role: m["role"].as_str().unwrap_or_default().to_string(),
                    role_name: m["role_name"].as_str().unwrap_or_default().to_string(),
                    rank: m["rank"].as_i64().unwrap_or(0),
                    avatar_path: m["avatar_path"].as_str().map(String::from),
                    email: m["email"].as_str().map(String::from),
                })
                .collect()
        })
        .unwrap_or_default())
}

pub struct CrmSync {
    auth: Arc<CloudAuth>,
    store: Arc<Mutex<WorkspaceStore>>,
    device: String,
    workspace: String,
    user: String,
}

impl CrmSync {
    pub fn new(auth: Arc<CloudAuth>, store: Arc<Mutex<WorkspaceStore>>, device: String) -> Self {
        let (workspace, user) = {
            let s = store.lock().unwrap();
            (s.workspace_id.clone(), s.user_id.clone())
        };
        Self { auth, store, device, workspace, user }
    }

    fn db<T>(&self, f: impl FnOnce(&WorkspaceStore) -> crate::error::AppResult<T>) -> CloudResult<T> {
        f(&self.store.lock().unwrap()).map_err(|e| CloudError::Server(e.to_string()))
    }

    pub async fn sync(&self) -> CloudResult<CrmSyncReport> {
        let mut report = CrmSyncReport::default();
        self.push(&mut report).await?;
        report.pulled = self.pull().await?;
        self.push(&mut report).await?;
        self.push_prefs().await?;
        Ok(report)
    }

    pub async fn push(&self, report: &mut CrmSyncReport) -> CloudResult<()> {
        for _ in 0..1000 {
            let ops = self.db(|s| s.pending_ops(PAGE))?;
            if ops.is_empty() {
                break;
            }
            self.db(|s| s.mark_sending(&ops))?;
            let body = json!({"p_workspace": self.workspace, "p_device": self.device, "p_ops": ops.iter().map(|o| o.to_push()).collect::<Vec<_>>()});
            let res = match call(&self.auth, "POST", "/rest/v1/rpc/crm_push", Some(&body), &[]).await {
                Ok(v) => v,
                Err(e) => {
                    if matches!(e, CloudError::Network(_)) {
                        self.db(|s| s.postpone(&ops, "нет связи"))?;
                    }
                    return Err(e);
                }
            };
            let mut refetch = Vec::new();
            for r in res["results"].as_array().cloned().unwrap_or_default() {
                match r["status"].as_str() {
                    Some("rejected") => report.rejected += 1,
                    Some("conflict") => report.conflicts += 1,
                    _ => report.pushed += 1,
                }
                if let Some(x) = self.db(|s| s.apply_result(&r))? {
                    refetch.push(x);
                }
            }
            // Отклонённая или проигравшая запись возвращается к серверной версии.
            for (table, id) in refetch {
                let rows = call(&self.auth, "GET", &format!("/rest/v1/{table}?id=eq.{id}&workspace_id=eq.{}", self.workspace), None, &[]).await?;
                let rows = rows.as_array().cloned().unwrap_or_default();
                if rows.is_empty() {
                    self.db(|s| s.forget(&table, &id))?;
                } else {
                    self.db(|s| s.apply_remote(&table, &rows).map(|_| ()))?;
                }
            }
        }
        Ok(())
    }

    async fn page(&self, table: &str, cursor: i64, extra: &str) -> CloudResult<Vec<Value>> {
        let path = format!("/rest/v1/{table}?{extra}server_seq=gt.{cursor}&order=server_seq.asc&limit={PAGE}");
        Ok(call(&self.auth, "GET", &path, None, &[]).await?.as_array().cloned().unwrap_or_default())
    }

    pub async fn pull(&self) -> CloudResult<usize> {
        let mut total = 0;
        let ws = format!("workspace_id=eq.{}&", self.workspace);
        let scope = self.scope_events().await?;
        if scope.full {
            self.db(|s| s.reset_record_cursors())?;
        }
        for e in ENTITIES {
            loop {
                let cursor = self.db(|s| Ok(s.cursor(e.table)))?;
                let rows = self.page(e.table, cursor, &ws).await?;
                total += rows.len();
                let n = rows.len();
                self.db(|s| s.apply_remote(e.table, &rows))?;
                if n < PAGE {
                    break;
                }
            }
        }
        for table in ["deal_stage_history", "sync_conflicts"] {
            loop {
                let cursor = self.db(|s| Ok(s.cursor(table)))?;
                let rows = self.page(table, cursor, &ws).await?;
                let n = rows.len();
                if table == "deal_stage_history" {
                    self.db(|s| s.apply_remote_history(&rows))?;
                } else {
                    let mine: Vec<Value> = rows
                        .into_iter()
                        .filter(|r| r["lost_by"].as_str() == Some(self.user.as_str()) || r["kept_by"].as_str() == Some(self.user.as_str()))
                        .collect();
                    self.db(|s| s.apply_remote_conflicts(&mine))?;
                    // Курсор двигается и по чужим конфликтам, которые здесь не показываются.
                }
                if n < PAGE {
                    break;
                }
            }
        }
        self.drop_hidden(&scope).await?;
        if scope.last > 0 {
            self.db(|s| s.set_cursor(SCOPE_EVENTS, scope.last))?;
        }
        let prefs = call(
            &self.auth,
            "GET",
            &format!("/rest/v1/collection_user_prefs?workspace_id=eq.{}&select=collection_id,position,hidden", self.workspace),
            None,
            &[],
        )
        .await?;
        self.db(|s| {
            for p in prefs.as_array().cloned().unwrap_or_default() {
                if let Some(id) = p["collection_id"].as_str() {
                    s.set_collection_pref(id, p["position"].as_f64().unwrap_or(0.0), p["hidden"].as_bool().unwrap_or(false), false)?;
                }
            }
            Ok(())
        })?;
        Ok(total)
    }

    /// Журнал видимости (ADR-096): какие записи перешли в другой отдел или к другому ответственному и менялись ли
    /// права и структура отделов. Сервер без журнала (миграция ещё не применена) — пустой ответ.
    async fn scope_events(&self) -> CloudResult<Scope> {
        let mut scope = Scope { last: self.db(|s| Ok(s.cursor(SCOPE_EVENTS)))?, ..Scope::default() };
        loop {
            let path =
                format!("/rest/v1/{SCOPE_EVENTS}?workspace_id=eq.{}&id=gt.{}&order=id.asc&limit={PAGE}&select=id,entity,entity_id", self.workspace, scope.last);
            let rows = match call(&self.auth, "GET", &path, None, &[]).await {
                Ok(v) => v.as_array().cloned().unwrap_or_default(),
                Err(CloudError::Server(m)) if m.contains(SCOPE_EVENTS) || m == "HTTP 404" => return Ok(Scope::default()),
                Err(e) => return Err(e),
            };
            for r in &rows {
                scope.last = scope.last.max(r["id"].as_i64().unwrap_or(0));
                match (r["entity"].as_str(), r["entity_id"].as_str()) {
                    (Some(t), Some(id)) if ENTITIES.iter().any(|e| e.table == t) => scope.moved.entry(t.to_string()).or_default().push(id.to_string()),
                    _ => scope.full = true,
                }
            }
            if rows.len() < PAGE {
                return Ok(scope);
            }
        }
    }

    /// Убирает с устройства записи, которых сервер больше не показывает.
    async fn drop_hidden(&self, scope: &Scope) -> CloudResult<()> {
        if scope.full {
            for e in ENTITIES.iter().filter(|e| e.class == Class::Records) {
                let mut visible = HashSet::new();
                let mut after = String::new();
                loop {
                    let from = if after.is_empty() { String::new() } else { format!("id=gt.{after}&") };
                    let path = format!("/rest/v1/{}?workspace_id=eq.{}&{from}select=id&order=id.asc&limit=1000", e.table, self.workspace);
                    let rows = call(&self.auth, "GET", &path, None, &[]).await?.as_array().cloned().unwrap_or_default();
                    for r in &rows {
                        if let Some(id) = r["id"].as_str() {
                            visible.insert(id.to_string());
                            after = id.to_string();
                        }
                    }
                    if rows.len() < 1000 {
                        break;
                    }
                }
                let hidden: Vec<String> = self.db(|s| s.synced_ids(e.table))?.into_iter().filter(|id| !visible.contains(id)).collect();
                self.db(|s| s.forget_hidden(e.table, &hidden))?;
            }
            return Ok(());
        }
        for (table, ids) in &scope.moved {
            for chunk in ids.chunks(100) {
                let list = chunk.join(",");
                let path = format!("/rest/v1/{table}?workspace_id=eq.{}&id=in.({list})&select=id", self.workspace);
                let rows = call(&self.auth, "GET", &path, None, &[]).await?;
                let seen: HashSet<&str> = rows.as_array().map(|a| a.iter().filter_map(|r| r["id"].as_str()).collect()).unwrap_or_default();
                let hidden: Vec<String> = chunk.iter().filter(|id| !seen.contains(id.as_str())).cloned().collect();
                self.db(|s| s.forget_hidden(table, &hidden))?;
            }
        }
        Ok(())
    }

    async fn push_prefs(&self) -> CloudResult<()> {
        let dirty = self.db(|s| s.dirty_collection_prefs())?;
        if dirty.is_empty() {
            return Ok(());
        }
        let rows: Vec<Value> = dirty
            .iter()
            .map(|(id, pos, hidden)| json!({"collection_id": id, "user_id": self.user, "workspace_id": self.workspace, "position": pos, "hidden": hidden}))
            .collect();
        call(
            &self.auth,
            "POST",
            "/rest/v1/collection_user_prefs?on_conflict=collection_id,user_id",
            Some(&Value::Array(rows)),
            &[("Prefer", "resolution=merge-duplicates,return=minimal")],
        )
        .await?;
        self.db(|s| {
            for (id, pos, hidden) in &dirty {
                s.set_collection_pref(id, *pos, *hidden, false)?;
            }
            Ok(())
        })
    }
}
