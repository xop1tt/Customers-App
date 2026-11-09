//! Данные открытой учётной записи: снимок для интерфейса, действия над лидами, исключения,
//! резервные копии, восстановление, перенос базы, экспорт в файл, настройки учётной записи.

use super::session::{Core, Session};
use super::{CmdError, CmdResult};
use crate::export::{self, ExportField, ExportFormat};
use crate::models::{lead_to_ui, ExclusionKind};
use crate::util::{format_date, parse_date};
use chrono::{Duration, Local, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Всё, что показывает интерфейс: списки, источники, ошибки, исключения, журнал синхронизации.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub leads: Vec<Value>,
    pub sources: Value,
    pub pipeline_errors: Value,
    pub exclusions: Value,
    pub sync_log: Value,
    pub last_search_at: Option<String>,
    pub database_size: u64,
}

impl Core {
    pub fn snapshot(&self) -> CmdResult<Snapshot> {
        let s = self.require()?;
        s.with_store(|st| -> CmdResult<Snapshot> {
            Ok(Snapshot {
                leads: st.all_leads(false)?.iter().map(lead_to_ui).collect(),
                sources: serde_json::to_value(st.source_states()?).unwrap_or(Value::Null),
                pipeline_errors: serde_json::to_value(st.pipeline_errors(50)?).unwrap_or(Value::Null),
                exclusions: serde_json::to_value(st.exclusions()?).unwrap_or(Value::Null),
                sync_log: serde_json::to_value(st.sync_log(50)?).unwrap_or(Value::Null),
                last_search_at: st.value("last_search_at"),
                database_size: st.file_size(),
            })
        })
    }

    pub fn events(&self, lead_id: &str) -> CmdResult<Value> {
        let s = self.require()?;
        Ok(serde_json::to_value(s.with_store(|st| st.events(lead_id))?).unwrap_or(Value::Null))
    }

    /// Выполнить действие над данными: перечитать список и отправить изменения в облако.
    fn act(self: &Arc<Self>, f: impl FnOnce(&crate::store::LeadStore) -> crate::error::AppResult<()>) -> CmdResult<()> {
        let s = self.require()?;
        s.with_store(f).map_err(|e| {
            self.env.log_error(&e.to_string());
            CmdError::from(e)
        })?;
        self.env.emit("data-changed", Value::Null);
        self.sync_soon(&s);
        Ok(())
    }

    pub fn set_favorite(self: &Arc<Self>, ids: &[String], on: bool) -> CmdResult<()> {
        self.act(|s| s.set_favorite(ids, on))
    }
    pub fn set_archived(self: &Arc<Self>, ids: &[String], on: bool) -> CmdResult<()> {
        self.act(|s| s.set_archived(ids, on))
    }
    pub fn delete_leads(self: &Arc<Self>, ids: &[String]) -> CmdResult<()> {
        self.act(|s| s.delete(ids))
    }
    pub fn mark_seen(self: &Arc<Self>, ids: &[String]) -> CmdResult<()> {
        self.act(|s| s.mark_seen(ids))
    }
    pub fn mark_all_seen(self: &Arc<Self>) -> CmdResult<()> {
        self.act(|s| s.mark_all_seen())
    }
    pub fn set_note(self: &Arc<Self>, id: &str, note: &str) -> CmdResult<()> {
        self.act(|s| s.set_note(id, note))
    }
    /// Запись в «Историю» лида: например, «Письмо отправлено на …» или «Звонок …».
    pub fn log_event(self: &Arc<Self>, id: &str, action: &str) -> CmdResult<()> {
        self.act(|s| s.log_event(id, action))
    }

    /// Формат (домен, телефон, email, иначе название) определяется по самому значению.
    pub fn exclude(self: &Arc<Self>, value: &str, kind: Option<&str>) -> CmdResult<String> {
        let kind = kind.and_then(ExclusionKind::parse).or_else(|| ExclusionKind::detect(value)).unwrap_or(ExclusionKind::Name);
        self.act(|s| s.add_exclusion(kind, value))?;
        Ok(format!("Добавлено исключение: {} {}", kind.title().to_lowercase(), value))
    }
    pub fn remove_exclusion(self: &Arc<Self>, id: i64) -> CmdResult<()> {
        self.act(|s| s.remove_exclusion(id))
    }

    pub fn import_exclusions(self: &Arc<Self>, path: &Path) -> CmdResult<String> {
        let text = std::fs::read_to_string(path).map_err(|e| CmdError::msg(format!("Не удалось прочитать файл: {e}")))?;
        let s = self.require()?;
        let n = s.with_store(|st| st.import_exclusions(&text))?;
        self.env.emit("data-changed", Value::Null);
        self.sync_soon(&s);
        Ok(format!("Из файла добавлено исключений: {n}"))
    }

    // ------------------------------------------------------------------ экспорт в файл

    pub fn export_to_file(&self, ids: &[String], format: &str, fields: &[String], path: &Path) -> CmdResult<String> {
        let s = self.require()?;
        let wanted: std::collections::HashSet<&String> = ids.iter().collect();
        let items: Vec<_> = s.with_store(|st| st.all_leads(false))?.into_iter().filter(|l| wanted.contains(&l.id)).collect();
        let fields: Vec<ExportField> = fields.iter().filter_map(|k| ExportField::from_key(k)).collect();
        if fields.is_empty() {
            return Err(CmdError::msg("Выберите хотя бы одно поле."));
        }
        let format = if format == "json" { ExportFormat::Json } else { ExportFormat::Csv };
        let bytes = export::export(&items, format, &fields).map_err(|e| CmdError::msg(format!("Экспорт не удался: {e}")))?;
        std::fs::write(path, bytes).map_err(|e| CmdError::msg(format!("Экспорт не удался: {e}")))?;
        Ok(format!("Экспортировано лидов: {}", items.len()))
    }

    // ------------------------------------------------------------------ резервные копии

    pub fn backup_directory(&self, s: &Session) -> PathBuf {
        let p = s.account_prefs();
        if !p.backup_directory.trim().is_empty() {
            return PathBuf::from(p.backup_directory);
        }
        // Папка копий прежней macOS-версии, если в ней уже есть копии, продолжает использоваться.
        let legacy = self.env.paths.legacy_backups(&s.id);
        if legacy.exists() {
            legacy
        } else {
            self.env.paths.default_backups(&s.id)
        }
    }

    pub fn list_backups(&self) -> CmdResult<Vec<Value>> {
        let s = self.require()?;
        Ok(self
            .backups_in(&self.backup_directory(&s))
            .into_iter()
            .map(|(path, name, size, at)| json!({"path": path.display().to_string(), "name": name, "size": size, "modifiedAt": at}))
            .collect())
    }

    fn backups_in(&self, dir: &Path) -> Vec<(PathBuf, String, u64, Option<String>)> {
        let mut files: Vec<_> = std::fs::read_dir(dir)
            .map(|rd| {
                rd.flatten()
                    .filter_map(|e| {
                        let name = e.file_name().to_string_lossy().into_owned();
                        (name.starts_with("leadgen-") && name.ends_with(".db")).then(|| {
                            let meta = e.metadata().ok();
                            let at = meta.as_ref().and_then(|m| m.modified().ok()).map(|t| format_date(&chrono::DateTime::<Utc>::from(t)));
                            (e.path(), name, meta.map(|m| m.len()).unwrap_or(0), at)
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        files.sort_by(|a, b| b.1.cmp(&a.1));
        files
    }

    /// Создаёт копию базы и удаляет самые старые сверх лимита. Возвращает путь к копии.
    pub fn backup_now(&self, s: &Session) -> CmdResult<PathBuf> {
        let dir = self.backup_directory(s);
        let prefs = s.account_prefs();
        let path = dir.join(format!("leadgen-{}.db", Local::now().format("%Y-%m-%d_%H-%M-%S")));
        std::fs::create_dir_all(&dir).map_err(|e| CmdError::msg(format!("Резервная копия не создана: {e}")))?;
        s.with_store(|st| st.backup(&path)).map_err(|e| {
            self.env.log_error(&format!("Резервная копия: {e}"));
            CmdError::msg(format!("Резервная копия не создана: {e}"))
        })?;
        for old in self.backups_in(&dir).into_iter().skip(prefs.keep_backups.max(1) as usize) {
            let _ = std::fs::remove_file(old.0);
        }
        let _ = s.with_store(|st| st.set_value("last_backup_at", &crate::util::now_string()));
        Ok(path)
    }

    pub fn backup_now_command(&self) -> CmdResult<String> {
        let s = self.require()?;
        let path = self.backup_now(&s)?;
        Ok(path.display().to_string())
    }

    /// Раз в сутки (и после поиска), если копии включены.
    pub(crate) fn daily_backup_if_needed(&self, s: &Session) {
        if !s.account_prefs().auto_backup {
            return;
        }
        let last = s.with_store(|st| st.value("last_backup_at")).as_deref().and_then(parse_date);
        if last.map(|l| Utc::now() - l > Duration::hours(20)).unwrap_or(true) {
            let _ = self.backup_now(s);
        }
    }

    pub fn restore(self: &Arc<Self>, path: &Path) -> CmdResult<String> {
        let s = self.require()?;
        if s.search.lock().unwrap().running {
            return Err(CmdError::msg("Дождитесь окончания поиска или остановите его, затем восстановите базу."));
        }
        {
            let mut store = s.store.lock().unwrap();
            store.restore(path).map_err(|e| CmdError::msg(format!("Восстановление не удалось: {e}")))?;
        }
        self.reload_synced_settings(&s);
        self.env.emit("data-changed", Value::Null);
        self.sync_soon(&s);
        Ok("База восстановлена из копии. Предыдущая версия сохранена как before-restore.db".into())
    }

    pub fn move_database(self: &Arc<Self>, dir: &Path) -> CmdResult<String> {
        let s = self.require()?;
        if s.search.lock().unwrap().running {
            return Err(CmdError::msg("Дождитесь окончания поиска или остановите его, затем перенесите базу."));
        }
        let path = {
            let mut store = s.store.lock().unwrap();
            store.move_to(dir).map_err(|e| CmdError::msg(format!("Перенос не удался: {e}")))?
        };
        s.prefs.lock().unwrap().patch(&json!({"dataPath": path.display().to_string()}));
        self.env.emit("account-prefs", s.prefs.lock().unwrap().to_json());
        self.env.emit("session-changed", serde_json::to_value(self.info()).unwrap_or(Value::Null));
        Ok(format!("База перенесена: {}", path.display()))
    }

    // ------------------------------------------------------------------ настройки учётной записи

    pub fn account_prefs(&self) -> CmdResult<Value> {
        Ok(self.require()?.prefs.lock().unwrap().to_json())
    }

    /// Изменить настройки учётной записи. Автопоиск хранится в базе (синхронизируется) и перезапускает таймер.
    pub fn patch_account_prefs(self: &Arc<Self>, changes: &Value) -> CmdResult<Value> {
        let s = self.require()?;
        let before = s.account_prefs();
        let (changed, json) = {
            let mut p = s.prefs.lock().unwrap();
            (p.patch(changes), p.to_json())
        };
        if changed {
            let after = s.account_prefs();
            if after.auto_search_minutes != before.auto_search_minutes {
                let _ = s.with_store(|st| st.set_synced_value("search.auto", &after.auto_search_minutes.to_string()));
                s.search.lock().unwrap().reschedule.notify_one();
                self.sync_soon(&s);
            }
            self.env.emit("account-prefs", json.clone());
        }
        Ok(json)
    }
}

#[cfg(test)]
mod tests {
    use super::super::testing::fixture;
    use super::*;
    use crate::models::{LeadData, LeadKind};

    fn seeded() -> (super::super::testing::Fixture, Arc<Core>, Vec<String>) {
        let f = fixture(false, vec![]);
        let core = Core::new(f.env.clone());
        core.register("anna", "password-1", "password-1", false).unwrap();
        let s = core.session().unwrap();
        let mut ids = vec![];
        for i in 1..=3 {
            let mut d = LeadData::new(LeadKind::Order, "fl_ru", &format!("e{i}"), &format!("Заказ {i}"));
            d.phone = Some(format!("+7 999 000-00-0{i}"));
            let id = crate::search::text::lead_id(&d.source, &d.external_id);
            s.with_store(|st| st.save(&d, &id, &crate::search::text::fingerprint(&d))).unwrap();
            ids.push(id);
        }
        (f, core, ids)
    }

    #[tokio::test]
    async fn lead_actions_update_snapshot_and_emit_events() {
        let (f, core, ids) = seeded();
        let snap = core.snapshot().unwrap();
        assert_eq!(snap.leads.len(), 3);
        core.set_favorite(&ids[..1], true).unwrap();
        core.set_archived(&ids[1..2], true).unwrap();
        core.mark_seen(&ids[..1]).unwrap();
        core.set_note(&ids[0], "позвонить завтра").unwrap();
        core.log_event(&ids[0], "Звонок").unwrap();
        let snap = core.snapshot().unwrap();
        let by_id = |id: &str| snap.leads.iter().find(|l| l["id"] == id).unwrap().clone();
        assert_eq!(
            (by_id(&ids[0])["favorite"].clone(), by_id(&ids[0])["seen"].clone(), by_id(&ids[0])["note"].clone()),
            (json!(true), json!(true), json!("позвонить завтра"))
        );
        assert_eq!(by_id(&ids[1])["archived"], true);
        assert!(core.events(&ids[0]).unwrap().as_array().unwrap().iter().any(|e| e["action"].as_str().unwrap_or("").contains("Звонок")));
        core.delete_leads(&ids[2..]).unwrap();
        assert_eq!(core.snapshot().unwrap().leads.len(), 2);
        assert!(f.events.count("data-changed") >= 6);
    }

    #[tokio::test]
    async fn exclusions_hide_matching_leads_and_import_from_file() {
        let (f, core, ids) = seeded();
        let msg = core.exclude("+7 (999) 000-00-01", None).unwrap();
        assert!(msg.contains("Добавлено исключение"));
        let snap = core.snapshot().unwrap();
        assert_eq!(snap.leads.iter().find(|l| l["id"] == ids[0].as_str()).unwrap()["excluded"], true);
        assert_eq!(snap.exclusions.as_array().unwrap().len(), 1);
        let id = snap.exclusions[0]["id"].as_i64().unwrap();
        core.remove_exclusion(id).unwrap();
        assert!(core.snapshot().unwrap().exclusions.as_array().unwrap().is_empty());
        let file = f.dir.path().join("ex.csv");
        std::fs::write(&file, "example.ru\nspam@mail.ru\n").unwrap();
        assert!(core.import_exclusions(&file).unwrap().contains(": 2"));
        assert!(core.import_exclusions(&f.dir.path().join("none.csv")).is_err());
    }

    #[tokio::test]
    async fn export_writes_selected_leads_and_fields() {
        let (f, core, ids) = seeded();
        let out = f.dir.path().join("out.csv");
        let msg = core.export_to_file(&ids[..2], "csv", &["title".into(), "phone".into()], &out).unwrap();
        assert_eq!(msg, "Экспортировано лидов: 2");
        let text = String::from_utf8(std::fs::read(&out).unwrap()).unwrap();
        assert!(text.contains("Заказ 1") && text.contains("Заказ 2") && !text.contains("Заказ 3"));
        assert!(core.export_to_file(&ids, "csv", &["нет такого".into()], &out).is_err());
        let json_out = f.dir.path().join("out.json");
        core.export_to_file(&ids, "json", &["title".into()], &json_out).unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&std::fs::read(&json_out).unwrap()).unwrap().as_array().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn backups_are_encrypted_pruned_and_restorable() {
        let (_f, core, ids) = seeded();
        let s = core.session().unwrap();
        core.patch_account_prefs(&json!({"keepBackups": 2})).unwrap();
        let first = core.backup_now(&s).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        core.backup_now(&s).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        core.backup_now(&s).unwrap();
        let list = core.list_backups().unwrap();
        assert_eq!(list.len(), 2, "старые копии удаляются сверх лимита");
        assert!(!first.exists());
        assert_eq!(crate::db::file_state(Path::new(list[0]["path"].as_str().unwrap())), crate::db::FileState::Encrypted);
        // удаляем всё и восстанавливаем из копии
        core.delete_leads(&ids).unwrap();
        assert_eq!(core.snapshot().unwrap().leads.len(), 0);
        let msg = core.restore(Path::new(list[0]["path"].as_str().unwrap())).unwrap();
        assert!(msg.contains("before-restore.db"));
        assert_eq!(core.snapshot().unwrap().leads.len(), 3);
        assert!(core.restore(Path::new("/nonexistent/x.db")).is_err());
    }

    #[tokio::test]
    async fn daily_backup_only_when_due() {
        let (_f, core, _ids) = seeded();
        let s = core.session().unwrap();
        core.daily_backup_if_needed(&s);
        assert_eq!(core.list_backups().unwrap().len(), 1);
        std::thread::sleep(std::time::Duration::from_millis(1100));
        core.daily_backup_if_needed(&s);
        assert_eq!(core.list_backups().unwrap().len(), 1, "прошло меньше 20 часов");
        core.patch_account_prefs(&json!({"autoBackup": false})).unwrap();
        s.with_store(|st| st.set_value("last_backup_at", "2000-01-01T00:00:00Z")).unwrap();
        core.daily_backup_if_needed(&s);
        assert_eq!(core.list_backups().unwrap().len(), 1, "копии выключены");
    }

    #[tokio::test]
    async fn moving_the_database_keeps_data_and_is_remembered() {
        let (f, core, _ids) = seeded();
        let target = f.dir.path().join("elsewhere");
        std::fs::create_dir_all(&target).unwrap();
        let msg = core.move_database(&target).unwrap();
        assert!(msg.contains("elsewhere"));
        assert_eq!(core.snapshot().unwrap().leads.len(), 3);
        assert_eq!(core.info().unwrap().database_path, target.join("leads.db").display().to_string());
        core.logout();
        core.login("anna", "password-1", false).unwrap();
        assert_eq!(core.snapshot().unwrap().leads.len(), 3, "после входа база открывается из новой папки");
    }

    #[tokio::test]
    async fn account_prefs_validate_and_autosearch_goes_to_database() {
        let (f, core, _ids) = seeded();
        let p = core.patch_account_prefs(&json!({"autoSearchMinutes": 30, "keepBackups": 9999, "signature": "С уважением"})).unwrap();
        assert_eq!((p["autoSearchMinutes"].clone(), p["keepBackups"].clone(), p["signature"].clone()), (json!(30), json!(365), json!("С уважением")));
        assert_eq!(core.session().unwrap().with_store(|st| st.value("search.auto")).as_deref(), Some("30"));
        assert!(f.events.count("account-prefs") >= 1);
        core.logout();
        core.login("anna", "password-1", false).unwrap();
        assert_eq!(core.account_prefs().unwrap()["autoSearchMinutes"], 30);
    }
}
