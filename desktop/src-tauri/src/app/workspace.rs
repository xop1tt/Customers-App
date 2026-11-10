//! Customers 2.0 в прикладном слое: выбранный Workspace открытой учётной записи, записи CRM, преобразование лидов,
//! участники и приглашения, коллекции, синхронизация базы Workspace и напоминания задач.
//!
//! Локальная учётная запись получает один локальный Workspace (только на этом устройстве). Облачная — список
//! Workspace с сервера (`my_workspaces`; личный создаётся при первом входе 2.0). Базы лежат в папке учётной
//! записи: `workspaces/<id>.db`; база генератора лидов не меняется.

use super::session::{Core, Session};
use super::{CmdError, CmdResult};
use crate::cloud::error::CloudError;
use crate::workspace::catalog::{database_file, Catalog, WorkspaceInfo};
use crate::workspace::convert::{convert_lead, ConvertOptions};
use crate::workspace::query::Query;
use crate::workspace::store::{stamp, Member, WorkspaceStore, ALL_PERMISSIONS};
use crate::workspace::sync::{self, CrmSync};
use crate::workspace::{dedupe, schema};
use chrono::Utc;
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Default)]
pub struct CrmState {
    catalog: Option<Catalog>,
    store: Option<Arc<Mutex<WorkspaceStore>>>,
    running: bool,
    again: bool,
    last_error: Option<String>,
    last_sync: Option<String>,
    reminders: bool,
    notified: std::collections::BTreeSet<String>,
}

type Store = Arc<Mutex<WorkspaceStore>>;

/// Идентификатор пользователя в записях CRM: uuid облачной учётной записи или постоянный uuid локальной.
pub fn user_id(s: &Session) -> String {
    if let Some(id) = s.id.strip_prefix("cloud-") {
        return id.to_lowercase();
    }
    use sha2::Digest;
    let hash = sha2::Sha256::digest(format!("customers-local-user:{}", s.key()).as_bytes());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&hash[..16]);
    uuid::Builder::from_bytes(bytes).with_version(uuid::Version::Sha1).with_variant(uuid::Variant::RFC4122).into_uuid().to_string()
}

fn cmd(e: impl std::fmt::Display) -> CmdError {
    CmdError::msg(e.to_string())
}

fn cloud_err(e: CloudError) -> CmdError {
    if sync::is_not_member(&e) {
        return CmdError::new("notMember", "Вас удалили из этого Workspace.");
    }
    CmdError::from(e)
}

impl Core {
    fn ws_dir(&self, s: &Session) -> PathBuf {
        s.dir.join("workspaces")
    }

    /// Список Workspace; у локальной учётной записи при первом обращении создаётся локальный Workspace.
    fn ws_catalog(&self, s: &Session) -> CmdResult<Catalog> {
        if let Some(c) = s.workspace.lock().unwrap().catalog.clone() {
            return Ok(c);
        }
        let dir = self.ws_dir(s);
        self.env.guard_path(&dir)?;
        let mut c = Catalog::load(&dir);
        // В облачной записи без единого Workspace (облако без миграций CRM, нет связи, первый запуск)
        // тоже создаётся локальный: CRM остаётся доступной, а серверные Workspace добавляются рядом.
        if c.workspaces.is_empty() {
            c.workspaces.push(WorkspaceInfo {
                id: uuid::Uuid::new_v4().to_string(),
                name: if s.is_cloud { "Личное пространство (на этом устройстве)".into() } else { "Личное пространство".into() },
                personal: true,
                role: "owner".into(),
                role_name: "Владелец".into(),
                rank: 100,
                permissions: ALL_PERMISSIONS.iter().map(|p| p.to_string()).collect(),
                members: 1,
                remote: false,
                default_currency: "RUB".into(),
            });
        }
        c.fix_active();
        c.save(&dir).map_err(cmd)?;
        s.workspace.lock().unwrap().catalog = Some(c.clone());
        Ok(c)
    }

    fn set_catalog(&self, s: &Session, c: Catalog) -> CmdResult<()> {
        c.save(&self.ws_dir(s)).map_err(cmd)?;
        s.workspace.lock().unwrap().catalog = Some(c);
        Ok(())
    }

    /// База выбранного Workspace (открывается при первом обращении).
    fn ws_store(&self, s: &Session) -> CmdResult<Store> {
        if let Some(st) = s.workspace.lock().unwrap().store.clone() {
            return Ok(st);
        }
        let c = self.ws_catalog(s)?;
        let info = c
            .active_info()
            .cloned()
            .ok_or_else(|| CmdError::new("noWorkspace", if s.is_cloud { "Workspace ещё не загружен: нужна связь с облаком." } else { "Нет Workspace." }))?;
        let path = database_file(&self.ws_dir(s), &info.id);
        self.env.guard_path(&path)?;
        let key = self.env.keys.key_for(&s.id).map_err(|e| CmdError::msg(format!("Не удалось открыть базу Workspace: {e}")))?;
        let store =
            WorkspaceStore::open(&path, Some(&key), &info.id, &user_id(s)).map_err(|e| CmdError::msg(format!("Не удалось открыть базу Workspace: {e}")))?;
        store.set_permissions(&info.permissions).map_err(cmd)?;
        store.set_meta("member_role", &info.role).map_err(cmd)?;
        store.set_meta("channel", self.env.channel.name()).map_err(cmd)?;
        if !info.remote {
            store.seed_local().map_err(cmd)?;
            let me = Member {
                user_id: user_id(s),
                display_name: s.display_name.clone(),
                role: "owner".into(),
                role_name: "Владелец".into(),
                rank: 100,
                avatar_path: None,
                email: None,
            };
            store.replace_members(&[me]).map_err(cmd)?;
        }
        let store = Arc::new(Mutex::new(store));
        s.workspace.lock().unwrap().store = Some(store.clone());
        Ok(store)
    }

    fn with_crm<T>(&self, f: impl FnOnce(&WorkspaceStore) -> crate::error::AppResult<T>) -> CmdResult<T> {
        let s = self.require()?;
        let st = self.ws_store(&s)?;
        let guard = st.lock().unwrap();
        f(&guard).map_err(cmd)
    }

    // ------------------------------------------------------------ состояние и выбор Workspace

    pub fn ws_state(self: &Arc<Self>) -> CmdResult<Value> {
        let s = self.require()?;
        let c = self.ws_catalog(&s)?;
        self.start_reminders(&s);
        let (pending, rejected, conflicts, members) = match self.ws_store(&s) {
            Ok(st) => {
                let g = st.lock().unwrap();
                (
                    g.pending_count(),
                    g.rejected_ops().map(|v| v.len()).unwrap_or(0),
                    g.conflicts().map(|v| v.len()).unwrap_or(0),
                    g.members().unwrap_or_default(),
                )
            }
            Err(_) => (0, 0, 0, vec![]),
        };
        let st = s.workspace.lock().unwrap();
        Ok(json!({
            "isCloud": s.is_cloud,
            "me": user_id(&s),
            "workspaces": c.workspaces,
            "active": c.active,
            "permissions": c.active_info().map(|w| w.permissions.clone()).unwrap_or_default(),
            "members": members,
            "pending": pending,
            "rejected": rejected,
            "conflicts": conflicts,
            "syncing": st.running,
            "lastSync": st.last_sync,
            "error": st.last_error,
        }))
    }

    pub fn ws_switch(self: &Arc<Self>, id: &str) -> CmdResult<Value> {
        let s = self.require()?;
        let mut c = self.ws_catalog(&s)?;
        if !c.workspaces.iter().any(|w| w.id == id) {
            return Err(CmdError::msg("Такого Workspace нет в списке."));
        }
        c.active = Some(id.to_string());
        self.set_catalog(&s, c)?;
        s.workspace.lock().unwrap().store = None;
        self.env.emit("workspace-changed", json!({"workspace": id}));
        if s.is_cloud {
            self.ws_sync_soon(&s);
        }
        self.ws_state()
    }

    /// Новый Workspace: в облаке — через `create_workspace`, у локальной учётной записи — на устройстве.
    pub async fn ws_create_workspace(self: &Arc<Self>, name: &str) -> CmdResult<Value> {
        let s = self.require()?;
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 120 {
            return Err(CmdError::msg("Название — от 1 до 120 символов."));
        }
        let id = if s.is_cloud {
            let cloud = self.env.cloud.clone().ok_or_else(|| CmdError::msg("Облако не настроено."))?;
            let id = sync::rpc(&cloud, "create_workspace", json!({"p_name": name})).await.map_err(cloud_err)?;
            self.ws_refresh_inner(&s).await?;
            id.as_str().unwrap_or_default().to_string()
        } else {
            let mut c = self.ws_catalog(&s)?;
            let id = uuid::Uuid::new_v4().to_string();
            c.workspaces.push(WorkspaceInfo {
                id: id.clone(),
                name: name.into(),
                personal: false,
                role: "owner".into(),
                role_name: "Владелец".into(),
                rank: 100,
                permissions: ALL_PERMISSIONS.iter().map(|p| p.to_string()).collect(),
                members: 1,
                remote: false,
                default_currency: "RUB".into(),
            });
            self.set_catalog(&s, c)?;
            id
        };
        self.ws_switch(&id)
    }

    /// Список Workspace и участники с сервера; Workspace, из которых пользователя удалили, исчезают с устройства.
    pub async fn ws_refresh(self: &Arc<Self>) -> CmdResult<Value> {
        let s = self.require()?;
        if s.is_cloud {
            self.ws_refresh_inner(&s).await?;
            self.ws_sync_soon(&s);
        }
        self.ws_state()
    }

    async fn ws_refresh_inner(self: &Arc<Self>, s: &Arc<Session>) -> CmdResult<()> {
        let cloud = self.env.cloud.clone().ok_or_else(|| CmdError::msg("Облако не настроено."))?;
        let fresh = sync::workspaces(&cloud).await.map_err(cloud_err)?;
        let mut c = self.ws_catalog(s)?;
        let before = c.active.clone();
        let gone = c.replace_remote(fresh);
        self.set_catalog(s, c.clone())?;
        if before != c.active || gone.iter().any(|w| Some(&w.id) == before.as_ref()) {
            s.workspace.lock().unwrap().store = None;
        }
        for w in gone {
            self.drop_workspace_copy(s, &w.id);
        }
        if let Some(active) = c.active_info().cloned() {
            if let Ok(members) = sync::members(&cloud, &active.id).await {
                let st = self.ws_store(s)?;
                let g = st.lock().unwrap();
                g.replace_members(&members).map_err(cmd)?;
                g.set_permissions(&active.permissions).map_err(cmd)?;
            }
        }
        self.env.emit("workspace-changed", Value::Null);
        Ok(())
    }

    /// Доступ к Workspace закрыт: неотправленные изменения сохраняются в файл рядом, база удаляется.
    fn drop_workspace_copy(&self, s: &Session, id: &str) {
        let dir = self.ws_dir(s);
        let path = database_file(&dir, id);
        if let Ok(key) = self.env.keys.key_for(&s.id) {
            if let Ok(st) = WorkspaceStore::open(&path, Some(&key), id, &user_id(s)) {
                let ops = st.all_ops().unwrap_or_default();
                if !ops.is_empty() {
                    let _ = std::fs::write(
                        dir.join(format!("{id}-unsent-{}.json", Utc::now().format("%Y%m%d-%H%M%S"))),
                        serde_json::to_vec_pretty(&ops).unwrap_or_default(),
                    );
                }
            }
        }
        crate::db::remove_database_files(&path);
        self.env.emit("notify", json!({"kind": "error", "title": "Доступ к Workspace закрыт", "body": "Локальная копия удалена. Неотправленные изменения сохранены в файл в папке учётной записи."}));
    }

    // ------------------------------------------------------------ записи

    pub fn ws_list(&self, entity: &str, query: Query) -> CmdResult<Value> {
        self.with_crm(|st| Ok(json!({"items": st.list(entity, &query)?, "total": st.count(entity, &Query { limit: None, offset: None, ..query.clone() })?})))
    }

    /// Карточка: запись и всё связанное с ней (контакты, сделки, задачи, лента, заметки, комментарии, история этапов).
    pub fn ws_card(&self, entity: &str, id: &str) -> CmdResult<Value> {
        self.with_crm(|st| {
            let record = st.get(entity, id)?.ok_or_else(|| crate::error::AppError::msg("Запись не найдена."))?;
            let mut out = json!({"record": record});
            if let Some(t) = schema::entity(entity).and_then(|e| e.entity_type).filter(|t| *t != "task") {
                for table in ["tasks", "activities", "notes", "comments", "custom_field_values"] {
                    out[table] = json!(st.linked(table, t, id)?);
                }
            }
            let by = |table: &str, field: &str| -> crate::error::AppResult<Value> {
                Ok(json!(st.list(table, &Query { filters: vec![crate::workspace::query::Filter::eq(field, id)], ..Default::default() })?))
            };
            match entity {
                "companies" => {
                    out["contacts"] = by("contacts", "company_id")?;
                    out["deals"] = by("deals", "company_id")?;
                }
                "deals" => {
                    out["history"] = json!(st.stage_history(id)?);
                    out["dealContacts"] = by("deal_contacts", "deal_id")?;
                }
                "contacts" => out["dealLinks"] = by("deal_contacts", "contact_id")?,
                _ => {}
            }
            let conflicts: Vec<Value> = st.conflicts()?.into_iter().filter(|c| c["entityId"] == id).collect();
            out["conflicts"] = json!(conflicts);
            Ok(out)
        })
    }

    pub fn ws_save(self: &Arc<Self>, entity: &str, id: Option<&str>, fields: Map<String, Value>) -> CmdResult<Value> {
        let row = self.with_crm(|st| st.save(entity, id, &fields))?;
        self.ws_changed();
        Ok(row)
    }

    pub fn ws_delete(self: &Arc<Self>, entity: &str, id: &str) -> CmdResult<Value> {
        let row = self.with_crm(|st| st.delete(entity, id))?;
        self.ws_changed();
        Ok(row)
    }

    pub fn ws_restore(self: &Arc<Self>, entity: &str, id: &str) -> CmdResult<Value> {
        let row = self.with_crm(|st| st.restore(entity, id))?;
        self.ws_changed();
        Ok(row)
    }

    /// «Похоже на: …» до сохранения.
    pub fn ws_duplicates(&self, entity: &str, fields: Map<String, Value>, except: Option<&str>) -> CmdResult<Value> {
        let keys = dedupe::keys(entity, &fields);
        self.with_crm(|st| Ok(json!(st.duplicates(entity, &keys, except)?)))
    }

    fn ws_changed(self: &Arc<Self>) {
        self.env.emit("workspace-changed", Value::Null);
        if let Some(s) = self.session().filter(|s| s.is_cloud) {
            self.ws_sync_soon(&s);
        }
    }

    /// Найденный лид → компания, контакт и (по желанию) сделка. Лид получает отметку `data.crm`.
    pub fn ws_convert_lead(self: &Arc<Self>, lead_id: &str, opts: ConvertOptions) -> CmdResult<Value> {
        let s = self.require()?;
        let lead = s.with_store(|st| st.all_leads(false)).map_err(cmd)?.into_iter().find(|l| l.id == lead_id).ok_or_else(|| CmdError::msg("Лид не найден."))?;
        let st = self.ws_store(&s)?;
        let done = convert_lead(&st.lock().unwrap(), &lead, &opts).map_err(cmd)?;
        s.with_store(|ls| ls.set_crm_mark(lead_id, &done.mark())).map_err(cmd)?;
        self.env.emit("data-changed", Value::Null);
        self.sync_soon(&s);
        self.ws_changed();
        serde_json::to_value(done).map_err(cmd)
    }

    // ------------------------------------------------------------ коллекции

    /// Коллекции для левой панели: свой порядок, скрытые не показываются, счётчик записей.
    pub fn ws_collections(&self) -> CmdResult<Value> {
        self.with_crm(|st| {
            let prefs = st.collection_prefs()?;
            let mut list = st.list("collections", &Query::default())?;
            list.retain(|c| !prefs.iter().any(|(id, _, hidden)| *hidden && c["id"] == json!(id)));
            for c in list.iter_mut() {
                if let Some((_, pos, _)) = prefs.iter().find(|(id, _, _)| c["id"] == json!(id)) {
                    c["position"] = json!(pos);
                }
                let table = c["entity_type"].as_str().and_then(schema::by_type).map(|e| e.table).unwrap_or("companies");
                c["count"] = json!(st.count(table, &Query::from_config(&c["config"])).unwrap_or(0));
            }
            list.sort_by(|a, b| a["position"].as_f64().unwrap_or(0.0).total_cmp(&b["position"].as_f64().unwrap_or(0.0)));
            Ok(json!(list))
        })
    }

    pub fn ws_collection_items(&self, id: &str, extra: Query) -> CmdResult<Value> {
        self.with_crm(|st| {
            let c = st.get("collections", id)?.ok_or_else(|| crate::error::AppError::msg("Коллекция не найдена."))?;
            let table = c["entity_type"]
                .as_str()
                .and_then(schema::by_type)
                .map(|e| e.table)
                .ok_or_else(|| crate::error::AppError::msg("Неизвестный тип коллекции."))?;
            let mut q = Query::from_config(&c["config"]);
            q.filters.extend(extra.filters);
            if !extra.sort.is_empty() {
                q.sort = extra.sort;
            }
            q.search = extra.search;
            q.limit = extra.limit;
            Ok(json!({"collection": c, "entity": table, "items": st.list(table, &q)?, "total": st.count(table, &Query { limit: None, ..q.clone() })?}))
        })
    }

    /// Порядок коллекций в левой панели — свой у каждого пользователя.
    pub fn ws_reorder_collections(self: &Arc<Self>, ids: Vec<String>) -> CmdResult<()> {
        self.with_crm(|st| {
            for (i, id) in ids.iter().enumerate() {
                st.set_collection_pref(id, (i + 1) as f64, false, true)?;
            }
            Ok(())
        })?;
        self.ws_changed();
        Ok(())
    }

    pub fn ws_hide_collection(self: &Arc<Self>, id: &str, hidden: bool) -> CmdResult<()> {
        self.with_crm(|st| {
            let pos = st.collection_prefs()?.into_iter().find(|(c, _, _)| c == id).map(|(_, p, _)| p).unwrap_or(0.0);
            st.set_collection_pref(id, pos, hidden, true)
        })?;
        self.ws_changed();
        Ok(())
    }

    // ------------------------------------------------------------ конфликты и отклонённые изменения

    pub fn ws_conflicts(&self) -> CmdResult<Value> {
        self.with_crm(|st| Ok(json!({"conflicts": st.conflicts()?, "rejected": st.rejected_ops()?})))
    }

    /// Закрыть конфликт; `take_lost` — вернуть потерянное значение (новая правка поверх текущей).
    pub fn ws_resolve_conflict(self: &Arc<Self>, id: &str, take_lost: bool) -> CmdResult<()> {
        self.with_crm(|st| {
            let c = st.conflicts()?.into_iter().find(|c| c["id"] == id).ok_or_else(|| crate::error::AppError::msg("Конфликт не найден."))?;
            if take_lost {
                let table =
                    c["entityType"].as_str().and_then(schema::entity).map(|e| e.table).ok_or_else(|| crate::error::AppError::msg("Неизвестная сущность."))?;
                let field = c["field"].as_str().unwrap_or_default();
                if field != "*deleted" {
                    let mut m = Map::new();
                    m.insert(field.into(), c["lost"].clone());
                    st.save(table, c["entityId"].as_str(), &m)?;
                }
            }
            st.resolve_conflict(id)
        })?;
        let s = self.require()?;
        if s.is_cloud {
            if let Some(cloud) = self.env.cloud.clone() {
                let id = id.to_string();
                tokio::spawn(async move {
                    let body = json!({"resolved_at": stamp(Utc::now())});
                    let _ = cloud.authorized("PATCH", &format!("/rest/v1/sync_conflicts?id=eq.{id}"), Some(&body), &[("Prefer", "return=minimal")]).await;
                });
            }
        }
        self.ws_changed();
        Ok(())
    }

    pub fn ws_dismiss_rejected(self: &Arc<Self>) -> CmdResult<usize> {
        let n = self.with_crm(|st| st.dismiss_rejected())?;
        self.ws_changed();
        Ok(n)
    }

    // ------------------------------------------------------------ участники и приглашения (облако)

    async fn ws_rpc(self: &Arc<Self>, name: &str, mut args: Value, with_workspace: bool) -> CmdResult<Value> {
        let s = self.require()?;
        if !s.is_cloud {
            return Err(CmdError::msg("Участники и приглашения доступны в облачной учётной записи."));
        }
        let cloud = self.env.cloud.clone().ok_or_else(|| CmdError::msg("Облако не настроено."))?;
        if with_workspace {
            let ws = self.ws_catalog(&s)?.active.ok_or_else(|| CmdError::msg("Workspace не выбран."))?;
            args["p_workspace"] = json!(ws);
        }
        let out = sync::rpc(&cloud, name, args).await.map_err(cloud_err)?;
        let _ = self.ws_refresh_inner(&s).await;
        Ok(out)
    }

    /// Приглашение: токен показывается один раз, его нужно передать приглашённому (письмом или в мессенджере).
    pub async fn ws_invite(self: &Arc<Self>, email: &str, role: &str) -> CmdResult<Value> {
        let r = self.ws_rpc("invite_member", json!({"p_email": email, "p_role": role}), true).await?;
        let token = r["token"].as_str().unwrap_or_default();
        Ok(json!({"id": r["id"], "email": r["email"], "role": r["role"], "expiresAt": r["expires_at"], "token": token,
                  "link": format!("{}://invite?token={token}", self.env.channel.identity().url_scheme)}))
    }

    pub async fn ws_accept_invitation(self: &Arc<Self>, token: &str) -> CmdResult<Value> {
        let token = token.trim().rsplit("token=").next().unwrap_or("").trim().to_string();
        let ws = self.ws_rpc("accept_invitation", json!({"p_token": token}), false).await?;
        if let Some(id) = ws.as_str() {
            self.ws_switch(id)?;
        }
        self.ws_state()
    }

    pub async fn ws_set_member_role(self: &Arc<Self>, user: &str, role: &str) -> CmdResult<Value> {
        self.ws_rpc("set_member_role", json!({"p_user": user, "p_role": role}), true).await?;
        self.ws_state()
    }

    pub async fn ws_remove_member(self: &Arc<Self>, user: &str) -> CmdResult<Value> {
        self.ws_rpc("remove_member", json!({"p_user": user}), true).await?;
        self.ws_state()
    }

    pub async fn ws_leave(self: &Arc<Self>) -> CmdResult<Value> {
        self.ws_rpc("leave_workspace", json!({}), true).await?;
        self.ws_state()
    }

    pub async fn ws_rename_workspace(self: &Arc<Self>, name: &str) -> CmdResult<Value> {
        let s = self.require()?;
        if s.is_cloud {
            self.ws_rpc("update_workspace", json!({"p_name": name}), true).await?;
        } else {
            let mut c = self.ws_catalog(&s)?;
            let active = c.active.clone();
            if let Some(w) = c.workspaces.iter_mut().find(|w| Some(&w.id) == active.as_ref()) {
                w.name = name.trim().chars().take(120).collect();
            }
            self.set_catalog(&s, c)?;
        }
        self.ws_state()
    }

    // ------------------------------------------------------------ роли и воронки (редакторы)

    /// Роли активного Workspace и каталог разрешений. Локальная запись: ролей нет (один владелец).
    pub async fn ws_roles(self: &Arc<Self>) -> CmdResult<Value> {
        let s = self.require()?;
        let c = self.ws_catalog(&s)?;
        let Some(active) = c.active_info().filter(|w| w.remote).cloned() else {
            return Ok(json!({"roles": [], "catalog": []}));
        };
        let cloud = self.env.cloud.clone().ok_or_else(|| CmdError::msg("Облако не настроено."))?;
        let roles = sync::select(&cloud, &format!("roles?select=key,name,rank,is_system,workspace_id,role_permissions(permission_key)&or=(workspace_id.is.null,workspace_id.eq.{})&order=rank.desc", active.id))
            .await
            .map_err(cloud_err)?;
        let catalog = sync::select(&cloud, "permissions?select=key,description&order=key").await.map_err(cloud_err)?;
        // Своя роль с тем же ключом заменяет системный шаблон.
        let mut by_key: std::collections::BTreeMap<String, Value> = Default::default();
        for r in roles.as_array().cloned().unwrap_or_default() {
            let key = r["key"].as_str().unwrap_or_default().to_string();
            let own = !r["workspace_id"].is_null();
            if own || !by_key.contains_key(&key) {
                let perms: Vec<Value> = r["role_permissions"].as_array().map(|a| a.iter().map(|p| p["permission_key"].clone()).collect()).unwrap_or_default();
                by_key.insert(key.clone(), json!({"key": key, "name": r["name"], "rank": r["rank"], "system": r["is_system"], "permissions": perms}));
            }
        }
        let mut list: Vec<Value> = by_key.into_values().collect();
        list.sort_by_key(|r| std::cmp::Reverse(r["rank"].as_i64().unwrap_or(0)));
        Ok(json!({"roles": list, "catalog": catalog}))
    }

    pub async fn ws_save_role(self: &Arc<Self>, key: &str, name: &str, rank: i64, permissions: Vec<String>) -> CmdResult<Value> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 60 {
            return Err(CmdError::msg("Название роли — от 1 до 60 символов."));
        }
        let rank_ok = (0..=100).contains(&rank);
        if !rank_ok {
            return Err(CmdError::msg("Ранг — число от 0 до 100."));
        }
        self.ws_rpc("save_role", json!({"p_key": key, "p_name": name, "p_rank": rank, "p_permissions": permissions}), true).await?;
        self.ws_roles().await
    }

    pub async fn ws_delete_role(self: &Arc<Self>, key: &str) -> CmdResult<Value> {
        self.ws_rpc("delete_role", json!({"p_key": key}), true).await?;
        self.ws_roles().await
    }

    /// Удаление этапа воронки: сделки переходят на этап `move_to`.
    pub async fn ws_delete_stage(self: &Arc<Self>, stage: &str, move_to: &str) -> CmdResult<Value> {
        let s = self.require()?;
        if stage == move_to {
            return Err(CmdError::msg("Выберите другой этап для переноса сделок."));
        }
        if s.is_cloud {
            let cloud = self.env.cloud.clone().ok_or_else(|| CmdError::msg("Облако не настроено."))?;
            let moved = sync::rpc(&cloud, "delete_stage", json!({"p_stage": stage, "p_move_to": move_to})).await.map_err(cloud_err)?;
            self.ws_sync_now().await?;
            return Ok(json!({"moved": moved}));
        }
        let moved = self.with_crm(|st| {
            let target = st.get("pipeline_stages", move_to)?.ok_or_else(|| crate::error::AppError::msg("Этап для переноса не найден."))?;
            let pipeline = target["pipeline_id"].clone();
            let q = Query { filters: vec![crate::workspace::query::Filter::eq("stage_id", stage)], ..Default::default() };
            let deals = st.list("deals", &q)?;
            for d in &deals {
                let mut f = Map::new();
                f.insert("stage_id".into(), json!(move_to));
                f.insert("pipeline_id".into(), pipeline.clone());
                st.save("deals", d["id"].as_str(), &f)?;
            }
            st.delete("pipeline_stages", stage)?;
            Ok(deals.len())
        })?;
        self.ws_changed();
        Ok(json!({"moved": moved}))
    }

    // ------------------------------------------------------------ загрузка локальной CRM в облако

    /// Копирует локальный Workspace (на этом устройстве) в новый облачный: записи сохраняют идентификаторы, поэтому
    /// повторная загрузка не плодит дубли. Воронки нового Workspace создаёт сервер; сделки переносятся на этапы с теми же названиями.
    /// Локальный Workspace остаётся на месте.
    pub async fn ws_upload_local(self: &Arc<Self>) -> CmdResult<Value> {
        let s = self.require()?;
        if !s.is_cloud {
            return Err(CmdError::msg("Загрузка доступна в облачной учётной записи."));
        }
        let cloud = self.env.cloud.clone().ok_or_else(|| CmdError::msg("Облако не настроено."))?;
        let catalog = self.ws_catalog(&s)?;
        let local = catalog.active_info().filter(|w| !w.remote).cloned().ok_or_else(|| CmdError::msg("Выберите локальный Workspace, который нужно загрузить."))?;
        let old = self.ws_store(&s)?;
        let snapshot: Vec<(&'static schema::Entity, Vec<Value>)> = {
            let g = old.lock().unwrap();
            let mut out = Vec::new();
            for e in schema::ENTITIES {
                let mut rows = Vec::new();
                loop {
                    let q = Query { archived: true, limit: Some(500), offset: Some(rows.len() as u32), ..Default::default() };
                    let page = g.list(e.table, &q).map_err(cmd)?;
                    let n = page.len();
                    rows.extend(page);
                    if n < 500 {
                        break;
                    }
                }
                out.push((e, rows));
            }
            out
        };

        let name = local.name.replace(" (на этом устройстве)", "");
        let id = sync::rpc(&cloud, "create_workspace", json!({"p_name": name})).await.map_err(cloud_err)?;
        let new_id = id.as_str().unwrap_or_default().to_string();
        if new_id.is_empty() {
            return Err(CmdError::msg("Сервер не создал Workspace."));
        }
        // Серверный список без переключения: загрузку ведём здесь, фоновая синхронизация не должна мешать.
        let fresh = sync::workspaces(&cloud).await.map_err(cloud_err)?;
        let mut c = self.ws_catalog(&s)?;
        c.replace_remote(fresh);
        c.active = Some(new_id.clone());
        self.set_catalog(&s, c)?;
        s.workspace.lock().unwrap().store = None;
        let target = self.ws_store(&s)?;
        if let Ok(members) = sync::members(&cloud, &new_id).await {
            target.lock().unwrap().replace_members(&members).map_err(cmd)?;
        }
        CrmSync::new(cloud.clone(), target.clone(), self.env.device_id.clone()).sync().await.map_err(cloud_err)?; // сначала получаем воронки, созданные сервером

        let (stage_map, pipeline_map) = {
            let g = target.lock().unwrap();
            let stages = g.list("pipeline_stages", &Query::default()).map_err(cmd)?;
            let pipelines = g.list("pipelines", &Query::default()).map_err(cmd)?;
            let default_pipeline = pipelines.iter().find(|p| p["is_default"] == json!(true)).or(pipelines.first()).cloned();
            let mut stage_map = std::collections::HashMap::new();
            let mut pipeline_map = std::collections::HashMap::new();
            if let Some(dp) = default_pipeline {
                let theirs: Vec<&Value> = stages.iter().filter(|x| x["pipeline_id"] == dp["id"]).collect();
                for (e, rows) in &snapshot {
                    if e.table == "pipelines" {
                        if let Some(lp) = rows.iter().find(|p| p["is_default"] == json!(true)).or(rows.first()) {
                            pipeline_map.insert(lp["id"].as_str().unwrap_or_default().to_string(), dp["id"].as_str().unwrap_or_default().to_string());
                            for st in snapshot.iter().filter(|(x, _)| x.table == "pipeline_stages").flat_map(|(_, r)| r.iter()).filter(|x| x["pipeline_id"] == lp["id"]) {
                                let pick = theirs
                                    .iter()
                                    .find(|t| t["name"] == st["name"])
                                    .or_else(|| theirs.iter().find(|t| t["kind"] == st["kind"]))
                                    .or(theirs.first());
                                if let Some(t) = pick {
                                    stage_map.insert(st["id"].as_str().unwrap_or_default().to_string(), t["id"].as_str().unwrap_or_default().to_string());
                                }
                            }
                        }
                    }
                }
            }
            (stage_map, pipeline_map)
        };

        let mut copied = 0usize;
        let mut skipped = 0usize;
        {
            let g = target.lock().unwrap();
            for (e, rows) in &snapshot {
                for row in rows {
                    let rid = row["id"].as_str().unwrap_or_default();
                    let is_seed_pipeline = matches!(e.table, "pipelines" | "pipeline_stages") && (pipeline_map.contains_key(rid) || stage_map.contains_key(rid) || pipeline_map.contains_key(row["pipeline_id"].as_str().unwrap_or_default()));
                    let is_builtin_collection = e.table == "collections" && !row["builtin"].is_null();
                    if is_seed_pipeline || is_builtin_collection || !row["deleted_at"].is_null() {
                        continue;
                    }
                    let mut f = Map::new();
                    for fld in e.fields.iter().filter(|x| x.writable) {
                        let v = &row[fld.name];
                        if !v.is_null() && !(fld.name == "is_default") {
                            f.insert(fld.name.into(), v.clone());
                        }
                    }
                    if let Some(p) = f.get("pipeline_id").and_then(Value::as_str).and_then(|p| pipeline_map.get(p)) {
                        f.insert("pipeline_id".into(), json!(p));
                    }
                    if let Some(st) = f.get("stage_id").and_then(Value::as_str).and_then(|x| stage_map.get(x)) {
                        f.insert("stage_id".into(), json!(st));
                    }
                    match g.save(e.table, Some(rid), &f) {
                        Ok(_) => copied += 1,
                        Err(err) => {
                            skipped += 1;
                            self.env.log_error(&format!("Загрузка CRM: {} {rid}: {err}", e.table));
                        }
                    }
                }
            }
        }
        old.lock().unwrap().set_meta("uploaded_to", &new_id).map_err(cmd)?;
        self.ws_changed();
        let state = self.ws_state()?;
        Ok(json!({"workspace": new_id, "copied": copied, "skipped": skipped, "state": state}))
    }

    // ------------------------------------------------------------ синхронизация

    fn ws_sync_soon(self: &Arc<Self>, s: &Arc<Session>) {
        let Some(cloud) = self.env.cloud.clone().filter(|_| s.is_cloud) else { return };
        if !self.ws_catalog(s).ok().and_then(|c| c.active_info().map(|w| w.remote)).unwrap_or(false) {
            return;
        }
        let Ok(store) = self.ws_store(s) else { return };
        {
            let mut st = s.workspace.lock().unwrap();
            if st.running {
                st.again = true;
                return;
            }
            st.running = true;
        }
        let (core, session) = (self.clone(), s.clone());
        let handle = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            loop {
                let result = CrmSync::new(cloud.clone(), store.clone(), core.env.device_id.clone()).sync().await;
                let again = {
                    let mut st = session.workspace.lock().unwrap();
                    match &result {
                        Ok(_) => {
                            st.last_error = None;
                            st.last_sync = Some(stamp(Utc::now()));
                        }
                        Err(CloudError::Network(_)) => st.last_error = Some("Нет связи: изменения отправятся позже.".into()),
                        Err(e) => st.last_error = Some(e.to_string()),
                    }
                    let again = std::mem::take(&mut st.again) && result.is_ok();
                    if !again {
                        st.running = false;
                    }
                    again
                };
                if let Err(e) = &result {
                    if sync::is_not_member(e) {
                        let _ = core.ws_refresh_inner(&session).await;
                    } else if !matches!(e, CloudError::Network(_)) {
                        core.env.log_error(&format!("Синхронизация CRM: {e}"));
                    }
                }
                core.env.emit("workspace-changed", Value::Null);
                if !again {
                    break;
                }
            }
        });
        s.tasks.lock().unwrap().push(handle);
    }

    pub async fn ws_sync_now(self: &Arc<Self>) -> CmdResult<Value> {
        let s = self.require()?;
        if s.is_cloud {
            if let Ok(st) = self.ws_store(&s) {
                st.lock().unwrap().retry_now().map_err(cmd)?;
            }
            self.ws_refresh_inner(&s).await?;
            self.ws_sync_soon(&s);
        }
        self.ws_state()
    }

    // ------------------------------------------------------------ напоминания задач

    /// Раз в минуту: задачи пользователя, у которых наступило время напоминания, — уведомление (один раз).
    fn start_reminders(self: &Arc<Self>, s: &Arc<Session>) {
        {
            let mut st = s.workspace.lock().unwrap();
            if st.reminders {
                return;
            }
            st.reminders = true;
        }
        let (core, session) = (self.clone(), s.clone());
        let handle = tokio::spawn(async move {
            loop {
                core.check_reminders(&session);
                tokio::time::sleep(Duration::from_secs(60)).await;
            }
        });
        s.tasks.lock().unwrap().push(handle);
    }

    pub(crate) fn check_reminders(&self, s: &Session) -> Vec<Value> {
        let Ok(store) = self.ws_store(s) else { return vec![] };
        let me = user_id(s);
        let due: Vec<Value> = {
            let st = store.lock().unwrap();
            let q = Query {
                filters: vec![
                    crate::workspace::query::Filter { field: "remind_at".into(), op: "lte".into(), value: json!(stamp(Utc::now())) },
                    crate::workspace::query::Filter { field: "status".into(), op: "in".into(), value: json!(["todo", "in_progress"]) },
                ],
                ..Default::default()
            };
            st.list("tasks", &q)
                .unwrap_or_default()
                .into_iter()
                .filter(|t| t["assignee_id"].as_str().map(|a| a == me).unwrap_or(t["created_by"].as_str() == Some(me.as_str())))
                .collect()
        };
        let mut fresh = vec![];
        let mut st = s.workspace.lock().unwrap();
        for t in due {
            let key = format!("{}@{}", t["id"].as_str().unwrap_or_default(), t["remind_at"].as_str().unwrap_or_default());
            if st.notified.insert(key) {
                self.env.emit("notify", json!({"kind": "reminder", "title": "Напоминание о задаче", "body": t["title"]}));
                fresh.push(t);
            }
        }
        fresh
    }
}
