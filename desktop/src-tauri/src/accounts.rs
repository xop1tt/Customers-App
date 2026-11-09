//! Локальные учётные записи в accounts.db рядом с базами пользователей. Пароль не хранится — только
//! соль и хэш PBKDF2-HMAC-SHA256. Формат таблицы и параметры совпадают с прежними версиями.

use crate::error::{AppError, AppResult};
use crate::util::{format_date, now_string, parse_date};
use base64::Engine;
use once_cell::sync::Lazy;
use rand::Rng;
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::Sha256;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const ITERATIONS: u32 = 310_000;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserAccount {
    pub username: String,
    pub created_at: Option<String>,
    pub last_login_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum AuthError {
    InvalidUsername,
    WeakPassword,
    PasswordsDiffer,
    Exists,
    WrongCredentials,
    TooManyAttempts(u64),
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthError::InvalidUsername => {
                f.write_str("Имя пользователя: от 3 до 32 символов — буквы, цифры, точка, дефис или подчёркивание, начинается с буквы или цифры.")
            }
            AuthError::WeakPassword => f.write_str("Пароль должен быть не короче 8 символов."),
            AuthError::PasswordsDiffer => f.write_str("Пароли не совпадают."),
            AuthError::Exists => f.write_str("Такое имя пользователя уже занято."),
            AuthError::WrongCredentials => f.write_str("Неверное имя пользователя или пароль."),
            AuthError::TooManyAttempts(s) => write!(f, "Слишком много попыток. Повторите через {s} с."),
        }
    }
}

impl std::error::Error for AuthError {}

impl From<AuthError> for AppError {
    fn from(e: AuthError) -> Self {
        AppError::msg(e.to_string())
    }
}

static NAME_RX: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[\p{L}\p{N}][\p{L}\p{N}_.-]{2,31}$").unwrap());

pub struct LocalAccounts {
    root: PathBuf,
    db: Mutex<Connection>,
    iterations: u32,
    failures: Mutex<HashMap<String, (u32, Instant)>>,
}

impl LocalAccounts {
    pub fn open(root: &Path) -> AppResult<Self> {
        Self::open_with(root, ITERATIONS)
    }

    pub fn open_with(root: &Path, iterations: u32) -> AppResult<Self> {
        std::fs::create_dir_all(root)?;
        let db = Connection::open(root.join("accounts.db"))?;
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS users (
                username_key TEXT PRIMARY KEY,
                username TEXT NOT NULL,
                salt TEXT NOT NULL,
                hash TEXT NOT NULL,
                iterations INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                last_login_at TEXT
            );",
        )?;
        Ok(Self { root: root.to_path_buf(), db: Mutex::new(db), iterations, failures: Mutex::new(HashMap::new()) })
    }

    pub fn normalized(username: &str) -> Option<String> {
        let u = username.trim();
        NAME_RX.is_match(u).then(|| u.to_string())
    }

    pub fn key(username: &str) -> String {
        username.to_lowercase()
    }

    pub fn has_users(&self) -> bool {
        self.db.lock().unwrap().query_row("SELECT COUNT(*) FROM users", [], |r| r.get::<_, i64>(0)).unwrap_or(0) > 0
    }

    pub fn account(&self, username: &str) -> Option<UserAccount> {
        let db = self.db.lock().unwrap();
        db.query_row("SELECT username, created_at, last_login_at FROM users WHERE username_key=?1", [Self::key(username)], |r| {
            Ok(UserAccount { username: r.get(0)?, created_at: r.get(1)?, last_login_at: r.get(2)? })
        })
        .optional()
        .ok()
        .flatten()
    }

    /// Все локальные учётные записи (для переноса их данных в облачную).
    pub fn all_accounts(&self) -> Vec<UserAccount> {
        let db = self.db.lock().unwrap();
        let Ok(mut st) = db.prepare("SELECT username, created_at, last_login_at FROM users ORDER BY username_key") else { return vec![] };
        st.query_map([], |r| Ok(UserAccount { username: r.get(0)?, created_at: r.get(1)?, last_login_at: r.get(2)? }))
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default()
    }

    pub fn register(&self, username: &str, password: &str) -> Result<UserAccount, AuthError> {
        let name = Self::normalized(username).ok_or(AuthError::InvalidUsername)?;
        if password.chars().count() < 8 {
            return Err(AuthError::WeakPassword);
        }
        if self.account(&name).is_some() {
            return Err(AuthError::Exists);
        }
        let mut salt = [0u8; 16];
        rand::rng().fill_bytes(&mut salt);
        let hash = pbkdf2(password, &salt, self.iterations);
        let now = now_string();
        let b64 = base64::engine::general_purpose::STANDARD;
        self.db
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO users(username_key, username, salt, hash, iterations, created_at, last_login_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![Self::key(&name), name, b64.encode(salt), b64.encode(hash), self.iterations, now, now],
            )
            .map_err(|_| AuthError::Exists)?;
        let _ = std::fs::create_dir_all(self.data_directory(&name));
        Ok(self.account(&name).unwrap_or(UserAccount { username: name, created_at: Some(now.clone()), last_login_at: Some(now) }))
    }

    pub fn login(&self, username: &str, password: &str) -> Result<UserAccount, AuthError> {
        let key = Self::key(username.trim());
        if let Some((_, until)) = self.failures.lock().unwrap().get(&key) {
            if *until > Instant::now() {
                return Err(AuthError::TooManyAttempts((*until - Instant::now()).as_secs_f64().ceil() as u64));
            }
        }
        if !self.verify(&key, password) {
            // После 5 неудачных попыток подряд — пауза, растущая с каждой следующей.
            let mut f = self.failures.lock().unwrap();
            let entry = f.entry(key).or_insert((0, Instant::now()));
            entry.0 += 1;
            if entry.0 >= 5 {
                entry.1 = Instant::now() + Duration::from_secs(u64::from((15 * (entry.0 - 4)).min(300)));
            }
            return Err(AuthError::WrongCredentials);
        }
        self.failures.lock().unwrap().remove(&key);
        let _ = self.db.lock().unwrap().execute("UPDATE users SET last_login_at=?1 WHERE username_key=?2", params![now_string(), key]);
        Ok(self.account(&key).unwrap_or(UserAccount { username: username.into(), created_at: None, last_login_at: None }))
    }

    fn verify(&self, key: &str, password: &str) -> bool {
        let b64 = base64::engine::general_purpose::STANDARD;
        let row: Option<(String, String, u32)> = self
            .db
            .lock()
            .unwrap()
            .query_row("SELECT salt, hash, iterations FROM users WHERE username_key=?1", [key], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .optional()
            .ok()
            .flatten();
        let parsed = row.and_then(|(s, h, n)| Some((b64.decode(s).ok()?, b64.decode(h).ok()?, n)));
        match parsed {
            Some((salt, stored, rounds)) => constant_time_eq(&pbkdf2(password, &salt, rounds), &stored),
            None => {
                // Тратим столько же времени, сколько на настоящую проверку: имя пользователя не угадать по задержке.
                let _ = pbkdf2(password, &[0u8; 16], self.iterations);
                false
            }
        }
    }

    pub fn change_password(&self, username: &str, old: &str, new: &str) -> Result<(), AuthError> {
        let key = Self::key(username);
        if !self.verify(&key, old) {
            return Err(AuthError::WrongCredentials);
        }
        if new.chars().count() < 8 {
            return Err(AuthError::WeakPassword);
        }
        let mut salt = [0u8; 16];
        rand::rng().fill_bytes(&mut salt);
        let hash = pbkdf2(new, &salt, self.iterations);
        let b64 = base64::engine::general_purpose::STANDARD;
        let _ = self.db.lock().unwrap().execute(
            "UPDATE users SET salt=?1, hash=?2, iterations=?3 WHERE username_key=?4",
            params![b64.encode(salt), b64.encode(hash), self.iterations, key],
        );
        Ok(())
    }

    /// Удаляет запись пользователя (данные в папке остаются — их убирает вызывающий).
    pub fn remove(&self, username: &str) {
        let _ = self.db.lock().unwrap().execute("DELETE FROM users WHERE username_key=?1", [Self::key(username)]);
    }

    pub fn data_directory(&self, username: &str) -> PathBuf {
        self.root.join("users").join(Self::key(username))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn last_login(&self, username: &str) -> Option<chrono::DateTime<chrono::Utc>> {
        self.account(username).and_then(|a| a.last_login_at).and_then(|s| parse_date(&s))
    }
}

/// PBKDF2-HMAC-SHA256, 32 байта.
pub fn pbkdf2(password: &str, salt: &[u8], iterations: u32) -> [u8; 32] {
    let mut out = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, iterations, &mut out);
    out
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

#[allow(unused)]
fn _keep(d: &chrono::DateTime<chrono::Utc>) -> String {
    format_date(d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn accounts() -> (tempfile::TempDir, LocalAccounts) {
        let dir = tempfile::tempdir().unwrap();
        let a = LocalAccounts::open_with(dir.path(), 1000).unwrap();
        (dir, a)
    }

    #[test]
    fn register_and_login() {
        let (_d, a) = accounts();
        assert!(!a.has_users());
        let acc = a.register("  Anna.K  ", "password1").unwrap();
        assert_eq!(acc.username, "Anna.K");
        assert!(a.has_users());
        assert_eq!(a.login("anna.k", "password1").unwrap().username, "Anna.K");
        assert_eq!(a.login("anna.k", "nope").unwrap_err(), AuthError::WrongCredentials);
        assert!(a.data_directory("Anna.K").ends_with("users/anna.k"));
        assert!(a.data_directory("Anna.K").exists());
    }

    #[test]
    fn validation_rules() {
        let (_d, a) = accounts();
        for bad in ["ab", "_abc", "a b c", &"x".repeat(33), ""] {
            assert_eq!(a.register(bad, "password1").unwrap_err(), AuthError::InvalidUsername, "{bad}");
        }
        assert_eq!(a.register("anna", "short").unwrap_err(), AuthError::WeakPassword);
        a.register("анна", "password1").unwrap();
        assert_eq!(a.register("АННА", "password1").unwrap_err(), AuthError::Exists);
    }

    #[test]
    fn lockout_after_five_failures_and_reset_on_success() {
        let (_d, a) = accounts();
        a.register("anna", "password1").unwrap();
        for _ in 0..4 {
            assert_eq!(a.login("anna", "x").unwrap_err(), AuthError::WrongCredentials);
        }
        assert_eq!(a.login("anna", "x").unwrap_err(), AuthError::WrongCredentials); // пятая
        match a.login("anna", "password1").unwrap_err() {
            AuthError::TooManyAttempts(s) => assert!((1..=15).contains(&s)),
            e => panic!("{e:?}"),
        }
        let (_d2, b) = accounts();
        b.register("bob", "password1").unwrap();
        for _ in 0..3 {
            let _ = b.login("bob", "x");
        }
        b.login("bob", "password1").unwrap();
        for _ in 0..3 {
            assert_eq!(b.login("bob", "x").unwrap_err(), AuthError::WrongCredentials);
        }
    }

    #[test]
    fn password_change() {
        let (_d, a) = accounts();
        a.register("anna", "password1").unwrap();
        assert_eq!(a.change_password("anna", "bad", "password2").unwrap_err(), AuthError::WrongCredentials);
        assert_eq!(a.change_password("anna", "password1", "short").unwrap_err(), AuthError::WeakPassword);
        a.change_password("anna", "password1", "password2").unwrap();
        assert!(a.login("anna", "password1").is_err());
        a.login("anna", "password2").unwrap();
    }

    #[test]
    fn reads_hashes_written_by_previous_versions() {
        // Запись, созданная приложением для macOS: соль и хэш в base64, 310 000 итераций.
        let dir = tempfile::tempdir().unwrap();
        let salt = [7u8; 16];
        let hash = pbkdf2("legacy-pass1", &salt, ITERATIONS);
        let b64 = base64::engine::general_purpose::STANDARD;
        {
            let a = LocalAccounts::open_with(dir.path(), 1000).unwrap();
            a.db.lock()
                .unwrap()
                .execute(
                    "INSERT INTO users VALUES('olga','Olga',?1,?2,?3,'2026-01-01T00:00:00Z',NULL)",
                    params![b64.encode(salt), b64.encode(hash), ITERATIONS],
                )
                .unwrap();
        }
        let a = LocalAccounts::open(dir.path()).unwrap();
        assert_eq!(a.login("OLGA", "legacy-pass1").unwrap().username, "Olga");
        assert_eq!(a.all_accounts().len(), 1);
    }

    #[test]
    fn pbkdf2_known_vector() {
        // RFC 7914, раздел 11: PBKDF2-HMAC-SHA-256 ("passwd", "salt", c=1) — первые байты.
        let out = pbkdf2("passwd", b"salt", 1);
        assert_eq!(hex::encode(&out[..8]), "55ac046e56e3089f");
    }
}
