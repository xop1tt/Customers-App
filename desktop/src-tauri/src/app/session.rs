//! Учётная запись этого компьютера и открытая сессия с базой, настройками и фоновыми задачами.
//! С ADR-100 приложение работает только локально: входа нет, запись открывается при запуске сама.
//! Прежняя облачная запись (`cloud-<uuid>`) становится записью этого компьютера вместе со своими базами.

const LOCAL_PREFIX: &str = "local-";
const CLOUD_PREFIX: &str = "cloud-";

use super::search::SearchState;
use super::{CmdError, CmdResult, Env};
use crate::db::DbKey;
use crate::prefs::{self, AccountPrefs, PrefsFile};
use crate::search::settings::SearchSettings;
use crate::store::LeadStore;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::task::JoinHandle;

/// Открытая учётная запись.
pub struct Session {
    /// Внутренний идентификатор: `local-<uuid>` (или `cloud-<uuid>` прежней облачной записи).
    pub id: String,
    /// Что показывать в интерфейсе, пока нет имени профиля: адрес почты.
    pub display_name: String,
    pub dir: PathBuf,
    pub store: Arc<Mutex<LeadStore>>,
    pub prefs: Mutex<PrefsFile<AccountPrefs>>,
    pub settings: Mutex<SearchSettings>,
    pub search: Mutex<SearchState>,
    /// Customers 2.0: выбранный Workspace и его база.
    pub workspace: Mutex<super::workspace::CrmState>,
    /// Открытие базы Workspace идёт по одному: параллельные команды при запуске иначе открывали бы её дважды и дважды засевали шаблон.
    pub ws_open: Mutex<()>,
    pub(crate) tasks: Mutex<Vec<JoinHandle<()>>>,
}

impl Session {
    pub fn key(&self) -> String {
        self.id.to_lowercase()
    }

    /// Файл базы: своя папка/файл из настроек или стандартный leads.db в папке учётной записи.
    pub fn database_path(dir: &Path, prefs: &AccountPrefs) -> PathBuf {
        match prefs.data_path.as_deref().filter(|p| !p.trim().is_empty()) {
            Some(p) if p.to_lowercase().ends_with(".db") => PathBuf::from(p),
            Some(p) => Path::new(p).join("leads.db"),
            None => dir.join("leads.db"),
        }
    }

    pub fn with_store<R>(&self, f: impl FnOnce(&LeadStore) -> R) -> R {
        f(&self.store.lock().unwrap())
    }

    pub fn account_prefs(&self) -> AccountPrefs {
        self.prefs.lock().unwrap().value.clone()
    }

    /// Остановить фоновые задачи (поиск, таймеры).
    pub fn shutdown(&self) {
        self.search.lock().unwrap().cancel();
        for t in self.tasks.lock().unwrap().drain(..) {
            t.abort();
        }
    }
}

/// Краткие сведения об открытой записи для интерфейса.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub display_name: String,
    /// Аватар в виде data-URL.
    pub avatar: Option<String>,
    pub database_path: String,
}

/// Имя и аватар хранятся в базе пользователя как JSON-строки.
fn stored_text(s: &Session, key: &str) -> Option<String> {
    let raw = s.with_store(|st| st.value(key))?;
    serde_json::from_str::<String>(&raw).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// Что нужно показать при запуске.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    pub version: String,
    pub platform: &'static str,
    pub session: Option<SessionInfo>,
    pub device: Value,
    pub error: Option<String>,
}

pub struct Core {
    pub env: Arc<Env>,
    pub(crate) current: Mutex<Option<Arc<Session>>>,
    pub(crate) updates: Mutex<super::update::UpdateState>,
    pub(crate) integ: Mutex<super::integrations::IntegrationState>,
    startup_error: Mutex<Option<String>>,
}

impl Core {
    pub fn new(env: Arc<Env>) -> Arc<Self> {
        Arc::new(Self { env, current: Mutex::new(None), updates: Mutex::default(), integ: Mutex::default(), startup_error: Mutex::new(None) })
    }

    pub fn session(&self) -> Option<Arc<Session>> {
        self.current.lock().unwrap().clone()
    }

    pub fn require(&self) -> CmdResult<Arc<Session>> {
        self.session().ok_or_else(|| CmdError::new("noSession", "Войдите в учётную запись."))
    }

    pub fn info(&self) -> Option<SessionInfo> {
        let s = self.session()?;
        let database_path = s.with_store(|st| st.path().display().to_string());
        // Имя из профиля, а пока его нет — имя пользователя системы.
        let display_name = stored_text(&s, "profile.name").unwrap_or_else(|| s.display_name.clone());
        let avatar = stored_text(&s, "profile.avatar");
        Some(SessionInfo { id: s.id.clone(), display_name, avatar, database_path })
    }

    pub fn boot_info(&self) -> BootInfo {
        BootInfo {
            version: self.env.version.to_string(),
            platform: if cfg!(windows) {
                "windows"
            } else if cfg!(target_os = "macos") {
                "macos"
            } else {
                "linux"
            },
            session: self.info(),
            device: self.env.device.lock().unwrap().to_json(),
            error: self.startup_error.lock().unwrap().clone(),
        }
    }

    // ------------------------------------------------------------------ запуск

    /// Перенос настроек прежних версий и открытие учётной записи этого компьютера (ADR-100: всё локально,
    /// без входа и без облака).
    pub fn startup(self: &Arc<Self>) {
        self.import_legacy();
        if let Err(e) = self.open_local() {
            *self.startup_error.lock().unwrap() = Some(e.message);
        }
    }

    /// Папка с данными учётной записи: `users/<id>`. Идентификатор берётся только из своего формата,
    /// чтобы значение из настроек не увело путь за пределы папки приложения.
    fn is_account_id(id: &str) -> bool {
        let rest = id.strip_prefix(LOCAL_PREFIX).or_else(|| id.strip_prefix(CLOUD_PREFIX));
        rest.is_some_and(|r| uuid::Uuid::parse_str(r).is_ok() && r.len() == 36)
    }

    /// Какую запись открыть: запомненную; иначе папку последней облачной записи прежних версий (её база и
    /// ключ остаются прежними, данные не переносятся); иначе новую `local-<uuid>`.
    pub(crate) fn local_account_id(&self) -> String {
        let env = &self.env;
        if let Some(id) = env.device_prefs().local_account.filter(|id| Self::is_account_id(id)) {
            return id;
        }
        let users = env.paths.root.join("users");
        let modified = |dir: &Path| {
            ["leads.db", "prefs.json", "workspaces/catalog.json"]
                .iter()
                .filter_map(|f| std::fs::metadata(dir.join(f)).and_then(|m| m.modified()).ok())
                .max()
                .or_else(|| std::fs::metadata(dir).and_then(|m| m.modified()).ok())
        };
        let adopted = std::fs::read_dir(&users)
            .map(|rd| {
                rd.flatten()
                    .filter(|e| e.path().is_dir())
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .filter(|n| n.starts_with(CLOUD_PREFIX) && Self::is_account_id(n))
                    .max_by_key(|n| modified(&users.join(n)))
            })
            .ok()
            .flatten();
        let id = adopted.unwrap_or_else(|| format!("{LOCAL_PREFIX}{}", uuid::Uuid::new_v4()));
        env.patch_device(&json!({"localAccount": id}));
        id
    }

    /// Открыть учётную запись этого компьютера. Имя по умолчанию — имя пользователя системы.
    pub fn open_local(self: &Arc<Self>) -> CmdResult<()> {
        let id = self.local_account_id();
        let dir = self.env.paths.root.join("users").join(&id);
        let name = ["USER", "USERNAME"]
            .iter()
            .filter_map(|v| std::env::var(v).ok())
            .map(|v| v.trim().to_string())
            .find(|v| !v.is_empty() && v.chars().count() <= 40)
            .unwrap_or_else(|| "Владелец".into());
        self.open_session(&id, &name, &dir)
    }

    /// Один раз: настройки UserDefaults macOS и ненужные секреты версии 1.0.
    fn import_legacy(&self) {
        let env = &self.env;
        if env.device_prefs().legacy_imported {
            return;
        }
        let mut patch = serde_json::Map::new();
        if let Some(defaults) = env.paths.legacy_defaults.as_deref().and_then(prefs::read_defaults_plist) {
            if let Value::Object(o) = prefs::legacy_device_patch(&defaults) {
                patch.extend(o);
            }
        }
        // Токен GitHub, ключ шифрования и запомненный локальный вход версии 1.0 больше не нужны.
        for name in ["github.token", "state.secret", "session.user"] {
            let _ = env.secrets.delete(name);
        }
        patch.insert("legacyImported".into(), json!(true));
        env.patch_device(&Value::Object(patch));
    }

    // ------------------------------------------------------------------ открытие и закрытие

    pub(crate) fn close_current(&self) {
        if let Some(s) = self.current.lock().unwrap().take() {
            s.shutdown();
        }
        self.env.emit("session-changed", Value::Null);
    }

    fn open_session(self: &Arc<Self>, id: &str, display_name: &str, dir: &Path) -> CmdResult<()> {
        self.close_current();
        let env = &self.env;
        std::fs::create_dir_all(dir).map_err(|e| CmdError::msg(format!("Не удалось создать папку данных: {e}")))?;
        let prefs_path = dir.join("prefs.json");
        let mut prefs = PrefsFile::<AccountPrefs>::load(&prefs_path);
        let db_path = Session::database_path(dir, &prefs.value);
        let key: DbKey = env.keys.key_for(id).map_err(|e| CmdError::msg(format!("Не удалось открыть базу: {e}")))?;
        let store = LeadStore::open(&db_path, Some(key)).map_err(|e| CmdError::msg(format!("Не удалось открыть базу: {e}")))?;
        let settings = SearchSettings::stored(store.value("search.settings").as_deref());
        // Автопоиск тоже хранится в базе: значение оттуда главнее.
        if let Some(v) = store.value("search.auto").and_then(|v| v.parse::<u32>().ok()) {
            prefs.patch(&json!({"autoSearchMinutes": v}));
        }
        let session = Arc::new(Session {
            id: id.to_string(),
            display_name: display_name.to_string(),
            dir: dir.to_path_buf(),
            store: Arc::new(Mutex::new(store)),
            prefs: Mutex::new(prefs),
            settings: Mutex::new(settings),
            search: Mutex::new(SearchState::default()),
            workspace: Mutex::default(),
            ws_open: Mutex::new(()),
            tasks: Mutex::new(vec![]),
        });
        *self.current.lock().unwrap() = Some(session.clone());
        self.start_background(&session);
        self.env.emit("session-changed", serde_json::to_value(self.info()).unwrap_or(Value::Null));
        Ok(())
    }

    // ------------------------------------------------------------------ профиль

    /// Имя пользователя: от 1 до 40 символов без пробелов по краям.
    pub fn checked_name(raw: &str) -> CmdResult<String> {
        let name = raw.trim();
        let len = name.chars().count();
        if len == 0 {
            return Err(CmdError::msg("Введите имя пользователя."));
        }
        if len > 40 {
            return Err(CmdError::msg("Имя не должно быть длиннее 40 символов."));
        }
        if name.chars().any(char::is_control) {
            return Err(CmdError::msg("В имени есть недопустимые символы."));
        }
        Ok(name.to_string())
    }

    /// Изменить имя и/или аватар. Пустой аватар удаляет картинку.
    pub fn set_profile(self: &Arc<Self>, name: Option<&str>, avatar: Option<&str>) -> CmdResult<SessionInfo> {
        let s = self.require()?;
        if let Some(n) = name {
            let n = Self::checked_name(n)?;
            s.with_store(|st| st.set_value("profile.name", &serde_json::to_string(&n).unwrap_or_default()))?;
        }
        if let Some(a) = avatar {
            let a = a.trim();
            if !a.is_empty() && (!a.starts_with("data:image/") || a.len() > 60_000) {
                return Err(CmdError::msg("Картинка не подходит: нужен небольшой снимок в формате PNG, JPEG или WebP."));
            }
            s.with_store(|st| st.set_value("profile.avatar", &serde_json::to_string(a).unwrap_or_default()))?;
        }
        let info = self.info().ok_or_else(|| CmdError::new("noSession", "Войдите в учётную запись."))?;
        self.env.emit("session-changed", serde_json::to_value(&info).unwrap_or(Value::Null));
        Ok(info)
    }

    /// Только для тестов: открывает запись `local-<uuid>` с именем `<name>@example.com`. Одно и то же имя даёт
    /// один и тот же идентификатор, поэтому повторное открытие попадает в ту же базу.
    #[cfg(test)]
    pub(crate) fn sign_in_test_user(self: &Arc<Self>, name: &str) {
        use sha2::Digest;
        let hash = sha2::Sha256::digest(name.as_bytes());
        let id = format!("{LOCAL_PREFIX}{}", uuid::Uuid::from_slice(&hash[..16]).expect("16 байт"));
        let dir = self.env.paths.root.join("users").join(&id);
        self.open_session(&id, &format!("{name}@example.com"), &dir).expect("сессия открывается");
    }
}

#[cfg(test)]
mod tests {
    use super::super::testing::fixture;
    use super::*;

    #[tokio::test]
    async fn profile_name_and_avatar_are_validated_and_stored() {
        let f = fixture(vec![]);
        let core = Core::new(f.env.clone());
        core.sign_in_test_user("anna");
        assert_eq!(core.info().unwrap().display_name, "anna@example.com");
        let info = core.set_profile(Some("  Анна К.  "), Some("data:image/jpeg;base64,AAAA")).unwrap();
        assert_eq!((info.display_name.as_str(), info.avatar.as_deref()), ("Анна К.", Some("data:image/jpeg;base64,AAAA")));
        assert!(core.set_profile(Some("   "), None).is_err());
        assert!(core.set_profile(Some(&"я".repeat(41)), None).is_err());
        assert!(core.set_profile(None, Some("http://evil.example/a.png")).is_err());
        assert!(core.set_profile(None, Some(&format!("data:image/png;base64,{}", "A".repeat(70_000)))).is_err());
        assert_eq!(core.set_profile(None, Some("")).unwrap().avatar, None, "пустое значение убирает аватар");
        assert_eq!(core.info().unwrap().display_name, "Анна К.");
    }

    #[tokio::test]
    async fn first_start_opens_a_new_local_account_without_sign_in() {
        let f = fixture(vec![]);
        let core = Core::new(f.env.clone());
        core.startup();
        let info = core.info().expect("запись открыта без входа");
        assert!(info.id.starts_with("local-"), "{}", info.id);
        assert!(f.dir.path().join("data/users").join(&info.id).join("leads.db").exists());
        assert_eq!(f.env.device_prefs().local_account.as_deref(), Some(info.id.as_str()), "запись запомнена");
        assert_eq!(core.boot_info().error, None);
        // Повторный запуск открывает ту же запись.
        let again = Core::new(f.env.clone());
        again.startup();
        assert_eq!(again.info().unwrap().id, info.id);
    }

    #[tokio::test]
    async fn previous_cloud_account_folder_is_adopted_with_its_data() {
        let f = fixture(vec![]);
        let users = f.dir.path().join("data/users");
        let (old, recent) = ("cloud-00000000-0000-4000-8000-000000000001", "cloud-00000000-0000-4000-8000-000000000002");
        for id in [old, recent] {
            let key = f.env.keys.key_for(id).unwrap();
            let st = LeadStore::open(&users.join(id).join("leads.db"), Some(key)).unwrap();
            st.set_value("profile.name", &serde_json::to_string(id).unwrap()).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
        std::fs::create_dir_all(users.join("../../etc")).unwrap();
        let core = Core::new(f.env.clone());
        core.startup();
        let info = core.info().unwrap();
        assert_eq!(info.id, recent, "открывается папка последней облачной записи");
        assert_eq!(info.display_name, recent, "её база открылась тем же ключом");
        assert!(!users.read_dir().unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with("local-")), "новая запись не создана");
    }

    #[test]
    fn account_ids_from_settings_cannot_leave_the_users_folder() {
        assert!(Core::is_account_id("local-00000000-0000-4000-8000-000000000001"));
        assert!(Core::is_account_id("cloud-00000000-0000-4000-8000-000000000001"));
        for bad in ["", "local-", "local-../../x", "cloud-00000000-0000-4000-8000-00000000000/", "alex", "local-00000000000040008000000000000001"] {
            assert!(!Core::is_account_id(bad), "{bad}");
        }
        let f = fixture(vec![]);
        f.env.patch_device(&json!({"localAccount": "../../outside"}));
        let core = Core::new(f.env.clone());
        assert!(core.local_account_id().starts_with("local-"), "неверное значение из настроек не используется");
    }
}
