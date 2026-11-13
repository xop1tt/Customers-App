//! База Workspace на устройстве: `<папка учётной записи>/workspaces/<workspace_id>.db` (SQLCipher, ключ учётной записи).
//!
//! Каждое изменение записывается в таблицу сущности и в очередь `sync_outbox` одной транзакцией
//! (docs/SYNC_ARCHITECTURE.md §2.1): изменение нельзя потерять при сбое, а повтор отправки идёт с тем же `op_id`.
//! Те же проверки, что делает сервер (обязательные поля, перечисления, ссылки только внутри Workspace, права роли),
//! выполняются здесь до записи — интерфейс не ждёт сети, а сервер остаётся последней проверкой.

use super::query::{self, Query};
use super::schema::{self, Class, Entity, Kind, ENTITIES, REFERENCES};
use crate::db::{self, DbKey};
use crate::error::{AppError, AppResult};
use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};
use rusqlite::{params, types::Value as Sql, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

pub const SCHEMA_VERSION: i64 = 1;
/// Все разрешения (локальный Workspace и владелец).
pub const ALL_PERMISSIONS: [&str; 18] = [
    "records.view",
    "records.create",
    "records.edit_own",
    "records.edit",
    "records.delete",
    "records.export",
    "members.view",
    "members.manage",
    "invitations.manage",
    "roles.manage",
    "workspace.manage",
    "workspace.delete",
    "ownership.transfer",
    "pipelines.manage",
    "fields.manage",
    "collections.manage",
    "analytics.view",
    "audit.view",
];

pub fn stamp(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Связь сделки и контакта получает одинаковый id на всех устройствах — две привязки сливаются в одну.
pub fn deal_contact_id(deal: &str, contact: &str) -> String {
    use sha2::Digest;
    let hash = sha2::Sha256::digest(format!("deal_contacts:{deal}:{contact}").as_bytes());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&hash[..16]);
    uuid::Builder::from_bytes(bytes).with_version(uuid::Version::Sha1).with_variant(uuid::Variant::RFC4122).into_uuid().to_string()
}

fn err(text: impl Into<String>) -> AppError {
    AppError::msg(text)
}

/// Операция очереди выгрузки.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Op {
    pub op_id: String,
    pub entity: String,
    pub id: String,
    pub kind: String,
    pub fields: Map<String, Value>,
    pub ts: Map<String, Value>,
    pub base_version: i64,
    pub attempts: i64,
    pub state: String,
    pub last_error: Option<String>,
}

impl Op {
    pub fn to_push(&self) -> Value {
        json!({"op_id": self.op_id, "entity": self.entity, "id": self.id, "kind": self.kind,
               "fields": self.fields, "ts": self.ts, "base_version": self.base_version})
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub user_id: String,
    pub display_name: String,
    pub role: String,
    pub role_name: String,
    pub rank: i64,
    pub avatar_path: Option<String>,
    pub email: Option<String>,
}

pub struct WorkspaceStore {
    conn: Connection,
    path: PathBuf,
    pub workspace_id: String,
    pub user_id: String,
}

/// Встроенная `lower()` SQLite приводит к нижнему регистру только латиницу, поэтому поиск «ромашка» не находил
/// «Ромашка». Подменяем её на версию с Юникодом: поиск, фильтр «содержит» и сопоставление этапов при импорте
/// перестают зависеть от регистра и для русских букв.
fn unicode_lower(conn: &Connection) -> AppResult<()> {
    use rusqlite::functions::FunctionFlags;
    use rusqlite::types::{Value as SqlValue, ValueRef};
    conn.create_scalar_function("lower", 1, FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC, |ctx| match ctx.get_raw(0) {
        ValueRef::Text(t) => Ok(SqlValue::Text(String::from_utf8_lossy(t).to_lowercase())),
        _ => ctx.get::<SqlValue>(0),
    })?;
    Ok(())
}

impl WorkspaceStore {
    pub fn open(path: &Path, key: Option<&DbKey>, workspace_id: &str, user_id: &str) -> AppResult<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = db::open_connection(path, false, key)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")?;
        unicode_lower(&conn)?;
        let store = Self { conn, path: path.to_path_buf(), workspace_id: workspace_id.to_string(), user_id: user_id.to_string() };
        store.create_schema()?;
        match store.meta("workspace_id") {
            Some(ws) if ws != workspace_id => return Err(err("Файл базы принадлежит другому Workspace.")),
            Some(_) => {}
            None => store.set_meta("workspace_id", workspace_id)?,
        }
        Ok(store)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    fn create_schema(&self) -> AppResult<()> {
        let mut sql = String::from(
            "CREATE TABLE IF NOT EXISTS local_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS sync_outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT, op_id TEXT NOT NULL UNIQUE,
                 entity TEXT NOT NULL, entity_id TEXT NOT NULL, kind TEXT NOT NULL, fields TEXT NOT NULL, ts TEXT NOT NULL,
                 base_version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
                 next_attempt_at TEXT, state TEXT NOT NULL DEFAULT 'pending', last_error TEXT);
             CREATE INDEX IF NOT EXISTS sync_outbox_entity ON sync_outbox(entity, entity_id, state);
             CREATE TABLE IF NOT EXISTS sync_cursor(table_name TEXT PRIMARY KEY, server_seq INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS conflicts(id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
                 field TEXT NOT NULL, kept TEXT, lost TEXT, lost_by TEXT, kept_by TEXT, at TEXT, resolved_at TEXT);
             CREATE TABLE IF NOT EXISTS members(user_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, role TEXT NOT NULL,
                 role_name TEXT NOT NULL, rank INTEGER NOT NULL, avatar_path TEXT, email TEXT);
             CREATE TABLE IF NOT EXISTS collection_prefs(collection_id TEXT PRIMARY KEY, position REAL NOT NULL DEFAULT 0,
                 hidden INTEGER NOT NULL DEFAULT 0, dirty INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE IF NOT EXISTS deal_stage_history(id TEXT PRIMARY KEY, deal_id TEXT NOT NULL, from_stage_id TEXT,
                 to_stage_id TEXT NOT NULL, changed_by TEXT, changed_at TEXT NOT NULL, server_seq INTEGER NOT NULL DEFAULT 0,
                 local INTEGER NOT NULL DEFAULT 0);
             CREATE INDEX IF NOT EXISTS deal_stage_history_deal ON deal_stage_history(deal_id, changed_at);
             CREATE TABLE IF NOT EXISTS attachment_blobs(id TEXT PRIMARY KEY, data BLOB NOT NULL, uploaded INTEGER NOT NULL DEFAULT 0);",
        );
        for e in ENTITIES {
            sql.push_str(&format!(
                "CREATE TABLE IF NOT EXISTS {t}(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, created_by TEXT, created_at TEXT,
                   updated_by TEXT, updated_at TEXT, version INTEGER NOT NULL DEFAULT 0, field_ts TEXT NOT NULL DEFAULT '{{}}',
                   field_ver TEXT NOT NULL DEFAULT '{{}}', server_seq INTEGER NOT NULL DEFAULT 0,
                   sync_state TEXT NOT NULL DEFAULT 'pending'",
                t = e.table
            ));
            for f in e.fields {
                let ty = match f.kind {
                    Kind::Num => "REAL",
                    Kind::Bool => "INTEGER",
                    _ => "TEXT",
                };
                sql.push_str(&format!(", {} {ty}", f.name));
            }
            sql.push_str(");");
            sql.push_str(&format!("CREATE INDEX IF NOT EXISTS {t}_updated ON {t}(updated_at);", t = e.table));
            if e.has("entity_id") {
                sql.push_str(&format!("CREATE INDEX IF NOT EXISTS {t}_entity ON {t}(entity_type, entity_id);", t = e.table));
            }
        }
        self.conn.execute_batch(&sql)?;
        if self.meta("schema_version").is_none() {
            self.set_meta("schema_version", &SCHEMA_VERSION.to_string())?;
        }
        Ok(())
    }

    // ------------------------------------------------------------ служебные значения

    pub fn meta(&self, key: &str) -> Option<String> {
        self.conn.query_row("SELECT value FROM local_meta WHERE key=?1", [key], |r| r.get(0)).optional().ok().flatten()
    }

    pub fn set_meta(&self, key: &str, value: &str) -> AppResult<()> {
        self.conn.execute("INSERT INTO local_meta(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, value])?;
        Ok(())
    }

    /// Разрешения пользователя в этом Workspace (из `my_workspaces` или все — у локального).
    pub fn permissions(&self) -> BTreeSet<String> {
        self.meta("permissions")
            .and_then(|v| serde_json::from_str::<Vec<String>>(&v).ok())
            .map(|v| v.into_iter().collect())
            .unwrap_or_else(|| ALL_PERMISSIONS.iter().map(|s| s.to_string()).collect())
    }

    pub fn set_permissions(&self, perms: &[String]) -> AppResult<()> {
        self.set_meta("permissions", &serde_json::to_string(perms)?)
    }

    pub fn can(&self, perm: &str) -> bool {
        self.permissions().contains(perm)
    }

    pub fn cursor(&self, table: &str) -> i64 {
        self.conn.query_row("SELECT server_seq FROM sync_cursor WHERE table_name=?1", [table], |r| r.get(0)).optional().ok().flatten().unwrap_or(0)
    }

    // ------------------------------------------------------------ участники

    pub fn members(&self) -> AppResult<Vec<Member>> {
        let mut st =
            self.conn.prepare("SELECT user_id, display_name, role, role_name, rank, avatar_path, email FROM members ORDER BY rank DESC, display_name")?;
        let rows = st.query_map([], |r| {
            Ok(Member {
                user_id: r.get(0)?,
                display_name: r.get(1)?,
                role: r.get(2)?,
                role_name: r.get(3)?,
                rank: r.get(4)?,
                avatar_path: r.get(5)?,
                email: r.get(6)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn replace_members(&self, members: &[Member]) -> AppResult<()> {
        self.transaction(|c| {
            c.execute("DELETE FROM members", [])?;
            for m in members {
                c.execute(
                    "INSERT INTO members(user_id, display_name, role, role_name, rank, avatar_path, email) VALUES(?1,?2,?3,?4,?5,?6,?7)",
                    params![m.user_id, m.display_name, m.role, m.role_name, m.rank, m.avatar_path, m.email],
                )?;
            }
            Ok(())
        })
    }

    fn is_member(&self, user: &str) -> bool {
        let n: i64 = self.conn.query_row("SELECT count(*) FROM members", [], |r| r.get(0)).unwrap_or(0);
        n == 0 || self.conn.query_row("SELECT 1 FROM members WHERE user_id=?1", [user], |_| Ok(())).optional().ok().flatten().is_some()
    }

    pub(crate) fn transaction<T>(&self, f: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        match f(&self.conn) {
            Ok(v) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(v)
            }
            Err(e) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    // ------------------------------------------------------------ чтение

    /// Строка как JSON: служебные столбцы, поля сущности и `sync_state`.
    pub fn get(&self, table: &str, id: &str) -> AppResult<Option<Value>> {
        let e = schema::entity(table).ok_or_else(|| err(format!("Неизвестная сущность: {table}")))?;
        let sql = format!("SELECT * FROM {} WHERE id=?1", e.table);
        Ok(self.conn.query_row(&sql, [id], |r| Ok(row_json(e, r))).optional()?)
    }

    pub fn list(&self, table: &str, q: &Query) -> AppResult<Vec<Value>> {
        let e = schema::entity(table).ok_or_else(|| err(format!("Неизвестная сущность: {table}")))?;
        let (sql, args) = query::build(e, q, &self.user_id, Utc::now())?;
        let mut st = self.conn.prepare(&sql)?;
        let rows = st.query_map(rusqlite::params_from_iter(args.iter()), |r| Ok(row_json(e, r)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn count(&self, table: &str, q: &Query) -> AppResult<i64> {
        let e = schema::entity(table).ok_or_else(|| err(format!("Неизвестная сущность: {table}")))?;
        let (sql, args) = query::build_count(e, q, &self.user_id, Utc::now())?;
        Ok(self.conn.query_row(&sql, rusqlite::params_from_iter(args.iter()), |r| r.get(0))?)
    }

    /// Записи, привязанные к карточке (задачи, активности, заметки, комментарии).
    pub fn linked(&self, table: &str, entity_type: &str, entity_id: &str) -> AppResult<Vec<Value>> {
        let mut q = Query::default();
        q.filters.push(query::Filter::eq("entity_type", entity_type));
        q.filters.push(query::Filter::eq("entity_id", entity_id));
        q.sort.push(query::Sort { field: "created_at".into(), dir: "desc".into() });
        self.list(table, &q)
    }

    pub fn stage_history(&self, deal: &str) -> AppResult<Vec<Value>> {
        let mut st = self
            .conn
            .prepare("SELECT from_stage_id, to_stage_id, changed_by, changed_at FROM deal_stage_history WHERE deal_id=?1 ORDER BY changed_at, server_seq")?;
        let rows = st.query_map([deal], |r| {
            Ok(json!({"from_stage_id": r.get::<_, Option<String>>(0)?, "to_stage_id": r.get::<_, String>(1)?,
                      "changed_by": r.get::<_, Option<String>>(2)?, "changed_at": r.get::<_, String>(3)?}))
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// История этапов всех неудалённых сделок (для отчётов воронки), по времени.
    pub fn stage_history_all(&self) -> AppResult<Vec<Value>> {
        let mut st = self.conn.prepare(
            "SELECT h.deal_id, h.from_stage_id, h.to_stage_id, h.changed_at FROM deal_stage_history h
             JOIN deals d ON d.id = h.deal_id WHERE d.deleted_at IS NULL ORDER BY h.changed_at, h.server_seq",
        )?;
        let rows = st.query_map([], |r| {
            Ok(json!({"deal_id": r.get::<_, String>(0)?, "from_stage_id": r.get::<_, Option<String>>(1)?,
                      "to_stage_id": r.get::<_, String>(2)?, "changed_at": r.get::<_, String>(3)?}))
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Похожие записи по ключам дедупликации («Похоже на: …»).
    pub fn duplicates(&self, table: &str, keys: &[String], except: Option<&str>) -> AppResult<Vec<Value>> {
        let e = schema::entity(table).filter(|e| e.has("dedupe_keys")).ok_or_else(|| err("Дедупликация есть только у компаний и контактов."))?;
        if keys.is_empty() {
            return Ok(vec![]);
        }
        let marks = vec!["?"; keys.len()].join(", ");
        let sql = format!(
            "SELECT DISTINCT t.* FROM {t} t, json_each(t.dedupe_keys) k WHERE t.deleted_at IS NULL AND k.value IN ({marks}) AND t.id IS NOT ? LIMIT 10",
            t = e.table
        );
        let mut args: Vec<Sql> = keys.iter().map(|k| Sql::Text(k.clone())).collect();
        args.push(except.map(|s| Sql::Text(s.into())).unwrap_or(Sql::Null));
        let mut st = self.conn.prepare(&sql)?;
        let rows = st.query_map(rusqlite::params_from_iter(args.iter()), |r| Ok(row_json(e, r)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Воронка (указанная или по умолчанию) и её первый открытый этап.
    pub fn first_stage(&self, pipeline: Option<&str>) -> AppResult<(String, String)> {
        let pid: String = match pipeline {
            Some(p) => p.to_string(),
            None => self
                .conn
                .query_row("SELECT id FROM pipelines WHERE deleted_at IS NULL ORDER BY is_default DESC, position LIMIT 1", [], |r| r.get(0))
                .optional()?
                .ok_or_else(|| err("В Workspace нет воронки."))?,
        };
        let sid: String = self
            .conn
            .query_row("SELECT id FROM pipeline_stages WHERE pipeline_id=?1 AND deleted_at IS NULL AND kind='open' ORDER BY position LIMIT 1", [&pid], |r| {
                r.get(0)
            })
            .optional()?
            .ok_or_else(|| err("В воронке нет открытых этапов."))?;
        Ok((pid, sid))
    }

    // ------------------------------------------------------------ запись

    /// Создать (`id = None`) или изменить запись. Возвращает строку после записи.
    pub fn save(&self, table: &str, id: Option<&str>, fields: &Map<String, Value>) -> AppResult<Value> {
        self.save_at(table, id, fields, Utc::now())
    }

    pub fn save_at(&self, table: &str, id: Option<&str>, fields: &Map<String, Value>, now: DateTime<Utc>) -> AppResult<Value> {
        let e = schema::entity(table).ok_or_else(|| err(format!("Неизвестная сущность: {table}")))?;
        let id = id.map(str::to_string).unwrap_or_else(new_id);
        uuid::Uuid::parse_str(&id).map_err(|_| err("Неверный идентификатор записи."))?;
        let current = self.get(e.table, &id)?;
        let mut clean = Map::new();
        for (k, v) in fields {
            let f = e.field(k).ok_or_else(|| err(format!("Поле «{k}» нельзя изменить.")))?;
            if !f.writable {
                return Err(err(format!("Поле «{k}» вычисляется автоматически.")));
            }
            clean.insert(k.clone(), check_value(e, f.name, f.kind, f.max_len, v)?);
        }
        if let Some(cur) = &current {
            if !cur["deleted_at"].is_null() && !clean.contains_key("deleted_at") {
                return Err(err("Запись удалена. Сначала восстановите её."));
            }
            // Неизменённые поля в операцию не попадают.
            clean.retain(|k, v| &cur[k.as_str()] != v);
        }
        self.check_rights(e, current.as_ref(), &clean)?;
        let merged = merged_row(current.as_ref(), &clean);
        self.check_required(e, current.is_none(), &merged)?;
        self.check_references(e, &clean, &merged)?;
        derive_fields(e, &merged, &mut clean, self)?;
        if let (Some(row), true) = (&current, clean.is_empty()) {
            return Ok(row.clone());
        }
        let now_s = stamp(now);
        self.transaction(|c| {
            write_row(c, e, &self.workspace_id, &self.user_id, &id, current.as_ref(), &clean, &now_s)?;
            let kind = if current.is_some() && clean.len() == 1 && clean.contains_key("deleted_at") {
                if clean["deleted_at"].is_null() {
                    "restore"
                } else {
                    "delete"
                }
            } else {
                "upsert"
            };
            let base = current.as_ref().and_then(|r| r["version"].as_i64()).unwrap_or(0);
            enqueue(c, e.table, &id, kind, &clean, &now_s, base)?;
            if e.table == "deals" && clean.contains_key("stage_id") {
                c.execute(
                    "INSERT INTO deal_stage_history(id, deal_id, from_stage_id, to_stage_id, changed_by, changed_at, local) VALUES(?1,?2,?3,?4,?5,?6,1)",
                    params![new_id(), id, current.as_ref().and_then(|r| r["stage_id"].as_str()), clean["stage_id"].as_str(), self.user_id, now_s],
                )?;
            }
            Ok(())
        })?;
        Ok(self.get(e.table, &id)?.unwrap_or(Value::Null))
    }

    /// Мягкое удаление (надгробие).
    pub fn delete(&self, table: &str, id: &str) -> AppResult<Value> {
        let mut m = Map::new();
        m.insert("deleted_at".into(), json!(stamp(Utc::now())));
        self.save(table, Some(id), &m)
    }

    pub fn restore(&self, table: &str, id: &str) -> AppResult<Value> {
        let mut m = Map::new();
        m.insert("deleted_at".into(), Value::Null);
        self.save(table, Some(id), &m)
    }

    fn check_rights(&self, e: &Entity, current: Option<&Value>, fields: &Map<String, Value>) -> AppResult<()> {
        let denied = |what: &str| Err(err(format!("Недостаточно прав: {what}.")));
        let me = self.user_id.as_str();
        let touches_delete = fields.contains_key("deleted_at");
        match e.class {
            Class::Settings => {
                if !self.can("pipelines.manage") {
                    return denied("воронки и этапы меняет администратор");
                }
            }
            Class::Fields => {
                if !self.can("fields.manage") {
                    return denied("свои поля меняет менеджер или администратор");
                }
            }
            Class::Collections => {
                let vis = fields.get("visibility").or(current.map(|c| &c["visibility"])).and_then(Value::as_str).unwrap_or("private");
                let author = current.map(|c| c["created_by"].as_str() == Some(me)).unwrap_or(true);
                if !self.can("records.view") || ((vis == "workspace" || !author) && !self.can("collections.manage")) {
                    return denied("общие коллекции меняет менеджер или администратор");
                }
            }
            Class::Records => match current {
                None => {
                    if !self.can("records.create") {
                        return denied("создание записей");
                    }
                }
                Some(cur) => {
                    let own = [&cur["created_by"], &cur["owner_id"], &cur["assignee_id"]].iter().any(|v| v.as_str() == Some(me));
                    if !(self.can("records.edit") || (self.can("records.edit_own") && own)) {
                        return denied("изменение чужих записей");
                    }
                    let author_may = matches!(e.table, "notes" | "comments" | "activities") && cur["created_by"].as_str() == Some(me);
                    if touches_delete && !self.can("records.delete") && !author_may {
                        return denied("удаление записей");
                    }
                }
            },
        }
        Ok(())
    }

    fn check_required(&self, e: &Entity, creating: bool, row: &Map<String, Value>) -> AppResult<()> {
        if creating {
            for r in e.required {
                let empty = match row.get(*r) {
                    None | Some(Value::Null) => true,
                    Some(Value::String(s)) => s.trim().is_empty(),
                    _ => false,
                };
                if empty {
                    return Err(err(format!("Заполните поле «{}».", field_title(r))));
                }
            }
        }
        if e.table == "contacts" {
            let name = format!("{}{}", row.get("first_name").and_then(Value::as_str).unwrap_or(""), row.get("last_name").and_then(Value::as_str).unwrap_or(""));
            if name.trim().is_empty() {
                return Err(err("Укажите имя или фамилию контакта."));
            }
        }
        if e.table == "tasks" {
            let has_type = !row.get("entity_type").unwrap_or(&Value::Null).is_null();
            let has_id = !row.get("entity_id").unwrap_or(&Value::Null).is_null();
            if has_type != has_id {
                return Err(err("Связь задачи с карточкой указана не полностью."));
            }
        }
        Ok(())
    }

    /// `row` — запись после изменения: перенос на другую карточку (`entity_id`) проверяется по её типу, даже если
    /// сам тип не менялся (объединение дубликатов, пакет G4).
    fn check_references(&self, e: &Entity, fields: &Map<String, Value>, row: &Map<String, Value>) -> AppResult<()> {
        for (col, target) in REFERENCES {
            if let Some(id) = fields.get(col).and_then(Value::as_str) {
                if e.has(col) && !self.exists(target, id) {
                    return Err(err(format!("Связанная запись не найдена в этом Workspace ({col}).")));
                }
            }
        }
        if let Some(id) = fields.get("entity_id").and_then(Value::as_str) {
            let t =
                fields.get("entity_type").or_else(|| row.get("entity_type")).and_then(Value::as_str).ok_or_else(|| err("Не указан тип связанной карточки."))?;
            let target = schema::by_type(t).filter(|x| x.table != "tasks").ok_or_else(|| err("Неизвестный тип карточки."))?;
            if !self.exists(target.table, id) {
                return Err(err("Связанная карточка не найдена в этом Workspace."));
            }
        }
        for col in ["owner_id", "assignee_id"] {
            if let Some(u) = fields.get(col).and_then(Value::as_str) {
                if !self.is_member(u) {
                    return Err(err("Ответственный должен быть участником этого Workspace."));
                }
            }
        }
        if let Some(stage) = fields.get("stage_id").and_then(Value::as_str).filter(|_| e.table == "deals") {
            let st = self.get("pipeline_stages", stage)?.ok_or_else(|| err("Этап не найден."))?;
            if !st["deleted_at"].is_null() {
                return Err(err("Этап удалён."));
            }
        }
        Ok(())
    }

    fn exists(&self, table: &str, id: &str) -> bool {
        self.conn.query_row(&format!("SELECT 1 FROM {table} WHERE id=?1"), [id], |_| Ok(())).optional().ok().flatten().is_some()
    }

    // ------------------------------------------------------------ очередь выгрузки

    pub fn pending_ops(&self, limit: usize) -> AppResult<Vec<Op>> {
        let mut st = self.conn.prepare(
            "SELECT op_id, entity, entity_id, kind, fields, ts, base_version, attempts, state, last_error FROM sync_outbox
             WHERE state='pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?1) ORDER BY seq LIMIT ?2",
        )?;
        let rows = st.query_map(params![stamp(Utc::now()), limit as i64], op_from_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn all_ops(&self) -> AppResult<Vec<Op>> {
        let mut st =
            self.conn.prepare("SELECT op_id, entity, entity_id, kind, fields, ts, base_version, attempts, state, last_error FROM sync_outbox ORDER BY seq")?;
        let rows = st.query_map([], op_from_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    // ------------------------------------------------------------ содержимое вложений (в зашифрованной базе)

    pub fn put_blob(&self, id: &str, data: &[u8], uploaded: bool) -> AppResult<()> {
        self.conn.execute("INSERT OR REPLACE INTO attachment_blobs(id, data, uploaded) VALUES(?1,?2,?3)", params![id, data, uploaded as i64])?;
        Ok(())
    }

    pub fn blob(&self, id: &str) -> Option<Vec<u8>> {
        self.conn.query_row("SELECT data FROM attachment_blobs WHERE id=?1", [id], |r| r.get(0)).optional().ok().flatten()
    }

    /// Файлы, ещё не отправленные в облако, только для вложений, чьи метаданные уже приняты сервером.
    pub fn blobs_to_upload(&self) -> Vec<(String, Vec<u8>)> {
        let Ok(mut st) = self.conn.prepare(
            "SELECT b.id, b.data FROM attachment_blobs b JOIN attachments a ON a.id=b.id
             WHERE b.uploaded=0 AND a.sync_state='synced' AND NOT EXISTS (SELECT 1 FROM sync_outbox o WHERE o.entity='attachments' AND o.entity_id=b.id AND o.state='pending')",
        ) else {
            return vec![];
        };
        st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))).map(|r| r.flatten().collect()).unwrap_or_default()
    }

    pub fn mark_blob_uploaded(&self, id: &str) -> AppResult<()> {
        self.conn.execute("UPDATE attachment_blobs SET uploaded=1 WHERE id=?1", [id])?;
        Ok(())
    }

    pub fn pending_count(&self) -> i64 {
        self.conn.query_row("SELECT count(*) FROM sync_outbox WHERE state='pending'", [], |r| r.get(0)).unwrap_or(0)
    }

    /// Перед отправкой: операция больше не сливается с новыми правками (её уже мог получить сервер).
    pub fn mark_sending(&self, ops: &[Op]) -> AppResult<()> {
        self.transaction(|c| {
            for o in ops {
                c.execute("UPDATE sync_outbox SET attempts=attempts+1 WHERE op_id=?1", [&o.op_id])?;
            }
            Ok(())
        })
    }

    /// Сеть недоступна: повтор с паузой 2 с → 5 мин (±20 %).
    pub fn postpone(&self, ops: &[Op], error: &str) -> AppResult<()> {
        self.transaction(|c| {
            for o in ops {
                let attempts: i64 = c.query_row("SELECT attempts FROM sync_outbox WHERE op_id=?1", [&o.op_id], |r| r.get(0)).unwrap_or(1);
                let secs = (2f64 * 2f64.powi((attempts - 1).clamp(0, 20) as i32)).min(300.0);
                let jitter = 0.8 + (uuid::Uuid::new_v4().as_u128() % 400) as f64 / 1000.0;
                let next = Utc::now() + chrono::Duration::milliseconds((secs * jitter * 1000.0) as i64);
                c.execute("UPDATE sync_outbox SET next_attempt_at=?2, last_error=?3 WHERE op_id=?1", params![o.op_id, stamp(next), error])?;
            }
            Ok(())
        })
    }

    pub fn retry_now(&self) -> AppResult<()> {
        self.conn.execute("UPDATE sync_outbox SET next_attempt_at=NULL WHERE state='pending'", [])?;
        Ok(())
    }

    /// Ответ `crm_push` на одну операцию. Возвращает id записей, которые нужно перечитать с сервера.
    pub fn apply_result(&self, result: &Value) -> AppResult<Option<(String, String)>> {
        let op_id = result["op_id"].as_str().unwrap_or_default();
        let Some(op) = self.all_ops()?.into_iter().find(|o| o.op_id == op_id) else { return Ok(None) };
        let e = schema::entity(&op.entity).ok_or_else(|| err("неизвестная сущность в очереди"))?;
        let status = result["status"].as_str().unwrap_or("rejected");
        self.transaction(|c| {
            let mut refetch = None;
            if status == "rejected" {
                c.execute(
                    "UPDATE sync_outbox SET state='rejected', last_error=?2 WHERE op_id=?1",
                    params![op_id, result["error"].as_str().unwrap_or("отклонено сервером")],
                )?;
                c.execute(&format!("UPDATE {} SET sync_state='rejected' WHERE id=?1", e.table), [&op.id])?;
                refetch = Some((op.entity.clone(), op.id.clone()));
            } else {
                c.execute("DELETE FROM sync_outbox WHERE op_id=?1", [op_id])?;
                let left: i64 =
                    c.query_row("SELECT count(*) FROM sync_outbox WHERE entity=?1 AND entity_id=?2 AND state='pending'", params![op.entity, op.id], |r| {
                        r.get(0)
                    })?;
                let state = if status == "conflict" {
                    "conflict"
                } else if left > 0 {
                    "pending"
                } else {
                    "synced"
                };
                let version = result["version"].as_i64();
                c.execute(&format!("UPDATE {} SET sync_state=?2, version=coalesce(?3, version) WHERE id=?1", e.table), params![op.id, state, version])?;
                if status == "conflict" {
                    refetch = Some((op.entity.clone(), op.id.clone()));
                }
            }
            Ok(refetch)
        })
    }

    /// Отклонённые сервером операции: показать пользователю и убрать из очереди.
    pub fn rejected_ops(&self) -> AppResult<Vec<Op>> {
        Ok(self.all_ops()?.into_iter().filter(|o| o.state == "rejected").collect())
    }

    pub fn dismiss_rejected(&self) -> AppResult<usize> {
        Ok(self.conn.execute("DELETE FROM sync_outbox WHERE state='rejected'", [])?)
    }

    // ------------------------------------------------------------ загрузка с сервера

    /// Строки с сервера (в порядке `server_seq`). Поля с неотправленными правками этого устройства не затираются.
    pub fn apply_remote(&self, table: &str, rows: &[Value]) -> AppResult<usize> {
        let e = schema::entity(table).ok_or_else(|| err(format!("Неизвестная сущность: {table}")))?;
        self.transaction(|c| {
            let mut max_seq = 0;
            for r in rows {
                let Some(id) = r["id"].as_str() else { continue };
                if r["workspace_id"].as_str() != Some(self.workspace_id.as_str()) {
                    continue; // чужая строка не попадает в эту базу ни при каких условиях
                }
                max_seq = max_seq.max(r["server_seq"].as_i64().unwrap_or(0));
                let pending = pending_fields(c, e.table, id)?;
                let mut cols: Vec<&str> = schema::SYSTEM_COLUMNS.to_vec();
                cols.extend(e.fields.iter().map(|f| f.name));
                let mut vals: Vec<Sql> = Vec::with_capacity(cols.len() + 1);
                for col in &cols {
                    let kind = e.column_kind(col).unwrap_or(Kind::Text);
                    let v = if *col == "field_ts" || *col == "field_ver" { Value::String(r[*col].to_string()) } else { r[*col].clone() };
                    vals.push(to_sql(if *col == "field_ts" || *col == "field_ver" { Kind::Text } else { kind }, &v));
                }
                let state = if pending.is_empty() { "synced" } else { "pending" };
                vals.push(Sql::Text(state.into()));
                let names = cols.join(", ");
                let marks = (1..=cols.len() + 1).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ");
                let updates = cols.iter().map(|c| format!("{c}=excluded.{c}")).collect::<Vec<_>>().join(", ");
                c.execute(
                    &format!("INSERT INTO {t}({names}, sync_state) VALUES({marks}) ON CONFLICT(id) DO UPDATE SET {updates}, sync_state=excluded.sync_state", t = e.table),
                    rusqlite::params_from_iter(vals.iter()),
                )?;
                // Свои ожидающие правки поверх загруженной строки: сервер сравнит время, когда они дойдут.
                for (k, v) in pending {
                    if let Some(f) = e.field(&k) {
                        c.execute(&format!("UPDATE {} SET {}=?2 WHERE id=?1", e.table, f.name), params![id, to_sql(f.kind, &v)])?;
                    }
                }
            }
            if max_seq > 0 {
                c.execute(
                    "INSERT INTO sync_cursor(table_name, server_seq) VALUES(?1, ?2) ON CONFLICT(table_name) DO UPDATE SET server_seq=max(server_seq, excluded.server_seq)",
                    params![e.table, max_seq],
                )?;
            }
            Ok(rows.len())
        })
    }

    /// Сервер больше не отдаёт запись (нет прав или её нет): локальная копия удаляется.
    pub fn forget(&self, table: &str, id: &str) -> AppResult<()> {
        let e = schema::entity(table).ok_or_else(|| err(format!("Неизвестная сущность: {table}")))?;
        self.transaction(|c| {
            c.execute(&format!("DELETE FROM {} WHERE id=?1", e.table), [id])?;
            c.execute("DELETE FROM sync_outbox WHERE entity=?1 AND entity_id=?2", params![e.table, id])?;
            Ok(())
        })
    }

    pub fn apply_remote_history(&self, rows: &[Value]) -> AppResult<()> {
        self.transaction(|c| {
            let mut max_seq = 0;
            for r in rows {
                if r["workspace_id"].as_str() != Some(self.workspace_id.as_str()) {
                    continue;
                }
                let deal = r["deal_id"].as_str().unwrap_or_default();
                c.execute("DELETE FROM deal_stage_history WHERE deal_id=?1 AND local=1", [deal])?;
                c.execute(
                    "INSERT OR REPLACE INTO deal_stage_history(id, deal_id, from_stage_id, to_stage_id, changed_by, changed_at, server_seq, local) VALUES(?1,?2,?3,?4,?5,?6,?7,0)",
                    params![r["id"].as_str(), deal, r["from_stage_id"].as_str(), r["to_stage_id"].as_str(), r["changed_by"].as_str(), r["changed_at"].as_str(), r["server_seq"].as_i64()],
                )?;
                max_seq = max_seq.max(r["server_seq"].as_i64().unwrap_or(0));
            }
            if max_seq > 0 {
                c.execute(
                    "INSERT INTO sync_cursor(table_name, server_seq) VALUES('deal_stage_history', ?1) ON CONFLICT(table_name) DO UPDATE SET server_seq=max(server_seq, excluded.server_seq)",
                    [max_seq],
                )?;
            }
            Ok(())
        })
    }

    pub fn apply_remote_conflicts(&self, rows: &[Value]) -> AppResult<()> {
        self.transaction(|c| {
            let mut max_seq = 0;
            for r in rows {
                c.execute(
                    "INSERT OR REPLACE INTO conflicts(id, entity_type, entity_id, field, kept, lost, lost_by, kept_by, at, resolved_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                    params![r["id"].as_str(), r["entity_type"].as_str(), r["entity_id"].as_str(), r["field"].as_str(), r["kept"].to_string(),
                            r["lost"].to_string(), r["lost_by"].as_str(), r["kept_by"].as_str(), r["at"].as_str(), r["resolved_at"].as_str()],
                )?;
                max_seq = max_seq.max(r["server_seq"].as_i64().unwrap_or(0));
            }
            if max_seq > 0 {
                c.execute(
                    "INSERT INTO sync_cursor(table_name, server_seq) VALUES('sync_conflicts', ?1) ON CONFLICT(table_name) DO UPDATE SET server_seq=max(server_seq, excluded.server_seq)",
                    [max_seq],
                )?;
            }
            Ok(())
        })
    }

    /// Нерешённые конфликты: что сохранилось и что было потеряно (можно вернуть своё значение одним нажатием).
    pub fn conflicts(&self) -> AppResult<Vec<Value>> {
        let mut st = self
            .conn
            .prepare("SELECT id, entity_type, entity_id, field, kept, lost, lost_by, kept_by, at FROM conflicts WHERE resolved_at IS NULL ORDER BY at DESC")?;
        let rows = st.query_map([], |r| {
            let parse = |s: Option<String>| s.and_then(|s| serde_json::from_str::<Value>(&s).ok()).unwrap_or(Value::Null);
            Ok(json!({"id": r.get::<_, String>(0)?, "entityType": r.get::<_, String>(1)?, "entityId": r.get::<_, String>(2)?,
                      "field": r.get::<_, String>(3)?, "kept": parse(r.get(4)?), "lost": parse(r.get(5)?),
                      "lostBy": r.get::<_, Option<String>>(6)?, "keptBy": r.get::<_, Option<String>>(7)?, "at": r.get::<_, Option<String>>(8)?}))
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn resolve_conflict(&self, id: &str) -> AppResult<()> {
        self.conn.execute("UPDATE conflicts SET resolved_at=?2 WHERE id=?1", params![id, stamp(Utc::now())])?;
        Ok(())
    }

    // ------------------------------------------------------------ коллекции: порядок у пользователя

    pub fn collection_prefs(&self) -> AppResult<Vec<(String, f64, bool)>> {
        let mut st = self.conn.prepare("SELECT collection_id, position, hidden FROM collection_prefs")?;
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? != 0)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn set_collection_pref(&self, id: &str, position: f64, hidden: bool, dirty: bool) -> AppResult<()> {
        self.conn.execute(
            "INSERT INTO collection_prefs(collection_id, position, hidden, dirty) VALUES(?1,?2,?3,?4)
             ON CONFLICT(collection_id) DO UPDATE SET position=excluded.position, hidden=excluded.hidden, dirty=excluded.dirty",
            params![id, position, hidden as i64, dirty as i64],
        )?;
        Ok(())
    }

    pub fn dirty_collection_prefs(&self) -> AppResult<Vec<(String, f64, bool)>> {
        let mut st = self.conn.prepare("SELECT collection_id, position, hidden FROM collection_prefs WHERE dirty=1")?;
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? != 0)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    // ------------------------------------------------------------ шаблон локального Workspace

    /// Воронка-шаблон и встроенные коллекции — как `private.seed_workspace()` на сервере. Только для локального
    /// Workspace: у облачного они приходят с сервера при загрузке.
    pub fn seed_local(&self) -> AppResult<()> {
        if self.meta("seeded").is_some() {
            return Ok(());
        }
        let pipeline = new_id();
        let mut p = Map::new();
        p.insert("name".into(), json!("Продажи"));
        p.insert("position".into(), json!(1));
        p.insert("is_default".into(), json!(true));
        self.save("pipelines", Some(&pipeline), &p)?;
        for (i, (name, color, prob, kind)) in SEED_STAGES.iter().enumerate() {
            let mut s = Map::new();
            for (k, v) in [
                ("pipeline_id", json!(pipeline)),
                ("name", json!(name)),
                ("position", json!(i + 1)),
                ("color", json!(color)),
                ("probability", json!(prob)),
                ("kind", json!(kind)),
            ] {
                s.insert(k.into(), v);
            }
            self.save("pipeline_stages", None, &s)?;
        }
        for (i, (_builtin, entity, name, emoji, config)) in SEED_COLLECTIONS.iter().enumerate() {
            let mut c = Map::new();
            for (k, v) in [
                ("visibility", json!("workspace")),
                ("entity_type", json!(entity)),
                ("name", json!(name)),
                ("emoji", json!(emoji)),
                ("config", serde_json::from_str::<Value>(config).unwrap_or(json!({}))),
                ("position", json!(i + 1)),
            ] {
                c.insert(k.into(), v);
            }
            self.save("collections", None, &c)?;
        }
        self.set_meta("seeded", "1")
    }

    /// Убирает дубли шаблона, которые давал одновременный запуск двух команд (2.3.0 и раньше): одинаковые общие коллекции
    /// и лишние воронки «Продажи». Воронку со сделками и коллекции с другим содержимым не трогает. Выполняется один раз.
    pub fn dedupe_local_seed(&self) -> AppResult<()> {
        if self.meta("seed_deduped").is_some() {
            return Ok(());
        }
        let order = |a: &Value, b: &Value| a["created_at"].as_str().cmp(&b["created_at"].as_str()).then(a["id"].as_str().cmp(&b["id"].as_str()));
        let mut seen = BTreeSet::new();
        let mut collections = self.list("collections", &Query::default())?;
        collections.sort_by(order);
        for c in collections.iter().filter(|c| c["visibility"] == "workspace") {
            let key = format!("{}|{}|{}", c["entity_type"], c["name"], c["config"]);
            if !seen.insert(key) {
                self.delete("collections", c["id"].as_str().unwrap_or_default())?;
            }
        }
        let mut pipelines = self.list("pipelines", &Query::default())?;
        pipelines.retain(|p| p["name"] == "Продажи");
        pipelines.sort_by(order);
        let deals = self.list("deals", &Query { archived: true, ..Default::default() })?;
        let used = |id: &Value| deals.iter().any(|d| d["pipeline_id"] == *id);
        // Оставляем первую воронку и любую, в которой есть сделки.
        for p in pipelines.iter().skip(1).filter(|p| !used(&p["id"])) {
            let id = p["id"].as_str().unwrap_or_default();
            for st in self.list("pipeline_stages", &Query::default())?.iter().filter(|st| st["pipeline_id"] == p["id"]) {
                self.delete("pipeline_stages", st["id"].as_str().unwrap_or_default())?;
            }
            self.delete("pipelines", id)?;
        }
        let alive: Vec<Value> = self.list("pipelines", &Query::default())?;
        if let Some(first) = alive.first() {
            let default_count = alive.iter().filter(|p| p["is_default"] == true).count();
            if default_count != 1 {
                for p in &alive {
                    let mut m = Map::new();
                    m.insert("is_default".into(), json!(p["id"] == first["id"]));
                    self.save("pipelines", p["id"].as_str(), &m)?;
                }
            }
        }
        self.set_meta("seed_deduped", "1")
    }

    pub fn row_counts(&self) -> AppResult<std::collections::BTreeMap<String, i64>> {
        db::row_counts(&self.conn)
    }
}

pub const SEED_STAGES: [(&str, &str, i64, &str); 7] = [
    ("Новый лид", "#6b7280", 10, "open"),
    ("Первый контакт", "#3b82f6", 20, "open"),
    ("Переговоры", "#8b5cf6", 40, "open"),
    ("Подготовка предложения", "#f59e0b", 60, "open"),
    ("Согласование", "#ec4899", 80, "open"),
    ("Успешная сделка", "#22c55e", 100, "won"),
    ("Проигранная сделка", "#ef4444", 0, "lost"),
];

pub const SEED_COLLECTIONS: [(&str, &str, &str, &str, &str); 7] = [
    ("all_clients", "company", "Все клиенты", "🤝", r#"{"filters": [], "sort": [{"field": "updated_at", "dir": "desc"}]}"#),
    (
        "my_clients",
        "company",
        "Мои клиенты",
        "⭐",
        r#"{"filters": [{"field": "owner_id", "op": "eq", "value": "$me"}], "sort": [{"field": "updated_at", "dir": "desc"}]}"#,
    ),
    (
        "new_leads",
        "crm_lead",
        "Новые лиды",
        "🌱",
        r#"{"filters": [{"field": "status", "op": "eq", "value": "new"}], "sort": [{"field": "created_at", "dir": "desc"}]}"#,
    ),
    (
        "deals_this_week",
        "deal",
        "Сделки на этой неделе",
        "📅",
        r#"{"filters": [{"field": "expected_close_date", "op": "this_week"}, {"field": "status", "op": "eq", "value": "open"}], "sort": [{"field": "expected_close_date", "dir": "asc"}]}"#,
    ),
    (
        "overdue_tasks",
        "task",
        "Просроченные задачи",
        "⏰",
        r#"{"filters": [{"field": "due_at", "op": "overdue"}], "sort": [{"field": "due_at", "dir": "asc"}]}"#,
    ),
    (
        "won_deals",
        "deal",
        "Успешные сделки",
        "🏆",
        r#"{"filters": [{"field": "status", "op": "eq", "value": "won"}], "sort": [{"field": "closed_at", "dir": "desc"}]}"#,
    ),
    (
        "lost_deals",
        "deal",
        "Потерянные сделки",
        "🥀",
        r#"{"filters": [{"field": "status", "op": "eq", "value": "lost"}], "sort": [{"field": "closed_at", "dir": "desc"}]}"#,
    ),
];

fn field_title(name: &str) -> &str {
    match name {
        "name" => "Название",
        "title" => "Название",
        "pipeline_id" => "Воронка",
        "stage_id" => "Этап",
        "body" => "Текст",
        "entity_type" | "entity_id" => "Карточка",
        "type" => "Тип",
        "deal_id" => "Сделка",
        "contact_id" => "Контакт",
        other => other,
    }
}

fn op_from_row(r: &rusqlite::Row) -> rusqlite::Result<Op> {
    let parse = |s: String| serde_json::from_str::<Map<String, Value>>(&s).unwrap_or_default();
    Ok(Op {
        op_id: r.get(0)?,
        entity: r.get(1)?,
        id: r.get(2)?,
        kind: r.get(3)?,
        fields: parse(r.get(4)?),
        ts: parse(r.get(5)?),
        base_version: r.get(6)?,
        attempts: r.get(7)?,
        state: r.get(8)?,
        last_error: r.get(9)?,
    })
}

/// Поля из ещё не отправленных операций записи (последнее значение каждого поля).
fn pending_fields(c: &Connection, table: &str, id: &str) -> AppResult<Map<String, Value>> {
    let mut st = c.prepare("SELECT fields FROM sync_outbox WHERE entity=?1 AND entity_id=?2 AND state='pending' ORDER BY seq")?;
    let mut out = Map::new();
    for f in st.query_map(params![table, id], |r| r.get::<_, String>(0))? {
        if let Ok(m) = serde_json::from_str::<Map<String, Value>>(&f?) {
            out.extend(m);
        }
    }
    Ok(out)
}

/// Новая операция или слияние с ещё не отправлявшейся операцией той же записи.
fn enqueue(c: &Connection, table: &str, id: &str, kind: &str, fields: &Map<String, Value>, now: &str, base: i64) -> AppResult<()> {
    let ts: Map<String, Value> = fields.keys().map(|k| (k.clone(), json!(now))).collect();
    if kind == "upsert" {
        let prev: Option<(String, String, String)> = c
            .query_row(
                "SELECT op_id, fields, ts FROM sync_outbox WHERE entity=?1 AND entity_id=?2 AND state='pending' AND attempts=0 AND kind='upsert' ORDER BY seq DESC LIMIT 1",
                params![table, id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        if let Some((op_id, f, t)) = prev {
            let mut fm: Map<String, Value> = serde_json::from_str(&f).unwrap_or_default();
            let mut tm: Map<String, Value> = serde_json::from_str(&t).unwrap_or_default();
            fm.extend(fields.clone());
            tm.extend(ts);
            c.execute("UPDATE sync_outbox SET fields=?2, ts=?3 WHERE op_id=?1", params![op_id, Value::Object(fm).to_string(), Value::Object(tm).to_string()])?;
            return Ok(());
        }
    }
    c.execute(
        "INSERT INTO sync_outbox(op_id, entity, entity_id, kind, fields, ts, base_version, created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        params![new_id(), table, id, kind, Value::Object(fields.clone()).to_string(), Value::Object(ts).to_string(), base, now],
    )?;
    Ok(())
}

fn merged_row(current: Option<&Value>, fields: &Map<String, Value>) -> Map<String, Value> {
    let mut m = current.and_then(Value::as_object).cloned().unwrap_or_default();
    m.extend(fields.clone());
    m
}

/// Поля, которые вычисляет сервер (те же правила здесь): статус сделки по этапу, дата выполнения задачи,
/// полное имя контакта, ключи дедупликации.
fn derive_fields(e: &Entity, row: &Map<String, Value>, fields: &mut Map<String, Value>, store: &WorkspaceStore) -> AppResult<()> {
    match e.table {
        "companies" | "contacts" if !fields.contains_key("dedupe_keys") => {
            let keys = super::dedupe::keys(e.table, row);
            let cur: Vec<String> =
                row.get("dedupe_keys").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
            if keys != cur && !fields.is_empty() {
                fields.insert("dedupe_keys".into(), json!(keys));
            }
        }
        "deals" if fields.contains_key("stage_id") => {
            if let Some(stage) = row.get("stage_id").and_then(Value::as_str) {
                let st = store.get("pipeline_stages", stage)?.ok_or_else(|| err("Этап не найден."))?;
                if row.get("pipeline_id").and_then(Value::as_str) != st["pipeline_id"].as_str() {
                    return Err(err("Этап не относится к выбранной воронке."));
                }
            }
        }
        _ => {}
    }
    Ok(())
}

/// Записать строку (вставка или изменение) с теми же вычисляемыми полями, что ставит сервер.
#[allow(clippy::too_many_arguments)] // строка пишется одной функцией и для своих, и для чужих правок
fn write_row(c: &Connection, e: &Entity, ws: &str, user: &str, id: &str, current: Option<&Value>, fields: &Map<String, Value>, now: &str) -> AppResult<()> {
    let mut ts: Map<String, Value> = current.and_then(|r| r["field_ts"].as_object().cloned()).unwrap_or_default();
    for k in fields.keys() {
        ts.insert(k.clone(), json!(now));
    }
    if current.is_none() {
        c.execute(
            &format!("INSERT INTO {}(id, workspace_id, created_by, created_at, updated_by, updated_at, field_ts, sync_state) VALUES(?1,?2,?3,?4,?3,?4,'{{}}','pending')", e.table),
            params![id, ws, user, now],
        )?;
        // Значения по умолчанию, как у столбцов на сервере.
        for (col, v) in default_values(e.table) {
            c.execute(&format!("UPDATE {} SET {col}=?2 WHERE id=?1", e.table), params![id, to_sql(e.column_kind(col).unwrap_or(Kind::Text), &v)])?;
        }
    }
    for (k, v) in fields {
        let f = e.field(k).expect("checked");
        c.execute(&format!("UPDATE {} SET {}=?2 WHERE id=?1", e.table, f.name), params![id, to_sql(f.kind, v)])?;
    }
    c.execute(
        &format!("UPDATE {} SET updated_by=?2, updated_at=?3, field_ts=?4, sync_state='pending' WHERE id=?1", e.table),
        params![id, user, now, Value::Object(ts).to_string()],
    )?;
    // Вычисляемые поля.
    match e.table {
        "contacts" => {
            c.execute("UPDATE contacts SET full_name=trim(coalesce(first_name,'') || ' ' || coalesce(last_name,'')) WHERE id=?1", [id])?;
        }
        "deals" => {
            c.execute(
                "UPDATE deals SET status=(SELECT kind FROM pipeline_stages WHERE id=deals.stage_id),
                   closed_at=CASE WHEN (SELECT kind FROM pipeline_stages WHERE id=deals.stage_id)='open' THEN NULL
                                  WHEN closed_at IS NULL OR status IS NOT (SELECT kind FROM pipeline_stages WHERE id=deals.stage_id) THEN ?2
                                  ELSE closed_at END
                 WHERE id=?1",
                params![id, now],
            )?;
            c.execute("UPDATE deals SET lost_reason=NULL WHERE id=?1 AND status<>'lost'", [id])?;
        }
        "tasks" => {
            c.execute("UPDATE tasks SET completed_at=CASE WHEN status='done' THEN coalesce(completed_at, ?2) ELSE NULL END WHERE id=?1", params![id, now])?;
        }
        _ => {}
    }
    Ok(())
}

fn default_values(table: &str) -> Vec<(&'static str, Value)> {
    match table {
        "companies" => vec![("phones", json!([])), ("emails", json!([])), ("dedupe_keys", json!([]))],
        "contacts" => vec![
            ("first_name", json!("")),
            ("last_name", json!("")),
            ("phones", json!([])),
            ("emails", json!([])),
            ("messengers", json!({})),
            ("dedupe_keys", json!([])),
        ],
        "crm_leads" => vec![("phones", json!([])), ("emails", json!([])), ("status", json!("new"))],
        "pipelines" => vec![("position", json!(0)), ("is_default", json!(false))],
        "pipeline_stages" => vec![("position", json!(0)), ("color", json!("#4f8cff")), ("probability", json!(0)), ("kind", json!("open"))],
        "deals" => vec![("amount", json!(0)), ("currency", json!("RUB")), ("status", json!("open"))],
        "tasks" => vec![("description", json!("")), ("priority", json!("normal")), ("status", json!("todo"))],
        "activities" => vec![("summary", json!("")), ("payload", json!({}))],
        "collections" => vec![("visibility", json!("private")), ("config", json!({})), ("position", json!(0))],
        _ => vec![],
    }
}

/// Проверка и приведение значения поля (как ограничения `check` таблиц на сервере).
fn check_value(e: &Entity, name: &str, kind: Kind, max_len: usize, v: &Value) -> AppResult<Value> {
    let bad = |what: &str| Err(err(format!("Поле «{}»: {what}.", field_title(name))));
    if v.is_null() {
        return if e.required.contains(&name) { bad("обязательное") } else { Ok(Value::Null) };
    }
    let out = match kind {
        Kind::Text => {
            let s = v.as_str().map(str::trim).ok_or_else(|| err(format!("Поле «{name}»: ожидается текст.")))?;
            if max_len > 0 && s.chars().count() > max_len {
                return bad(&format!("не длиннее {max_len} символов"));
            }
            if let Some(allowed) = schema::allowed_values(e.table, name) {
                if !allowed.contains(&s) {
                    return bad("недопустимое значение");
                }
            }
            match (e.table, name) {
                ("pipeline_stages", "color")
                    if !(s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())) =>
                {
                    return bad("цвет в виде #rrggbb");
                }
                ("deals", "currency") if !(s.len() == 3 && s.chars().all(|c| c.is_ascii_uppercase())) => return bad("код валюты ISO 4217"),
                ("companies", "inn") if !s.is_empty() && !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') => return bad("только цифры и буквы"),
                ("collections", "icon") if !s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') => return bad("имя иконки"),
                _ => {}
            }
            if s.is_empty() && !matches!(name, "first_name" | "last_name" | "description" | "summary") {
                Value::Null
            } else {
                json!(s)
            }
        }
        Kind::Num => {
            let n = v.as_f64().filter(|n| n.is_finite()).ok_or_else(|| err(format!("Поле «{name}»: ожидается число.")))?;
            match name {
                "amount" if !(0.0..1e16).contains(&n) => return bad("не меньше нуля"),
                "probability" if !(0.0..=100.0).contains(&n) => return bad("от 0 до 100"),
                _ => {}
            }
            let n = if name == "amount" { (n * 100.0).round() / 100.0 } else { n };
            json!(n)
        }
        Kind::Bool => json!(v.as_bool().ok_or_else(|| err(format!("Поле «{name}»: ожидается да/нет.")))?),
        Kind::Ts => {
            let s = v.as_str().ok_or_else(|| err(format!("Поле «{name}»: ожидается дата и время.")))?;
            let t = DateTime::parse_from_rfc3339(s).map_err(|_| err(format!("Поле «{}»: неверная дата.", field_title(name))))?;
            json!(stamp(t.with_timezone(&Utc)))
        }
        Kind::Date => {
            let s = v.as_str().ok_or_else(|| err(format!("Поле «{name}»: ожидается дата.")))?;
            NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|_| err(format!("Поле «{}»: дата в виде ГГГГ-ММ-ДД.", field_title(name))))?;
            json!(s)
        }
        Kind::Uuid => {
            let s = v.as_str().ok_or_else(|| err(format!("Поле «{name}»: ожидается идентификатор.")))?;
            uuid::Uuid::parse_str(s).map_err(|_| err(format!("Поле «{name}»: неверный идентификатор.")))?;
            json!(s.to_lowercase())
        }
        Kind::Json => {
            let array_field = matches!(name, "phones" | "emails" | "dedupe_keys" | "options");
            if name == "value" {
                // Значение своего поля: строка, число или да/нет.
                if !(v.is_string() || v.is_number() || v.is_boolean()) || v.to_string().len() > 2000 {
                    return bad("ожидается строка, число или да/нет (до 2000 знаков)");
                }
                v.clone()
            } else if array_field {
                let arr = v.as_array().ok_or_else(|| err(format!("Поле «{name}»: ожидается список.")))?;
                let limit = if name == "options" { 100 } else { max_len };
                if arr.len() > limit {
                    return bad(&format!("не больше {limit} значений"));
                }
                let mut out: Vec<String> = Vec::new();
                for x in arr {
                    let s = x.as_str().map(str::trim).ok_or_else(|| err(format!("Поле «{name}»: ожидается список строк.")))?;
                    if !s.is_empty() && !out.iter().any(|o| o == s) {
                        out.push(s.chars().take(320).collect());
                    }
                }
                json!(out)
            } else {
                if !v.is_object() {
                    return bad("ожидается объект");
                }
                if v.to_string().len() > max_len.max(1) {
                    return bad("слишком большое значение");
                }
                v.clone()
            }
        }
    };
    Ok(out)
}

pub(crate) fn to_sql(kind: Kind, v: &Value) -> Sql {
    match v {
        Value::Null => Sql::Null,
        _ => match kind {
            Kind::Num => v.as_f64().map(Sql::Real).unwrap_or(Sql::Null),
            Kind::Bool => Sql::Integer(v.as_bool().unwrap_or(false) as i64),
            Kind::Json => Sql::Text(v.to_string()),
            _ => match v {
                Value::String(s) => Sql::Text(s.clone()),
                other => Sql::Text(other.to_string()),
            },
        },
    }
}

/// Строка таблицы как JSON по описанию сущности.
fn row_json(e: &Entity, r: &rusqlite::Row) -> Value {
    let mut m = Map::new();
    let text = |name: &str| r.get::<_, Option<String>>(name).ok().flatten();
    for col in ["id", "workspace_id", "created_by", "created_at", "updated_by", "updated_at", "sync_state"] {
        m.insert(col.into(), text(col).map(Value::String).unwrap_or(Value::Null));
    }
    for col in ["version", "server_seq"] {
        m.insert(col.into(), json!(r.get::<_, i64>(col).unwrap_or(0)));
    }
    for col in ["field_ts", "field_ver"] {
        m.insert(col.into(), text(col).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!({})));
    }
    for f in e.fields {
        let v = match f.kind {
            Kind::Num => r.get::<_, Option<f64>>(f.name).ok().flatten().map(|n| json!(n)).unwrap_or(Value::Null),
            Kind::Bool => r.get::<_, Option<i64>>(f.name).ok().flatten().map(|n| json!(n != 0)).unwrap_or(Value::Null),
            Kind::Json => text(f.name).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null),
            _ => text(f.name).map(Value::String).unwrap_or(Value::Null),
        };
        m.insert(f.name.into(), v);
    }
    Value::Object(m)
}
