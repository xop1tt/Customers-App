//! Customers 2.0 в прикладном слое: выбранный Workspace открытой учётной записи, записи CRM, преобразование лидов,
//! участники и приглашения, коллекции, синхронизация базы Workspace и напоминания задач.
//!
//! Локальная учётная запись получает один локальный Workspace (только на этом устройстве). Облачная — список
//! Workspace с сервера (`my_workspaces`; личный создаётся при первом входе 2.0). Базы лежат в папке учётной
//! записи: `workspaces/<id>.db`; база генератора лидов не меняется.

use super::session::{Core, Session};
use super::{CmdError, CmdResult};
use crate::workspace::catalog::{database_file, Catalog, WorkspaceInfo};
use crate::workspace::convert::{convert_lead, ConvertOptions};
use crate::workspace::query::Query;
use crate::workspace::store::{stamp, Member, WorkspaceStore, ALL_PERMISSIONS};
use crate::workspace::{dedupe, schema};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Default)]
pub struct CrmState {
    catalog: Option<Catalog>,
    store: Option<Arc<Mutex<WorkspaceStore>>>,
    reminders: bool,
    notified: std::collections::BTreeSet<String>,
}

type Store = Arc<Mutex<WorkspaceStore>>;

const MAX_ATTACHMENT: usize = 5 * 1024 * 1024;

/// Идентификатор пользователя в записях CRM: uuid учётной записи (`local-<uuid>` или прежней `cloud-<uuid>`).
pub fn user_id(s: &Session) -> String {
    s.id.strip_prefix("cloud-").or_else(|| s.id.strip_prefix("local-")).unwrap_or(&s.id).to_lowercase()
}

/// Новый Workspace только на этом устройстве: владелец — сам пользователь, все права.
fn local_workspace(name: &str, personal: bool) -> WorkspaceInfo {
    WorkspaceInfo {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.into(),
        personal,
        role: "owner".into(),
        role_name: "Владелец".into(),
        rank: 100,
        permissions: ALL_PERMISSIONS.iter().map(|p| p.to_string()).collect(),
        members: 1,
        remote: false,
        default_currency: "RUB".into(),
    }
}

/// Базы Workspace в папке: `<id>.db`, без служебных копий (`before-restore`, `restore-…`).
fn workspace_files(dir: &Path) -> Vec<(String, PathBuf)> {
    let mut out: Vec<(String, PathBuf)> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().into_owned();
                    let id = name.strip_suffix(".db")?;
                    (uuid::Uuid::parse_str(id).is_ok() && e.path().is_file()).then(|| (id.to_string(), e.path()))
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

/// Название Workspace: от 1 до 120 символов.
fn checked_title(raw: &str) -> CmdResult<String> {
    let name = raw.trim();
    if name.is_empty() || name.chars().count() > 120 {
        return Err(CmdError::msg("Название — от 1 до 120 символов."));
    }
    Ok(name.to_string())
}

fn cmd(e: impl std::fmt::Display) -> CmdError {
    CmdError::msg(e.to_string())
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
        let mut c = Catalog::load(&dir);
        self.convert_remote(s, &mut c);
        // Без единого Workspace (первый запуск) создаётся локальный.
        if c.workspaces.is_empty() {
            c.workspaces.push(local_workspace("Личное пространство", true));
        }
        c.fix_active();
        c.save(&dir).map_err(cmd)?;
        s.workspace.lock().unwrap().catalog = Some(c.clone());
        Ok(c)
    }

    /// ADR-100: облака больше нет. Копии облачных Workspace, скачанные на это устройство, становятся
    /// локальными: пользователь — их владелец со всеми правами, участники остаются в списке (по ним видны
    /// ответственные в старых записях), шаблон воронки повторно не засевается. Workspace без скачанной базы
    /// убирается из списка: данных на устройстве у него нет.
    fn convert_remote(&self, s: &Session, c: &mut Catalog) {
        if !c.workspaces.iter().any(|w| w.remote) {
            return;
        }
        let dir = self.ws_dir(s);
        let key = self.env.keys.key_for(&s.id).ok();
        let me = user_id(s);
        c.workspaces.retain_mut(|w| {
            if !w.remote {
                return true;
            }
            let path = database_file(&dir, &w.id);
            let Some(key) = key.as_ref().filter(|_| path.exists()) else { return false };
            let Ok(st) = WorkspaceStore::open(&path, Some(key), &w.id, &me) else { return true };
            let _ = st.set_meta("seeded", "converted");
            let _ = st.set_meta("seed_deduped", "converted");
            let mut members = st.members().unwrap_or_default();
            members.retain(|m| m.user_id != me);
            members.insert(
                0,
                Member {
                    user_id: me.clone(),
                    display_name: s.display_name.clone(),
                    role: "owner".into(),
                    role_name: "Владелец".into(),
                    rank: 100,
                    avatar_path: None,
                    email: None,
                },
            );
            let _ = st.replace_members(&members);
            *w = WorkspaceInfo {
                id: w.id.clone(),
                name: w.name.clone(),
                personal: w.personal,
                default_currency: w.default_currency.clone(),
                ..local_workspace("", false)
            };
            w.members = members.len() as i64;
            true
        });
        c.fix_active();
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
        // Одновременные команды при запуске (состояние, коллекции, «Сегодня») ждут здесь, пока первая откроет базу.
        let _opening = s.ws_open.lock().unwrap();
        if let Some(st) = s.workspace.lock().unwrap().store.clone() {
            return Ok(st);
        }
        let c = self.ws_catalog(s)?;
        let info = c.active_info().cloned().ok_or_else(|| CmdError::new("noWorkspace", "Рабочее пространство не выбрано."))?;
        let path = database_file(&self.ws_dir(s), &info.id);
        let key = self.env.keys.key_for(&s.id).map_err(|e| CmdError::msg(format!("Не удалось открыть базу Workspace: {e}")))?;
        let store = WorkspaceStore::open(&path, Some(&key), &info.id, &user_id(s))
            .and_then(WorkspaceStore::without_outbox)
            .map_err(|e| CmdError::msg(format!("Не удалось открыть базу Workspace: {e}")))?;
        store.set_permissions(&info.permissions).map_err(cmd)?;
        store.set_meta("member_role", &info.role).map_err(cmd)?;
        store.set_meta("channel", "stable").map_err(cmd)?;
        if !info.remote && store.meta("seeded").as_deref() == Some("converted") {
            // Бывший облачный Workspace: участники сохранены при переводе (convert_remote).
        } else if !info.remote {
            store.seed_local().map_err(cmd)?;
            store.dedupe_local_seed().map_err(cmd)?;
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
        let members = self.ws_store(&s).map(|st| st.lock().unwrap().members().unwrap_or_default()).unwrap_or_default();
        Ok(json!({
            "me": user_id(&s),
            "workspaces": c.workspaces,
            "active": c.active,
            "permissions": c.active_info().map(|w| w.permissions.clone()).unwrap_or_default(),
            "members": members,
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
        self.ws_state()
    }

    /// Новый Workspace на этом устройстве; он сразу становится выбранным.
    pub fn ws_create_workspace(self: &Arc<Self>, name: &str) -> CmdResult<Value> {
        let s = self.require()?;
        let name = checked_title(name)?;
        let mut c = self.ws_catalog(&s)?;
        let w = local_workspace(&name, false);
        let id = w.id.clone();
        c.workspaces.push(w);
        self.set_catalog(&s, c)?;
        self.ws_switch(&id)
    }

    // ------------------------------------------------------------ резервные копии баз CRM (пакет A1)

    /// Копирует базы всех Workspace учётной записи (`workspaces/<id>.db`) и `catalog.json` в папку `to`.
    /// Копия снимается `VACUUM INTO` и остаётся зашифрованной ключом учётной записи; незашифрованная копия
    /// удаляется с ошибкой. Возвращает число скопированных баз (0 — у учётной записи ещё нет CRM).
    pub(crate) fn backup_workspaces(&self, s: &Session, to: &Path) -> CmdResult<usize> {
        let src = self.ws_dir(s);
        let files = workspace_files(&src);
        if files.is_empty() {
            return Ok(0);
        }
        let key = self.env.keys.key_for(&s.id).map_err(cmd)?;
        std::fs::create_dir_all(to).map_err(cmd)?;
        for (id, path) in &files {
            let target = database_file(to, id);
            let _ = std::fs::remove_file(&target);
            let conn = crate::db::open_connection(path, false, Some(&key)).map_err(cmd)?;
            conn.execute("VACUUM INTO ?1", [target.to_string_lossy().as_ref()]).map_err(cmd)?;
            drop(conn);
            if crate::db::file_state(&target) != crate::db::FileState::Encrypted {
                let _ = std::fs::remove_file(&target);
                return Err(CmdError::msg("Резервная копия CRM получилась незашифрованной и удалена."));
            }
        }
        if Catalog::file(&src).exists() {
            std::fs::copy(Catalog::file(&src), Catalog::file(to)).map_err(cmd)?;
        }
        Ok(files.len())
    }

    /// Восстанавливает из папки копии базы локальных Workspace (только на этом устройстве). Облачные Workspace
    /// не восстанавливаются: источник истины для них — сервер, они загружаются заново. Текущая база каждого
    /// восстановленного Workspace сохраняется рядом как `<id>.before-restore.db`. Возвращает число баз.
    pub(crate) fn restore_workspaces(&self, s: &Session, from: &Path) -> CmdResult<usize> {
        let saved = Catalog::load(from);
        let local: Vec<WorkspaceInfo> = saved.workspaces.iter().filter(|w| !w.remote && database_file(from, &w.id).exists()).cloned().collect();
        if local.is_empty() {
            return Ok(0);
        }
        let key = self.env.keys.key_for(&s.id).map_err(cmd)?;
        // Сначала проверяем все копии: файл открывается ключом учётной записи и принадлежит своему Workspace.
        for w in &local {
            let conn =
                crate::db::open_connection(&database_file(from, &w.id), true, Some(&key)).map_err(|e| CmdError::msg(format!("Копия CRM не читается: {e}")))?;
            let owner: Option<String> = conn.query_row("SELECT value FROM local_meta WHERE key = 'workspace_id'", [], |r| r.get(0)).ok();
            if owner.as_deref() != Some(w.id.as_str()) {
                return Err(CmdError::msg("Копия CRM принадлежит другому Workspace."));
            }
        }
        // Открытая база закрывается до замены файла (Windows не даёт заменить открытый файл).
        s.workspace.lock().unwrap().store = None;
        let dir = self.ws_dir(s);
        std::fs::create_dir_all(&dir).map_err(cmd)?;
        let mut catalog = self.ws_catalog(s)?;
        for w in &local {
            let current = database_file(&dir, &w.id);
            if current.exists() {
                let safety = dir.join(format!("{}.before-restore.db", w.id));
                let _ = std::fs::remove_file(&safety);
                let conn = crate::db::open_connection(&current, false, Some(&key)).map_err(cmd)?;
                conn.execute("VACUUM INTO ?1", [safety.to_string_lossy().as_ref()]).map_err(cmd)?;
            }
            let staged = dir.join(format!("{}.restore-{}.db", w.id, uuid::Uuid::new_v4()));
            std::fs::copy(database_file(from, &w.id), &staged).map_err(cmd)?;
            crate::db::remove_database_files(&current);
            std::fs::rename(&staged, &current).map_err(cmd)?;
            if !catalog.workspaces.iter().any(|c| c.id == w.id) {
                catalog.workspaces.push(w.clone());
            }
        }
        catalog.fix_active();
        self.set_catalog(s, catalog)?;
        self.env.emit("workspace-changed", Value::Null);
        Ok(local.len())
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
                for table in ["tasks", "activities", "notes", "comments", "custom_field_values", "attachments"] {
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

    // ------------------------------------------------------------ импорт CSV/Excel (B1, docs/IMPORT.md)

    fn import_table(name: &str, data_base64: &str) -> CmdResult<crate::workspace::import::Table> {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD.decode(data_base64.trim()).map_err(|_| CmdError::msg("Файл не прочитан."))?;
        crate::workspace::import::parse(name, &bytes).map_err(cmd)
    }

    /// Таблица из файла и предложенное сопоставление колонок.
    pub fn ws_import_read(&self, name: &str, data_base64: &str) -> CmdResult<Value> {
        let t = Self::import_table(name, data_base64)?;
        let fields: Vec<Value> = crate::workspace::import::FIELDS.iter().map(|(k, l, _)| json!({"key": k, "label": l})).collect();
        let sample: Vec<&Vec<String>> = t.rows.iter().take(5).collect();
        Ok(json!({"headers": t.headers, "rows": t.rows.len(), "sample": sample, "mapping": crate::workspace::import::suggest(&t.headers), "fields": fields}))
    }

    pub fn ws_import_preview(&self, name: &str, data_base64: &str, opts: crate::workspace::import::ImportOptions) -> CmdResult<Value> {
        let t = Self::import_table(name, data_base64)?;
        self.with_crm(|st| crate::workspace::import::preview(st, &t, &opts))
    }

    pub fn ws_import_run(self: &Arc<Self>, name: &str, data_base64: &str, opts: crate::workspace::import::ImportOptions) -> CmdResult<Value> {
        let t = Self::import_table(name, data_base64)?;
        let out = self.with_crm(|st| crate::workspace::import::run(st, name, &t, &opts))?;
        self.ws_changed();
        Ok(out)
    }

    /// История этапов всех сделок Workspace — для отчётов (только чтение).
    pub fn ws_stage_history(&self) -> CmdResult<Value> {
        self.with_crm(|st| Ok(json!(st.stage_history_all()?)))
    }

    pub fn ws_import_history(&self) -> CmdResult<Value> {
        self.with_crm(crate::workspace::import::history)
    }

    pub fn ws_import_undo(self: &Arc<Self>, batch: &str) -> CmdResult<Value> {
        let out = self.with_crm(|st| crate::workspace::import::undo(st, batch))?;
        self.ws_changed();
        Ok(out)
    }

    /// «Похоже на: …» до сохранения.
    /// Объединить две компании или два контакта (пакет G4).
    pub fn ws_merge(self: &Arc<Self>, request: crate::workspace::merge::MergeRequest) -> CmdResult<Value> {
        let out = self.with_crm(|st| crate::workspace::merge::merge(st, &request))?;
        self.ws_changed();
        Ok(json!(out))
    }

    /// Последнее объединение, которое ещё можно отменить, или null.
    pub fn ws_merge_last(&self) -> CmdResult<Value> {
        self.with_crm(|st| Ok(json!(crate::workspace::merge::last(st)?)))
    }

    pub fn ws_merge_undo(self: &Arc<Self>) -> CmdResult<Value> {
        let out = self.with_crm(crate::workspace::merge::undo)?;
        self.ws_changed();
        Ok(json!(out))
    }

    pub fn ws_duplicates(&self, entity: &str, fields: Map<String, Value>, except: Option<&str>) -> CmdResult<Value> {
        let keys = dedupe::keys(entity, &fields);
        self.with_crm(|st| Ok(json!(st.duplicates(entity, &keys, except)?)))
    }

    fn ws_changed(&self) {
        self.env.emit("workspace-changed", Value::Null);
    }

    /// Найденный лид → компания, контакт и (по желанию) сделка. Лид получает отметку `data.crm`.
    pub fn ws_convert_lead(self: &Arc<Self>, lead_id: &str, opts: ConvertOptions) -> CmdResult<Value> {
        let s = self.require()?;
        let lead = s.with_store(|st| st.all_leads(false)).map_err(cmd)?.into_iter().find(|l| l.id == lead_id).ok_or_else(|| CmdError::msg("Лид не найден."))?;
        let st = self.ws_store(&s)?;
        let done = convert_lead(&st.lock().unwrap(), &lead, &opts).map_err(cmd)?;
        s.with_store(|ls| ls.set_crm_mark(lead_id, &done.mark())).map_err(cmd)?;
        self.env.emit("data-changed", Value::Null);
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

    /// Коллекция, её таблица и запрос: фильтры коллекции вместе с тем, что добавил пользователь (поиск, сортировка).
    fn collection_query(st: &WorkspaceStore, id: &str, extra: Query) -> crate::error::AppResult<(Value, &'static str, Query)> {
        let c = st.get("collections", id)?.ok_or_else(|| crate::error::AppError::msg("Коллекция не найдена."))?;
        let table =
            c["entity_type"].as_str().and_then(schema::by_type).map(|e| e.table).ok_or_else(|| crate::error::AppError::msg("Неизвестный тип коллекции."))?;
        let mut q = Query::from_config(&c["config"]);
        q.filters.extend(extra.filters);
        if !extra.sort.is_empty() {
            q.sort = extra.sort;
        }
        q.search = extra.search;
        q.limit = extra.limit;
        Ok((c, table, q))
    }

    pub fn ws_collection_items(&self, id: &str, extra: Query) -> CmdResult<Value> {
        self.with_crm(|st| {
            let (c, table, q) = Self::collection_query(st, id, extra)?;
            Ok(json!({"collection": c, "entity": table, "items": st.list(table, &q)?, "total": st.count(table, &Query { limit: None, ..q.clone() })?}))
        })
    }

    // ------------------------------------------------------------ экспорт CSV/Excel (G1, docs/EXPORT.md)

    /// Колонки, которые можно выгрузить для записей таблицы: поля и свои поля Workspace.
    pub fn ws_export_fields(&self, entity: &str, lang: &str) -> CmdResult<Value> {
        self.with_crm(|st| Ok(json!(crate::workspace::export::fields(st, entity, crate::tray_text::Lang::parse(lang))?)))
    }

    /// Выгрузка локального Workspace (облачный — через `ws_export_checked`).
    pub fn ws_export(&self, request: crate::workspace::export::Request, path: &Path) -> CmdResult<Value> {
        let (bytes, count, _) = self.export_bytes(request)?;
        std::fs::write(path, bytes).map_err(|e| CmdError::msg(format!("Не удалось сохранить файл: {e}")))?;
        Ok(json!({"count": count}))
    }

    fn export_bytes(&self, request: crate::workspace::export::Request) -> CmdResult<(Vec<u8>, usize, String)> {
        let lang = crate::tray_text::Lang::parse(&request.lang);
        self.with_crm(|st| {
            let (table, q) = match request.collection.as_deref() {
                Some(id) => {
                    let (_, table, q) = Self::collection_query(st, id, request.query)?;
                    (table.to_string(), q)
                }
                None => (request.entity, request.query),
            };
            let (bytes, count) = crate::workspace::export::file(st, &table, &q, &request.fields, &request.format, lang)?;
            Ok((bytes, count, table))
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

    // ------------------------------------------------------------ название и валюта

    pub fn ws_rename_workspace(self: &Arc<Self>, name: &str) -> CmdResult<Value> {
        let s = self.require()?;
        let name = checked_title(name)?;
        let mut c = self.ws_catalog(&s)?;
        let active = c.active.clone();
        let w = c.workspaces.iter_mut().find(|w| Some(&w.id) == active.as_ref()).ok_or_else(|| CmdError::msg("Нет активного Workspace."))?;
        w.name = name;
        self.set_catalog(&s, c)?;
        self.env.emit("workspace-changed", Value::Null);
        self.ws_state()
    }

    /// Название и валюта сделок активного Workspace (мастер первого запуска, пакет G7).
    pub fn ws_set_local_details(self: &Arc<Self>, name: &str, currency: &str) -> CmdResult<Value> {
        let s = self.require()?;
        let name = checked_title(name)?;
        let currency = currency.trim().to_uppercase();
        if currency.len() != 3 || !currency.bytes().all(|b| b.is_ascii_uppercase()) {
            return Err(CmdError::msg("Валюта — трёхбуквенный код, например RUB."));
        }
        let mut c = self.ws_catalog(&s)?;
        let active = c.active.clone();
        let w = c.workspaces.iter_mut().find(|w| Some(&w.id) == active.as_ref()).ok_or_else(|| CmdError::msg("Нет активного Workspace."))?;
        w.name = name;
        w.default_currency = currency;
        self.set_catalog(&s, c)?;
        self.ws_state()
    }

    // ------------------------------------------------------------ воронки

    /// Удаление этапа воронки: сделки переходят на этап `move_to`.
    pub fn ws_delete_stage(self: &Arc<Self>, stage: &str, move_to: &str) -> CmdResult<Value> {
        let moved = self.with_crm(|st| st.delete_stage(stage, move_to))?;
        self.ws_changed();
        Ok(json!({"moved": moved}))
    }

    // ------------------------------------------------------------ вложения

    /// Файл к карточке (до 5 МБ): метаданные — запись CRM, содержимое — в зашифрованной базе Workspace.
    pub fn ws_attach_add(self: &Arc<Self>, entity_type: &str, entity_id: &str, name: &str, mime: &str, data_base64: &str) -> CmdResult<Value> {
        use base64::Engine;
        let data = base64::engine::general_purpose::STANDARD.decode(data_base64.trim()).map_err(|_| CmdError::msg("Файл не читается."))?;
        if data.len() > MAX_ATTACHMENT {
            return Err(CmdError::msg("Файл больше 5 МБ."));
        }
        let name: String = name.rsplit(['/', '\\']).next().unwrap_or("").trim().chars().take(255).collect();
        if name.is_empty() {
            return Err(CmdError::msg("У файла нет имени."));
        }
        let mut f = Map::new();
        f.insert("entity_type".into(), json!(entity_type));
        f.insert("entity_id".into(), json!(entity_id));
        f.insert("name".into(), json!(name));
        f.insert("mime".into(), json!(mime.chars().take(100).collect::<String>()));
        f.insert("size".into(), json!(data.len()));
        let row = self.with_crm(|st| {
            let row = st.save("attachments", None, &f)?;
            st.put_blob(row["id"].as_str().unwrap_or_default(), &data, false)?;
            Ok(row)
        })?;
        self.ws_changed();
        Ok(row)
    }

    /// Сохраняет вложение в файл, выбранный пользователем.
    pub fn ws_attach_save(self: &Arc<Self>, id: &str, path: &str) -> CmdResult<String> {
        let (meta, data) = self.with_crm(|st| Ok((st.get("attachments", id)?, st.blob(id))))?;
        let meta = meta.ok_or_else(|| CmdError::msg("Вложение не найдено."))?;
        // Файлы облачных коллег, которые так и не скачались на это устройство, после отказа от облака недоступны.
        let data = data.ok_or_else(|| CmdError::msg("Содержимого файла нет на этом компьютере."))?;
        std::fs::write(path, data).map_err(|e| CmdError::msg(format!("Не удалось сохранить файл: {e}")))?;
        Ok(meta["name"].as_str().unwrap_or_default().to_string())
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
                    crate::workspace::query::Filter { field: "remind_at".into(), op: "lte".into(), value: json!(stamp(crate::time::now())) },
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

#[cfg(test)]
mod local_tests {
    use super::super::testing::fixture;
    use super::*;

    fn local() -> (super::super::testing::Fixture, Arc<Core>) {
        let f = fixture(vec![]);
        let core = Core::new(f.env.clone());
        core.sign_in_test_user("anna");
        (f, core)
    }

    fn active(state: &Value) -> Value {
        let id = state["active"].clone();
        state["workspaces"].as_array().unwrap().iter().find(|w| w["id"] == id).unwrap().clone()
    }

    #[tokio::test]
    async fn first_run_sets_name_and_currency_of_local_workspace() {
        let (_f, core) = local();
        let state = core.ws_set_local_details("  Студия «Пиксель» ", "usd").unwrap();
        let w = active(&state);
        assert_eq!(w["name"], "Студия «Пиксель»");
        assert_eq!(w["defaultCurrency"], "USD");
        assert!(core.ws_set_local_details("", "RUB").unwrap_err().message.contains("от 1 до 120"));
        assert!(core.ws_set_local_details("X", "рубль").unwrap_err().message.contains("трёхбуквенный"));
        assert!(core.ws_set_local_details("X", "RU").is_err());
        // После перезапуска список Workspace читается с диска с теми же значениями.
        let again = core.ws_state().unwrap();
        assert!(again["workspaces"].as_array().unwrap().iter().any(|w| w["name"] == "Студия «Пиксель»" && w["defaultCurrency"] == "USD"));
    }

    #[tokio::test]
    async fn workspaces_are_created_and_renamed_on_this_computer() {
        let (_f, core) = local();
        let first = core.ws_state().unwrap()["active"].clone();
        let state = core.ws_create_workspace(" Филиал ").unwrap();
        let w = active(&state);
        assert_eq!(w["name"], "Филиал");
        assert_eq!(w["remote"], false);
        assert_eq!(w["role"], "owner");
        assert_ne!(state["active"], first, "новое пространство сразу выбрано");
        assert_eq!(state["workspaces"].as_array().unwrap().len(), 2);
        assert!(w["permissions"].as_array().unwrap().iter().any(|p| p == "workspace.manage"));
        let renamed = core.ws_rename_workspace("Филиал на Ленина").unwrap();
        assert_eq!(active(&renamed)["name"], "Филиал на Ленина");
        assert!(core.ws_create_workspace("   ").is_err());
        assert!(core.ws_rename_workspace(&"я".repeat(121)).is_err());
        // В новом пространстве своя воронка из шаблона и я — единственный участник.
        assert!(!core.ws_list("pipelines", Query::default()).unwrap()["items"].as_array().unwrap().is_empty());
        let members = core.ws_state().unwrap()["members"].clone();
        assert_eq!(members.as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn deleting_a_stage_moves_its_deals() {
        let (_f, core) = local();
        let stages = core.ws_list("pipeline_stages", Query::default()).unwrap()["items"].as_array().unwrap().clone();
        let (from, to) = (stages[0]["id"].as_str().unwrap().to_string(), stages[1]["id"].as_str().unwrap().to_string());
        let pipeline = stages[0]["pipeline_id"].clone();
        let mut deal = Map::new();
        deal.insert("title".into(), json!("Сайт"));
        deal.insert("pipeline_id".into(), pipeline);
        deal.insert("stage_id".into(), json!(from));
        let d = core.ws_save("deals", None, deal).unwrap();
        assert!(core.ws_delete_stage(&from, &from).is_err(), "перенос на тот же этап");
        assert_eq!(core.ws_delete_stage(&from, &to).unwrap()["moved"], 1);
        let pending = core.with_crm(|st| Ok(st.pending_count())).unwrap();
        assert_eq!(pending, 0, "изменения не копятся в очереди отправки: отправлять их некуда");
        let card = core.ws_card("deals", d["id"].as_str().unwrap()).unwrap();
        assert_eq!(card["record"]["stage_id"], json!(to));
        let left = core.ws_list("pipeline_stages", Query::default()).unwrap()["items"].as_array().unwrap().clone();
        assert!(!left.iter().any(|s| s["id"] == json!(from)), "этап удалён");
        assert!(core.ws_delete_stage(&from, &to).is_err(), "удалённый этап второй раз не удаляется");
    }

    #[tokio::test]
    async fn attachments_stay_in_the_workspace_database() {
        use base64::Engine;
        let (f, core) = local();
        let c = core.ws_save("companies", None, json!({"name": "Вектор"}).as_object().unwrap().clone()).unwrap();
        let data = base64::engine::general_purpose::STANDARD.encode(b"hello");
        let a = core.ws_attach_add("company", c["id"].as_str().unwrap(), "../счёт.txt", "text/plain", &data).unwrap();
        assert_eq!(a["name"], "счёт.txt");
        let out = f.dir.path().join("out.txt");
        assert_eq!(core.ws_attach_save(a["id"].as_str().unwrap(), out.to_str().unwrap()).unwrap(), "счёт.txt");
        assert_eq!(std::fs::read(&out).unwrap(), b"hello");
        let big = base64::engine::general_purpose::STANDARD.encode(vec![0u8; MAX_ATTACHMENT + 1]);
        assert!(core.ws_attach_add("company", c["id"].as_str().unwrap(), "big.bin", "", &big).is_err());
    }

    /// Копия облачного Workspace прежней версии становится локальной: данные и участники на месте, права — владельца.
    #[tokio::test]
    async fn downloaded_cloud_workspace_becomes_local() {
        let f = fixture(vec![]);
        let core = Core::new(f.env.clone());
        core.sign_in_test_user("anna");
        let s = core.require().unwrap();
        let me = user_id(&s);
        let dir = s.dir.join("workspaces");
        let (cloud_id, missing_id) = (uuid::Uuid::new_v4().to_string(), uuid::Uuid::new_v4().to_string());
        {
            let key = f.env.keys.key_for(&s.id).unwrap();
            let st = WorkspaceStore::open(&database_file(&dir, &cloud_id), Some(&key), &cloud_id, &me).unwrap();
            st.set_permissions(&["records.create".to_string()]).unwrap();
            let colleague = Member {
                user_id: "11111111-1111-4111-8111-111111111111".into(),
                display_name: "Борис".into(),
                role: "manager".into(),
                role_name: "Менеджер".into(),
                rank: 50,
                avatar_path: None,
                email: None,
            };
            st.replace_members(&[colleague]).unwrap();
            let mut c = Map::new();
            c.insert("name".into(), json!("Из облака"));
            st.save("companies", None, &c).unwrap();
        }
        let mut info = local_workspace("Команда", false);
        info.id = cloud_id.clone();
        info.remote = true;
        info.role = "manager".into();
        info.permissions = vec!["records.read".into()];
        let mut gone = local_workspace("Не скачан", false);
        gone.id = missing_id.clone();
        gone.remote = true;
        Catalog { active: Some(cloud_id.clone()), workspaces: vec![info, gone] }.save(&dir).unwrap();
        *s.workspace.lock().unwrap() = CrmState::default();

        let state = core.ws_state().unwrap();
        let list = state["workspaces"].as_array().unwrap();
        assert_eq!(list.len(), 1, "Workspace без скачанной базы убран: {list:?}");
        let w = active(&state);
        assert_eq!((w["id"].as_str().unwrap(), w["remote"].as_bool().unwrap(), w["role"].as_str().unwrap()), (cloud_id.as_str(), false, "owner"));
        let names: Vec<&str> = state["members"].as_array().unwrap().iter().map(|m| m["displayName"].as_str().unwrap()).collect();
        assert_eq!(names.len(), 2, "коллега остался в списке, я добавлен: {names:?}");
        assert!(names.contains(&"Борис"));
        let companies = core.ws_list("companies", Query::default()).unwrap();
        assert_eq!(companies["items"].as_array().unwrap().len(), 1);
        let pipelines = core.ws_list("pipelines", Query::default()).unwrap();
        assert!(pipelines["items"].as_array().unwrap().is_empty(), "шаблон воронки в бывший облачный Workspace не засевается");
        let mut c = Map::new();
        c.insert("name".into(), json!("Новая"));
        core.ws_save("companies", None, c).expect("владелец может создавать записи");
    }
}
