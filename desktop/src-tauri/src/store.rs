//! Локальная база пользователя. Результаты поиска и действия пользователя хранятся рядом, но поиск
//! никогда не затирает избранное, архив, заметки и удаления. Схема совместима с базами macOS и
//! Windows версий: они открываются без преобразования.

use crate::cloud::types::*;
use crate::db::{self, DbKey, FileState};
use crate::error::{AppError, AppResult};
use crate::models::*;
use crate::util::{self, format_date, format_precise, normalize, parse_date, source_title};
use chrono::{DateTime, TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS leads (
    lead_id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    score REAL NOT NULL DEFAULT 0,
    relevance TEXT NOT NULL DEFAULT 'rejected',
    discovered_at TEXT NOT NULL,
    updated_at TEXT,
    data_json TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    favorite INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    excluded INTEGER NOT NULL DEFAULT 0,
    seen INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_leads_discovered ON leads(discovered_at);
CREATE TABLE IF NOT EXISTS source_state (
    source TEXT PRIMARY KEY,
    last_success_at TEXT,
    last_attempt_at TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ok',
    last_error TEXT
);
CREATE TABLE IF NOT EXISTS pipeline_errors (
    id INTEGER PRIMARY KEY,
    at TEXT,
    module TEXT NOT NULL,
    message TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS exclusions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(kind, value)
);
CREATE TABLE IF NOT EXISTS lead_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id TEXT NOT NULL,
    at TEXT NOT NULL,
    action TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_events_lead ON lead_events(lead_id);
CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    ok INTEGER NOT NULL,
    added INTEGER NOT NULL DEFAULT 0,
    updated INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
";

const MIGRATION: &str = "
CREATE TABLE IF NOT EXISTS search_queries (
    qhash TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    label TEXT NOT NULL,
    last_run_at TEXT NOT NULL,
    results INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS seen_objects (
    source TEXT NOT NULL,
    object_id TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    PRIMARY KEY (source, object_id)
);
CREATE INDEX IF NOT EXISTS ix_leads_fingerprint ON leads(fingerprint);
CREATE TABLE IF NOT EXISTS sync_dirty (
    entity TEXT NOT NULL,
    key TEXT NOT NULL,
    field TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    PRIMARY KEY (entity, key, field)
);
";

/// Ключи kv, которые уходят в облако. Значения — JSON-текст.
pub const SYNCED_KEYS: [&str; 7] = ["search.settings", "draft.signature", "search.auto", "profile.name", "profile.avatar", "account.prefs", "interface.prefs"];
const LEAD_FIELDS: [&str; 6] = ["data", "favorite", "archived", "deleted", "seen", "note"];

/// Время изменения для перенесённых данных: раньше любых изменений в облаке (2000-01-01).
pub fn import_stamp() -> DateTime<Utc> {
    Utc.timestamp_opt(946_684_800, 0).unwrap()
}

pub struct LeadStore {
    conn: Connection,
    path: PathBuf,
    key: Option<DbKey>,
    /// Записывать изменения в журнал синхронизации (включено для облачных учётных записей).
    sync_tracking: bool,
}

fn b(v: bool) -> i64 {
    v as i64
}

impl LeadStore {
    /// `key` — ключ шифрования. С ключом база хранится зашифрованной; если по этому пути лежит
    /// незашифрованная база прежней версии, она переписывается в зашифрованную без потери данных.
    pub fn open(path: &Path, key: Option<DbKey>) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let conn = Self::open_file(path, key.as_ref())?;
        let mut s = LeadStore { conn, path: path.to_path_buf(), key, sync_tracking: false };
        s.prepare_schema()?;
        s.sync_tracking = s.value("sync.enabled").as_deref() == Some("1");
        Ok(s)
    }

    fn open_file(path: &Path, key: Option<&DbKey>) -> AppResult<Connection> {
        match key {
            Some(k) => db::open_encrypted(path, k),
            None => db::open_connection(path, false, None),
        }
    }

    fn prepare_schema(&mut self) -> AppResult<()> {
        let _: String = self.conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))?;
        self.conn.execute_batch(SCHEMA)?;
        self.conn.execute("INSERT OR IGNORE INTO kv(key, value) VALUES('schema_version', '1')", [])?;
        self.migrate()
    }

    /// Миграции схемы старых баз (версия 1.0.x хранила результаты поиска из GitHub Actions).
    fn migrate(&mut self) -> AppResult<()> {
        let cols: Vec<String> = {
            let mut st = self.conn.prepare("PRAGMA table_info(source_state)")?;
            let rows = st.query_map([], |r| r.get::<_, String>(1))?;
            rows.collect::<Result<_, _>>()?
        };
        if !cols.iter().any(|c| c == "cursor_json") {
            self.conn.execute_batch("ALTER TABLE source_state ADD COLUMN cursor_json TEXT")?;
        }
        self.conn.execute_batch(MIGRATION)?;
        self.conn.execute("INSERT INTO kv(key, value) VALUES('schema_version', '2') ON CONFLICT(key) DO UPDATE SET value='2'", [])?;
        Ok(())
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn key(&self) -> Option<&DbKey> {
        self.key.as_ref()
    }
    pub fn is_encrypted(&self) -> bool {
        self.key.is_some()
    }
    pub fn sync_tracking(&self) -> bool {
        self.sync_tracking
    }
    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    /// Включить журнал изменений для облака. Флаг хранится в самой базе, поэтому его видят все соединения.
    pub fn enable_sync_tracking(&mut self) -> AppResult<()> {
        self.set_value("sync.enabled", "1")?;
        self.sync_tracking = true;
        Ok(())
    }

    pub fn file_size(&self) -> u64 {
        fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0)
    }

    /// Выполняет `body` в одной транзакции (BEGIN IMMEDIATE … COMMIT), откатывая при ошибке.
    pub(crate) fn transaction<T>(&self, body: impl FnOnce() -> AppResult<T>) -> AppResult<T> {
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        match body() {
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

    fn scalar_text(&self, sql: &str, p: impl rusqlite::Params) -> Option<String> {
        self.conn.query_row(sql, p, |r| r.get::<_, Option<String>>(0)).optional().ok().flatten().flatten()
    }

    fn exists(&self, sql: &str, p: impl rusqlite::Params) -> bool {
        self.conn.query_row(sql, p, |_| Ok(())).optional().ok().flatten().is_some()
    }

    // ------------------------------------------------------------ результаты поиска

    /// Сохраняет найденный лид. Избранное, архив, заметки и удаления пользователя не трогаются.
    pub fn save(&self, lead: &LeadData, id: &str, fingerprint: &str) -> AppResult<SaveOutcome> {
        let mut data = lead.clone();
        let now = util::now_string();
        let existing: Option<(Option<String>, String)> =
            self.conn.query_row("SELECT discovered_at, data_json FROM leads WHERE lead_id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
        if let Some((discovered, old_json)) = existing {
            // Дата обнаружения — первая, а не последняя.
            if let Some(d) = discovered.as_deref().and_then(parse_date) {
                data.discovered_at = Some(d);
            }
            // Отметка о переносе в CRM (Customers 2.0) сохраняется, даже если поиск нашёл лид заново.
            if data.crm.is_none() {
                data.crm = serde_json::from_str::<Value>(&old_json).ok().and_then(|v| v.get("crm").cloned()).filter(|v| !v.is_null());
            }
            let new_value = data.to_value();
            let same = serde_json::from_str::<Value>(&old_json).map(|old| json_equal(&old, &new_value)).unwrap_or(false);
            if same {
                return Ok(SaveOutcome::Unchanged);
            }
            self.conn.execute(
                "UPDATE leads SET fingerprint=?1, kind=?2, source=?3, title=?4, score=?5, relevance=?6, updated_at=?7, data_json=?8 WHERE lead_id=?9",
                params![fingerprint, data.kind.as_str(), data.source, data.title, data.score, data.relevance.as_str(), now, canonical_json(&new_value), id],
            )?;
            self.mark_dirty("lead", id, &["data"], None)?;
            return Ok(SaveOutcome::Updated);
        }
        if !fingerprint.is_empty() && self.exists("SELECT 1 FROM leads WHERE fingerprint=?1 LIMIT 1", [fingerprint]) {
            return Ok(SaveOutcome::Duplicate); // та же заявка или организация уже есть из другого места
        }
        let discovered = data.discovered_at.map(|d| format_date(&d)).unwrap_or_else(|| now.clone());
        self.conn.execute(
            "INSERT INTO leads(lead_id, fingerprint, kind, source, title, score, relevance, discovered_at, updated_at, data_json, imported_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![id, fingerprint, data.kind.as_str(), data.source, data.title, data.score, data.relevance.as_str(), discovered, now, canonical_json(&data.to_value()), now],
        )?;
        self.log_event(id, &format!("Найден поиском ({})", source_title(&data.source)))?;
        self.mark_dirty("lead", id, &["data"], None)?;
        Ok(SaveOutcome::Added)
    }

    /// После поиска: применить исключения к новым лидам и запомнить время.
    pub fn search_finished(&self) -> AppResult<()> {
        self.apply_exclusions()?;
        self.set_value("last_search_at", &util::now_string())
    }

    pub fn source_cursor(&self, source: &str) -> Option<String> {
        self.scalar_text("SELECT cursor_json FROM source_state WHERE source=?1", [source])
    }

    pub fn last_success(&self, source: &str) -> Option<DateTime<Utc>> {
        self.scalar_text("SELECT last_success_at FROM source_state WHERE source=?1", [source]).and_then(|s| parse_date(&s))
    }

    pub fn mark_attempt(&self, source: &str) {
        let _ = self.conn.execute(
            "INSERT INTO source_state(source, last_attempt_at) VALUES(?1,?2) ON CONFLICT(source) DO UPDATE SET last_attempt_at=excluded.last_attempt_at",
            params![source, util::now_string()],
        );
    }

    pub fn finish_source(&self, source: &str, ok: bool, partial: bool, error: Option<&str>, cursor: Option<&str>) {
        let now = util::now_string();
        let _ = if ok {
            self.conn.execute(
                "UPDATE source_state SET last_success_at=?1, consecutive_failures=0, status=?2, last_error=?3, cursor_json=COALESCE(?4, cursor_json) WHERE source=?5",
                params![now, if partial { "partial" } else { "ok" }, error, cursor, source],
            )
        } else {
            self.conn.execute(
                "UPDATE source_state SET consecutive_failures=consecutive_failures+1, status='error', last_error=?1, cursor_json=COALESCE(?2, cursor_json) WHERE source=?3",
                params![error, cursor, source],
            )
        };
    }

    pub fn log_error(&self, module: &str, message: &str) {
        let _ = self.conn.execute("INSERT INTO pipeline_errors(at, module, message) VALUES(?1,?2,?3)", params![util::now_string(), module, message]);
        let _ = self.conn.execute("DELETE FROM pipeline_errors WHERE id NOT IN (SELECT id FROM pipeline_errors ORDER BY id DESC LIMIT 500)", []);
    }

    pub fn log_run(&self, ok: bool, added: i64, updated: i64, message: &str) {
        let _ = self.add_sync_log(ok, added, updated, message);
    }

    pub fn query_last_run(&self, hash: &str) -> Option<DateTime<Utc>> {
        self.scalar_text("SELECT last_run_at FROM search_queries WHERE qhash=?1", [hash]).and_then(|s| parse_date(&s))
    }

    pub fn record_query(&self, hash: &str, source: &str, label: &str, results: i64) {
        let _ = self.conn.execute(
            "INSERT INTO search_queries(qhash, source, label, last_run_at, results) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(qhash) DO UPDATE SET last_run_at=excluded.last_run_at, results=excluded.results",
            params![hash, source, label, util::now_string(), results],
        );
    }

    pub fn forget_query(&self, hash: &str) {
        let _ = self.conn.execute("DELETE FROM search_queries WHERE qhash=?1", [hash]);
    }

    pub fn object_checked_at(&self, source: &str, object_id: &str) -> Option<DateTime<Utc>> {
        self.scalar_text("SELECT checked_at FROM seen_objects WHERE source=?1 AND object_id=?2", [source, object_id]).and_then(|s| parse_date(&s))
    }

    pub fn mark_object_checked(&self, source: &str, object_id: &str) {
        let _ = self.conn.execute(
            "INSERT INTO seen_objects(source, object_id, checked_at) VALUES(?1,?2,?3) ON CONFLICT(source, object_id) DO UPDATE SET checked_at=excluded.checked_at",
            params![source, object_id, util::now_string()],
        );
    }

    /// Сбросить память источника (курсоры, историю запросов): следующий поиск начнёт заново.
    pub fn reset_source_memory(&self, source: &str) -> AppResult<()> {
        self.conn.execute("UPDATE source_state SET cursor_json=NULL WHERE source=?1", [source])?;
        self.conn.execute("DELETE FROM search_queries WHERE source=?1", [source])?;
        self.conn.execute("DELETE FROM seen_objects WHERE source=?1", [source])?;
        Ok(())
    }

    // ------------------------------------------------------------ чтение

    pub fn all_leads(&self, include_deleted: bool) -> AppResult<Vec<LeadItem>> {
        let sql = format!(
            "SELECT lead_id, data_json, discovered_at, favorite, archived, excluded, seen, note FROM leads {} ORDER BY discovered_at DESC",
            if include_deleted { "" } else { "WHERE deleted=0" }
        );
        let mut st = self.conn.prepare(&sql)?;
        let rows = st.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, i64>(6)?,
                r.get::<_, Option<String>>(7)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (id, json, disc, fav, arch, excl, seen, note) = row?;
            let Some(data) = LeadData::parse_json(&json) else { continue };
            let discovered = disc.as_deref().and_then(parse_date).or(data.discovered_at).unwrap_or_else(Utc::now);
            out.push(LeadItem {
                id,
                data,
                discovered_at: discovered,
                favorite: fav != 0,
                archived: arch != 0,
                excluded: excl != 0,
                seen: seen != 0,
                note: note.unwrap_or_default(),
            });
        }
        Ok(out)
    }

    /// Новые лиды: не просмотрены, не в архиве и не исключены. Показываются в меню значка.
    pub fn new_lead_count(&self) -> i64 {
        self.conn.query_row("SELECT COUNT(*) FROM leads WHERE deleted=0 AND archived=0 AND excluded=0 AND seen=0", [], |r| r.get(0)).unwrap_or(0)
    }

    pub fn lead_count(&self) -> i64 {
        self.conn.query_row("SELECT COUNT(*) FROM leads WHERE deleted=0", [], |r| r.get(0)).unwrap_or(0)
    }

    pub fn source_states(&self) -> AppResult<Vec<SourceState>> {
        let mut st =
            self.conn.prepare("SELECT source, last_success_at, last_attempt_at, consecutive_failures, status, last_error FROM source_state ORDER BY source")?;
        let rows = st.query_map([], |r| {
            Ok(SourceState {
                source: r.get(0)?,
                last_success_at: r.get(1)?,
                last_attempt_at: r.get(2)?,
                consecutive_failures: r.get(3)?,
                status: r.get::<_, Option<String>>(4)?.unwrap_or_else(|| "ok".into()),
                last_error: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn pipeline_errors(&self, limit: i64) -> AppResult<Vec<PipelineError>> {
        let mut st = self.conn.prepare("SELECT id, at, module, message FROM pipeline_errors ORDER BY id DESC LIMIT ?1")?;
        let rows = st.query_map([limit], |r| Ok(PipelineError { id: r.get(0)?, at: r.get(1)?, module: r.get(2)?, message: r.get(3)? }))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn events(&self, lead_id: &str) -> AppResult<Vec<LeadEvent>> {
        let mut st = self.conn.prepare("SELECT id, at, action FROM lead_events WHERE lead_id=?1 ORDER BY id DESC LIMIT 100")?;
        let rows = st.query_map([lead_id], |r| Ok(LeadEvent { id: r.get(0)?, at: r.get(1)?, action: r.get(2)? }))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn sync_log(&self, limit: i64) -> AppResult<Vec<SyncLogEntry>> {
        let mut st = self.conn.prepare("SELECT id, at, ok, added, updated, message FROM sync_log ORDER BY id DESC LIMIT ?1")?;
        let rows = st.query_map([limit], |r| {
            Ok(SyncLogEntry { id: r.get(0)?, at: r.get(1)?, ok: r.get::<_, i64>(2)? != 0, added: r.get(3)?, updated: r.get(4)?, message: r.get(5)? })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn exclusions(&self) -> AppResult<Vec<Exclusion>> {
        let mut st = self.conn.prepare("SELECT id, kind, value, created_at FROM exclusions ORDER BY id DESC")?;
        let rows = st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, Option<String>>(3)?)))?;
        let mut out = Vec::new();
        for row in rows {
            let (id, kind, value, created_at) = row?;
            if let Some(kind) = ExclusionKind::parse(&kind) {
                out.push(Exclusion { id, kind, value, created_at });
            }
        }
        Ok(out)
    }

    pub fn value(&self, key: &str) -> Option<String> {
        self.scalar_text("SELECT value FROM kv WHERE key=?1", [key])
    }

    pub fn set_value(&self, key: &str, value: &str) -> AppResult<()> {
        self.conn.execute("INSERT INTO kv(key, value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, value])?;
        Ok(())
    }

    pub fn delete_value(&self, key: &str) -> AppResult<()> {
        self.conn.execute("DELETE FROM kv WHERE key=?1", [key])?;
        Ok(())
    }

    // ------------------------------------------------------------ действия пользователя

    fn update_many(&self, ids: &[String], sql: &str, flag: Option<i64>, event: Option<&str>, field: &str) -> AppResult<()> {
        if ids.is_empty() {
            return Ok(());
        }
        self.transaction(|| {
            for id in ids {
                let changed = match flag {
                    Some(f) => self.conn.execute(sql, params![f, id])?,
                    None => self.conn.execute(sql, params![id])?,
                };
                if changed > 0 {
                    self.mark_dirty("lead", id, &[field], None)?;
                }
                if let Some(e) = event {
                    self.log_event(id, e)?;
                }
            }
            Ok(())
        })
    }

    pub fn set_favorite(&self, ids: &[String], on: bool) -> AppResult<()> {
        self.update_many(
            ids,
            "UPDATE leads SET favorite=?1 WHERE lead_id=?2",
            Some(b(on)),
            Some(if on { "Добавлен в избранное" } else { "Убран из избранного" }),
            "favorite",
        )
    }

    pub fn set_archived(&self, ids: &[String], on: bool) -> AppResult<()> {
        self.update_many(
            ids,
            "UPDATE leads SET archived=?1 WHERE lead_id=?2",
            Some(b(on)),
            Some(if on { "Перенесён в архив" } else { "Возвращён из архива" }),
            "archived",
        )
    }

    /// Удалённые лиды остаются в базе скрытыми, чтобы следующий поиск не вернул их.
    pub fn delete(&self, ids: &[String]) -> AppResult<()> {
        self.update_many(ids, "UPDATE leads SET deleted=1 WHERE lead_id=?1", None, Some("Удалён"), "deleted")
    }

    pub fn mark_seen(&self, ids: &[String]) -> AppResult<()> {
        self.update_many(ids, "UPDATE leads SET seen=1 WHERE lead_id=?1 AND seen=0", None, None, "seen")
    }

    pub fn mark_all_seen(&self) -> AppResult<()> {
        let ids: Vec<String> = {
            let mut st = self.conn.prepare("SELECT lead_id FROM leads WHERE seen=0")?;
            let rows = st.query_map([], |r| r.get(0))?;
            rows.collect::<Result<_, _>>()?
        };
        self.mark_seen(&ids)
    }

    /// Отметка о переносе лида в CRM: поле `data.crm` (синхронизируется вместе с данными лида).
    pub fn set_crm_mark(&self, id: &str, mark: &Value) -> AppResult<()> {
        let old: String = self
            .conn
            .query_row("SELECT data_json FROM leads WHERE lead_id=?1", [id], |r| r.get(0))
            .optional()?
            .ok_or_else(|| AppError::msg("Лид не найден."))?;
        let mut v: Value = serde_json::from_str(&old)?;
        if let Some(obj) = v.as_object_mut() {
            obj.insert("crm".into(), mark.clone());
        }
        self.conn.execute("UPDATE leads SET data_json=?1, updated_at=?2 WHERE lead_id=?3", params![canonical_json(&v), util::now_string(), id])?;
        self.mark_dirty("lead", id, &["data"], None)
    }

    pub fn set_note(&self, id: &str, note: &str) -> AppResult<()> {
        self.transaction(|| {
            if self.conn.execute("UPDATE leads SET note=?1 WHERE lead_id=?2 AND note<>?1", params![note, id])? > 0 {
                self.mark_dirty("lead", id, &["note"], None)?;
            }
            Ok(())
        })
    }

    pub fn log_event(&self, id: &str, action: &str) -> AppResult<()> {
        self.conn.execute("INSERT INTO lead_events(lead_id, at, action) VALUES(?1,?2,?3)", params![id, util::now_string(), action])?;
        Ok(())
    }

    pub fn add_sync_log(&self, ok: bool, added: i64, updated: i64, message: &str) -> AppResult<()> {
        self.conn.execute(
            "INSERT INTO sync_log(at, ok, added, updated, message) VALUES(?1,?2,?3,?4,?5)",
            params![util::now_string(), b(ok), added, updated, message],
        )?;
        Ok(())
    }

    // ------------------------------------------------------------ исключения

    pub fn add_exclusion(&self, kind: ExclusionKind, raw: &str) -> AppResult<()> {
        let value = normalize::value(raw, kind);
        if value.is_empty() {
            return Ok(());
        }
        let added = self
            .conn
            .execute("INSERT OR IGNORE INTO exclusions(kind, value, created_at) VALUES(?1,?2,?3)", params![kind.as_str(), value, util::now_string()])?;
        if added > 0 {
            self.mark_dirty("exclusion", &format!("{}|{}", kind.as_str(), value), &["deleted"], None)?;
        }
        self.apply_exclusions()
    }

    pub fn remove_exclusion(&self, id: i64) -> AppResult<()> {
        let row: Option<(String, String)> =
            self.conn.query_row("SELECT kind, value FROM exclusions WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
        if let Some((k, v)) = row {
            self.mark_dirty("exclusion", &format!("{k}|{v}"), &["deleted"], None)?;
        }
        self.conn.execute("DELETE FROM exclusions WHERE id=?1", [id])?;
        self.apply_exclusions()
    }

    /// Пересчитывает флаг «исключён» у всех лидов.
    pub fn apply_exclusions(&self) -> AppResult<()> {
        let mut by_kind: HashMap<ExclusionKind, BTreeSet<String>> = HashMap::new();
        for r in self.exclusions()? {
            by_kind.entry(r.kind).or_default().insert(r.value);
        }
        let leads = self.all_leads(true)?;
        self.transaction(|| {
            for lead in leads {
                let hit = Self::matches(&lead.data, &by_kind);
                if hit != lead.excluded {
                    self.conn.execute("UPDATE leads SET excluded=?1 WHERE lead_id=?2", params![b(hit), lead.id])?;
                }
            }
            Ok(())
        })
    }

    pub fn matches(d: &LeadData, rules: &HashMap<ExclusionKind, BTreeSet<String>>) -> bool {
        if let Some(set) = rules.get(&ExclusionKind::Domain) {
            let mut domains: Vec<String> = Vec::new();
            if let Some(dm) = d.domain() {
                domains.push(dm);
            }
            for e in d.emails() {
                if let Some(at) = e.split('@').next_back() {
                    domains.push(normalize::domain(at));
                }
            }
            if domains.iter().any(|dom| set.iter().any(|r| dom == r || dom.ends_with(&format!(".{r}")))) {
                return true;
            }
        }
        if let Some(set) = rules.get(&ExclusionKind::Phone) {
            if d.phones().iter().any(|p| set.contains(&normalize::phone(p))) {
                return true;
            }
        }
        if let Some(set) = rules.get(&ExclusionKind::Email) {
            if d.emails().iter().any(|e| set.contains(&normalize::email(e))) {
                return true;
            }
        }
        if let Some(set) = rules.get(&ExclusionKind::Name) {
            let customer = d.customer_name.clone().unwrap_or_default();
            if [d.title.as_str(), customer.as_str()].iter().map(|n| normalize::name(n)).filter(|n| !n.is_empty()).any(|n| set.contains(&n)) {
                return true;
            }
        }
        false
    }

    /// Импорт базы существующих клиентов: каждая ячейка с доменом, телефоном или email становится исключением.
    pub fn import_exclusions(&self, csv_text: &str) -> AppResult<usize> {
        let mut count = 0;
        for line in csv_text.lines() {
            for cell in crate::csvfmt::parse_line(line) {
                let v = cell.trim();
                if v.is_empty() {
                    continue;
                }
                if let Some(kind) = ExclusionKind::detect(v) {
                    let norm = normalize::value(v, kind);
                    let added = self.conn.execute(
                        "INSERT OR IGNORE INTO exclusions(kind, value, created_at) VALUES(?1,?2,?3)",
                        params![kind.as_str(), norm, util::now_string()],
                    )?;
                    if added > 0 {
                        self.mark_dirty("exclusion", &format!("{}|{}", kind.as_str(), norm), &["deleted"], None)?;
                    }
                    count += added;
                }
            }
        }
        self.apply_exclusions()?;
        Ok(count)
    }

    // ------------------------------------------------------------ резервные копии

    /// Консистентная копия базы через VACUUM INTO. Копия зашифрованной базы шифруется тем же ключом.
    pub fn backup(&self, to: &Path) -> AppResult<()> {
        let _ = fs::remove_file(to);
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent)?;
        }
        self.conn.execute("VACUUM INTO ?1", [to.to_string_lossy().as_ref()])?;
        if self.key.is_some() && db::file_state(to) != FileState::Encrypted {
            let _ = fs::remove_file(to);
            return Err(AppError::msg("резервная копия получилась незашифрованной и удалена"));
        }
        Ok(())
    }

    /// Заменяет базу копией. Текущая база перед этим сохраняется рядом (before-restore.db).
    pub fn restore(&mut self, from: &Path) -> AppResult<()> {
        // Копии прежних версий не зашифрованы, новые — зашифрованы ключом этого устройства.
        let probe_key = if db::file_state(from) == FileState::Encrypted { self.key.as_ref() } else { None };
        let valid = {
            let probe = db::open_connection(from, true, probe_key)?;
            probe.query_row("SELECT 1 FROM sqlite_master WHERE type='table' AND name='leads'", [], |_| Ok(())).optional()?.is_some()
        };
        if !valid {
            return Err(AppError::msg("это не резервная копия Customers"));
        }
        let current = self.path.clone();
        let same = fs::canonicalize(from).ok() == fs::canonicalize(&current).ok();
        if same {
            return Err(AppError::msg("это текущая база, восстанавливать из неё нечего"));
        }
        let dir = current.parent().map(Path::to_path_buf).unwrap_or_default();
        // Сначала копируем выбранный файл рядом, и только потом убираем текущую базу.
        let staged = dir.join(format!("restore-{}.db", uuid::Uuid::new_v4()));
        fs::copy(from, &staged)?;
        let safety = dir.join("before-restore.db");
        if let Err(e) = self.backup(&safety) {
            let _ = fs::remove_file(&staged);
            return Err(e);
        }
        // Закрываем текущее соединение, подменяя его временным в памяти.
        let old = std::mem::replace(&mut self.conn, Connection::open_in_memory()?);
        drop(old);
        db::remove_database_files(&current);
        if let Err(e) = fs::rename(&staged, &current) {
            let _ = fs::copy(&safety, &current);
            self.conn = Self::open_file(&current, self.key.as_ref())?;
            return Err(e.into());
        }
        // Незашифрованная копия прежней версии здесь же переписывается в зашифрованную.
        self.conn = Self::open_file(&current, self.key.as_ref())?;
        self.prepare_schema()?;
        // Восстановленная копия — осознанный выбор пользователя: её состояние уходит в облако как
        // новое изменение, а всё, что появилось в облаке позже, загрузится заново.
        if self.sync_tracking {
            self.set_value("sync.enabled", "1")?;
            self.mark_everything_dirty(Utc::now())?;
            self.reset_sync_cursors()?;
        }
        Ok(())
    }

    /// Переносит базу в другую папку.
    pub fn move_to(&mut self, dir: &Path) -> AppResult<PathBuf> {
        let target = dir.join("leads.db");
        if target == self.path {
            return Ok(self.path.clone());
        }
        self.backup(&target)?;
        let old = self.path.clone();
        let tmp = std::mem::replace(&mut self.conn, Connection::open_in_memory()?);
        drop(tmp);
        db::remove_database_files(&old);
        self.conn = Self::open_file(&target, self.key.as_ref())?;
        let _: String = self.conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))?;
        self.path = target.clone();
        Ok(target)
    }

    /// Закрыть базу (освободить файл).
    pub fn close(self) {
        drop(self.conn);
    }

    // ------------------------------------------------------------ журнал синхронизации

    pub fn stamp(d: DateTime<Utc>) -> String {
        format_precise(&d)
    }

    pub(crate) fn mark_dirty(&self, entity: &str, key: &str, fields: &[&str], at: Option<&str>) -> AppResult<()> {
        if !self.sync_tracking {
            return Ok(());
        }
        let stamp = at.map(str::to_string).unwrap_or_else(|| Self::stamp(Utc::now()));
        for f in fields {
            self.conn.execute(
                "INSERT INTO sync_dirty(entity, key, field, changed_at) VALUES(?1,?2,?3,?4) ON CONFLICT(entity, key, field) DO UPDATE SET changed_at=excluded.changed_at",
                params![entity, key, f, stamp],
            )?;
        }
        Ok(())
    }

    /// Отметить все данные как изменённые — для первой выгрузки (перенос локальной базы в облако).
    pub fn mark_everything_dirty(&self, at: DateTime<Utc>) -> AppResult<()> {
        let ts = Self::stamp(at);
        self.transaction(|| {
            let ids: Vec<String> = {
                let mut st = self.conn.prepare("SELECT lead_id FROM leads")?;
                let rows = st.query_map([], |r| r.get(0))?;
                rows.collect::<Result<_, _>>()?
            };
            for id in ids {
                self.mark_dirty("lead", &id, &LEAD_FIELDS, Some(&ts))?;
            }
            for e in self.exclusions()? {
                self.mark_dirty("exclusion", &format!("{}|{}", e.kind.as_str(), e.value), &["deleted"], Some(&ts))?;
            }
            for k in SYNCED_KEYS {
                if self.value(k).is_some() {
                    self.mark_dirty("setting", k, &["value"], Some(&ts))?;
                }
            }
            Ok(())
        })
    }

    /// Есть ли в журнале неотправленная правка этой записи.
    pub fn has_pending(&self, entity: &str, key: &str) -> bool {
        self.exists("SELECT 1 FROM sync_dirty WHERE entity=?1 AND key=?2", [entity, key])
    }

    pub fn pending_sync_count(&self) -> i64 {
        self.conn.query_row("SELECT COUNT(DISTINCT entity || key) FROM sync_dirty", [], |r| r.get(0)).unwrap_or(0)
    }

    pub fn pending_changes(&self, limit: i64) -> AppResult<PendingChanges> {
        let mut out = PendingChanges::default();
        let mut grouped: HashMap<String, HashMap<String, BTreeMap<String, String>>> = HashMap::new();
        {
            let mut st = self.conn.prepare(
                "SELECT entity, key, field, changed_at FROM sync_dirty WHERE (entity, key) IN \
                 (SELECT entity, key FROM sync_dirty GROUP BY entity, key ORDER BY MIN(changed_at) LIMIT ?1)",
            )?;
            let rows = st.query_map([limit], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)))?;
            for r in rows {
                let (e, k, f, at) = r?;
                grouped.entry(e).or_default().entry(k).or_default().insert(f, at);
            }
        }
        if let Some(leads) = grouped.get("lead") {
            for (id, ts) in leads {
                let row = self
                    .conn
                    .query_row(
                        "SELECT lead_id, fingerprint, kind, source, title, score, relevance, discovered_at, data_json, favorite, archived, deleted, seen, note FROM leads WHERE lead_id=?1",
                        [id],
                        |r| {
                            Ok((
                                r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?,
                                r.get::<_, f64>(5)?, r.get::<_, String>(6)?, r.get::<_, Option<String>>(7)?, r.get::<_, String>(8)?,
                                r.get::<_, i64>(9)?, r.get::<_, i64>(10)?, r.get::<_, i64>(11)?, r.get::<_, i64>(12)?, r.get::<_, Option<String>>(13)?,
                            ))
                        },
                    )
                    .optional()?;
                let parsed = row.as_ref().and_then(|r| serde_json::from_str::<Value>(&r.7).ok());
                let (Some(r), Some(data)) = (row, parsed) else {
                    // Лида больше нет локально — изменение отправлять некуда.
                    self.conn.execute("DELETE FROM sync_dirty WHERE entity='lead' AND key=?1", [id])?;
                    continue;
                };
                out.leads.push(LeadChange {
                    lead_id: id.clone(),
                    fingerprint: r.0,
                    kind: r.1,
                    source: r.2,
                    title: r.3,
                    score: r.4,
                    relevance: r.5,
                    discovered_at: r.6.as_deref().and_then(parse_date).map(|d| format_date(&d)).unwrap_or_else(util::now_string),
                    data,
                    favorite: r.8 != 0,
                    archived: r.9 != 0,
                    deleted: r.10 != 0,
                    seen: r.11 != 0,
                    note: r.12.unwrap_or_default(),
                    ts: ts.clone(),
                });
            }
        }
        if let Some(ex) = grouped.get("exclusion") {
            for (key, ts) in ex {
                let Some((kind, value)) = key.split_once('|') else { continue };
                let Some(at) = ts.get("deleted") else { continue };
                let exists = self.exists("SELECT 1 FROM exclusions WHERE kind=?1 AND value=?2", [kind, value]);
                out.exclusions.push(ExclusionChange { kind: kind.into(), value: value.into(), deleted: !exists, changed_at: at.clone() });
            }
        }
        if let Some(st) = grouped.get("setting") {
            for (key, ts) in st {
                let Some(at) = ts.get("value") else { continue };
                let v = self.value(key).and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or(Value::Null);
                out.settings.push(SettingChange { key: key.clone(), value: v, changed_at: at.clone() });
            }
        }
        out.leads.sort_by(|a, b| a.lead_id.cmp(&b.lead_id));
        Ok(out)
    }

    /// Убрать из журнала отправленные изменения (только если поле не менялось снова).
    pub fn mark_pushed(&self, c: &PendingChanges) -> AppResult<()> {
        self.transaction(|| {
            let clear = |entity: &str, key: &str, field: &str, at: &str| -> AppResult<()> {
                self.conn.execute("DELETE FROM sync_dirty WHERE entity=?1 AND key=?2 AND field=?3 AND changed_at=?4", params![entity, key, field, at])?;
                Ok(())
            };
            for l in &c.leads {
                for (f, at) in &l.ts {
                    clear("lead", &l.lead_id, f, at)?;
                }
            }
            for e in &c.exclusions {
                clear("exclusion", &format!("{}|{}", e.kind, e.value), "deleted", &e.changed_at)?;
            }
            for s in &c.settings {
                clear("setting", &s.key, "value", &s.changed_at)?;
            }
            Ok(())
        })
    }

    fn dirty_at(&self, entity: &str, key: &str) -> AppResult<HashMap<String, DateTime<Utc>>> {
        let mut st = self.conn.prepare("SELECT field, changed_at FROM sync_dirty WHERE entity=?1 AND key=?2")?;
        let rows = st.query_map([entity, key], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut out = HashMap::new();
        for r in rows {
            let (f, at) = r?;
            if let Some(d) = parse_date(&at) {
                out.insert(f, d);
            }
        }
        Ok(out)
    }

    /// Применяет изменения с сервера. Поле, изменённое здесь позже серверного, не трогается: оно уйдёт
    /// на сервер при следующей выгрузке. Применённые изменения в журнал не пишутся, поэтому эхо-цикла
    /// «загрузил → выгрузил» не возникает.
    pub fn apply_remote(&self, leads: &[RemoteLead], exclusions: &[RemoteExclusion], settings: &[RemoteSetting]) -> AppResult<()> {
        self.transaction(|| {
            for r in leads {
                let local = self.dirty_at("lead", &r.lead_id)?;
                let remote_wins = |f: &str| -> bool {
                    match local.get(f) {
                        None => true,
                        Some(mine) => {
                            let theirs = r.field_ts.get(f).and_then(|s| parse_date(s)).unwrap_or(DateTime::<Utc>::MIN_UTC);
                            theirs > *mine
                        }
                    }
                };
                // Данные лида храним в том же стабильном виде, что и поиск.
                let json = canonical_json(&LeadData::from_value(&r.data).to_value());
                let discovered = parse_date(&r.discovered_at).map(|d| format_date(&d)).unwrap_or_else(util::now_string);
                let exists = self.exists("SELECT 1 FROM leads WHERE lead_id=?1", [&r.lead_id]);
                if !exists {
                    let now = util::now_string();
                    self.conn.execute(
                        "INSERT INTO leads(lead_id, fingerprint, kind, source, title, score, relevance, discovered_at, updated_at, data_json, imported_at, favorite, archived, deleted, seen, note) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
                        params![r.lead_id, r.fingerprint, r.kind, r.source, r.title, r.score, r.relevance, discovered, now, json, now, b(r.favorite), b(r.archived), b(r.deleted), b(r.seen), r.note],
                    )?;
                    continue;
                }
                if remote_wins("data") {
                    self.conn.execute(
                        "UPDATE leads SET fingerprint=?1, kind=?2, source=?3, title=?4, score=?5, relevance=?6, data_json=?7, discovered_at=MIN(discovered_at, ?8) WHERE lead_id=?9",
                        params![r.fingerprint, r.kind, r.source, r.title, r.score, r.relevance, json, discovered, r.lead_id],
                    )?;
                }
                for (f, v) in [("favorite", b(r.favorite)), ("archived", b(r.archived)), ("deleted", b(r.deleted)), ("seen", b(r.seen))] {
                    if remote_wins(f) {
                        self.conn.execute(&format!("UPDATE leads SET {f}=?1 WHERE lead_id=?2"), params![v, r.lead_id])?;
                    }
                }
                if remote_wins("note") {
                    self.conn.execute("UPDATE leads SET note=?1 WHERE lead_id=?2", params![r.note, r.lead_id])?;
                }
            }
            for e in exclusions {
                let key = format!("{}|{}", e.kind, e.value);
                if let Some(mine) = self.dirty_at("exclusion", &key)?.get("deleted") {
                    if *mine >= parse_date(&e.changed_at).unwrap_or(DateTime::<Utc>::MIN_UTC) {
                        continue;
                    }
                }
                if e.deleted {
                    self.conn.execute("DELETE FROM exclusions WHERE kind=?1 AND value=?2", [&e.kind, &e.value])?;
                } else if ExclusionKind::parse(&e.kind).is_some() {
                    self.conn.execute("INSERT OR IGNORE INTO exclusions(kind, value, created_at) VALUES(?1,?2,?3)", params![e.kind, e.value, util::now_string()])?;
                }
            }
            for s in settings.iter().filter(|s| SYNCED_KEYS.contains(&s.key.as_str())) {
                if let Some(mine) = self.dirty_at("setting", &s.key)?.get("value") {
                    if *mine >= parse_date(&s.changed_at).unwrap_or(DateTime::<Utc>::MIN_UTC) {
                        continue;
                    }
                }
                self.set_value(&s.key, &canonical_json(&s.value))?;
            }
            Ok(())
        })?;
        if !exclusions.is_empty() || !leads.is_empty() {
            self.apply_exclusions()?;
        }
        Ok(())
    }

    pub fn sync_cursor(&self, table: &str) -> i64 {
        self.value(&format!("sync.cursor.{table}")).and_then(|s| s.parse().ok()).unwrap_or(0)
    }

    pub fn set_sync_cursor(&self, table: &str, value: i64) -> AppResult<()> {
        self.set_value(&format!("sync.cursor.{table}"), &value.to_string())
    }

    /// Начать синхронизацию заново (например, после восстановления из резервной копии).
    pub fn reset_sync_cursors(&self) -> AppResult<()> {
        self.conn.execute("DELETE FROM kv WHERE key LIKE 'sync.cursor.%'", [])?;
        Ok(())
    }

    /// Копирует в эту базу лиды, исключения и синхронизируемые настройки из другой базы и отмечает их
    /// для выгрузки. Источник только читается. Лиды, которые уже есть здесь (тот же id или тот же
    /// отпечаток), не дублируются. Возвращает число добавленных лидов.
    pub fn import_from(&self, src: &LeadStore) -> AppResult<usize> {
        let ts = Self::stamp(import_stamp());
        let mut added = 0;
        let cols = [
            "lead_id",
            "fingerprint",
            "kind",
            "source",
            "title",
            "score",
            "relevance",
            "discovered_at",
            "updated_at",
            "data_json",
            "imported_at",
            "favorite",
            "archived",
            "deleted",
            "excluded",
            "seen",
            "note",
        ];
        let select = format!("SELECT {} FROM leads", cols.join(", "));
        let exclusions = src.exclusions()?;
        self.transaction(|| {
            let mut st = src.conn.prepare(&select)?;
            let mut rows = st.query([])?;
            while let Some(r) = rows.next()? {
                let id: String = r.get(0)?;
                let fp: String = r.get::<_, Option<String>>(1)?.unwrap_or_default();
                if self.exists("SELECT 1 FROM leads WHERE lead_id=?1 OR (?2<>'' AND fingerprint=?2)", params![id, fp]) {
                    continue;
                }
                let values: Vec<rusqlite::types::Value> = (0..cols.len()).map(|i| r.get::<_, rusqlite::types::Value>(i)).collect::<Result<_, _>>()?;
                let placeholders = vec!["?"; cols.len()].join(",");
                self.conn.execute(&format!("INSERT INTO leads({}) VALUES({placeholders})", cols.join(",")), rusqlite::params_from_iter(values))?;
                self.mark_dirty("lead", &id, &LEAD_FIELDS, Some(&ts))?;
                added += 1;
            }
            for e in &exclusions {
                self.conn.execute(
                    "INSERT OR IGNORE INTO exclusions(kind, value, created_at) VALUES(?1,?2,?3)",
                    params![e.kind.as_str(), e.value, util::now_string()],
                )?;
                self.mark_dirty("exclusion", &format!("{}|{}", e.kind.as_str(), e.value), &["deleted"], Some(&ts))?;
            }
            for k in SYNCED_KEYS {
                if self.value(k).is_none() {
                    if let Some(v) = src.value(k) {
                        self.conn.execute("INSERT INTO kv(key, value) VALUES(?1,?2)", params![k, v])?;
                        self.mark_dirty("setting", k, &["value"], Some(&ts))?;
                    }
                }
            }
            Ok(())
        })?;
        self.apply_exclusions()?;
        Ok(added)
    }

    /// Записать синхронизируемую настройку (JSON-текст) и отметить её для выгрузки.
    pub fn set_synced_value(&self, key: &str, json: &str) -> AppResult<()> {
        self.transaction(|| {
            self.set_value(key, json)?;
            if SYNCED_KEYS.contains(&key) {
                self.mark_dirty("setting", key, &["value"], None)?;
            }
            Ok(())
        })
    }
}

impl crate::search::sources::SearchMemory for std::sync::Mutex<LeadStore> {
    fn query_last_run(&self, hash: &str) -> Option<DateTime<Utc>> {
        self.lock().unwrap().query_last_run(hash)
    }
    fn record_query(&self, hash: &str, source: &str, label: &str, results: i64) {
        self.lock().unwrap().record_query(hash, source, label, results)
    }
    fn forget_query(&self, hash: &str) {
        self.lock().unwrap().forget_query(hash)
    }
    fn object_checked_at(&self, source: &str, object_id: &str) -> Option<DateTime<Utc>> {
        self.lock().unwrap().object_checked_at(source, object_id)
    }
    fn mark_object_checked(&self, source: &str, object_id: &str) {
        self.lock().unwrap().mark_object_checked(source, object_id)
    }
}
