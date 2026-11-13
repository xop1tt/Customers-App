//! Где приложение хранит данные. Папки совпадают с прежними версиями, поэтому после обновления
//! все данные находятся на месте и копировать ничего не нужно:
//! macOS — ~/Library/Application Support/Lead Generator, Windows — %LOCALAPPDATA%\Customers.

use crate::identity::APP;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub struct AppPaths {
    /// Корень данных: учётные записи, базы пользователей, настройки, секреты.
    pub root: PathBuf,
    /// Журналы и отчёты о сбоях.
    pub logs: PathBuf,
    /// «Документы» пользователя: сюда по умолчанию складываются резервные копии.
    pub documents: PathBuf,
    /// Файл настроек прежней macOS-версии (UserDefaults), если он есть на этой системе.
    pub legacy_defaults: Option<PathBuf>,
}

impl AppPaths {
    pub fn new(root: PathBuf, logs: PathBuf, documents: PathBuf) -> Self {
        Self { root, logs, documents, legacy_defaults: None }
    }

    pub fn with_legacy_defaults(mut self, plist: PathBuf) -> Self {
        self.legacy_defaults = Some(plist);
        self
    }

    /// Всё в одной папке (тесты и портативный запуск).
    pub fn under(dir: &Path) -> Self {
        Self::new(dir.join("data"), dir.join("logs"), dir.join("documents"))
    }

    /// Стандартные папки текущей системы (с файлом настроек прежней macOS-версии).
    /// `home` — домашняя папка, `local_app_data` — только Windows.
    pub fn for_system(home: &Path, local_app_data: Option<&Path>, documents: Option<PathBuf>) -> Self {
        let documents = documents.unwrap_or_else(|| home.join("Documents"));
        if cfg!(windows) {
            let local = local_app_data.map(Path::to_path_buf).unwrap_or_else(|| home.join("AppData").join("Local"));
            let root = local.join(APP.windows_data);
            Self::new(root.clone(), root.join("logs"), documents)
        } else if cfg!(target_os = "macos") {
            Self::new(home.join(APP.mac_data), home.join(APP.mac_logs), documents)
                .with_legacy_defaults(home.join("Library/Preferences/local.leadgenerator.app.plist"))
        } else {
            let root = home.join(APP.linux_data);
            Self::new(root.clone(), root.join("logs"), documents)
        }
    }

    pub fn secrets(&self) -> PathBuf {
        self.root.join("secrets")
    }
    pub fn device_prefs(&self) -> PathBuf {
        self.root.join("device.json")
    }
    pub fn updates(&self) -> PathBuf {
        self.root.join("updates")
    }
    pub fn crashes(&self) -> PathBuf {
        self.logs.join("crashes")
    }
    pub fn default_backups(&self, username: &str) -> PathBuf {
        self.documents.join(APP.backups).join(username)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_folders_match_previous_versions() {
        let p = AppPaths::for_system(Path::new("/home/a"), Some(Path::new("/home/a/AppData/Local")), None);
        if cfg!(windows) {
            assert_eq!(p.root, Path::new("/home/a/AppData/Local").join("Customers"));
            assert_eq!(p.logs, p.root.join("logs"));
        } else if cfg!(target_os = "macos") {
            assert_eq!(p.root, Path::new("/home/a/Library/Application Support/Lead Generator"));
            assert_eq!(p.logs, Path::new("/home/a/Library/Logs/LeadGenerator"));
        }
        assert_eq!(p.documents, Path::new("/home/a/Documents"));
        assert_eq!(p.secrets(), p.root.join("secrets"));
        assert_eq!(p.default_backups("anna"), Path::new("/home/a/Documents/Customers Backups/anna"));
        assert_eq!(p.device_prefs(), p.root.join("device.json"));
    }
}
