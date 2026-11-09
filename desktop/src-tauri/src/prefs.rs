//! Настройки в JSON-файлах: `device.json` в корне данных (оформление, панели, обновления, окно) и
//! `prefs.json` в папке каждой учётной записи (автопоиск, резервные копии, почта, уведомления).
//! Имена полей совпадают с файлами Windows-версии, поэтому они читаются без преобразования.
//! Повреждённый файл не мешает запуску — берутся значения по умолчанию. Запись целиком или не запись вовсе.
//!
//! Интерфейс получает настройки одним объектом и присылает изменения частью объекта (`patch`).

use crate::util::{format_date, parse_date};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

pub const DEFAULT_CHECK_HOURS: u32 = 24;
pub const DEFAULT_LIGHT_THRESHOLD: u32 = 20;

/// Цвет вида #RRGGBB (в верхнем регистре) или None.
pub fn normalize_color(raw: &str) -> Option<String> {
    let s = raw.trim().trim_start_matches('#');
    (s.len() == 6 && s.chars().all(|c| c.is_ascii_hexdigit())).then(|| format!("#{}", s.to_uppercase()))
}

/// Настройки этого компьютера, не относящиеся к учётной записи.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DevicePrefs {
    /// Свой акцентный цвет (#RRGGBB) или None — цвет по умолчанию.
    pub accent: Option<String>,
    /// Масштаб интерфейса, 0.8–1.6.
    pub ui_scale: f64,
    pub nav_width: f64,
    pub nav_open: bool,
    pub nav_hidden: bool,
    pub inspector_width: f64,
    pub inspector_shown: bool,
    pub compact_rows: bool,
    pub animations: bool,
    /// Скрытые разделы и источники, порядок элементов боковой панели.
    pub sidebar_hidden: Vec<String>,
    pub sidebar_hidden_sources: Vec<String>,
    pub sidebar_order: Vec<String>,
    pub sidebar_source_order: Vec<String>,
    pub sidebar_counts: bool,
    pub sidebar_sources: bool,
    pub sidebar_hover: bool,
    /// Автоматический облегчённый режим: при режиме экономии системы или низком заряде батареи.
    pub light_mode_auto: bool,
    pub light_mode_threshold: u32,
    pub check_updates: bool,
    pub update_check_hours: u32,
    pub last_update_check: Option<String>,
    pub background_download: bool,
    /// Версия, для которой уже показан экран «Что нового» (или записана молча при первом запуске).
    pub last_seen_version: Option<String>,
    /// Закрытие окна оставляет приложение работать в трее (автопоиск и копии продолжаются).
    pub close_to_tray: bool,
    /// При запуске вместе с системой не показывать окно.
    pub start_minimized: bool,
    pub launch_at_login: bool,
    pub tray_hint_shown: bool,
    /// Имя локальной учётной записи, в которую входить автоматически.
    pub remembered_user: Option<String>,
    pub last_section: String,
    pub list_sort: String,
    pub list_sort_descending: bool,
    // Отчёты о сбоях.
    pub reports_offer_after_crash: bool,
    pub reports_log_errors: bool,
    pub reports_include_log: bool,
    pub reports_last_seen: Option<String>,
    /// Старые настройки (UserDefaults macOS) уже перенесены.
    pub legacy_imported: bool,
}

impl Default for DevicePrefs {
    fn default() -> Self {
        Self {
            accent: None,
            ui_scale: 1.0,
            nav_width: 260.0,
            nav_open: true,
            nav_hidden: false,
            inspector_width: 400.0,
            inspector_shown: true,
            compact_rows: false,
            animations: true,
            sidebar_hidden: vec![],
            sidebar_hidden_sources: vec![],
            sidebar_order: vec![],
            sidebar_source_order: vec![],
            sidebar_counts: true,
            sidebar_sources: true,
            sidebar_hover: true,
            light_mode_auto: true,
            light_mode_threshold: DEFAULT_LIGHT_THRESHOLD,
            check_updates: true,
            update_check_hours: DEFAULT_CHECK_HOURS,
            last_update_check: None,
            background_download: true,
            last_seen_version: None,
            close_to_tray: true,
            start_minimized: true,
            launch_at_login: false,
            tray_hint_shown: false,
            remembered_user: None,
            last_section: "all".into(),
            list_sort: "score".into(),
            list_sort_descending: true,
            reports_offer_after_crash: true,
            reports_log_errors: true,
            reports_include_log: true,
            reports_last_seen: None,
            legacy_imported: false,
        }
    }
}

impl DevicePrefs {
    /// Приводит значения к допустимым границам.
    pub fn normalize(&mut self) {
        self.accent = self.accent.as_deref().and_then(normalize_color);
        self.ui_scale = if self.ui_scale.is_finite() { self.ui_scale.clamp(0.8, 1.6) } else { 1.0 };
        self.nav_width = self.nav_width.clamp(180.0, 420.0);
        self.inspector_width = self.inspector_width.clamp(280.0, 640.0);
        self.light_mode_threshold = self.light_mode_threshold.clamp(5, 50);
        self.update_check_hours = normalized_hours(self.update_check_hours);
        if !["score", "date", "title", "source"].contains(&self.list_sort.as_str()) {
            self.list_sort = "score".into();
        }
    }

    pub fn last_update_check(&self) -> Option<DateTime<Utc>> {
        self.last_update_check.as_deref().and_then(parse_date)
    }
    pub fn set_last_update_check(&mut self, at: DateTime<Utc>) {
        self.last_update_check = Some(format_date(&at));
    }
}

fn normalized_hours(h: u32) -> u32 {
    if crate::updates::INTERVALS.iter().any(|(x, _)| *x == h) {
        h
    } else {
        DEFAULT_CHECK_HOURS
    }
}

/// Настройки одной учётной записи, которые не синхронизируются через облако.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AccountPrefs {
    pub auto_search_minutes: u32,
    pub signature: String,
    /// Папка резервных копий; пусто — стандартная.
    pub backup_directory: String,
    pub auto_backup: bool,
    pub keep_backups: u32,
    /// Своя папка для базы (после переноса) или None — стандартная.
    pub data_path: Option<String>,
    pub notify_new_leads: bool,
    pub notify_errors: bool,
    pub notify_sync: bool,
    /// Настройки почтового ящика (JSON без пароля; пароль — в защищённом хранилище).
    pub mail_account: String,
    pub mail_delivery: String,
    /// Спрашивать подтверждение перед звонком из карточки лида.
    pub confirm_calls: bool,
    pub confirm_calls_version: u32,
    /// Программа для звонков: system, whatsapp, telegram, viber, skype, teams, facetime.
    pub call_app: String,
    /// Мастер первого запуска пройден или пропущен для этой учётной записи.
    pub welcome_done: bool,
    pub export_last_tab: String,
}

impl Default for AccountPrefs {
    fn default() -> Self {
        Self {
            auto_search_minutes: 60,
            signature: String::new(),
            backup_directory: String::new(),
            auto_backup: true,
            keep_backups: 14,
            data_path: None,
            notify_new_leads: true,
            notify_errors: true,
            notify_sync: false,
            mail_account: String::new(),
            mail_delivery: "mailApp".into(),
            confirm_calls: true,
            confirm_calls_version: 0,
            call_app: "system".into(),
            welcome_done: false,
            export_last_tab: String::new(),
        }
    }
}

impl AccountPrefs {
    pub fn normalize(&mut self) {
        self.auto_search_minutes = self.auto_search_minutes.min(24 * 60);
        self.keep_backups = self.keep_backups.clamp(1, 365);
        // До версии 2 «выключено» записывалось при любом сохранении настроек, даже если пользователь
        // его не трогал, поэтому старое значение не считается выбором: звонок подтверждается по умолчанию.
        if self.confirm_calls_version < 2 {
            self.confirm_calls = true;
        }
        self.confirm_calls_version = 2;
        if !crate::contact::CALL_APPS.iter().any(|a| a.id == self.call_app) {
            self.call_app = "system".into();
        }
        // Windows записывал имя варианта с заглавной буквы (MailApp, Smtp).
        self.mail_delivery = match self.mail_delivery.to_lowercase().as_str() {
            "smtp" => "smtp".into(),
            _ => "mailApp".into(),
        };
    }
}

/// Файл настроек: чтение, слияние изменений, атомарная запись.
pub struct PrefsFile<T> {
    path: PathBuf,
    pub value: T,
}

pub trait Prefs: Serialize + for<'de> Deserialize<'de> + Default + Clone {
    fn normalize(&mut self);
}

impl Prefs for DevicePrefs {
    fn normalize(&mut self) {
        DevicePrefs::normalize(self)
    }
}
impl Prefs for AccountPrefs {
    fn normalize(&mut self) {
        AccountPrefs::normalize(self)
    }
}

impl<T: Prefs> PrefsFile<T> {
    /// Читает файл; нет файла или он испорчен — значения по умолчанию.
    pub fn load(path: &Path) -> Self {
        let mut value: T = fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        value.normalize();
        Self { path: path.to_path_buf(), value }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn exists(&self) -> bool {
        self.path.exists()
    }

    /// Применяет изменения (часть объекта настроек), проверяет, сохраняет. Неизвестные поля и значения
    /// неверного типа отбрасываются; остальные изменения применяются. Возвращает true, если что-то изменилось.
    pub fn patch(&mut self, changes: &Value) -> bool {
        let Some(changes) = changes.as_object() else { return false };
        let mut current = serde_json::to_value(&self.value).unwrap_or(Value::Null);
        let Some(cur) = current.as_object_mut() else { return false };
        for (k, v) in changes {
            if !cur.contains_key(k) {
                continue;
            }
            // Проверяем поле отдельно: неверный тип одного поля не портит остальные.
            let mut trial = cur.clone();
            trial.insert(k.clone(), v.clone());
            if serde_json::from_value::<T>(Value::Object(trial)).is_ok() {
                cur.insert(k.clone(), v.clone());
            }
        }
        let mut next: T = serde_json::from_value(current).unwrap_or_else(|_| self.value.clone());
        next.normalize();
        if serde_json::to_value(&next).ok() == serde_json::to_value(&self.value).ok() {
            return false;
        }
        self.value = next;
        self.save();
        true
    }

    /// Запись целиком или не запись вовсе: во временный файл и переименование.
    pub fn save(&self) {
        if let Some(dir) = self.path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let tmp = self.path.with_extension("json.tmp");
        if let Ok(text) = serde_json::to_string_pretty(&self.value) {
            if fs::write(&tmp, text).is_ok() {
                let _ = fs::rename(&tmp, &self.path);
            }
        }
    }

    pub fn to_json(&self) -> Value {
        serde_json::to_value(&self.value).unwrap_or(Value::Null)
    }
}

// ------------------------------------------------------------------ перенос из UserDefaults macOS

/// Значение из plist как JSON: bool, число, строка, дата (ISO 8601).
fn plist_json(v: &plist::Value) -> Option<Value> {
    match v {
        plist::Value::Boolean(b) => Some(json!(b)),
        plist::Value::Integer(i) => i.as_signed().map(|n| json!(n)),
        plist::Value::Real(r) => Some(json!(r)),
        plist::Value::String(s) => Some(json!(s)),
        plist::Value::Date(d) => parse_date(&d.to_xml_format()).map(|d| json!(format_date(&d))),
        _ => None,
    }
}

fn split_list(v: &Value) -> Value {
    let items: Vec<String> = v.as_str().unwrap_or("").split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    json!(items)
}

/// Настройки прежней macOS-версии (UserDefaults) → изменения для `DevicePrefs`.
pub fn legacy_device_patch(defaults: &plist::Dictionary) -> Value {
    let get = |k: &str| defaults.get(k).and_then(plist_json);
    let mut out = Map::new();
    let mut put = |key: &str, v: Option<Value>| {
        if let Some(v) = v {
            out.insert(key.into(), v);
        }
    };
    put("checkUpdates", get("updates.auto"));
    put("updateCheckHours", get("updates.intervalHours"));
    put("backgroundDownload", get("updates.background"));
    put("lastUpdateCheck", get("updates.lastCheck"));
    put("lastSeenVersion", get("app.lastSeenVersion"));
    put("lightModeAuto", get("power.auto"));
    put("lightModeThreshold", get("power.threshold").filter(|v| v.as_i64().unwrap_or(0) > 0));
    put("uiScale", get("appearance.scale").filter(|v| v.as_f64().unwrap_or(0.0) > 0.0));
    put("compactRows", get("appearance.density").map(|v| json!(v.as_str() == Some("compact"))));
    put("sidebarHidden", get("sidebar.hidden").map(|v| split_list(&v)));
    put("sidebarHiddenSources", get("sidebar.hiddenSources").map(|v| split_list(&v)));
    put("sidebarOrder", get("sidebar.order").map(|v| split_list(&v)));
    put("sidebarSourceOrder", get("sidebar.sourceOrder").map(|v| split_list(&v)));
    put("sidebarCounts", get("sidebar.counts"));
    put("sidebarSources", get("sidebar.sources"));
    put("sidebarHover", get("sidebar.hover"));
    put("reportsOfferAfterCrash", get("reports.offerAfterCrash"));
    put("reportsLogErrors", get("reports.logErrors"));
    put("reportsIncludeLog", get("reports.includeLog"));
    put("reportsLastSeen", get("reports.lastSeen"));
    Value::Object(out)
}

/// Настройки учётной записи из UserDefaults macOS (ключи вида `search.auto.<имя в нижнем регистре>`).
pub fn legacy_account_patch(defaults: &plist::Dictionary, username: &str) -> Value {
    let u = username.to_lowercase();
    let get = |k: &str| defaults.get(&format!("{k}.{u}")).and_then(plist_json);
    let mut out = Map::new();
    let mut put = |key: &str, v: Option<Value>| {
        if let Some(v) = v {
            out.insert(key.into(), v);
        }
    };
    put("autoSearchMinutes", get("search.auto"));
    put("backupDirectory", get("data.backupDir"));
    put("autoBackup", get("data.autoBackup"));
    put("keepBackups", get("data.keepBackups").filter(|v| v.as_i64().unwrap_or(0) > 0));
    put("dataPath", get("data.path"));
    put("mailAccount", defaults.get(&format!("mail.account.{u}")).or_else(|| defaults.get(&format!("mail.account.{username}"))).and_then(plist_json));
    put("mailDelivery", defaults.get(&format!("mail.delivery.{u}")).or_else(|| defaults.get(&format!("mail.delivery.{username}"))).and_then(plist_json));
    put("welcomeDone", get("welcome.done"));
    put("exportLastTab", defaults.get("export.lastTab").and_then(plist_json));
    Value::Object(out)
}

/// Подключение Notion (JSON без токена) из UserDefaults macOS. Теперь оно лежит в базе пользователя
/// (значение `export.notion`), как в Windows-версии, и переносится вместе с ней.
pub fn legacy_notion_config(defaults: &plist::Dictionary, username: &str) -> Option<String> {
    let u = username.to_lowercase();
    match defaults.get(&format!("export.notion.{u}")).or_else(|| defaults.get(&format!("export.notion.{username}")))? {
        plist::Value::Data(d) => String::from_utf8(d.clone()).ok().filter(|t| !t.trim().is_empty()),
        _ => None,
    }
}

/// Файл настроек macOS: ~/Library/Preferences/<bundle id>.plist.
pub fn read_defaults_plist(path: &Path) -> Option<plist::Dictionary> {
    plist::Value::from_file(path).ok()?.into_dictionary()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_or_broken_file_gives_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let p = PrefsFile::<DevicePrefs>::load(&dir.path().join("device.json"));
        assert_eq!(p.value, DevicePrefs::default());
        assert!(p.value.close_to_tray && p.value.animations && p.value.check_updates && p.value.sidebar_counts);
        assert_eq!((p.value.nav_width, p.value.inspector_width, p.value.update_check_hours, p.value.light_mode_threshold), (260.0, 400.0, 24, 20));
        fs::write(dir.path().join("bad.json"), "{не json").unwrap();
        assert_eq!(PrefsFile::<DevicePrefs>::load(&dir.path().join("bad.json")).value, DevicePrefs::default());
        let a = PrefsFile::<AccountPrefs>::load(&dir.path().join("prefs.json")).value;
        assert_eq!((a.auto_search_minutes, a.keep_backups, a.auto_backup, a.confirm_calls, a.mail_delivery.as_str()), (60, 14, true, true, "mailApp"));
    }

    #[test]
    fn reads_windows_device_json_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("device.json");
        fs::write(&path, r##"{"theme":"Dark","backdrop":"Mica","accent":"#12ab34","navWidth":9999,"navOpen":false,"inspectorWidth":100,"compactRows":true,"lightModeThreshold":99,"updateCheckHours":5,"lastUpdateCheck":"2026-11-05T09:42:00.0000000+00:00","lastSeenVersion":"1.0.9","rememberedUser":"anna","lastSection":"favorites","listSort":"weird","windowWidth":1360}"##).unwrap();
        let p = PrefsFile::<DevicePrefs>::load(&path).value;
        assert_eq!(p.accent.as_deref(), Some("#12AB34"));
        assert_eq!((p.nav_width, p.inspector_width, p.light_mode_threshold, p.update_check_hours), (420.0, 280.0, 50, 24));
        assert!(!p.nav_open && p.compact_rows);
        assert_eq!((p.remembered_user.as_deref(), p.last_section.as_str(), p.list_sort.as_str()), (Some("anna"), "favorites", "score"));
        assert_eq!(p.last_update_check().unwrap().timestamp(), 1_793_871_720);
    }

    #[test]
    fn reads_windows_account_json_and_resets_old_call_confirmation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("prefs.json");
        fs::write(&path, r#"{"autoSearchMinutes":99999,"keepBackups":0,"backupDirectory":"D:\\Копии","mailDelivery":"Smtp","confirmCalls":false,"welcomeDone":true,"notifySync":true}"#).unwrap();
        let a = PrefsFile::<AccountPrefs>::load(&path).value;
        assert_eq!((a.auto_search_minutes, a.keep_backups), (1440, 1));
        assert_eq!(a.backup_directory, "D:\\Копии");
        assert_eq!(a.mail_delivery, "smtp", "Windows писал имя варианта с заглавной буквы");
        assert!(a.confirm_calls, "старое «выключено» не считается выбором");
        assert!(a.welcome_done && a.notify_sync);
        fs::write(&path, r#"{"confirmCalls":false,"confirmCallsVersion":2}"#).unwrap();
        assert!(!PrefsFile::<AccountPrefs>::load(&path).value.confirm_calls);
    }

    #[test]
    fn patch_validates_saves_and_reports_changes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub/device.json");
        let mut p = PrefsFile::<DevicePrefs>::load(&path);
        assert!(p.patch(&json!({"navWidth": 500, "accent": "ff0000", "animations": false, "unknown": 1, "compactRows": "да"})));
        assert_eq!((p.value.nav_width, p.value.accent.as_deref(), p.value.animations, p.value.compact_rows), (420.0, Some("#FF0000"), false, false));
        assert!(!p.patch(&json!({"animations": false})), "то же значение — не изменение");
        assert!(!p.patch(&json!("не объект")));
        let again = PrefsFile::<DevicePrefs>::load(&path);
        assert_eq!(again.value, p.value, "сохранено на диск");
        assert!(!path.with_extension("json.tmp").exists());
        assert_eq!(p.to_json()["navWidth"], 420.0);
    }

    #[test]
    fn imports_macos_user_defaults() {
        let mut d = plist::Dictionary::new();
        d.insert("updates.auto".into(), false.into());
        d.insert("updates.intervalHours".into(), 6.into());
        d.insert("power.threshold".into(), 30.into());
        d.insert("appearance.density".into(), "compact".into());
        d.insert("appearance.scale".into(), 1.2.into());
        d.insert("sidebar.hidden".into(), "archive, excluded".into());
        d.insert("sidebar.counts".into(), false.into());
        d.insert("app.lastSeenVersion".into(), "1.0.9".into());
        d.insert("search.auto.anna".into(), 30.into());
        d.insert("data.backupDir.anna".into(), "/Users/a/Копии".into());
        d.insert("data.keepBackups.anna".into(), 0.into());
        d.insert("mail.account.anna".into(), r#"{"email":"a@b.c"}"#.into());
        d.insert("welcome.done.anna".into(), true.into());
        d.insert("export.notion.anna".into(), plist::Value::Data(br#"{"database":"x"}"#.to_vec()));
        d.insert("search.auto.boris".into(), 5.into());
        let mut dev = PrefsFile::<DevicePrefs>::load(Path::new("/nonexistent/device.json"));
        let dir = tempfile::tempdir().unwrap();
        dev.path = dir.path().join("device.json");
        assert!(dev.patch(&legacy_device_patch(&d)));
        assert_eq!(
            (dev.value.check_updates, dev.value.update_check_hours, dev.value.light_mode_threshold, dev.value.compact_rows, dev.value.ui_scale),
            (false, 6, 30, true, 1.2)
        );
        assert_eq!(dev.value.sidebar_hidden, ["archive", "excluded"]);
        assert!(!dev.value.sidebar_counts);
        assert_eq!(dev.value.last_seen_version.as_deref(), Some("1.0.9"));
        let mut acc = PrefsFile::<AccountPrefs>::load(&dir.path().join("prefs.json"));
        assert!(acc.patch(&legacy_account_patch(&d, "Anna")));
        assert_eq!(
            (acc.value.auto_search_minutes, acc.value.backup_directory.as_str(), acc.value.keep_backups, acc.value.welcome_done),
            (30, "/Users/a/Копии", 14, true)
        );
        assert_eq!(acc.value.mail_account, r#"{"email":"a@b.c"}"#);
        assert_eq!(legacy_notion_config(&d, "Anna").as_deref(), Some(r#"{"database":"x"}"#));
        assert!(legacy_notion_config(&d, "boris").is_none());
        let boris = legacy_account_patch(&d, "boris");
        assert_eq!(boris["autoSearchMinutes"], 5);
    }

    #[test]
    fn plist_roundtrip_from_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.plist");
        let mut d = plist::Dictionary::new();
        d.insert("updates.auto".into(), true.into());
        plist::Value::Dictionary(d).to_file_xml(&path).unwrap();
        assert!(read_defaults_plist(&path).unwrap().contains_key("updates.auto"));
        assert!(read_defaults_plist(&dir.path().join("missing.plist")).is_none());
    }
}
