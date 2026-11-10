//! Где приложение хранит данные. Папки совпадают с прежними версиями, поэтому после обновления
//! все данные находятся на месте и копировать ничего не нужно:
//! macOS — ~/Library/Application Support/Lead Generator, Windows — %LOCALAPPDATA%\Customers.

use crate::channel::Channel;
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

    /// Стандартные папки текущей системы для Stable. `home` — домашняя папка, `local_app_data` — только Windows.
    pub fn for_system(home: &Path, local_app_data: Option<&Path>, documents: Option<PathBuf>) -> Self {
        Self::for_channel(Channel::Stable, home, local_app_data, documents)
    }

    /// Стандартные папки канала. Stable — прежние папки (с файлом настроек прежней macOS-версии),
    /// Beta — свои папки рядом, без доступа к прежним данным.
    pub fn for_channel(channel: Channel, home: &Path, local_app_data: Option<&Path>, documents: Option<PathBuf>) -> Self {
        let id = channel.identity();
        let documents = documents.unwrap_or_else(|| home.join("Documents"));
        if cfg!(windows) {
            let local = local_app_data.map(Path::to_path_buf).unwrap_or_else(|| home.join("AppData").join("Local"));
            let root = local.join(id.windows_data);
            Self::new(root.clone(), root.join("logs"), documents)
        } else if cfg!(target_os = "macos") {
            let p = Self::new(home.join(id.mac_data), home.join(id.mac_logs), documents);
            match channel {
                Channel::Stable => p.with_legacy_defaults(home.join("Library/Preferences/local.leadgenerator.app.plist")),
                Channel::Beta => p,
            }
        } else {
            let root = home.join(id.linux_data);
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
        self.documents.join("Customers Backups").join(username)
    }
    /// Папка копий канала: у Beta своя, чтобы копии разных версий не смешивались.
    pub fn channel_backups(&self, channel: Channel, username: &str) -> PathBuf {
        self.documents.join(channel.identity().backups).join(username)
    }
    /// Папка резервных копий прежней macOS-версии: если она есть, копии продолжают лежать в ней.
    pub fn legacy_backups(&self, username: &str) -> PathBuf {
        self.documents.join("Lead Generator Backups").join(username)
    }
    /// База версии 1.0, созданная до появления учётных записей.
    pub fn legacy_database(&self) -> PathBuf {
        self.root.join("leads.db")
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
        assert_eq!(p.legacy_backups("anna"), Path::new("/home/a/Documents/Lead Generator Backups/anna"));
        assert_eq!(p.device_prefs(), p.root.join("device.json"));
    }

    #[test]
    fn stable_channel_is_the_previous_layout_and_beta_is_separate() {
        let (home, local) = (Path::new("/home/a"), Some(Path::new("/home/a/AppData/Local")));
        assert_eq!(AppPaths::for_channel(Channel::Stable, home, local, None), AppPaths::for_system(home, local, None));
        let b = AppPaths::for_channel(Channel::Beta, home, local, None);
        if cfg!(windows) {
            assert_eq!(b.root, Path::new("/home/a/AppData/Local").join("Customers Beta"));
        } else if cfg!(target_os = "macos") {
            assert_eq!(b.root, Path::new("/home/a/Library/Application Support/Customers Beta"));
            assert_eq!(b.logs, Path::new("/home/a/Library/Logs/Customers Beta"));
        } else {
            assert_eq!(b.root, Path::new("/home/a/.local/share/customers-beta"));
        }
        assert_eq!(b.legacy_defaults, None, "Beta не читает настройки прежней версии");
        assert_eq!(b.channel_backups(Channel::Beta, "anna"), Path::new("/home/a/Documents/Customers Beta Backups/anna"));
        assert_eq!(b.channel_backups(Channel::Stable, "anna"), b.default_backups("anna"));
    }
}
