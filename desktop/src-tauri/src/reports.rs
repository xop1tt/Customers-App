//! Отчёты о вылетах, зависаниях и ошибках. Ничего не отправляется само: приложение собирает текст, показывает его,
//! и по кнопке открывает в браузере новое обращение в Issues репозитория. Отправляет его сам пользователь
//! со своей учётной записью GitHub, поэтому в приложении нет ни ключей, ни сервера.

use crate::updates::REPOSITORY;
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

// ------------------------------------------------------------------ журнал ошибок

/// Журнал ошибок: последние сообщения, по строке на сообщение. Лежит в папке журналов приложения
/// (macOS ~/Library/Logs/LeadGenerator, Windows %LOCALAPPDATA%\Customers\logs) и никуда не отправляется сам.
#[derive(Debug, Clone)]
pub struct ErrorLog {
    path: PathBuf,
    keep: usize,
}

impl ErrorLog {
    pub fn new(logs_dir: &Path) -> Self {
        Self { path: logs_dir.join("errors.log"), keep: 300 }
    }
    pub fn with_keep(mut self, keep: usize) -> Self {
        self.keep = keep.max(1);
        self
    }
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Добавляет строку и оставляет только последние `keep` строк. Журнал не должен ронять приложение.
    pub fn append(&self, message: &str, at: DateTime<Utc>) {
        if let Some(dir) = self.path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let line = format!("{}  {}", crate::util::format_date(&at), scrub(&message.replace(['\n', '\r'], " ")));
        let mut lines = self.recent(self.keep - 1);
        lines.push(line);
        let _ = fs::write(&self.path, lines.join("\n") + "\n");
    }

    /// Последние `count` строк журнала, старые сначала.
    pub fn recent(&self, count: usize) -> Vec<String> {
        if count == 0 {
            return vec![];
        }
        let Ok(text) = fs::read_to_string(&self.path) else { return vec![] };
        let lines: Vec<String> = text.lines().filter(|l| !l.is_empty()).map(str::to_string).collect();
        lines[lines.len().saturating_sub(count)..].to_vec()
    }

    pub fn clear(&self) {
        let _ = fs::remove_file(&self.path);
    }
}

/// Убирает параметры запроса из адресов (в них бывают ключи доступа).
pub fn scrub(message: &str) -> String {
    use once_cell::sync::Lazy;
    static RE: Lazy<regex::Regex> = Lazy::new(|| regex::Regex::new(r"(https?://[^\s?#]+)[?#]\S*").unwrap());
    RE.replace_all(message, "$1?…").into_owned()
}

// ------------------------------------------------------------------ файлы отчётов

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashFile {
    pub path: PathBuf,
    pub date: DateTime<Utc>,
    pub kind: String,
}

fn kind_of(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(str::to_lowercase).as_deref() {
        Some("hang") | Some("spin") => "Зависание",
        Some("diag") => "Сбой ресурсов",
        _ => "Вылет",
    }
}

const SYSTEM_EXTENSIONS: [&str; 5] = ["ips", "crash", "hang", "spin", "diag"];

/// Каталоги отчётов macOS (~/Library/Logs/DiagnosticReports и Retired).
pub fn system_report_dirs(home: &Path) -> Vec<PathBuf> {
    let logs = home.join("Library/Logs/DiagnosticReports");
    vec![logs.clone(), logs.join("Retired")]
}

/// Отчёт относится к этому приложению: macOS называет файлы по имени процесса.
pub fn is_ours(file_name: &str) -> bool {
    let ext = Path::new(file_name).extension().and_then(|e| e.to_str()).map(str::to_lowercase).unwrap_or_default();
    SYSTEM_EXTENSIONS.contains(&ext.as_str()) && ["LeadGenerator", "Lead Generator", "Customers", "customers"].iter().any(|p| file_name.starts_with(p))
}

fn modified(path: &Path) -> DateTime<Utc> {
    fs::metadata(path).and_then(|m| m.modified()).map(DateTime::<Utc>::from).unwrap_or(DateTime::<Utc>::MIN_UTC)
}

/// Отчёты этого приложения, новые сначала: системные (macOS) и собственные (`crash-*.txt` после паники).
pub fn find(system_dirs: &[PathBuf], own_dir: Option<&Path>, newer_than: Option<DateTime<Utc>>) -> Vec<CrashFile> {
    let mut found = vec![];
    let mut scan = |dir: &Path, own: bool| {
        let Ok(entries) = fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let ok = if own { name.starts_with("crash-") && name.ends_with(".txt") } else { is_ours(&name) };
            if !ok {
                continue;
            }
            let date = modified(&e.path());
            if newer_than.is_some_and(|n| date <= n) {
                continue;
            }
            found.push(CrashFile { kind: kind_of(&e.path()).to_string(), path: e.path(), date });
        }
    };
    for d in system_dirs {
        scan(d, false);
    }
    if let Some(d) = own_dir {
        scan(d, true);
    }
    found.sort_by(|a, b| b.date.cmp(&a.date));
    found
}

/// Убирает из текста домашнюю папку и имя пользователя.
pub fn redact(text: &str, home: &str, user: &str) -> String {
    let mut s = text.to_string();
    if !home.is_empty() {
        s = s.replace(home, "~");
        if home.contains('\\') {
            s = s.replace(&home.replace('\\', "/"), "~");
        }
    }
    if user.chars().count() >= 3 {
        s = s.replace(user, "<user>");
    }
    s
}

/// Главное из отчёта: тип исключения и стек упавшего потока.
/// Отчёт .ips — строка-заголовок JSON и тело JSON; если разобрать не вышло, берётся начало текста.
pub fn summary(text: &str, frames: usize, fallback_limit: usize) -> String {
    let fallback = || text.chars().take(fallback_limit).collect::<String>();
    let Some((head, body)) = text.split_once('\n') else { return fallback() };
    let (Ok(header), Ok(body)) = (serde_json::from_str::<Value>(head), serde_json::from_str::<Value>(body)) else { return fallback() };
    if !header.is_object() || !body.is_object() {
        return fallback();
    }
    let mut out: Vec<String> = vec![];
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    if let Some(v) = s(&header, "app_version") {
        out.push(format!("Версия: {v}"));
    }
    if let Some(v) = s(&header, "os_version") {
        out.push(format!("macOS: {v}"));
    }
    if let Some(v) = s(&header, "timestamp") {
        out.push(format!("Время: {v}"));
    }
    if let Some(e) = body.get("exception") {
        let fields: Vec<String> = ["type", "signal", "codes", "subtype"].iter().filter_map(|k| s(e, k)).collect();
        out.push(format!("Исключение: {}", fields.join(", ")));
    }
    if let Some(ind) = body.get("termination").and_then(|t| s(t, "indicator")) {
        out.push(format!("Завершение: {ind}"));
    }
    if let Some(asi) = body.get("asi").and_then(Value::as_object) {
        for (lib, msgs) in asi {
            let m: Vec<&str> = msgs.as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
            out.push(format!("{lib}: {}", m.join(" ")));
        }
    }
    let images = body.get("usedImages").and_then(Value::as_array).cloned().unwrap_or_default();
    if let Some(threads) = body.get("threads").and_then(Value::as_array) {
        let faulting = body
            .get("faultingThread")
            .and_then(Value::as_u64)
            .map(|n| n as usize)
            .or_else(|| threads.iter().position(|t| t.get("triggered").and_then(Value::as_bool) == Some(true)))
            .unwrap_or(0);
        if let Some(fs) = threads.get(faulting).and_then(|t| t.get("frames")).and_then(Value::as_array) {
            out.push(String::new());
            out.push(format!("Поток {faulting}:"));
            for (i, f) in fs.iter().take(frames).enumerate() {
                let image = f.get("imageIndex").and_then(Value::as_i64).filter(|i| *i >= 0).and_then(|i| images.get(i as usize)).and_then(|im| s(im, "name")).unwrap_or_else(|| "?".into());
                let symbol = s(f, "symbol").unwrap_or_else(|| format!("+0x{:x}", f.get("imageOffset").and_then(Value::as_u64).unwrap_or(0)));
                out.push(format!("{i}  {image}  {symbol}"));
            }
        }
    }
    if out.is_empty() { fallback() } else { out.join("\n") }
}

/// Ссылка на новое обращение (Issue) с готовым текстом. GitHub не принимает очень длинные адреса,
/// поэтому текст в ссылке обрезается.
pub fn issue_url(repository: &str, title: &str, body: &str, max_body: usize) -> String {
    use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
    let mut text: String = body.to_string();
    if text.chars().count() > max_body {
        text = text.chars().take(max_body).collect::<String>() + "\n\n…(текст обрезан: полный отчёт скопирован в буфер обмена, вставьте его ниже)";
    }
    format!("https://github.com/{repository}/issues/new?title={}&body={}", utf8_percent_encode(title, NON_ALPHANUMERIC), utf8_percent_encode(&text, NON_ALPHANUMERIC))
}

pub fn default_issue_url(title: &str, body: &str) -> String {
    issue_url(REPOSITORY, title, body, 6000)
}

// ------------------------------------------------------------------ паника

/// Сохраняет отчёт о панике в `crash-ГГГГММДД-ЧЧММСС.txt` и добавляет строку в журнал ошибок.
/// При следующем запуске приложение предложит отчёт посмотреть и отправить.
pub fn install_panic_hook(logs_dir: PathBuf, app_version: String) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let now = Utc::now();
        let location = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_else(|| "?".into());
        let message = info.payload().downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| info.payload().downcast_ref::<String>().cloned()).unwrap_or_else(|| "без сообщения".into());
        let report = format!(
            "Customers {app_version}, {} {}\n{}\nГде: {location}\n{message}\n\n{}\n",
            std::env::consts::OS,
            std::env::consts::ARCH,
            crate::util::format_date(&now),
            std::backtrace::Backtrace::force_capture()
        );
        let dir = logs_dir.join("crashes");
        let _ = fs::create_dir_all(&dir);
        let _ = fs::write(dir.join(format!("crash-{}.txt", now.format("%Y%m%d-%H%M%S"))), scrub(&report));
        ErrorLog::new(&logs_dir).append(&format!("Паника: {message} ({location})"), now);
        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    #[test]
    fn only_own_reports_are_found() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["LeadGenerator-2026-11-06-120000.ips", "LeadGenerator_2026-11-06-120500.hang", "Customers-2026-11-07.ips", "Safari-2026-11-06-120000.ips", "LeadGenerator-notes.txt"] {
            fs::write(dir.path().join(name), "x").unwrap();
        }
        let missing = dir.path().join("missing");
        let found = find(&[dir.path().to_path_buf(), missing], None, None);
        let names: std::collections::HashSet<String> = found.iter().map(|f| f.path.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["LeadGenerator-2026-11-06-120000.ips", "LeadGenerator_2026-11-06-120500.hang", "Customers-2026-11-07.ips"].map(String::from).into_iter().collect());
        assert_eq!(found.iter().find(|f| f.path.extension().unwrap() == "hang").unwrap().kind, "Зависание");
        assert!(find(&[dir.path().to_path_buf()], None, Some(Utc::now() + Duration::seconds(60))).is_empty());
    }

    #[test]
    fn own_panic_reports_are_found_in_own_dir() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("crash-20261107-120000.txt"), "x").unwrap();
        fs::write(dir.path().join("other.txt"), "x").unwrap();
        let f = find(&[], Some(dir.path()), None);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].kind, "Вылет");
    }

    #[test]
    fn summary_of_ips() {
        let header = r#"{"app_name":"LeadGenerator","app_version":"1.0.3","os_version":"macOS 15.1 (24B83)","timestamp":"2026-11-06 12:00:00.00 +0300"}"#;
        let body = r#"{"exception":{"type":"EXC_BREAKPOINT","signal":"SIGTRAP"},"faultingThread":0,"usedImages":[{"name":"SwiftUI"},{"name":"LeadGenerator"}],"threads":[{"triggered":true,"frames":[{"imageIndex":0,"symbol":"EnvironmentValues.subscript.getter"},{"imageIndex":1,"imageOffset":4096}]}]}"#;
        let s = summary(&format!("{header}\n{body}"), 30, 4000);
        assert!(s.contains("Версия: 1.0.3") && s.contains("EXC_BREAKPOINT, SIGTRAP"));
        assert!(s.contains("0  SwiftUI  EnvironmentValues.subscript.getter"));
        assert!(s.contains("1  LeadGenerator  +0x1000"));
    }

    #[test]
    fn summary_falls_back_to_text() {
        assert_eq!(summary("Process: LeadGenerator\nCrashed Thread: 0", 30, 7), "Process");
        assert_eq!(summary("одна строка", 30, 5), "одна ");
    }

    #[test]
    fn redaction() {
        assert_eq!(redact("/Users/maksim/Library/x and maksim", "/Users/maksim", "maksim"), "~/Library/x and <user>");
        assert_eq!(redact(r"C:\Users\Anna\x и C:/Users/Anna/y", r"C:\Users\Anna", "Anna"), "~\\x и ~/y".replace("~\\x", r"~\x"));
        assert_eq!(redact("ab", "", "ab"), "ab", "короткие имена не скрываются");
    }

    #[test]
    fn issue_url_is_truncated_and_has_no_plus() {
        let url = issue_url("o/r", "Вылет", &format!("{} C++", "a".repeat(50)), 40);
        let u = url::Url::parse(&url).unwrap();
        assert_eq!(u.path(), "/o/r/issues/new");
        let q: std::collections::HashMap<_, _> = u.query_pairs().into_owned().collect();
        assert_eq!(q["title"], "Вылет");
        assert!(q["body"].starts_with(&"a".repeat(40)) && q["body"].contains("текст обрезан"));
        assert!(!url.contains('+'));
        assert!(default_issue_url("t", "b").starts_with("https://github.com/xop1tt/CLIENTS/issues/new"));
    }

    #[test]
    fn error_log_keeps_last_lines_and_scrubs_urls() {
        let dir = tempfile::tempdir().unwrap();
        let log = ErrorLog::new(dir.path()).with_keep(3);
        for i in 1..=5 {
            log.append(&format!("ошибка {i}\nвторая строка"), Utc::now());
        }
        let lines = log.recent(10);
        assert_eq!(lines.len(), 3);
        assert!(lines.last().unwrap().ends_with("ошибка 5 вторая строка"));
        log.append("GET https://api.example.com/x?key=SECRET#frag не удалось", Utc::now());
        let last = log.recent(1).remove(0);
        assert!(last.contains("https://api.example.com/x?…") && !last.contains("SECRET"));
        log.clear();
        assert!(log.recent(10).is_empty());
    }
}
