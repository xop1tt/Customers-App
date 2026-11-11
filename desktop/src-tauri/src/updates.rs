//! Обновления из GitHub Releases: проверка, список релизов для «Что нового», скачивание с проверкой SHA-256,
//! установка. Без серверов и ключей: публичный API и файлы, которые публикует release.yml.
//! Сетевые вызовы идут через `HttpTransport`, поэтому вся логика проверяется тестами без интернета.

use crate::search::http::{HttpRequest, HttpTransport, SearchError, Sleeper};
use crate::util::{format_date, parse_date, AppVersion};
use chrono::{DateTime, Duration, Utc};
use fancy_regex::Regex as FRegex;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub const REPOSITORY: &str = "xop1tt/Customers-App";
/// Начало имён файлов снятых с выпуска Beta-сборок (Customers-Beta-v1.3.0-beta.1-macOS.dmg): их приложение не ставит.
pub const BETA_ASSET_PREFIX: &str = "Customers-Beta-";
pub const RELEASES_PAGE: &str = "https://github.com/xop1tt/Customers-App/releases";
pub const WIKI_PAGE: &str = "https://github.com/xop1tt/Customers-App/wiki";

pub fn user_agent(version: &str) -> String {
    format!("Customers/{version} ({})", Platform::current().label())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    MacOs,
    Windows,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(windows) {
            Platform::Windows
        } else {
            Platform::MacOs
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Platform::MacOs => "macOS",
            Platform::Windows => "Windows",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum UpdateError {
    BadResponse(u16),
    NoInstaller,
    NoChecksum,
    ChecksumMismatch,
    WrongApp(String),
    CannotInstall(String),
    NotEnoughSpace(String),
    Network(String),
}

impl std::fmt::Display for UpdateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            UpdateError::BadResponse(code) => write!(f, "GitHub ответил с кодом {code}"),
            UpdateError::NoInstaller => f.write_str("В релизе нет установщика для этой системы"),
            UpdateError::NoChecksum => f.write_str("В релизе нет контрольной суммы установщика, установка небезопасна"),
            UpdateError::ChecksumMismatch => f.write_str("Контрольная сумма скачанного файла не совпала: файл повреждён или подменён"),
            UpdateError::WrongApp(why) => write!(f, "В установщике не то приложение: {why}"),
            UpdateError::CannotInstall(why) => write!(f, "Не удалось установить обновление: {why}"),
            UpdateError::NotEnoughSpace(why) | UpdateError::Network(why) => f.write_str(why),
        }
    }
}

impl std::error::Error for UpdateError {}

impl From<SearchError> for UpdateError {
    fn from(e: SearchError) -> Self {
        match &e {
            SearchError::Http { status: Some(code), .. } => UpdateError::BadResponse(*code),
            _ => UpdateError::Network(friendly_network(&e.message())),
        }
    }
}

/// Понятное сообщение вместо технической ошибки сети.
pub fn friendly_network(raw: &str) -> String {
    let l = raw.to_lowercase();
    if ["dns", "resolve", "not connected", "offline", "network is unreachable", "no route"].iter().any(|k| l.contains(k)) {
        "Нет подключения к интернету. Приложение работает как прежде, попробуйте позже.".into()
    } else if ["timed out", "timeout", "connection reset", "connection refused", "connection closed", "broken pipe", "error sending request", "connect"]
        .iter()
        .any(|k| l.contains(k))
    {
        "Соединение прервалось, обновление не скачано. Приложение работает как прежде, попробуйте позже.".into()
    } else {
        raw.to_string()
    }
}

// ------------------------------------------------------------------ релизы GitHub

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct ReleaseAsset {
    pub name: String,
    #[serde(rename = "browser_download_url")]
    pub download_url: String,
    #[serde(default)]
    pub size: Option<u64>,
    /// «sha256:…», GitHub считает сам для каждого файла релиза.
    #[serde(default)]
    pub digest: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct ReleaseInfo {
    pub tag_name: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub html_url: Option<String>,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub prerelease: bool,
    #[serde(default)]
    pub assets: Vec<ReleaseAsset>,
    #[serde(default)]
    pub published_at: Option<String>,
}

impl ReleaseInfo {
    pub fn parse(data: &[u8]) -> Option<Self> {
        serde_json::from_slice(data).ok()
    }
    pub fn published_date(&self) -> Option<DateTime<Utc>> {
        self.published_at.as_deref().and_then(parse_date)
    }
    /// Название для списка: «Customers 1.1.0» или тег, если названия нет.
    pub fn title(&self) -> String {
        self.name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| self.tag_name.clone())
    }
    pub fn checksum_for(&self, installer: &ReleaseAsset) -> Option<&ReleaseAsset> {
        let want = format!("{}.sha256", installer.name);
        self.assets.iter().find(|a| a.name == want)
    }
    /// Установщик для системы: macOS — образ .dmg (лучше с «macOS» в имени), Windows — Customers-…-Windows-x64-Setup.exe.
    pub fn installer(&self, platform: Platform) -> Option<&ReleaseAsset> {
        match platform {
            Platform::MacOs => {
                // Файлы старых Beta-сборок (Customers-Beta-…) не устанавливаются, даже если оказались в обычном релизе.
                let dmgs: Vec<&ReleaseAsset> =
                    self.assets.iter().filter(|a| a.name.to_lowercase().ends_with(".dmg") && !a.name.starts_with(BETA_ASSET_PREFIX)).collect();
                dmgs.iter().find(|a| a.name.contains("macOS")).or(dmgs.first()).copied()
            }
            Platform::Windows => self.assets.iter().find(|a| {
                a.name.starts_with("Customers-") && !a.name.starts_with(BETA_ASSET_PREFIX) && a.name.to_lowercase().ends_with("-windows-x64-setup.exe")
            }),
        }
    }
}

/// Найденное обновление: версия, установщик и его контрольная сумма.
#[derive(Debug, Clone, PartialEq)]
pub struct AvailableUpdate {
    pub version: AppVersion,
    pub title: String,
    pub notes: String,
    pub page: Option<String>,
    pub installer: ReleaseAsset,
    /// Файл .sha256 рядом с установщиком (запасной способ, если GitHub не прислал digest).
    pub checksum_file: Option<ReleaseAsset>,
}

impl AvailableUpdate {
    /// Ожидаемая SHA-256 из ответа GitHub, если она есть.
    pub fn expected_digest(&self) -> Option<String> {
        let d = self.installer.digest.as_deref()?.to_lowercase();
        let hex = d.strip_prefix("sha256:")?;
        is_sha256(hex).then(|| hex.to_string())
    }
}

/// Последние опубликованные релизы, новые сначала (без черновиков и предварительных версий).
pub fn recent(releases: Vec<ReleaseInfo>, limit: usize) -> Vec<ReleaseInfo> {
    releases.into_iter().filter(|r| !r.draft && !r.prerelease).take(limit).collect()
}

/// Есть ли в релизе версия новее установленной и установщик для этой системы.
pub fn update_from(release: &ReleaseInfo, current: &AppVersion, platform: Platform) -> Option<AvailableUpdate> {
    if release.draft || release.prerelease {
        return None;
    }
    let version = AppVersion::parse(&release.tag_name).filter(|v| current < v)?;
    let installer = release.installer(platform)?.clone();
    let checksum_file = release.checksum_for(&installer).cloned();
    Some(AvailableUpdate {
        version: version.clone(),
        title: release.name.clone().unwrap_or_else(|| format!("Customers {version}")),
        notes: release.body.clone().unwrap_or_default(),
        page: release.html_url.clone(),
        installer,
        checksum_file,
    })
}

fn api_request(url: String, version: &str) -> HttpRequest {
    HttpRequest {
        method: "GET".into(),
        url,
        headers: vec![
            ("Accept".into(), "application/vnd.github+json".into()),
            ("X-GitHub-Api-Version".into(), "2022-11-28".into()),
            ("User-Agent".into(), user_agent(version)),
        ],
        body: None,
        timeout: 20.0,
    }
}

async fn api_get(t: &dyn HttpTransport, url: String, version: &str) -> Result<crate::search::http::HttpResponse, UpdateError> {
    Ok(t.send(api_request(url, version)).await?)
}

/// Последний релиз из публичного API (без токена: 60 запросов в час на адрес, проверке раз в сутки хватает).
pub async fn fetch_latest(t: &dyn HttpTransport, version: &str) -> Result<ReleaseInfo, UpdateError> {
    let r = api_get(t, format!("https://api.github.com/repos/{REPOSITORY}/releases/latest"), version).await?;
    if r.status != 200 {
        return Err(UpdateError::BadResponse(r.status));
    }
    ReleaseInfo::parse(&r.data).ok_or(UpdateError::BadResponse(200))
}

/// Три последних релиза для раздела «Что нового?».
pub async fn fetch_recent(t: &dyn HttpTransport, version: &str, limit: usize) -> Result<Vec<ReleaseInfo>, UpdateError> {
    let r = api_get(t, format!("https://api.github.com/repos/{REPOSITORY}/releases?per_page=10"), version).await?;
    if r.status != 200 {
        return Err(UpdateError::BadResponse(r.status));
    }
    let all: Vec<ReleaseInfo> = serde_json::from_slice(&r.data).map_err(|_| UpdateError::BadResponse(200))?;
    Ok(recent(all, limit))
}

/// Релиз по номеру версии (для «Что нового» после ручной установки). None — такого релиза нет.
pub async fn fetch_release(t: &dyn HttpTransport, version: &AppVersion, app_version: &str) -> Result<Option<ReleaseInfo>, UpdateError> {
    for tag in [format!("v{version}"), version.to_string()] {
        let r = api_get(t, format!("https://api.github.com/repos/{REPOSITORY}/releases/tags/{tag}"), app_version).await?;
        match r.status {
            404 => continue,
            200 => {
                if let Some(rel) = ReleaseInfo::parse(&r.data).filter(|r| !r.draft) {
                    return Ok(Some(rel));
                }
            }
            code => return Err(UpdateError::BadResponse(code)),
        }
    }
    Ok(None)
}

/// Проверка: есть ли обновление для этой системы. Релиза без установщика для неё считается «обновлений нет».
pub async fn check(t: &dyn HttpTransport, current: &AppVersion, platform: Platform) -> Result<Option<AvailableUpdate>, UpdateError> {
    let release = fetch_latest(t, &current.to_string()).await?;
    Ok(update_from(&release, current, platform))
}

// ------------------------------------------------------------------ контрольные суммы

pub fn is_sha256(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// Первая 64-символьная шестнадцатеричная строка из файла вида «<sha256>  <имя файла>».
pub fn parse_checksum_file(text: &str) -> Option<String> {
    text.split_whitespace().map(str::to_lowercase).find(|w| is_sha256(w))
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// SHA-256 файла, читается по частям.
pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

// ------------------------------------------------------------------ скачивание

/// Скачивает установщик в `dir/<версия>/`, сверяет SHA-256. Без контрольной суммы не скачивает.
/// Папка `dir` очищается: старые и недокачанные версии не копятся.
pub async fn download(update: &AvailableUpdate, dir: &Path, t: &dyn HttpTransport, sleeper: &Sleeper) -> Result<PathBuf, UpdateError> {
    // Сумма: digest от GitHub, иначе файл .sha256 из релиза.
    let mut expected = update.expected_digest();
    if expected.is_none() {
        if let Some(sum) = &update.checksum_file {
            let r = t
                .send(HttpRequest {
                    method: "GET".into(),
                    url: sum.download_url.clone(),
                    headers: vec![("User-Agent".into(), user_agent("updater"))],
                    body: None,
                    timeout: 30.0,
                })
                .await?;
            if r.status < 400 {
                expected = parse_checksum_file(&r.text());
            }
        }
    }
    let expected = expected.ok_or(UpdateError::NoChecksum)?;

    let mut data = None;
    for attempt in 1..=3u32 {
        let req = HttpRequest {
            method: "GET".into(),
            url: update.installer.download_url.clone(),
            headers: vec![("User-Agent".into(), user_agent("updater"))],
            body: None,
            timeout: 900.0,
        };
        match t.send(req).await {
            Ok(r) if r.status == 200 => {
                data = Some(r.data);
                break;
            }
            Ok(r) => return Err(UpdateError::BadResponse(r.status)),
            Err(SearchError::Http { transient: true, .. }) if attempt < 3 => sleeper(f64::from(attempt) * 4.0).await, // обрыв связи: пробуем снова
            Err(e) => return Err(e.into()),
        }
    }
    let data = data.ok_or_else(|| UpdateError::Network("Соединение прервалось, обновление не скачано.".into()))?;
    if sha256_hex(&data) != expected {
        return Err(UpdateError::ChecksumMismatch);
    }
    let _ = std::fs::remove_dir_all(dir);
    let work = dir.join(update.version.to_string());
    std::fs::create_dir_all(&work).map_err(|e| UpdateError::CannotInstall(e.to_string()))?;
    let file = work.join(&update.installer.name);
    std::fs::write(&file, &data).map_err(|e| UpdateError::CannotInstall(e.to_string()))?;
    Ok(file)
}

// ------------------------------------------------------------------ установка

/// Скачанное и проверенное обновление, запомненное между запусками.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StagedRecord {
    pub version: String,
    pub path: String,
    pub title: String,
    pub notes: String,
}

/// Проверка Info.plist приложения из образа: тот же идентификатор и версия релиза.
pub fn check_bundle_info(info_plist: &[u8], bundle_id: &str, version: &AppVersion) -> Result<(), UpdateError> {
    let value = plist::Value::from_reader(std::io::Cursor::new(info_plist)).map_err(|_| UpdateError::WrongApp("не читается Info.plist".into()))?;
    let dict = value.as_dictionary().ok_or_else(|| UpdateError::WrongApp("не читается Info.plist".into()))?;
    if dict.get("CFBundleIdentifier").and_then(|v| v.as_string()) != Some(bundle_id) {
        return Err(UpdateError::WrongApp("другой идентификатор приложения".into()));
    }
    let v = dict.get("CFBundleShortVersionString").and_then(|v| v.as_string()).and_then(AppVersion::parse);
    if v.as_ref() != Some(version) {
        return Err(UpdateError::WrongApp("версия внутри не совпадает с версией релиза".into()));
    }
    Ok(())
}

/// Скрипт замены пакета macOS: ждёт выхода приложения, меняет пакет целиком, при ошибке возвращает прежний.
/// Приложение раньше называлось «Lead Generator.app»: после обновления оно ставится как «Customers.app»,
/// а старый пакет удаляется.
pub const MACOS_INSTALL_SCRIPT: &str = r#"#!/bin/sh
PID="$1"; NEW="$2"; OLD="$3"; TARGET="$4"
while kill -0 "$PID" 2>/dev/null; do sleep 0.3; done
rm -rf "$TARGET.update" "$TARGET.previous"
/usr/bin/ditto "$NEW" "$TARGET.update" || exit 1
mv "$OLD" "$OLD.previous" || exit 1
if [ -e "$TARGET" ]; then mv "$TARGET" "$TARGET.replaced"; fi
if mv "$TARGET.update" "$TARGET"; then
  rm -rf "$OLD.previous" "$TARGET.replaced"
else
  rm -rf "$TARGET"
  mv "$OLD.previous" "$OLD"
  if [ -e "$TARGET.replaced" ]; then mv "$TARGET.replaced" "$TARGET"; fi
  TARGET="$OLD"
fi
/usr/bin/xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null
/usr/bin/open "$TARGET"
"#;

/// Параметры тихой установки Inno Setup. RELAUNCH сообщает установщику, что приложение нужно открыть снова.
pub const WINDOWS_INSTALLER_ARGS: [&str; 5] = ["/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CLOSEAPPLICATIONS", "/RELAUNCH=1"];

#[cfg(target_os = "macos")]
fn run_tool(tool: &str, args: &[&str]) -> Result<(), UpdateError> {
    let status = std::process::Command::new(tool)
        .args(args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|e| UpdateError::CannotInstall(e.to_string()))?;
    if status.success() {
        Ok(())
    } else {
        let name = Path::new(tool).file_name().and_then(|n| n.to_str()).unwrap_or(tool);
        Err(UpdateError::CannotInstall(format!("{name} завершился с кодом {}", status.code().unwrap_or(-1))))
    }
}

/// macOS: достаёт приложение из образа и проверяет его. Возвращает путь к распакованному «Customers.app».
#[cfg(target_os = "macos")]
pub fn stage_macos_app(dmg: &Path, bundle_id: &str, version: &AppVersion) -> Result<PathBuf, UpdateError> {
    let work = dmg.parent().ok_or_else(|| UpdateError::CannotInstall("нет папки загрузки".into()))?;
    let mount = work.join("mnt");
    std::fs::create_dir_all(&mount).map_err(|e| UpdateError::CannotInstall(e.to_string()))?;
    run_tool("/usr/bin/hdiutil", &["attach", &dmg.to_string_lossy(), "-nobrowse", "-noautoopen", "-readonly", "-mountpoint", &mount.to_string_lossy()])?;
    let result = (|| {
        let app = std::fs::read_dir(&mount)
            .map_err(|e| UpdateError::CannotInstall(e.to_string()))?
            .filter_map(Result::ok)
            .map(|e| e.path())
            .find(|p| p.extension().and_then(|e| e.to_str()) == Some("app"))
            .ok_or_else(|| UpdateError::WrongApp("приложение не найдено в образе".into()))?;
        let staged = work.join("Customers.app");
        run_tool("/usr/bin/ditto", &[&app.to_string_lossy(), &staged.to_string_lossy()])?;
        let info = std::fs::read(staged.join("Contents/Info.plist")).map_err(|_| UpdateError::WrongApp("нет Info.plist".into()))?;
        check_bundle_info(&info, bundle_id, version)?;
        Ok(staged)
    })();
    let _ = run_tool("/usr/bin/hdiutil", &["detach", &mount.to_string_lossy(), "-force"]);
    result
}

/// macOS: запускает скрипт замены и возвращает управление; приложение должно сразу завершиться.
#[cfg(target_os = "macos")]
pub fn relaunch_macos(staged: &Path, current_bundle: &Path, installer_dmg: &Path) -> Result<(), UpdateError> {
    let parent = current_bundle.parent().ok_or_else(|| UpdateError::CannotInstall("нет папки приложения".into()))?;
    // Проверка прав записи: создаём и удаляем пробный файл.
    let probe = parent.join(".customers-write-test");
    if std::fs::write(&probe, b"").is_err() {
        let _ = std::process::Command::new("/usr/bin/open").arg(installer_dmg).status();
        return Err(UpdateError::CannotInstall(format!(
            "нет прав на запись в {}. Установщик открыт: перетащите приложение в «Программы» вручную",
            parent.display()
        )));
    }
    let _ = std::fs::remove_file(&probe);
    let script = staged.parent().unwrap_or(parent).join("install.sh");
    std::fs::write(&script, MACOS_INSTALL_SCRIPT).map_err(|e| UpdateError::CannotInstall(e.to_string()))?;
    std::process::Command::new("/bin/sh")
        .arg(&script)
        .arg(std::process::id().to_string())
        .arg(staged)
        .arg(current_bundle)
        .arg(parent.join("Customers.app"))
        .spawn()
        .map_err(|e| UpdateError::CannotInstall(e.to_string()))?;
    Ok(())
}

/// Windows: запускает скачанный установщик тихо; он сам закроет приложение и откроет его снова.
#[cfg(windows)]
pub fn launch_windows_installer(path: &Path) -> Result<(), UpdateError> {
    std::process::Command::new(path).args(WINDOWS_INSTALLER_ARGS).spawn().map(|_| ()).map_err(|e| UpdateError::CannotInstall(e.to_string()))
}

// ------------------------------------------------------------------ расписание проверок

/// Варианты частоты автоматической проверки: часы и подпись.
pub const INTERVALS: [(u32, &str); 6] =
    [(1, "Каждый час"), (3, "Каждые 3 часа"), (6, "Каждые 6 часов"), (12, "Каждые 12 часов"), (24, "Раз в сутки"), (168, "Раз в неделю")];

pub fn normalized_interval(hours: Option<i64>) -> u32 {
    hours.and_then(|h| INTERVALS.iter().find(|(x, _)| i64::from(*x) == h)).map(|(h, _)| *h).unwrap_or(24)
}

/// Пора ли проверять обновления. Небольшой запас, чтобы проверка «раз в час» не сдвигалась на следующий тик;
/// после неудачи повторяем не чаще раза в час.
pub fn should_check(automatic: bool, interval_hours: u32, last_check: Option<DateTime<Utc>>, last_attempt: Option<DateTime<Utc>>, now: DateTime<Utc>) -> bool {
    if !automatic {
        return false;
    }
    if let Some(l) = last_check {
        if now - l < Duration::seconds(i64::from(interval_hours) * 3600 - 300) {
            return false;
        }
    }
    if let Some(a) = last_attempt {
        if now - a < Duration::seconds(3600 - 300) {
            return false;
        }
    }
    true
}

pub fn stamp(d: &DateTime<Utc>) -> String {
    format_date(d)
}

// ------------------------------------------------------------------ описание релиза: Markdown → обычный текст

static RE_COMMENT: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?s)<!--.*?-->").unwrap());
static RE_HEADING: Lazy<Regex> = Lazy::new(|| Regex::new(r"^#{1,6}\s*").unwrap());
static RE_HEADING_END: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s+#+$").unwrap());
static RE_LIST: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[-*+]\s+(\[[ xX]\]\s+)?(.*)$").unwrap());
static RE_ORDERED: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\d+[.)]\s+").unwrap());
static RE_TRAIL: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s+$").unwrap());

static INLINE: Lazy<Vec<(FRegex, &'static str)>> = Lazy::new(|| {
    [
        (r"!\[([^\]]*)\]\([^)]*\)", "$1"),
        (r"\[([^\]]+)\]\(([^)\s]+)[^)]*\)", "$1"),
        (r"<(https?://[^>\s]+)>", "$1"),
        (r"</?[A-Za-z][^>]*>", ""),
        (r"`+([^`]*)`+", "$1"),
        (r"\*\*\*(.+?)\*\*\*", "$1"),
        (r"\*\*(.+?)\*\*", "$1"),
        (r"(?<![A-Za-z0-9_])__(.+?)__(?![A-Za-z0-9_])", "$1"),
        (r"(?<![\*\w])\*(?!\s)([^*]+?)(?<!\s)\*(?![\*\w])", "$1"),
        (r"(?<![A-Za-z0-9_])_(?!\s)([^_]+?)(?<!\s)_(?![A-Za-z0-9_])", "$1"),
        (r"~~(.+?)~~", "$1"),
    ]
    .into_iter()
    .map(|(p, r)| (FRegex::new(p).expect("regex"), r))
    .collect()
});

/// Разметка внутри строки: ссылки, картинки, жирный, курсив, зачёркнутый, код, HTML-теги.
fn inline(s: &str) -> String {
    let mut t = s.to_string();
    for (re, rep) in INLINE.iter() {
        t = re.replace_all(&t, *rep).into_owned();
    }
    t
}

/// Горизонтальные линии «---», «***», «___», «===».
fn is_rule(trimmed: &str) -> bool {
    let compact: Vec<char> = trimmed.chars().filter(|c| !c.is_whitespace()).collect();
    compact.len() >= 3 && ["-", "*", "_", "="].iter().any(|m| compact.iter().all(|c| c.to_string() == *m))
}

/// Описание релиза (Markdown с GitHub) в обычный читаемый текст: без «**», «##», обратных кавычек и ссылок,
/// списки — с точками «•», переносы строк сохраняются, лишние пустые строки схлопываются.
/// `limit` — максимум символов; текст обрезается по границе строки с многоточием.
pub fn plain_notes(markdown: &str, limit: Option<usize>) -> String {
    let text = markdown.replace("\r\n", "\n").replace('\r', "\n");
    let text = RE_COMMENT.replace_all(&text, "").into_owned();
    let mut out: Vec<String> = vec![];
    let mut in_fence = false;
    for raw in text.split('\n') {
        let trimmed = raw.trim_matches(|c| c == ' ' || c == '\t');
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            out.push(raw.replace('\t', "  "));
            continue;
        }
        if trimmed.is_empty() {
            out.push(String::new());
            continue;
        }
        if is_rule(trimmed) {
            continue;
        }
        let mut line = trimmed.to_string();
        let mut indent = String::new();
        // Уровень вложенности списка — по отступу в исходной строке.
        let lead: usize = raw.chars().take_while(|c| *c == ' ' || *c == '\t').map(|c| if c == '\t' { 4 } else { 1 }).sum();
        if lead >= 2 {
            indent = "  ".repeat((lead / 2).min(4));
        }
        while let Some(rest) = line.strip_prefix('>') {
            line = rest.trim_matches(|c| c == ' ' || c == '\t').to_string();
        }
        if line.starts_with('#') {
            line = RE_HEADING.replace(&line, "").into_owned();
            line = RE_HEADING_END.replace(&line, "").into_owned();
            indent.clear();
        } else if let Some(m) = RE_LIST.captures(&line) {
            let boxed = m.get(1).map(|b| b.as_str().trim().to_string()).unwrap_or_default();
            let mark = if boxed.is_empty() {
                "•"
            } else if boxed == "[ ]" {
                "☐"
            } else {
                "☑"
            };
            line = format!("{indent}{mark} {}", &m[2]);
            indent.clear();
        } else if RE_ORDERED.is_match(&line) {
            line = format!("{indent}{line}");
            indent.clear();
        }
        out.push(format!("{indent}{}", inline(&line)));
    }
    // Схлопываем пустые строки и обрезаем края.
    let mut lines: Vec<String> = vec![];
    for l in out {
        if l.trim().is_empty() {
            if lines.last().map(|x| !x.is_empty()).unwrap_or(false) {
                lines.push(String::new());
            }
        } else {
            lines.push(RE_TRAIL.replace(&l, "").into_owned());
        }
    }
    while lines.last().map(String::is_empty).unwrap_or(false) {
        lines.pop();
    }
    while lines.first().map(String::is_empty).unwrap_or(false) {
        lines.remove(0);
    }
    let mut result = lines.join("\n");
    if let Some(limit) = limit {
        if result.chars().count() > limit {
            let mut cut: String = result.chars().take(limit).collect();
            if let Some(nl) = cut.rfind('\n') {
                if cut[..nl].chars().count() > limit / 2 {
                    cut.truncate(nl);
                }
            }
            result = format!("{}…", cut.trim());
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::http::{no_sleep, testing::FakeTransport, HttpResponse};

    fn v(s: &str) -> AppVersion {
        AppVersion::parse(s).unwrap()
    }

    fn release_json(tag: &str, assets: &str) -> String {
        format!(
            r#"{{"tag_name":"{tag}","name":"Customers {tag}","body":"Что нового","html_url":"https://github.com/xop1tt/Customers-App/releases/tag/{tag}","draft":false,"prerelease":false,"published_at":"2026-11-05T09:42:00Z","assets":[{assets}]}}"#
        )
    }

    fn asset(name: &str, digest: Option<&str>) -> String {
        let d = digest.map(|d| format!(r#","digest":"{d}""#)).unwrap_or_default();
        format!(r#"{{"name":"{name}","browser_download_url":"https://github.com/dl/{name}","size":1000{d}}}"#)
    }

    fn full_release(tag: &str) -> ReleaseInfo {
        let assets = [
            asset(&format!("Customers-{tag}-macOS.dmg"), None),
            asset(&format!("Customers-{tag}-macOS.dmg.sha256"), None),
            asset(&format!("Customers-{tag}-Windows-x64-Setup.exe"), None),
            asset(&format!("Customers-{tag}-Windows-x64-Setup.exe.sha256"), None),
        ]
        .join(",");
        ReleaseInfo::parse(release_json(tag, &assets).as_bytes()).unwrap()
    }

    #[test]
    fn never_picks_old_beta_installers() {
        let assets = [asset("Customers-Beta-v1.3.0-beta.1-macOS.dmg", None), asset("Customers-Beta-v1.3.0-beta.1-Windows-x64-Setup.exe", None)].join(",");
        let r = ReleaseInfo::parse(release_json("v1.3.0", &assets).as_bytes()).unwrap();
        assert!(r.installer(Platform::MacOs).is_none());
        assert!(r.installer(Platform::Windows).is_none());
        assert!(update_from(&r, &v("1.2.0"), Platform::MacOs).is_none());
    }

    #[test]
    fn picks_installer_per_platform() {
        let r = full_release("v1.2.0");
        assert_eq!(r.installer(Platform::MacOs).unwrap().name, "Customers-v1.2.0-macOS.dmg");
        assert_eq!(r.installer(Platform::Windows).unwrap().name, "Customers-v1.2.0-Windows-x64-Setup.exe");
        let only_mac = ReleaseInfo::parse(release_json("v1.2.0", &asset("Customers-v1.2.0-macOS.dmg", None)).as_bytes()).unwrap();
        assert!(only_mac.installer(Platform::Windows).is_none());
        let odd = ReleaseInfo::parse(release_json("v1.2.0", &asset("Other.dmg", None)).as_bytes()).unwrap();
        assert_eq!(odd.installer(Platform::MacOs).unwrap().name, "Other.dmg");
    }

    #[test]
    fn update_only_for_newer_published_release() {
        let r = full_release("v1.2.0");
        let u = update_from(&r, &v("1.1.0"), Platform::Windows).unwrap();
        assert_eq!(u.version, v("1.2.0"));
        assert_eq!(u.checksum_file.as_ref().unwrap().name, "Customers-v1.2.0-Windows-x64-Setup.exe.sha256");
        assert_eq!(u.page.as_deref(), Some("https://github.com/xop1tt/Customers-App/releases/tag/v1.2.0"));
        assert!(update_from(&r, &v("1.2.0"), Platform::MacOs).is_none());
        assert!(update_from(&r, &v("2.0"), Platform::MacOs).is_none());
        let mut draft = r.clone();
        draft.draft = true;
        assert!(update_from(&draft, &v("1.0"), Platform::MacOs).is_none());
        let mut pre = r;
        pre.prerelease = true;
        assert!(update_from(&pre, &v("1.0"), Platform::MacOs).is_none());
    }

    #[test]
    fn digest_and_checksum_file_parsing() {
        let hex = "ab".repeat(32);
        let rel = ReleaseInfo::parse(release_json("v1.2.0", &asset("Customers-v1.2.0-macOS.dmg", Some(&format!("sha256:{}", hex.to_uppercase())))).as_bytes())
            .unwrap();
        assert_eq!(update_from(&rel, &v("1.0"), Platform::MacOs).unwrap().expected_digest(), Some(hex.clone()));
        let bad = ReleaseInfo::parse(release_json("v1.2.0", &asset("Customers-v1.2.0-macOS.dmg", Some("sha256:123"))).as_bytes()).unwrap();
        assert_eq!(update_from(&bad, &v("1.0"), Platform::MacOs).unwrap().expected_digest(), None);
        assert_eq!(parse_checksum_file(&format!("{}  Customers.dmg\n", hex.to_uppercase())), Some(hex));
        assert_eq!(parse_checksum_file("не сумма"), None);
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn recent_skips_drafts_and_prereleases() {
        let mut d = full_release("v1.3.0");
        d.draft = true;
        let mut p = full_release("v1.2.5");
        p.prerelease = true;
        let list = recent(vec![d, p, full_release("v1.2.0"), full_release("v1.1.0"), full_release("v1.0.0")], 2);
        assert_eq!(list.iter().map(|r| r.tag_name.as_str()).collect::<Vec<_>>(), ["v1.2.0", "v1.1.0"]);
        assert_eq!(full_release("v1.0.0").published_date().unwrap().timestamp(), 1_793_871_720);
    }

    #[tokio::test]
    async fn check_uses_github_api_and_reports_errors() {
        let t = FakeTransport::new(vec![Ok(HttpResponse::new(200, release_json("v1.2.0", &[asset("Customers-v1.2.0-macOS.dmg", None)].join(","))))]);
        assert!(check(t.as_ref(), &v("1.1.0"), Platform::MacOs).await.unwrap().is_some());
        let sent = &t.requests.lock().unwrap()[0];
        assert_eq!(sent.url, "https://api.github.com/repos/xop1tt/Customers-App/releases/latest");
        assert!(sent.headers.iter().any(|h| h.0 == "User-Agent" && h.1.starts_with("Customers/1.1.0")));
        let t = FakeTransport::new(vec![Ok(HttpResponse::new(403, ""))]);
        assert_eq!(check(t.as_ref(), &v("1.1.0"), Platform::MacOs).await.unwrap_err(), UpdateError::BadResponse(403));
        let t = FakeTransport::new(vec![Err(SearchError::http("dns error", None, true))]);
        assert!(check(t.as_ref(), &v("1.1.0"), Platform::MacOs).await.unwrap_err().to_string().starts_with("Нет подключения"));
    }

    #[tokio::test]
    async fn fetch_release_tries_both_tag_spellings() {
        let t = FakeTransport::new(vec![Ok(HttpResponse::new(404, "")), Ok(HttpResponse::new(200, release_json("1.2.0", "")))]);
        let r = fetch_release(t.as_ref(), &v("1.2.0"), "1.2.0").await.unwrap().unwrap();
        assert_eq!(r.tag_name, "1.2.0");
        assert!(t.urls()[0].ends_with("/tags/v1.2.0") && t.urls()[1].ends_with("/tags/1.2.0"));
        let t = FakeTransport::new(vec![Ok(HttpResponse::new(404, "")), Ok(HttpResponse::new(404, ""))]);
        assert!(fetch_release(t.as_ref(), &v("9.9"), "1.0").await.unwrap().is_none());
        let t = FakeTransport::new(vec![Ok(HttpResponse::new(500, ""))]);
        assert_eq!(fetch_release(t.as_ref(), &v("1.2"), "1.0").await.unwrap_err(), UpdateError::BadResponse(500));
        let t = FakeTransport::new(vec![Ok(HttpResponse::new(200, format!("[{},{}]", release_json("v1.2.0", ""), release_json("v1.1.0", ""))))]);
        assert_eq!(fetch_recent(t.as_ref(), "1.0", 1).await.unwrap().len(), 1);
    }

    fn update_with(data: &[u8], digest: bool) -> AvailableUpdate {
        let mut rel = full_release("v1.2.0");
        if digest {
            rel.assets[0].digest = Some(format!("sha256:{}", sha256_hex(data)));
        }
        update_from(&rel, &v("1.0"), Platform::MacOs).unwrap()
    }

    #[tokio::test]
    async fn download_verifies_checksum_and_stores_file() {
        let dir = tempfile::tempdir().unwrap();
        let data = b"INSTALLER-BYTES".to_vec();
        let u = update_with(&data, true);
        let t = FakeTransport::new(vec![Ok(HttpResponse::new(200, data.clone()))]);
        let path = download(&u, dir.path(), t.as_ref(), &no_sleep()).await.unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), data);
        assert!(path.ends_with("1.2.0/Customers-v1.2.0-macOS.dmg"));
        assert_eq!(sha256_file(&path).unwrap(), sha256_hex(&data));

        // сумма из файла .sha256
        let u = update_with(&data, false);
        let t = FakeTransport::new(vec![Ok(HttpResponse::new(200, format!("{}  x.dmg", sha256_hex(&data)))), Ok(HttpResponse::new(200, data.clone()))]);
        download(&u, dir.path(), t.as_ref(), &no_sleep()).await.unwrap();
    }

    #[tokio::test]
    async fn download_refuses_bad_or_missing_checksum_and_keeps_old_files() {
        let dir = tempfile::tempdir().unwrap();
        let keep = dir.path().join("keep.txt");
        std::fs::write(&keep, "x").unwrap();
        let u = update_with(b"good", true);
        let t = FakeTransport::new(vec![Ok(HttpResponse::new(200, "подмена"))]);
        assert_eq!(download(&u, dir.path(), t.as_ref(), &no_sleep()).await.unwrap_err(), UpdateError::ChecksumMismatch);
        assert!(keep.exists(), "при ошибке прежние файлы не трогаются");
        let mut none = update_with(b"good", false);
        none.checksum_file = None;
        assert_eq!(download(&none, dir.path(), FakeTransport::new(vec![]).as_ref(), &no_sleep()).await.unwrap_err(), UpdateError::NoChecksum);
        let t = FakeTransport::new(vec![Ok(HttpResponse::new(404, ""))]);
        assert_eq!(download(&u, dir.path(), t.as_ref(), &no_sleep()).await.unwrap_err(), UpdateError::BadResponse(404));
    }

    #[tokio::test]
    async fn download_retries_dropped_connections_up_to_three_times() {
        let dir = tempfile::tempdir().unwrap();
        let u = update_with(b"ok", true);
        let drop = || Err(SearchError::http("connection reset", None, true));
        let t = FakeTransport::new(vec![drop(), drop(), Ok(HttpResponse::new(200, "ok"))]);
        assert!(download(&u, dir.path(), t.as_ref(), &no_sleep()).await.is_ok());
        let t = FakeTransport::new(vec![drop(), drop(), drop()]);
        let e = download(&u, dir.path(), t.as_ref(), &no_sleep()).await.unwrap_err();
        assert!(e.to_string().starts_with("Соединение прервалось"), "{e}");
        assert_eq!(t.requests.lock().unwrap().len(), 3);
    }

    fn info_plist(id: &str, version: &str) -> Vec<u8> {
        let mut d = plist::Dictionary::new();
        d.insert("CFBundleIdentifier".into(), id.into());
        d.insert("CFBundleShortVersionString".into(), version.into());
        let mut out = vec![];
        plist::to_writer_xml(&mut out, &plist::Value::Dictionary(d)).unwrap();
        out
    }

    #[test]
    fn bundle_info_must_match_id_and_version() {
        let id = "local.leadgenerator.app";
        assert!(check_bundle_info(&info_plist(id, "1.2.0"), id, &v("1.2")).is_ok());
        assert!(matches!(check_bundle_info(&info_plist("other", "1.2.0"), id, &v("1.2.0")), Err(UpdateError::WrongApp(_))));
        assert!(matches!(check_bundle_info(&info_plist(id, "1.1.0"), id, &v("1.2.0")), Err(UpdateError::WrongApp(_))));
        assert!(matches!(check_bundle_info(b"not a plist", id, &v("1.2.0")), Err(UpdateError::WrongApp(_))));
    }

    #[test]
    fn install_constants_keep_previous_behavior() {
        assert!(MACOS_INSTALL_SCRIPT.contains("kill -0") && MACOS_INSTALL_SCRIPT.contains("com.apple.quarantine"));
        assert!(WINDOWS_INSTALLER_ARGS.contains(&"/RELAUNCH=1") && WINDOWS_INSTALLER_ARGS.contains(&"/CLOSEAPPLICATIONS"));
    }

    #[test]
    fn check_schedule() {
        let now = Utc::now();
        assert!(!should_check(false, 24, None, None, now));
        assert!(should_check(true, 24, None, None, now));
        assert!(!should_check(true, 24, Some(now - Duration::hours(23)), None, now));
        assert!(should_check(true, 24, Some(now - Duration::hours(25)), None, now));
        assert!(should_check(true, 1, Some(now - Duration::minutes(56)), None, now), "запас на тик таймера");
        assert!(!should_check(true, 1, Some(now - Duration::hours(3)), Some(now - Duration::minutes(10)), now), "после неудачи — не чаще раза в час");
        assert_eq!(normalized_interval(Some(6)), 6);
        assert_eq!(normalized_interval(Some(5)), 24);
        assert_eq!(normalized_interval(None), 24);
    }

    #[test]
    fn notes_become_plain_text() {
        let md = "<!-- скрыто -->\n## What's Changed\n* Новая **кнопка** обновления с [прогрессом](https://x.y/z) by @xop1tt in https://github.com/xop1tt/Customers-App/pull/63\n  * вложенный `пункт`\n- [x] сделано\n- [ ] нет\n1. первый\n\n\n---\n> цитата *курсив* и _тоже_ ~~старое~~\n```\nкод  **как есть**\n```\n**Full Changelog**: https://github.com/a/b/compare/v1...v2\n";
        let t = plain_notes(md, None);
        let lines: Vec<&str> = t.lines().collect();
        assert_eq!(lines[0], "What's Changed");
        assert_eq!(lines[1], "• Новая кнопка обновления с прогрессом by @xop1tt in https://github.com/xop1tt/Customers-App/pull/63");
        assert_eq!(lines[2], "  • вложенный пункт");
        assert_eq!(&lines[3..6], ["☑ сделано", "☐ нет", "1. первый"]);
        assert_eq!(lines[6], "");
        assert_eq!(lines[7], "цитата курсив и тоже старое");
        assert_eq!(lines[8], "код  **как есть**");
        assert_eq!(lines[9], "Full Changelog: https://github.com/a/b/compare/v1...v2");
        assert!(!t.contains("<!--") && !t.contains("---"));
    }

    #[test]
    fn notes_are_cut_on_line_boundary() {
        let md = "строка один\nстрока два\nстрока три\nстрока четыре";
        let cut = plain_notes(md, Some(30));
        assert!(cut.ends_with('…') && cut.chars().count() <= 31, "{cut}");
        assert_eq!(cut, "строка один\nстрока два…");
        assert_eq!(plain_notes("коротко", Some(30)), "коротко");
        assert_eq!(plain_notes("", None), "");
        assert_eq!(plain_notes("snake_case_name и 2*3*4", None), "snake_case_name и 2*3*4");
    }
}
