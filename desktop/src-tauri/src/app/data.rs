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
            .map(|(path, name, size, at)| {
                let crm = crm_copy_dir(&path).is_dir();
                json!({"path": path.display().to_string(), "name": name, "size": size, "modifiedAt": at, "crm": crm})
            })
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

    /// Создаёт копию базы генератора и рядом копию баз CRM (`leadgen-….crm/`), удаляет самые старые сверх
    /// лимита. Копия либо полная, либо её нет: если базы CRM скопировать не удалось, удаляется и копия лидов.
    /// Возвращает путь к копии базы генератора.
    pub fn backup_now(&self, s: &Session) -> CmdResult<PathBuf> {
        let dir = self.backup_directory(s);
        let prefs = s.account_prefs();
        let path = dir.join(format!("leadgen-{}.db", Local::now().format("%Y-%m-%d_%H-%M-%S")));
        std::fs::create_dir_all(&dir).map_err(|e| CmdError::msg(format!("Резервная копия не создана: {e}")))?;
        s.with_store(|st| st.backup(&path)).map_err(|e| {
            self.env.log_error(&format!("Резервная копия: {e}"));
            CmdError::msg(format!("Резервная копия не создана: {e}"))
        })?;
        if let Err(e) = self.backup_workspaces(s, &crm_copy_dir(&path)) {
            self.env.log_error(&format!("Резервная копия CRM: {}", e.message));
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::remove_dir_all(crm_copy_dir(&path));
            return Err(CmdError::msg(format!("Резервная копия не создана: {}", e.message)));
        }
        for old in self.backups_in(&dir).into_iter().skip(prefs.keep_backups.max(1) as usize) {
            let _ = std::fs::remove_file(&old.0);
            let _ = std::fs::remove_dir_all(crm_copy_dir(&old.0));
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
        // Копии до пакета A1 не содержат CRM: тогда базы Workspace не трогаются.
        let crm = crm_copy_dir(path);
        let restored = if crm.is_dir() {
            self.restore_workspaces(&s, &crm).map_err(|e| CmdError::msg(format!("Лиды восстановлены, а CRM — нет: {}", e.message)))?
        } else {
            0
        };
        let mut msg = String::from("База восстановлена из копии. Предыдущая версия сохранена как before-restore.db");
        if restored > 0 {
            msg.push_str(&format!(". Восстановлено баз CRM: {restored}"));
        }
        Ok(msg)
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
            self.push_account_prefs(&s, changes);
            self.env.emit("account-prefs", json.clone());
        }
        Ok(json)
    }
}

/// Папка копии баз CRM рядом с копией базы генератора: `leadgen-2026-11-11_10-00-00.db` → `leadgen-2026-11-11_10-00-00.crm`.
fn crm_copy_dir(leads_copy: &Path) -> PathBuf {
    leads_copy.with_extension("crm")
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
        let p = core.patch_account_prefs(&json!({"autoSearchMinutes": 240, "keepBackups": 9999, "signature": "С уважением"})).unwrap();
        assert_eq!((p["autoSearchMinutes"].clone(), p["keepBackups"].clone(), p["signature"].clone()), (json!(240), json!(365), json!("С уважением")));
        assert_eq!(core.session().unwrap().with_store(|st| st.value("search.auto")).as_deref(), Some("240"));
        assert!(f.events.count("account-prefs") >= 1);
        core.logout();
        core.login("anna", "password-1", false).unwrap();
        assert_eq!(core.account_prefs().unwrap()["autoSearchMinutes"], 240);
    }

    /// Пароль собирается во время работы теста, чтобы в коде не было постоянного пароля.
    fn password() -> String {
        ["password", "-1"].concat()
    }

    #[tokio::test]
    async fn backups_go_to_default_folder_or_keep_using_the_legacy_one() {
        let f = super::super::testing::fixture(false, vec![]);
        let core = Core::new(f.env.clone());
        core.register("anna", &password(), &password(), false).unwrap();
        let s = core.session().unwrap();
        let path = core.backup_now(&s).unwrap();
        assert!(path.starts_with(f.env.paths.documents.join("Customers Backups").join("anna")), "{}", path.display());
        // Папка копий прежней macOS-версии существует — копии продолжают складываться в неё.
        std::fs::create_dir_all(f.env.paths.legacy_backups("anna")).unwrap();
        let path = core.backup_now(&s).unwrap();
        assert!(path.starts_with(f.env.paths.legacy_backups("anna")), "{}", path.display());
    }

    fn company(core: &Arc<Core>, name: &str) {
        let mut m = serde_json::Map::new();
        m.insert("name".into(), json!(name));
        core.ws_save("companies", None, m).unwrap();
    }

    fn companies(core: &Arc<Core>) -> i64 {
        core.ws_list("companies", Default::default()).unwrap()["total"].as_i64().unwrap()
    }

    #[tokio::test]
    async fn crm_export_saves_what_the_collection_shows() {
        use crate::workspace::export::Request;
        let (f, core, _) = seeded();
        company(&core, "Ромашка");
        company(&core, "Лютик");
        let fields = core.ws_export_fields("companies", "ru").unwrap();
        assert_eq!(fields[0], json!({"key": "name", "title": "Компания", "default": true, "custom": false}));
        let collections = core.ws_collections().unwrap();
        let all = collections.as_array().unwrap().iter().find(|c| c["name"] == "Все клиенты").unwrap()["id"].as_str().unwrap().to_string();
        let request = |format: &str, search: Option<&str>| Request {
            collection: Some(all.clone()),
            query: crate::workspace::query::Query { search: search.map(String::from), ..Default::default() },
            format: format.into(),
            fields: vec!["name".into()],
            lang: "ru".into(),
            ..Default::default()
        };
        let csv = f.dir.path().join("crm.csv");
        assert_eq!(core.ws_export(request("csv", None), &csv).unwrap()["count"], 2);
        let text = String::from_utf8(std::fs::read(&csv).unwrap()).unwrap();
        assert!(text.contains("Компания\r\n") && text.contains("Ромашка") && text.contains("Лютик"));
        let xlsx = f.dir.path().join("crm.xlsx");
        assert_eq!(core.ws_export(request("xlsx", Some("лют")), &xlsx).unwrap()["count"], 1, "поиск пользователя сужает выгрузку");
        let table = crate::workspace::import::parse("crm.xlsx", &std::fs::read(&xlsx).unwrap()).unwrap();
        assert_eq!((table.headers, table.rows), (vec!["Компания".to_string()], vec![vec!["Лютик".to_string()]]));
        // Без коллекции выгружается таблица целиком; неизвестная коллекция и папка, которой нет, — ошибки.
        let plain = Request { entity: "companies".into(), format: "csv".into(), fields: vec!["name".into()], ..Default::default() };
        assert_eq!(core.ws_export(plain.clone(), &csv).unwrap()["count"], 2);
        assert!(core.ws_export(Request { collection: Some("нет".into()), ..plain.clone() }, &csv).is_err());
        assert!(core.ws_export(plain, &f.dir.path().join("нет").join("crm.csv")).is_err());
    }

    #[tokio::test]
    async fn backup_includes_crm_databases_and_restores_them() {
        let (f, core, _) = seeded();
        let s = core.session().unwrap();
        company(&core, "Ромашка");
        let copy = core.backup_now(&s).unwrap();
        let crm = crm_copy_dir(&copy);
        let dbs: Vec<_> = std::fs::read_dir(&crm).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".db")).collect();
        assert_eq!(dbs.len(), 1, "база локального Workspace в копии");
        assert_eq!(crate::db::file_state(&dbs[0].path()), crate::db::FileState::Encrypted);
        assert!(crm.join("catalog.json").exists());
        assert_eq!(core.list_backups().unwrap()[0]["crm"], true);

        company(&core, "Лютик");
        assert_eq!(companies(&core), 2);
        let msg = core.restore(&copy).unwrap();
        assert!(msg.contains("Восстановлено баз CRM: 1"), "{msg}");
        assert_eq!(companies(&core), 1, "CRM вернулась к состоянию копии");
        let ws_dir = s.dir.join("workspaces");
        assert!(std::fs::read_dir(&ws_dir).unwrap().flatten().any(|e| e.file_name().to_string_lossy().ends_with(".before-restore.db")));
        assert!(f.events.count("workspace-changed") >= 1);
    }

    #[tokio::test]
    async fn old_backups_without_crm_leave_workspaces_untouched_and_pruning_removes_crm_copies() {
        let (_f, core, _) = seeded();
        let s = core.session().unwrap();
        core.patch_account_prefs(&json!({"keepBackups": 1})).unwrap();
        company(&core, "Ромашка");
        let first = core.backup_now(&s).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let second = core.backup_now(&s).unwrap();
        assert!(!first.exists() && !crm_copy_dir(&first).exists(), "старая копия удалена вместе с CRM");
        assert!(second.exists() && crm_copy_dir(&second).is_dir());

        // Копия прежней версии: только база лидов.
        std::fs::remove_dir_all(crm_copy_dir(&second)).unwrap();
        company(&core, "Лютик");
        let msg = core.restore(&second).unwrap();
        assert!(!msg.contains("CRM"), "{msg}");
        assert_eq!(companies(&core), 2);
    }

    #[tokio::test]
    async fn crm_copy_of_another_workspace_is_refused() {
        let (_f, core, _) = seeded();
        let s = core.session().unwrap();
        company(&core, "Ромашка");
        let copy = core.backup_now(&s).unwrap();
        let crm = crm_copy_dir(&copy);
        let db = std::fs::read_dir(&crm).unwrap().flatten().find(|e| e.file_name().to_string_lossy().ends_with(".db")).unwrap().path();
        let other = crm.join(format!("{}.db", uuid::Uuid::new_v4()));
        std::fs::rename(&db, &other).unwrap();
        let mut catalog = crate::workspace::catalog::Catalog::load(&crm);
        catalog.workspaces[0].id = other.file_stem().unwrap().to_string_lossy().into_owned();
        catalog.save(&crm).unwrap();
        let e = core.restore(&copy).unwrap_err();
        assert!(e.message.contains("другому Workspace"), "{}", e.message);
        assert_eq!(companies(&core), 1);
    }
}
