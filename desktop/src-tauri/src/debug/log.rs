//! Журнал событий Beta: кольцевой буфер в памяти и файл `logs/events.jsonl` (с одной предыдущей частью
//! `events.1.jsonl`). Секреты, токены, адреса почты, телефоны и личные пути маскируются до записи —
//! ни в памяти, ни в файле, ни в отчёте их нет.

use crate::app::Events;
use chrono::{DateTime, Utc};
use once_cell::sync::{Lazy, OnceCell};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Level {
    Debug,
    Info,
    Warning,
    Error,
    Critical,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Debug => "DEBUG",
            Level::Info => "INFO",
            Level::Warning => "WARNING",
            Level::Error => "ERROR",
            Level::Critical => "CRITICAL",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub seq: u64,
    pub at: String,
    pub level: Level,
    pub module: String,
    pub message: String,
}

/// Фильтр журнала: уровни (пусто — все), текст (без учёта регистра), период, последние `limit` записей.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Query {
    pub levels: Vec<Level>,
    pub text: String,
    pub since: Option<String>,
    pub until: Option<String>,
    pub limit: Option<usize>,
}

/// Размер файла, после которого он переименовывается в `events.1.jsonl` и начинается новый.
const ROTATE_BYTES: u64 = 4 * 1024 * 1024;
pub const CAPACITY: usize = 5000;

struct Inner {
    buf: VecDeque<Entry>,
    seq: u64,
}

pub struct EventLog {
    inner: Mutex<Inner>,
    file: Option<PathBuf>,
    capacity: usize,
    home: String,
    user: String,
}

impl EventLog {
    /// `dir` — папка журналов канала (None — только память). `home` и `user` вырезаются из текста.
    pub fn new(dir: Option<&Path>, capacity: usize, home: &str, user: &str) -> Self {
        let file = dir.map(|d| {
            let _ = fs::create_dir_all(d);
            d.join("events.jsonl")
        });
        let mut buf = VecDeque::with_capacity(capacity.min(1024));
        let mut seq = 0;
        // Записи прошлых запусков видны после перезапуска (последние `capacity`).
        if let Some(f) = &file {
            if let Ok(text) = fs::read_to_string(f) {
                for e in text.lines().filter_map(|l| serde_json::from_str::<Entry>(l).ok()) {
                    seq = seq.max(e.seq);
                    buf.push_back(e);
                    if buf.len() > capacity {
                        buf.pop_front();
                    }
                }
            }
        }
        Self { inner: Mutex::new(Inner { buf, seq }), file, capacity, home: home.to_string(), user: user.to_string() }
    }

    pub fn path(&self) -> Option<&Path> {
        self.file.as_deref()
    }

    pub fn record(&self, level: Level, module: &str, message: &str) -> Entry {
        let message = crate::reports::redact(&mask(message), &self.home, &self.user);
        let mut g = self.inner.lock().unwrap();
        g.seq += 1;
        let entry = Entry { seq: g.seq, at: crate::util::format_date(&Utc::now()), level, module: module.to_string(), message };
        g.buf.push_back(entry.clone());
        while g.buf.len() > self.capacity {
            g.buf.pop_front();
        }
        if let Some(f) = &self.file {
            if fs::metadata(f).map(|m| m.len() > ROTATE_BYTES).unwrap_or(false) {
                let _ = fs::rename(f, f.with_file_name("events.1.jsonl"));
            }
            if let Ok(mut out) = OpenOptions::new().create(true).append(true).open(f) {
                let _ = writeln!(out, "{}", serde_json::to_string(&entry).unwrap_or_default());
            }
        }
        entry
    }

    pub fn query(&self, q: &Query) -> Vec<Entry> {
        let since = q.since.as_deref().and_then(parse);
        let until = q.until.as_deref().and_then(parse);
        let text = q.text.trim().to_lowercase();
        let g = self.inner.lock().unwrap();
        let mut out: Vec<Entry> = g
            .buf
            .iter()
            .filter(|e| q.levels.is_empty() || q.levels.contains(&e.level))
            .filter(|e| text.is_empty() || e.message.to_lowercase().contains(&text) || e.module.to_lowercase().contains(&text))
            .filter(|e| {
                let at = parse(&e.at);
                since.map_or(true, |s| at.is_some_and(|a| a >= s)) && until.map_or(true, |u| at.is_some_and(|a| a <= u))
            })
            .cloned()
            .collect();
        if let Some(n) = q.limit {
            let skip = out.len().saturating_sub(n);
            out.drain(..skip);
        }
        out
    }

    pub fn last(&self, n: usize) -> Vec<Entry> {
        self.query(&Query { limit: Some(n), ..Query::default() })
    }

    pub fn len(&self) -> usize {
        self.inner.lock().unwrap().buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Очистить журнал: память и оба файла.
    pub fn clear(&self) {
        self.inner.lock().unwrap().buf.clear();
        if let Some(f) = &self.file {
            let _ = fs::remove_file(f.with_file_name("events.1.jsonl"));
            let _ = fs::write(f, b"");
        }
    }
}

fn parse(s: &str) -> Option<DateTime<Utc>> {
    crate::util::parse_date(s)
}

/// Записи в виде JSON Lines (для экспорта и отчёта).
pub fn to_jsonl(entries: &[Entry]) -> String {
    entries.iter().map(|e| serde_json::to_string(e).unwrap_or_default() + "\n").collect()
}

/// Записи в виде текста: «время УРОВЕНЬ [модуль] сообщение».
pub fn to_text(entries: &[Entry]) -> String {
    entries.iter().map(|e| format!("{} {} [{}] {}\n", e.at, e.level.as_str(), e.module, e.message)).collect()
}

// ---------------------------------------------------------------- маскирование

static JWT: Lazy<Regex> = Lazy::new(|| Regex::new(r"eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*").unwrap());
static SB_KEY: Lazy<Regex> = Lazy::new(|| Regex::new(r"sb_(publishable|secret)_[A-Za-z0-9_-]+").unwrap());
static BEARER: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}").unwrap());
static NAMED: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)("?(?:access_token|refresh_token|token|password|passwd|secret|api[_-]?key|apikey|authorization|code)"?\s*[:=]\s*"?)([^"\s,&}]+)"#)
        .unwrap()
});
static EMAIL: Lazy<Regex> = Lazy::new(|| Regex::new(r"([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})").unwrap());
static PHONE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?:\+\d{1,3}|\b8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}\b").unwrap());

/// Убирает из текста то, что нельзя хранить в журнале и отправлять в отчёте.
pub fn mask(text: &str) -> String {
    let s = JWT.replace_all(text, "<token>");
    let s = SB_KEY.replace_all(&s, "<key>");
    let s = BEARER.replace_all(&s, "$1 <token>");
    let s = NAMED.replace_all(&s, "${1}<hidden>");
    let s = EMAIL.replace_all(&s, "$1•••@$2");
    let s = PHONE.replace_all(&s, |c: &regex::Captures| {
        let digits: String = c[0].chars().filter(char::is_ascii_digit).collect();
        format!("•••{}", &digits[digits.len().saturating_sub(2)..])
    });
    s.into_owned()
}

// ---------------------------------------------------------------- журнал приложения

static GLOBAL: OnceCell<EventLog> = OnceCell::new();

/// Включить журнал приложения (один раз при запуске Beta).
pub fn install(dir: &Path, home: &str, user: &str) -> &'static EventLog {
    GLOBAL.get_or_init(|| EventLog::new(Some(dir), CAPACITY, home, user))
}

pub fn global() -> Option<&'static EventLog> {
    GLOBAL.get()
}

/// Записать событие в журнал приложения; до `install` (тесты ядра) — ничего не делает.
pub fn record(level: Level, module: &str, message: &str) {
    if let Some(log) = GLOBAL.get() {
        log.record(level, module, message);
    }
}

/// События ядра для интерфейса — и в журнал (только имя и краткая суть, без содержимого данных).
pub struct LoggedEvents(pub Arc<dyn Events>);

impl Events for LoggedEvents {
    fn emit(&self, name: &str, payload: Value) {
        let (level, detail) = describe(name, &payload);
        record(level, "event", &detail);
        self.0.emit(name, payload);
    }
}

fn describe(name: &str, payload: &Value) -> (Level, String) {
    let text = |key: &str| payload.get(key).and_then(Value::as_str).map(|v| v.chars().take(300).collect::<String>()).unwrap_or_default();
    match name {
        "search-finished" => {
            let failed = payload.get("failed").and_then(Value::as_bool).unwrap_or(false);
            (if failed { Level::Warning } else { Level::Info }, format!("Поиск завершён: {}", text("summary")))
        }
        "sync-state" => {
            let kind = text("kind");
            let level = if kind == "failed" || kind == "offline" { Level::Warning } else { Level::Debug };
            (level, format!("Синхронизация: {kind} {}", text("message")).trim_end().to_string())
        }
        "notify" => {
            let level = if text("kind") == "error" { Level::Error } else { Level::Info };
            (level, format!("Уведомление: {} — {}", text("title"), text("body")))
        }
        "toast" => (Level::Info, format!("Сообщение: {}", text("text"))),
        "session-ended" => (Level::Warning, "Сессия завершена".into()),
        _ => (Level::Debug, name.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_and_personal_data_are_masked_before_storage() {
        let token = format!("eyJ{}.eyJ{}.{}", "a".repeat(20), "b".repeat(20), "c".repeat(20));
        let text = format!(
            "token {token}; key sb_publishable_{}; Authorization: Bearer abcdefghijk123; {{\"password\":\"hunter2\"}}; mail anna.petrova@example.com; tel +7 (912) 345-67-89; /home/anna/x",
            "z".repeat(20)
        );
        let dir = tempfile::tempdir().unwrap();
        let log = EventLog::new(Some(dir.path()), 10, "/home/anna", "anna");
        let e = log.record(Level::Info, "test", &text);
        for leaked in [token.as_str(), "sb_publishable_", "abcdefghijk123", "hunter2", "anna.petrova", "345-67-89", "/home/anna"] {
            assert!(!e.message.contains(leaked), "{leaked} в «{}»", e.message);
        }
        assert!(e.message.contains("a•••@example.com") && e.message.contains("•••89"), "{}", e.message);
        let plain = log.record(Level::Info, "test", "2026-11-09 12:00:00, версия 1.1.0, найдено 1234567890 байт");
        assert_eq!(plain.message, "2026-11-09 12:00:00, версия 1.1.0, найдено 1234567890 байт", "даты и числа не портятся");
        let file = fs::read_to_string(dir.path().join("events.jsonl")).unwrap();
        assert!(!file.contains("hunter2") && !file.contains(&token));
    }

    #[test]
    fn ring_buffer_filters_and_survives_restart() {
        let dir = tempfile::tempdir().unwrap();
        let log = EventLog::new(Some(dir.path()), 3, "", "");
        log.record(Level::Debug, "a", "один");
        log.record(Level::Error, "b", "два");
        log.record(Level::Warning, "c", "три");
        log.record(Level::Info, "d", "четыре");
        assert_eq!(log.len(), 3, "старые записи вытесняются");
        assert_eq!(log.query(&Query { levels: vec![Level::Error, Level::Warning], ..Query::default() }).len(), 2);
        assert_eq!(log.query(&Query { text: "ЧЕТЫ".into(), ..Query::default() })[0].module, "d");
        assert_eq!(log.query(&Query { since: Some("2100-01-01T00:00:00Z".into()), ..Query::default() }).len(), 0);
        assert_eq!(log.last(1)[0].message, "четыре");

        let again = EventLog::new(Some(dir.path()), 3, "", "");
        assert_eq!(again.last(3).iter().map(|e| e.message.as_str()).collect::<Vec<_>>(), ["два", "три", "четыре"]);
        assert_eq!(again.record(Level::Info, "e", "пять").seq, 5, "нумерация продолжается");

        again.clear();
        assert!(again.is_empty());
        assert_eq!(fs::read_to_string(dir.path().join("events.jsonl")).unwrap(), "");
        assert!(EventLog::new(Some(dir.path()), 3, "", "").is_empty(), "после очистки журнал пуст и после перезапуска");
    }

    #[test]
    fn text_export_uses_level_names() {
        let log = EventLog::new(None, 10, "", "");
        log.record(Level::Warning, "sync", "нет сети");
        let text = to_text(&log.last(10));
        assert!(text.contains("WARNING [sync] нет сети"), "{text}");
        assert!(to_jsonl(&log.last(10)).contains("\"level\":\"WARNING\""));
    }
}
