//! Обновления: проверка релизов на GitHub, скачивание с проверкой SHA-256, установка и экран «Что нового».

use super::session::Core;
use super::{CmdError, CmdResult};
use crate::updates::{self, AvailableUpdate, Platform, ReleaseInfo, StagedRecord};
use crate::util::{parse_date, AppVersion};
use crate::whatsnew::{self, Decision, InstalledNotes};
use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;

/// Список последних релизов запоминается: пока окно «Что нового» открыто, сеть не нужна.
const RELEASES_TTL_OK: i64 = 6 * 3600;
const RELEASES_TTL_FAIL: i64 = 10 * 60;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum Phase {
    Idle,
    Checking,
    UpToDate,
    Available,
    Downloading,
    Ready,
    Installing,
    Failed { message: String },
}

pub struct UpdateState {
    pub phase: Phase,
    pub available: Option<AvailableUpdate>,
    pub staged: Option<StagedRecord>,
    pub last_attempt: Option<DateTime<Utc>>,
    pub releases: Option<(DateTime<Utc>, Vec<ReleaseInfo>)>,
    pub releases_failed_at: Option<DateTime<Utc>>,
    pub notes_request: Option<ReleaseInfo>,
}

impl Default for UpdateState {
    fn default() -> Self {
        Self { phase: Phase::Idle, available: None, staged: None, last_attempt: None, releases: None, releases_failed_at: None, notes_request: None }
    }
}

fn platform() -> Platform {
    Platform::current()
}

/// Свободное место на диске, где лежит `path` (поднимаясь к существующей папке).
pub fn free_space(path: &std::path::Path) -> Option<u64> {
    let mut p = path.to_path_buf();
    while !p.exists() {
        if !p.pop() {
            return None;
        }
    }
    fs4::available_space(&p).ok()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub phase: Phase,
    pub current: String,
    pub can_update: bool,
    pub available: Option<Value>,
    pub staged_version: Option<String>,
    pub last_check: Option<String>,
    pub releases_page: &'static str,
}

impl Core {
    fn staged_file(&self) -> PathBuf {
        self.env.paths.updates().join("staged.json")
    }

    fn installed_notes_file(&self) -> PathBuf {
        self.env.paths.root.join("installed-notes.json")
    }

    fn set_phase(&self, phase: Phase) {
        self.updates.lock().unwrap().phase = phase;
        self.env.emit("update-state", serde_json::to_value(self.update_info()).unwrap_or(Value::Null));
    }

    fn available_json(u: &AvailableUpdate) -> Value {
        json!({"version": u.version.to_string(), "title": u.title, "notes": updates::plain_notes(&u.notes, None), "page": u.page, "size": u.installer.size})
    }

    pub fn update_info(&self) -> UpdateInfo {
        let st = self.updates.lock().unwrap();
        UpdateInfo {
            phase: st.phase.clone(),
            current: self.env.version.to_string(),
            can_update: self.env.can_update,
            available: st.available.as_ref().map(Self::available_json),
            staged_version: st.staged.as_ref().map(|s| s.version.clone()),
            last_check: self.env.device_prefs().last_update_check,
            releases_page: updates::RELEASES_PAGE,
        }
    }

    /// Скачанное ранее обновление, которое ещё не установлено: после перезапуска оно остаётся готовым.
    pub fn restore_staged(&self) {
        let Some(rec) = std::fs::read_to_string(self.staged_file()).ok().and_then(|t| serde_json::from_str::<StagedRecord>(&t).ok()) else { return };
        let newer = AppVersion::parse(&rec.version).map(|v| v > self.env.version).unwrap_or(false);
        if newer && PathBuf::from(&rec.path).exists() {
            let mut st = self.updates.lock().unwrap();
            st.staged = Some(rec);
            st.phase = Phase::Ready;
        } else {
            let _ = std::fs::remove_dir_all(self.env.paths.updates());
        }
    }

    /// Проверка. `manual` — по кнопке: показывает «Установлена последняя версия» и ошибки; фоновая молчит.
    pub async fn check_updates(self: &Arc<Self>, manual: bool) -> CmdResult<UpdateInfo> {
        if matches!(self.updates.lock().unwrap().phase, Phase::Checking | Phase::Downloading | Phase::Installing) {
            return Ok(self.update_info());
        }
        let was = self.updates.lock().unwrap().phase.clone();
        self.updates.lock().unwrap().last_attempt = Some(Utc::now());
        self.set_phase(Phase::Checking);
        let result = updates::check(self.env.transport.as_ref(), &self.env.version, platform()).await;
        match result {
            Ok(found) => {
                self.env.patch_device(&json!({"lastUpdateCheck": updates::stamp(&Utc::now())}));
                let has = found.is_some();
                let staged_same = {
                    let mut st = self.updates.lock().unwrap();
                    let same = matches!((&found, &st.staged), (Some(f), Some(s)) if f.version.to_string() == s.version);
                    st.available = found;
                    same
                };
                self.set_phase(if staged_same {
                    Phase::Ready
                } else if has {
                    Phase::Available
                } else {
                    Phase::UpToDate
                });
                if has && !staged_same && self.env.device_prefs().background_download && self.env.can_update {
                    let core = self.clone();
                    tokio::spawn(async move {
                        let _ = core.prepare_update().await;
                    });
                }
            }
            Err(e) => {
                let message = e.to_string();
                self.env.log_error(&format!("Проверка обновлений: {message}"));
                if manual {
                    self.set_phase(Phase::Failed { message: message.clone() });
                    return Err(CmdError::msg(message));
                }
                self.set_phase(if matches!(was, Phase::Checking) { Phase::Idle } else { was });
            }
        }
        Ok(self.update_info())
    }

    /// Скачивает и проверяет установщик. На macOS ещё достаёт приложение из образа и проверяет его.
    pub async fn prepare_update(self: &Arc<Self>) -> CmdResult<UpdateInfo> {
        if !self.env.can_update {
            return Err(CmdError::msg("Эта копия приложения не обновляется автоматически: скачайте новую версию на странице релизов."));
        }
        let update = {
            let st = self.updates.lock().unwrap();
            if matches!(st.phase, Phase::Downloading | Phase::Installing | Phase::Ready) {
                drop(st);
                return Ok(self.update_info());
            }
            st.available.clone()
        };
        let Some(update) = update else { return Err(CmdError::msg("Нет доступного обновления.")) };
        let dir = self.env.paths.updates();
        if let Some(avail) = free_space(&self.env.paths.root) {
            if !whatsnew::space::is_enough(avail, update.installer.size) {
                let message = whatsnew::space::message(avail, update.installer.size);
                self.set_phase(Phase::Failed { message: message.clone() });
                return Err(CmdError::msg(message));
            }
        }
        self.set_phase(Phase::Downloading);
        let file = match updates::download(&update, &dir, self.env.transport.as_ref(), &self.env.sleeper).await {
            Ok(f) => f,
            Err(e) => return Err(self.update_failed(e.to_string())),
        };
        #[cfg(target_os = "macos")]
        let path = match updates::stage_macos_app(&file, &self.env.bundle_id, &update.version) {
            Ok(app) => app,
            Err(e) => return Err(self.update_failed(e.to_string())),
        };
        #[cfg(not(target_os = "macos"))]
        let path = file;
        let record =
            StagedRecord { version: update.version.to_string(), path: path.display().to_string(), title: update.title.clone(), notes: update.notes.clone() };
        let _ = std::fs::write(self.staged_file(), serde_json::to_string(&record).unwrap_or_default());
        self.updates.lock().unwrap().staged = Some(record);
        self.set_phase(Phase::Ready);
        Ok(self.update_info())
    }

    fn update_failed(&self, message: String) -> CmdError {
        self.env.log_error(&format!("Обновление: {message}"));
        self.set_phase(Phase::Failed { message: message.clone() });
        CmdError::msg(message)
    }

    /// Запускает установку. После успеха интерфейс получает `exit-requested` и закрывает приложение.
    pub fn install_update(self: &Arc<Self>) -> CmdResult<()> {
        let rec = self.updates.lock().unwrap().staged.clone().ok_or("Обновление ещё не скачано.")?;
        // Описание запоминается до установки: «Что нового» покажется после перезапуска без сети.
        let notes = InstalledNotes { version: rec.version.clone(), title: rec.title.clone(), notes: rec.notes.clone() };
        let _ = std::fs::write(self.installed_notes_file(), notes.encoded());
        self.set_phase(Phase::Installing);
        let result = self.launch_installer(&rec);
        match result {
            Ok(()) => {
                self.env.emit("exit-requested", Value::Null);
                Ok(())
            }
            Err(message) => {
                let _ = std::fs::remove_file(self.installed_notes_file());
                self.set_phase(Phase::Ready);
                Err(CmdError::msg(message))
            }
        }
    }

    #[cfg(target_os = "macos")]
    fn launch_installer(&self, rec: &StagedRecord) -> Result<(), String> {
        let bundle = self.env.app_bundle.clone().ok_or("Не найдено расположение приложения.")?;
        let dmg = std::fs::read_dir(PathBuf::from(&rec.path).parent().ok_or("нет папки загрузки")?)
            .ok()
            .and_then(|d| d.filter_map(Result::ok).map(|e| e.path()).find(|p| p.extension().and_then(|e| e.to_str()) == Some("dmg")))
            .unwrap_or_else(|| PathBuf::from(&rec.path));
        updates::relaunch_macos(&PathBuf::from(&rec.path), &bundle, &dmg).map_err(|e| e.to_string())
    }

    #[cfg(windows)]
    fn launch_installer(&self, rec: &StagedRecord) -> Result<(), String> {
        updates::launch_windows_installer(&PathBuf::from(&rec.path)).map_err(|e| e.to_string())
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    fn launch_installer(&self, _rec: &StagedRecord) -> Result<(), String> {
        Err("Автоматическая установка доступна только в macOS и Windows.".into())
    }

    /// Раз в 10 минут: пора ли проверять по настройкам.
    pub async fn automatic_update_check(self: &Arc<Self>) {
        let prefs = self.env.device_prefs();
        let last = prefs.last_update_check.as_deref().and_then(parse_date);
        let attempt = self.updates.lock().unwrap().last_attempt;
        if updates::should_check(prefs.check_updates, updates::normalized_interval(Some(i64::from(prefs.update_check_hours))), last, attempt, Utc::now()) {
            let _ = self.check_updates(false).await;
        }
    }

    pub(crate) fn start_update_loop(self: &Arc<Self>) {
        self.restore_staged();
        let core = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            loop {
                core.automatic_update_check().await;
                tokio::time::sleep(std::time::Duration::from_secs(600)).await;
            }
        });
    }

    // ------------------------------------------------------------------ последние релизы и «Что нового»

    /// Три последних релиза для экрана «Обновления»; результат запоминается.
    pub async fn recent_releases(self: &Arc<Self>) -> CmdResult<Value> {
        let now = Utc::now();
        let cached = {
            let st = self.updates.lock().unwrap();
            match (&st.releases, st.releases_failed_at) {
                (Some((at, list)), _) if now - *at < Duration::seconds(RELEASES_TTL_OK) => Some(list.clone()),
                (_, Some(failed)) if now - failed < Duration::seconds(RELEASES_TTL_FAIL) => {
                    return Err(CmdError::msg("Не удалось загрузить список версий. Повторите позже."))
                }
                _ => None,
            }
        };
        let list = match cached {
            Some(l) => l,
            None => match updates::fetch_recent(self.env.transport.as_ref(), &self.env.version.to_string(), 3).await {
                Ok(l) => {
                    self.updates.lock().unwrap().releases = Some((now, l.clone()));
                    l
                }
                Err(e) => {
                    self.updates.lock().unwrap().releases_failed_at = Some(now);
                    return Err(CmdError::msg(e.to_string()));
                }
            },
        };
        Ok(Value::Array(
            list.iter()
                .map(|r| json!({"tag": r.tag_name, "title": r.title(), "date": r.published_at, "notes": updates::plain_notes(r.body.as_deref().unwrap_or(""), None), "page": r.html_url, "current": AppVersion::parse(&r.tag_name).map(|v| v == self.env.version).unwrap_or(false)}))
                .collect(),
        ))
    }

    /// Нужно ли при запуске показать «Что нового», и что именно.
    pub async fn whats_new(self: &Arc<Self>) -> CmdResult<Value> {
        let prefs = self.env.device_prefs();
        let boot = self.boot_info();
        match whatsnew::decide(prefs.last_seen_version.as_deref(), &self.env.version, boot.existing_install) {
            Decision::None => Ok(json!({"show": false})),
            Decision::RecordOnly => {
                self.mark_whats_new_seen();
                Ok(json!({"show": false}))
            }
            Decision::Show => {
                // Описание: запомненное перед установкой, иначе из GitHub.
                let remembered = InstalledNotes::decode(std::fs::read_to_string(self.installed_notes_file()).ok().as_deref(), &self.env.version);
                let (title, notes, page) = match remembered {
                    Some(n) => (n.title, n.notes, None),
                    None => match updates::fetch_release(self.env.transport.as_ref(), &self.env.version, &self.env.version.to_string()).await {
                        Ok(Some(r)) => (r.title(), r.body.clone().unwrap_or_default(), r.html_url.clone()),
                        _ => {
                            // Без сети экран не показываем: версия не помечается, попробуем в следующий запуск.
                            return Ok(json!({"show": false}));
                        }
                    },
                };
                let features = whatsnew::build(&notes, platform());
                Ok(
                    json!({"show": true, "version": self.env.version.to_string(), "title": title, "page": page, "features": features, "notes": updates::plain_notes(&notes, Some(1200))}),
                )
            }
        }
    }

    pub fn mark_whats_new_seen(&self) {
        self.env.patch_device(&json!({"lastSeenVersion": self.env.version.to_string()}));
        let _ = std::fs::remove_file(self.installed_notes_file());
    }
}

#[cfg(test)]
mod tests {
    use super::super::testing::fixture;
    use super::*;
    use crate::search::http::HttpResponse;

    fn release(tag: &str, installer: &str, sum: &str) -> String {
        json!({
            "tag_name": tag, "name": format!("Customers {tag}"), "body": "## Интерфейс\n- Новый вид", "html_url": "https://github.com/x/y/releases/1",
            "assets": [
                {"name": installer, "browser_download_url": "https://dl.example/installer", "size": 4, "digest": format!("sha256:{sum}")},
            ],
        })
        .to_string()
    }

    fn installer_name() -> &'static str {
        match platform() {
            Platform::MacOs => "Customers-v9.9.9-macOS.dmg",
            Platform::Windows => "Customers-v9.9.9-Windows-x64-Setup.exe",
        }
    }

    #[tokio::test]
    async fn check_finds_a_newer_release_and_stays_quiet_when_up_to_date() {
        let f = fixture(
            false,
            vec![
                Ok(HttpResponse::new(200, release("v1.1.0", installer_name(), &"0".repeat(64)))),
                Ok(HttpResponse::new(200, release("v9.9.9", installer_name(), &"0".repeat(64)))),
            ],
        );
        let core = super::super::session::Core::new(f.env.clone());
        let info = core.check_updates(true).await.unwrap();
        assert_eq!(info.phase, Phase::UpToDate);
        assert!(info.last_check.is_some());
        let info = core.check_updates(true).await.unwrap();
        // can_update выключен в тестах: фоновая загрузка не стартует
        assert_eq!(info.phase, Phase::Available);
        assert_eq!(info.available.unwrap()["version"], "9.9.9");
    }

    #[tokio::test]
    async fn manual_check_reports_errors_but_automatic_stays_silent() {
        let f = fixture(false, vec![Ok(HttpResponse::new(500, "")), Ok(HttpResponse::new(500, ""))]);
        let core = super::super::session::Core::new(f.env.clone());
        assert!(core.check_updates(false).await.is_ok());
        assert_eq!(core.update_info().phase, Phase::Idle);
        let e = core.check_updates(true).await.unwrap_err();
        assert!(e.message.contains("500"));
        assert!(matches!(core.update_info().phase, Phase::Failed { .. }));
    }

    #[test]
    fn background_tasks_start_on_the_main_thread_like_in_the_app() {
        // Запуск приложения: setup идёт на главном потоке, где нет контекста tokio. Без входа в общий runtime это паника.
        let f = fixture(false, vec![]);
        let core = super::super::session::Core::new(f.env.clone());
        let _runtime = crate::shell::enter_async_runtime();
        core.start_update_loop();
    }

    #[test]
    fn whats_new_decision_follows_last_seen_version() {
        let f = fixture(false, vec![]);
        let core = super::super::session::Core::new(f.env.clone());
        f.env.patch_device(&json!({"lastSeenVersion": "1.0.0"}));
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        // нет сети (пустая заглушка) — экран не показывается и версия не помечается
        let v = rt.block_on(core.whats_new()).unwrap();
        assert_eq!(v["show"], false);
        assert_eq!(f.env.device_prefs().last_seen_version.as_deref(), Some("1.0.0"));
        // запомненное описание показывается без сети
        let notes = InstalledNotes { version: "1.1.0".into(), title: "Customers 1.1.0".into(), notes: "## Поиск\n- Быстрее".into() };
        std::fs::write(f.env.paths.root.join("installed-notes.json"), notes.encoded()).unwrap();
        let v = rt.block_on(core.whats_new()).unwrap();
        assert_eq!(v["show"], true);
        core.mark_whats_new_seen();
        assert_eq!(f.env.device_prefs().last_seen_version.as_deref(), Some("1.1.0"));
        assert!(!f.env.paths.root.join("installed-notes.json").exists());
        assert_eq!(rt.block_on(core.whats_new()).unwrap()["show"], false);
    }

    #[test]
    fn first_install_records_version_without_showing() {
        let f = fixture(false, vec![]);
        let core = super::super::session::Core::new(f.env.clone());
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        assert_eq!(rt.block_on(core.whats_new()).unwrap()["show"], false);
        assert_eq!(f.env.device_prefs().last_seen_version.as_deref(), Some("1.1.0"));
    }

    #[test]
    fn staged_update_survives_restart_only_if_newer_and_present() {
        let f = fixture(false, vec![]);
        let core = super::super::session::Core::new(f.env.clone());
        let dir = f.env.paths.updates();
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("Setup.exe");
        std::fs::write(&file, b"x").unwrap();
        let rec = StagedRecord { version: "9.9.9".into(), path: file.display().to_string(), title: "t".into(), notes: "n".into() };
        std::fs::write(dir.join("staged.json"), serde_json::to_string(&rec).unwrap()).unwrap();
        core.restore_staged();
        assert_eq!(core.update_info().phase, Phase::Ready);
        assert_eq!(core.update_info().staged_version.as_deref(), Some("9.9.9"));
        // устаревшая запись (версия не новее) удаляется вместе с файлами
        let core2 = super::super::session::Core::new(f.env.clone());
        let old = StagedRecord { version: "1.0.0".into(), ..rec };
        std::fs::write(dir.join("staged.json"), serde_json::to_string(&old).unwrap()).unwrap();
        core2.restore_staged();
        assert_eq!(core2.update_info().phase, Phase::Idle);
        assert!(!dir.exists());
    }

    #[tokio::test]
    async fn recent_releases_are_cached() {
        let one = json!([{"tag_name": "v1.1.0", "name": "Customers 1.1.0", "body": "- a", "html_url": "u", "assets": []}]).to_string();
        let f = fixture(false, vec![Ok(HttpResponse::new(200, one))]);
        let core = super::super::session::Core::new(f.env.clone());
        let a = core.recent_releases().await.unwrap();
        assert_eq!(a[0]["current"], true);
        // второй вызов — из памяти: заглушка пуста и вызвала бы ошибку
        let b = core.recent_releases().await.unwrap();
        assert_eq!(a, b);
        assert_eq!(f.transport.urls().len(), 1);
    }

    #[test]
    fn free_space_walks_up_to_an_existing_folder() {
        let dir = tempfile::tempdir().unwrap();
        assert!(free_space(&dir.path().join("a/b/c")).unwrap() > 0);
    }
}
