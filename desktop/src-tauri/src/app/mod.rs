//! Прикладной слой без привязки к окну: учётная запись, открытая база, поиск, синхронизация, копии, обновления.
//! Интерфейс (Tauri) только вызывает его методы и слушает события, поэтому всё проверяется обычными тестами.

pub mod data;
pub mod integrations;
pub mod prefs_sync;
pub mod search;
pub mod session;
pub mod sync;
pub mod system;
pub mod update;
pub mod workspace;

use crate::accounts::LocalAccounts;
use crate::cloud::auth::{CloudAuth, CloudSession, SessionStore};
use crate::cloud::error::CloudError;
use crate::error::AppError;
use crate::paths::AppPaths;
use crate::prefs::{DevicePrefs, PrefsFile};
use crate::reports::ErrorLog;
use crate::search::http::HttpTransport;
use crate::secrets::{DatabaseKeys, SecretStore};
use crate::util::AppVersion;
use serde::Serialize;
use serde_json::Value;
use std::sync::{Arc, Mutex};

/// Куда приложение отправляет события для интерфейса.
pub trait Events: Send + Sync {
    fn emit(&self, name: &str, payload: Value);
}

/// Открытие адресов в браузере и папок в проводнике.
pub trait Opener: Send + Sync {
    fn open_url(&self, url: &str) -> Result<(), String>;
    fn reveal(&self, path: &std::path::Path) -> Result<(), String>;
}

/// Ошибка команды для интерфейса: понятный текст и необязательный код, по которому интерфейс выбирает действие.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CmdError {
    pub code: String,
    pub message: String,
}

pub type CmdResult<T> = Result<T, CmdError>;

impl CmdError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }
    pub fn msg(message: impl Into<String>) -> Self {
        Self::new("", message)
    }
}

impl From<AppError> for CmdError {
    fn from(e: AppError) -> Self {
        CmdError::msg(e.to_string())
    }
}
impl From<String> for CmdError {
    fn from(e: String) -> Self {
        CmdError::msg(e)
    }
}
impl From<&str> for CmdError {
    fn from(e: &str) -> Self {
        CmdError::msg(e)
    }
}
impl From<CloudError> for CmdError {
    fn from(e: CloudError) -> Self {
        let code = match &e {
            CloudError::EmailNotConfirmed => "emailNotConfirmed",
            CloudError::SessionExpired => "sessionExpired",
            CloudError::Network(_) => "offline",
            CloudError::InvalidCode => "invalidCode",
            _ => "",
        };
        CmdError::new(code, e.to_string())
    }
}
impl From<crate::accounts::AuthError> for CmdError {
    fn from(e: crate::accounts::AuthError) -> Self {
        CmdError::msg(e.to_string())
    }
}

/// Сессия облака в защищённом хранилище (имя секрета `cloud.session` — как в прежних версиях).
pub struct SecretSessionStore(pub Arc<dyn SecretStore>);

impl SessionStore for SecretSessionStore {
    fn load(&self) -> Option<CloudSession> {
        self.0.get("cloud.session").ok().flatten().and_then(|t| CloudSession::from_json(&t))
    }
    fn save(&self, session: Option<&CloudSession>) {
        let _ = match session {
            Some(s) => self.0.set("cloud.session", &s.to_json()),
            None => self.0.delete("cloud.session"),
        };
    }
}

/// Случайный идентификатор этого компьютера для лимитов писем. Хранится в защищённом хранилище.
pub fn device_id(secrets: &dyn SecretStore) -> String {
    if let Some(v) = secrets.get("cloud.device").ok().flatten().filter(|v| !v.is_empty()) {
        return v;
    }
    let v = uuid::Uuid::new_v4().to_string().to_uppercase();
    let _ = secrets.set("cloud.device", &v);
    v
}

/// Всё, что не зависит от открытой учётной записи.
pub struct Env {
    pub paths: AppPaths,
    pub secrets: Arc<dyn SecretStore>,
    pub keys: DatabaseKeys,
    pub device: Mutex<PrefsFile<DevicePrefs>>,
    pub accounts: LocalAccounts,
    pub transport: Arc<dyn HttpTransport>,
    pub events: Arc<dyn Events>,
    pub opener: Arc<dyn Opener>,
    pub cloud: Option<Arc<CloudAuth>>,
    pub errors: ErrorLog,
    pub version: AppVersion,
    pub device_id: String,
    /// Идентификатор приложения (bundle id) для проверки скачанного обновления на macOS.
    pub bundle_id: String,
    /// Путь к «.app» (macOS): куда ставить обновление.
    pub app_bundle: Option<std::path::PathBuf>,
    /// Обновляться можно (установленная копия, а не запуск из сборки/разработки).
    pub can_update: bool,
    /// Ограничения для тестов: ускоренные паузы.
    pub sleeper: crate::search::http::Sleeper,
}

impl Env {
    pub fn emit(&self, name: &str, payload: Value) {
        self.events.emit(name, payload);
    }

    pub fn device_prefs(&self) -> DevicePrefs {
        self.device.lock().unwrap().value.clone()
    }

    /// Изменить настройки устройства и сообщить интерфейсу.
    pub fn patch_device(&self, changes: &Value) -> bool {
        let (changed, json) = {
            let mut d = self.device.lock().unwrap();
            (d.patch(changes), d.to_json())
        };
        if changed {
            self.emit("device-prefs", json);
        }
        changed
    }

    /// Записать ошибку в журнал, если журнал включён.
    pub fn log_error(&self, message: &str) {
        if self.device_prefs().reports_log_errors {
            self.errors.append(message, chrono::Utc::now());
        }
    }

    pub fn cloud_available(&self) -> bool {
        self.cloud.is_some()
    }
}

#[cfg(test)]
pub mod testing {
    use super::*;
    use crate::cloud::config::CloudConfig;
    use crate::search::http::testing::FakeTransport;
    use crate::secrets::MemorySecretStore;

    #[derive(Default)]
    pub struct RecordingEvents(pub Mutex<Vec<(String, Value)>>);

    impl Events for RecordingEvents {
        fn emit(&self, name: &str, payload: Value) {
            self.0.lock().unwrap().push((name.to_string(), payload));
        }
    }

    impl RecordingEvents {
        pub fn names(&self) -> Vec<String> {
            self.0.lock().unwrap().iter().map(|e| e.0.clone()).collect()
        }
        pub fn count(&self, name: &str) -> usize {
            self.0.lock().unwrap().iter().filter(|e| e.0 == name).count()
        }
    }

    #[derive(Default)]
    pub struct RecordingOpener(pub Mutex<Vec<String>>);

    impl Opener for RecordingOpener {
        fn open_url(&self, url: &str) -> Result<(), String> {
            self.0.lock().unwrap().push(url.to_string());
            Ok(())
        }
        fn reveal(&self, path: &std::path::Path) -> Result<(), String> {
            self.0.lock().unwrap().push(path.display().to_string());
            Ok(())
        }
    }

    pub struct Fixture {
        pub dir: tempfile::TempDir,
        pub env: Arc<Env>,
        pub events: Arc<RecordingEvents>,
        pub opener: Arc<RecordingOpener>,
        pub transport: Arc<FakeTransport>,
    }

    /// Окружение для тестов: всё во временной папке, секреты в памяти, сеть — заглушка.
    pub fn fixture(with_cloud: bool, replies: Vec<Result<crate::search::http::HttpResponse, crate::search::http::SearchError>>) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let paths = AppPaths::under(dir.path());
        let secrets: Arc<dyn SecretStore> = Arc::new(MemorySecretStore::default());
        let transport = FakeTransport::new(replies);
        let events = Arc::new(RecordingEvents::default());
        let opener = Arc::new(RecordingOpener::default());
        let cloud = with_cloud.then(|| {
            let config = CloudConfig::new("https://example.supabase.co", &format!("sb_publishable_{}", "a".repeat(30))).expect("config");
            Arc::new(CloudAuth::new(config, transport.clone(), Arc::new(SecretSessionStore(secrets.clone())), "DEVICE-1".into()))
        });
        let env = Arc::new(Env {
            device: Mutex::new(PrefsFile::load(&paths.device_prefs())),
            accounts: LocalAccounts::open_with(&paths.root, 1000).unwrap(),
            keys: DatabaseKeys::new(secrets.clone()),
            errors: ErrorLog::new(&paths.logs),
            paths,
            secrets,
            transport: transport.clone(),
            events: events.clone(),
            opener: opener.clone(),
            cloud,
            version: AppVersion::parse("1.1.0").unwrap(),
            device_id: "DEVICE-1".into(),
            bundle_id: "local.leadgenerator.app".into(),
            app_bundle: None,
            can_update: false,
            sleeper: crate::search::http::no_sleep(),
        });
        Fixture { dir, env, events, opener, transport }
    }
}
