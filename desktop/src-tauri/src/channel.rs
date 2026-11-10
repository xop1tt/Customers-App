//! Каналы приложения: Stable (обычная пользовательская версия) и Beta (Debug/Beta для разработки и проверки).
//!
//! Канал выбирается при сборке и не меняется во время работы:
//! * Stable — релизная сборка без признака `beta`. Все её идентификаторы и папки совпадают с прежними версиями,
//!   поэтому установленная Stable-версия и её данные не меняются.
//! * Beta — сборка с признаком `beta` (`npm run debug:build`) и любая отладочная сборка (`debug_assertions`,
//!   то есть `tauri dev`): своя папка данных, свои секреты, своя схема ссылок, свой канал обновлений.
//!
//! Защита от пересечения (см. docs/DEBUG_BUILD.md): при запуске проверяется, что идентификатор приложения из
//! конфигурации Tauri совпадает с каналом, папки канала не совпадают и не вложены в папки другого канала,
//! а папка данных не помечена другим каналом. Любой путь, куда пользователь просит записать или откуда
//! прочитать базу (перенос, восстановление, экспорт, папка копий), проверяется тем же правилом.

use crate::paths::AppPaths;
use serde::Serialize;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Stable,
    Beta,
}

/// Всё, чем установки разных каналов отличаются друг от друга.
#[derive(Debug, Clone, PartialEq)]
pub struct Identity {
    /// Идентификатор приложения (bundle id macOS, имя для single-instance, папка WebView, уведомления).
    pub identifier: &'static str,
    pub product_name: &'static str,
    /// Схема ссылок возврата из писем (подтверждение адреса, восстановление пароля).
    pub url_scheme: &'static str,
    /// Сервис записей в Связке ключей macOS.
    pub keychain_service: &'static str,
    /// Дополнительная энтропия DPAPI на Windows.
    pub dpapi_entropy: &'static [u8],
    /// Папки данных и журналов.
    pub mac_data: &'static str,
    pub mac_logs: &'static str,
    pub windows_data: &'static str,
    pub linux_data: &'static str,
    /// Папка резервных копий в «Документах».
    pub backups: &'static str,
    /// Начало имени файлов релиза: Customers-v1.2.0-macOS.dmg / Customers-Beta-v1.3.0-beta.1-macOS.dmg.
    pub asset_prefix: &'static str,
    /// Имя исполняемого файла: по нему macOS называет отчёты о сбоях.
    pub binary: &'static str,
}

const STABLE: Identity = Identity {
    identifier: "local.leadgenerator.app",
    product_name: "Customers",
    url_scheme: "leadgenerator",
    keychain_service: "LeadGenerator",
    dpapi_entropy: b"Customers.Secrets.v1",
    mac_data: "Library/Application Support/Lead Generator",
    mac_logs: "Library/Logs/LeadGenerator",
    windows_data: "Customers",
    linux_data: ".local/share/customers",
    backups: "Customers Backups",
    asset_prefix: "Customers-v",
    binary: "customers",
};

const BETA: Identity = Identity {
    identifier: "local.customers.beta",
    product_name: "Customers Beta",
    url_scheme: "customers-beta",
    keychain_service: "Customers Beta",
    dpapi_entropy: b"Customers.Beta.Secrets.v1",
    mac_data: "Library/Application Support/Customers Beta",
    mac_logs: "Library/Logs/Customers Beta",
    windows_data: "Customers Beta",
    linux_data: ".local/share/customers-beta",
    backups: "Customers Beta Backups",
    asset_prefix: "Customers-Beta-v",
    binary: "customers-beta",
};

/// Имя файла-метки канала в корне папки данных.
pub const MARKER_FILE: &str = "channel.json";

impl Channel {
    /// Канал этой сборки. Отладочная сборка всегда Beta: `tauri dev` не должен работать с данными Stable.
    pub const fn current() -> Self {
        if cfg!(feature = "beta") || cfg!(debug_assertions) {
            Channel::Beta
        } else {
            Channel::Stable
        }
    }

    pub const fn identity(self) -> &'static Identity {
        match self {
            Channel::Stable => &STABLE,
            Channel::Beta => &BETA,
        }
    }

    pub const fn other(self) -> Self {
        match self {
            Channel::Stable => Channel::Beta,
            Channel::Beta => Channel::Stable,
        }
    }

    pub const fn is_beta(self) -> bool {
        matches!(self, Channel::Beta)
    }

    pub fn name(self) -> &'static str {
        match self {
            Channel::Stable => "stable",
            Channel::Beta => "beta",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum IsolationError {
    /// Идентификатор из tauri.conf.json не совпадает с каналом сборки (например, `tauri dev` без beta-конфигурации).
    WrongIdentifier { channel: Channel, expected: String, actual: String },
    /// Папка этого канала совпадает с папкой другого канала или вложена в неё (или наоборот).
    Overlap { own: PathBuf, other: PathBuf },
    /// Папка данных помечена другим каналом.
    ForeignMarker { root: PathBuf, found: String },
    /// Путь, указанный пользователем, ведёт в данные другого канала.
    ForbiddenPath { path: PathBuf, other: PathBuf },
}

impl std::fmt::Display for IsolationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IsolationError::WrongIdentifier { channel, expected, actual } => write!(
                f,
                "Сборка канала {} запущена с идентификатором «{actual}», нужен «{expected}». Запуск остановлен, чтобы не тронуть данные другой версии. \
                 Для разработки используйте npm run dev:beta.",
                channel.name()
            ),
            IsolationError::Overlap { own, other } => write!(
                f,
                "Папка {} пересекается с папкой другой версии Customers ({}). Запуск остановлен, чтобы не тронуть её данные.",
                own.display(),
                other.display()
            ),
            IsolationError::ForeignMarker { root, found } => {
                write!(f, "Папка {} принадлежит версии «{found}». Запуск остановлен, чтобы не тронуть её данные.", root.display())
            }
            IsolationError::ForbiddenPath { path, other } => {
                write!(f, "Путь {} относится к данным другой версии Customers ({}). Выберите другую папку.", path.display(), other.display())
            }
        }
    }
}

/// Путь без «.» и «..», с разрешёнными ссылками там, где путь уже существует.
/// Сравнение должно видеть, что `~/A/../B` и ссылка на `~/B` — одна и та же папка.
pub fn resolve(path: &Path) -> PathBuf {
    let mut lexical = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                lexical.pop();
            }
            Component::CurDir => {}
            other => lexical.push(other.as_os_str()),
        }
    }
    // Ближайший существующий предок разворачивается через canonicalize, остаток дописывается.
    let mut existing = lexical.clone();
    let mut rest: Vec<std::ffi::OsString> = vec![];
    loop {
        if let Ok(c) = std::fs::canonicalize(&existing) {
            let mut out = c;
            for r in rest.iter().rev() {
                out.push(r);
            }
            return normalize_case(out);
        }
        match (existing.file_name().map(|n| n.to_os_string()), existing.parent().map(Path::to_path_buf)) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                existing = parent;
            }
            _ => return normalize_case(lexical),
        }
    }
}

/// На macOS и Windows файловая система обычно не различает регистр: «Customers» и «customers» — одна папка.
fn normalize_case(p: PathBuf) -> PathBuf {
    if cfg!(any(windows, target_os = "macos")) {
        PathBuf::from(p.to_string_lossy().to_lowercase())
    } else {
        p
    }
}

/// `a` совпадает с `b` или лежит внутри неё.
fn within(a: &Path, b: &Path) -> bool {
    a.starts_with(b)
}

fn overlaps(a: &Path, b: &Path) -> bool {
    within(a, b) || within(b, a)
}

/// Папки данных одного канала, которые не должны пересекаться с папками другого.
#[derive(Debug, Clone, PartialEq)]
pub struct ChannelDirs {
    pub channel: Channel,
    pub root: PathBuf,
    pub logs: PathBuf,
    pub backups: PathBuf,
    /// Прежние места данных (только Stable): база 1.0, папка копий прежней macOS-версии, файл настроек.
    pub legacy: Vec<PathBuf>,
}

impl ChannelDirs {
    pub fn of(channel: Channel, paths: &AppPaths) -> Self {
        let mut legacy = vec![];
        if channel == Channel::Stable {
            legacy.push(paths.documents.join("Lead Generator Backups"));
            if let Some(p) = &paths.legacy_defaults {
                legacy.push(p.clone());
            }
        }
        Self { channel, root: paths.root.clone(), logs: paths.logs.clone(), backups: paths.documents.join(channel.identity().backups), legacy }
    }

    fn own(&self) -> Vec<&PathBuf> {
        vec![&self.root, &self.logs, &self.backups]
    }

    fn all(&self) -> Vec<&PathBuf> {
        let mut v = self.own();
        v.extend(self.legacy.iter());
        v
    }
}

/// Проверка разделения каналов. Создаётся при запуске и хранится в окружении приложения.
#[derive(Debug, Clone, PartialEq)]
pub struct Isolation {
    pub channel: Channel,
    own: ChannelDirs,
    other: ChannelDirs,
}

impl Isolation {
    pub fn new(own: ChannelDirs, other: ChannelDirs) -> Self {
        Self { channel: own.channel, own, other }
    }

    /// Папки обоих каналов для этой системы.
    pub fn for_system(channel: Channel, home: &Path, local_app_data: Option<&Path>, documents: Option<PathBuf>) -> Self {
        let own = AppPaths::for_channel(channel, home, local_app_data, documents.clone());
        let other = AppPaths::for_channel(channel.other(), home, local_app_data, documents);
        Self::new(ChannelDirs::of(channel, &own), ChannelDirs::of(channel.other(), &other))
    }

    /// Для тестов и портативного запуска: другой канал лежит в несуществующей папке, ничего не запрещает.
    pub fn none(channel: Channel, paths: &AppPaths) -> Self {
        let nowhere = Path::new("/nonexistent-customers-other-channel");
        let other =
            ChannelDirs { channel: channel.other(), root: nowhere.join("data"), logs: nowhere.join("logs"), backups: nowhere.join("backups"), legacy: vec![] };
        Self::new(ChannelDirs::of(channel, paths), other)
    }

    pub fn other_dirs(&self) -> &ChannelDirs {
        &self.other
    }
    pub fn own_dirs(&self) -> &ChannelDirs {
        &self.own
    }

    /// Идентификатор из конфигурации Tauri совпадает с каналом сборки.
    pub fn check_identifier(&self, actual: &str) -> Result<(), IsolationError> {
        let expected = self.channel.identity().identifier;
        if actual == expected {
            Ok(())
        } else {
            Err(IsolationError::WrongIdentifier { channel: self.channel, expected: expected.into(), actual: actual.into() })
        }
    }

    /// Ни одна папка этого канала не совпадает и не вложена в папки другого (и наоборот).
    pub fn check_dirs(&self) -> Result<(), IsolationError> {
        for own in self.own.own() {
            let a = resolve(own);
            for other in self.other.all() {
                if overlaps(&a, &resolve(other)) {
                    return Err(IsolationError::Overlap { own: own.clone(), other: other.clone() });
                }
            }
        }
        Ok(())
    }

    /// Путь, выбранный пользователем (база, папка копий, файл экспорта или восстановления), не ведёт в данные другого канала.
    pub fn check_path(&self, path: &Path) -> Result<(), IsolationError> {
        let p = resolve(path);
        for other in self.other.all() {
            if within(&p, &resolve(other)) {
                return Err(IsolationError::ForbiddenPath { path: path.to_path_buf(), other: other.clone() });
            }
        }
        Ok(())
    }

    /// Метка канала в папке данных. Beta ставит свою метку; Stable папку не меняет, только проверяет,
    /// что в ней нет метки Beta (так Stable не откроет данные Beta, даже если папки как-то совпали).
    pub fn check_marker(&self) -> Result<(), IsolationError> {
        let path = self.own.root.join(MARKER_FILE);
        if let Ok(text) = std::fs::read_to_string(&path) {
            let found = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v.get("channel").and_then(|c| c.as_str()).map(str::to_string))
                .unwrap_or_else(|| "неизвестно".into());
            if found != self.channel.name() {
                return Err(IsolationError::ForeignMarker { root: self.own.root.clone(), found });
            }
            return Ok(());
        }
        if self.channel.is_beta() {
            let _ = std::fs::create_dir_all(&self.own.root);
            let body = serde_json::json!({"channel": self.channel.name(), "identifier": self.channel.identity().identifier});
            std::fs::write(&path, body.to_string())
                .map_err(|_| IsolationError::ForeignMarker { root: self.own.root.clone(), found: "не удалось записать метку".into() })?;
        }
        Ok(())
    }

    /// Все проверки запуска по порядку.
    pub fn check_startup(&self, identifier: &str) -> Result<(), IsolationError> {
        self.check_identifier(identifier)?;
        self.check_dirs()?;
        self.check_marker()
    }

    /// Отчёт для диагностики: какие папки у каждого канала и прошли ли проверки.
    pub fn report(&self) -> serde_json::Value {
        let dirs = |d: &ChannelDirs| {
            serde_json::json!({
                "channel": d.channel.name(),
                "root": d.root.display().to_string(),
                "logs": d.logs.display().to_string(),
                "backups": d.backups.display().to_string(),
            })
        };
        serde_json::json!({
            "channel": self.channel.name(),
            "identifier": self.channel.identity().identifier,
            "own": dirs(&self.own),
            "other": dirs(&self.other),
            "dirsSeparate": self.check_dirs().is_ok(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn identities_differ_in_every_isolating_field() {
        let (s, b) = (Channel::Stable.identity(), Channel::Beta.identity());
        assert_ne!(s.identifier, b.identifier);
        assert_ne!(s.product_name, b.product_name);
        assert_ne!(s.url_scheme, b.url_scheme);
        assert_ne!(s.keychain_service, b.keychain_service);
        assert_ne!(s.dpapi_entropy, b.dpapi_entropy);
        assert_ne!(s.mac_data, b.mac_data);
        assert_ne!(s.mac_logs, b.mac_logs);
        assert_ne!(s.windows_data.to_lowercase(), b.windows_data.to_lowercase());
        assert_ne!(s.linux_data, b.linux_data);
        assert_ne!(s.backups, b.backups);
        assert_ne!(s.binary, b.binary);
        // Префиксы файлов релиза не должны находить друг друга: «Customers-v» не начало «Customers-Beta-v».
        assert!(!b.asset_prefix.starts_with(s.asset_prefix) && !s.asset_prefix.starts_with(b.asset_prefix));
    }

    #[test]
    fn stable_identity_matches_previous_versions() {
        // Эти значения уже записаны у пользователей: изменение потеряло бы данные или ключи.
        let s = Channel::Stable.identity();
        assert_eq!(s.identifier, "local.leadgenerator.app");
        assert_eq!(s.url_scheme, "leadgenerator");
        assert_eq!(s.keychain_service, "LeadGenerator");
        assert_eq!(s.dpapi_entropy, b"Customers.Secrets.v1");
        assert_eq!(s.mac_data, "Library/Application Support/Lead Generator");
        assert_eq!(s.windows_data, "Customers");
    }

    #[test]
    fn debug_builds_are_never_stable() {
        if cfg!(debug_assertions) || cfg!(feature = "beta") {
            assert_eq!(Channel::current(), Channel::Beta);
        } else {
            assert_eq!(Channel::current(), Channel::Stable);
        }
        assert_eq!(Channel::Stable.other(), Channel::Beta);
        assert_eq!(Channel::Beta.other(), Channel::Stable);
    }

    #[test]
    fn system_folders_of_channels_are_separate() {
        let h = home();
        for ch in [Channel::Stable, Channel::Beta] {
            let iso = Isolation::for_system(ch, h.path(), Some(&h.path().join("AppData/Local")), None);
            iso.check_dirs().unwrap();
            assert_ne!(iso.own_dirs().root, iso.other_dirs().root);
        }
    }

    #[test]
    fn identifier_mismatch_stops_start() {
        let h = home();
        let beta = Isolation::for_system(Channel::Beta, h.path(), None, None);
        assert!(beta.check_identifier("local.customers.beta").is_ok());
        let e = beta.check_identifier("local.leadgenerator.app").unwrap_err();
        assert!(matches!(e, IsolationError::WrongIdentifier { .. }));
        assert!(e.to_string().contains("dev:beta"));
        let stable = Isolation::for_system(Channel::Stable, h.path(), None, None);
        assert!(stable.check_identifier("local.customers.beta").is_err());
    }

    fn dirs(ch: Channel, base: &Path) -> ChannelDirs {
        ChannelDirs { channel: ch, root: base.join("data"), logs: base.join("logs"), backups: base.join("backups"), legacy: vec![] }
    }

    #[test]
    fn overlapping_or_nested_folders_are_rejected() {
        let h = home();
        let p = h.path();
        // Совпадение.
        let iso = Isolation::new(dirs(Channel::Beta, &p.join("same")), dirs(Channel::Stable, &p.join("same")));
        assert!(matches!(iso.check_dirs(), Err(IsolationError::Overlap { .. })));
        // Папка Beta внутри данных Stable.
        let mut beta = dirs(Channel::Beta, &p.join("b"));
        beta.root = p.join("s/data/beta");
        let iso = Isolation::new(beta, dirs(Channel::Stable, &p.join("s")));
        assert!(iso.check_dirs().is_err());
        // Данные Stable внутри папки Beta.
        let mut beta = dirs(Channel::Beta, &p.join("b"));
        beta.root = p.join("s");
        let iso = Isolation::new(beta, dirs(Channel::Stable, &p.join("s")));
        assert!(iso.check_dirs().is_err());
        // Через «..».
        let mut beta = dirs(Channel::Beta, &p.join("b"));
        beta.logs = p.join("b/../s/logs");
        let iso = Isolation::new(beta, dirs(Channel::Stable, &p.join("s")));
        assert!(iso.check_dirs().is_err());
        // Отдельные папки с похожим началом имени — не пересечение.
        let iso = Isolation::new(dirs(Channel::Beta, &p.join("Customers Beta")), dirs(Channel::Stable, &p.join("Customers")));
        iso.check_dirs().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlink_into_other_channel_is_rejected() {
        let h = home();
        let p = h.path();
        std::fs::create_dir_all(p.join("s/data")).unwrap();
        std::os::unix::fs::symlink(p.join("s/data"), p.join("link")).unwrap();
        let mut beta = dirs(Channel::Beta, &p.join("b"));
        beta.root = p.join("link");
        let iso = Isolation::new(beta, dirs(Channel::Stable, &p.join("s")));
        assert!(matches!(iso.check_dirs(), Err(IsolationError::Overlap { .. })));
        let iso = Isolation::new(dirs(Channel::Beta, &p.join("b")), dirs(Channel::Stable, &p.join("s")));
        assert!(iso.check_path(&p.join("link/leads.db")).is_err());
    }

    #[test]
    fn user_paths_into_other_channel_are_rejected() {
        let h = home();
        let p = h.path();
        let mut stable = dirs(Channel::Stable, &p.join("s"));
        stable.legacy.push(p.join("Documents/Lead Generator Backups"));
        let iso = Isolation::new(dirs(Channel::Beta, &p.join("b")), stable);
        for bad in
            ["s/data/anna/leads.db", "s/data", "s/backups/anna/x.db", "s/logs/a.txt", "Documents/Lead Generator Backups/anna/leadgen.db", "b/../s/data/x.db"]
        {
            let e = iso.check_path(&p.join(bad)).unwrap_err();
            assert!(matches!(e, IsolationError::ForbiddenPath { .. }), "{bad}");
        }
        for ok in ["b/data/anna/leads.db", "Desktop/export.csv", "s-other/leads.db", "Documents/Customers Beta Backups/a.db"] {
            iso.check_path(&p.join(ok)).unwrap_or_else(|e| panic!("{ok}: {e}"));
        }
    }

    #[test]
    fn beta_writes_marker_and_both_channels_refuse_foreign_marker() {
        let h = home();
        let p = h.path();
        let beta = Isolation::new(dirs(Channel::Beta, &p.join("b")), dirs(Channel::Stable, &p.join("s")));
        beta.check_marker().unwrap();
        let text = std::fs::read_to_string(p.join("b/data").join(MARKER_FILE)).unwrap();
        assert!(text.contains("\"beta\""));
        beta.check_marker().unwrap(); // повторный запуск

        // Stable не пишет метку в свою папку (её данные не меняются)…
        let stable = Isolation::new(dirs(Channel::Stable, &p.join("s")), dirs(Channel::Beta, &p.join("b")));
        stable.check_marker().unwrap();
        assert!(!p.join("s/data").join(MARKER_FILE).exists());
        // …но отказывается работать в папке с меткой Beta.
        let confused = Isolation::new(dirs(Channel::Stable, &p.join("b")), dirs(Channel::Beta, &p.join("x")));
        assert!(matches!(confused.check_marker(), Err(IsolationError::ForeignMarker { .. })));
        // Beta отказывается от папки с чужой или испорченной меткой.
        std::fs::create_dir_all(p.join("c/data")).unwrap();
        std::fs::write(p.join("c/data").join(MARKER_FILE), "{\"channel\":\"stable\"}").unwrap();
        let b2 = Isolation::new(dirs(Channel::Beta, &p.join("c")), dirs(Channel::Stable, &p.join("s")));
        assert!(b2.check_marker().is_err());
        std::fs::write(p.join("c/data").join(MARKER_FILE), "мусор").unwrap();
        assert!(b2.check_marker().is_err());
    }

    #[test]
    fn startup_check_runs_all_steps() {
        let h = home();
        let p = h.path();
        let beta = Isolation::new(dirs(Channel::Beta, &p.join("b")), dirs(Channel::Stable, &p.join("s")));
        assert!(beta.check_startup("local.leadgenerator.app").is_err());
        assert!(!p.join("b/data").join(MARKER_FILE).exists(), "при неверном идентификаторе ничего не пишется");
        beta.check_startup("local.customers.beta").unwrap();
        let r = beta.report();
        assert_eq!(r["channel"], "beta");
        assert_eq!(r["dirsSeparate"], true);
    }

    #[test]
    fn resolve_handles_dots_and_missing_tail() {
        let h = home();
        let p = h.path();
        let a = resolve(&p.join("x/./y/../z/new.db"));
        assert_eq!(a, resolve(&p.join("x/z/new.db")));
        assert!(a.ends_with("new.db"));
    }
}
