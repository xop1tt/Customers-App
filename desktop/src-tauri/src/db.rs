//! Шифрованная локальная база (SQLCipher, AES-256) и перевод старых незашифрованных баз.
//!
//! Два вида ключей, потому что так хранят прежние версии:
//! * macOS: 32 случайных байта в виде 64 hex-символов, передаются как «сырой» ключ `x'…'`;
//! * Windows: случайная строка (base64), SQLCipher выводит из неё ключ сам (PBKDF2).
//! Оба открываются одним и тем же кодом, формат файла одинаковый.

use crate::error::{AppError, AppResult};
use rusqlite::{Connection, OpenFlags};
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Clone, PartialEq, Eq)]
pub enum DbKey {
    /// 64 шестнадцатеричных символа в нижнем регистре.
    Raw(String),
    /// Пароль-строка (ключ Windows-версии).
    Passphrase(String),
}

impl std::fmt::Debug for DbKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Ключ не попадает в журналы и сообщения об ошибках.
        write!(f, "DbKey(…)")
    }
}

impl DbKey {
    /// Значение из хранилища секретов: 64 hex — сырой ключ, иначе пароль-строка.
    pub fn from_secret(value: &str) -> Option<Self> {
        let v = value.trim();
        if v.is_empty() {
            return None;
        }
        if v.len() == 64 && v.chars().all(|c| c.is_ascii_hexdigit()) {
            return Some(DbKey::Raw(v.to_lowercase()));
        }
        Some(DbKey::Passphrase(v.to_string()))
    }

    pub fn raw_hex(hex: &str) -> Option<Self> {
        let h = hex.to_lowercase();
        (h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit())).then_some(DbKey::Raw(h))
    }

    /// Новый случайный ключ.
    pub fn random() -> Self {
        use rand::RngCore;
        let mut b = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut b);
        DbKey::Raw(hex::encode(b))
    }

    /// Строка для хранилища секретов.
    pub fn secret(&self) -> String {
        match self {
            DbKey::Raw(h) => h.clone(),
            DbKey::Passphrase(p) => p.clone(),
        }
    }

    /// Значение для `ATTACH … KEY ?` (без кавычек): сырой ключ в виде x'…' или сама строка.
    fn attach_value(&self) -> String {
        match self {
            DbKey::Raw(h) => format!("x'{h}'"),
            DbKey::Passphrase(p) => p.clone(),
        }
    }

    /// Предложение `PRAGMA key = …` с экранированием.
    fn pragma(&self) -> String {
        match self {
            DbKey::Raw(h) => format!("PRAGMA key = \"x'{h}'\";"),
            DbKey::Passphrase(p) => format!("PRAGMA key = '{}';", p.replace('\'', "''")),
        }
    }
}

/// Первые 16 байт любого незашифрованного файла SQLite. У файла SQLCipher заголовок случайный.
const PLAIN_HEADER: &[u8; 16] = b"SQLite format 3\0";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileState {
    Missing,
    Empty,
    Plaintext,
    Encrypted,
}

pub fn file_state(path: &Path) -> FileState {
    let Ok(mut f) = fs::File::open(path) else { return FileState::Missing };
    let mut head = [0u8; 16];
    let n = f.read(&mut head).unwrap_or(0);
    if n == 0 {
        return FileState::Empty;
    }
    if n == 16 && &head == PLAIN_HEADER { FileState::Plaintext } else { FileState::Encrypted }
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(suffix);
    PathBuf::from(s)
}

/// Удалить файл базы вместе с -wal/-shm/-journal.
pub fn remove_database_files(path: &Path) {
    for s in ["", "-wal", "-shm", "-journal"] {
        let _ = fs::remove_file(with_suffix(path, s));
    }
}

/// Открывает файл базы. С ключом: библиотека обязана быть SQLCipher, а файл — зашифрован этим ключом
/// (или ещё не существовать), иначе ошибка, и файл не меняется.
pub fn open_connection(path: &Path, read_only: bool, key: Option<&DbKey>) -> AppResult<Connection> {
    let flags = if read_only {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    } else {
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE
    } | OpenFlags::SQLITE_OPEN_FULL_MUTEX;
    let conn = Connection::open_with_flags(path, flags)?;
    conn.busy_timeout(std::time::Duration::from_millis(3000))?;
    if let Some(key) = key {
        // Без SQLCipher «PRAGMA key» молча ничего не делает и база осталась бы открытой.
        let version: Option<String> = conn.query_row("PRAGMA cipher_version", [], |r| r.get(0)).ok();
        if version.as_deref().unwrap_or("").is_empty() {
            return Err(AppError::msg("сборка без SQLCipher: шифрование базы недоступно"));
        }
        conn.execute_batch(&key.pragma())?;
        // Ключ проверяется только при первом чтении.
        if let Err(e) = conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0)) {
            if let rusqlite::Error::SqliteFailure(f, _) = &e {
                if f.code == rusqlite::ErrorCode::NotADatabase {
                    return Err(AppError::msg("не удалось расшифровать базу: ключ не подходит или файл повреждён"));
                }
            }
            return Err(e.into());
        }
    }
    Ok(conn)
}

/// Число строк в каждой пользовательской таблице.
pub fn row_counts(conn: &Connection) -> AppResult<BTreeMap<String, i64>> {
    let mut st = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")?;
    let names: Vec<String> = st.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
    let mut out = BTreeMap::new();
    for t in names {
        let quoted = format!("\"{}\"", t.replace('"', "\"\""));
        let n: i64 = conn.query_row(&format!("SELECT count(*) FROM {quoted}"), [], |r| r.get(0))?;
        out.insert(t, n);
    }
    Ok(out)
}

fn verify(path: &Path, key: &DbKey, expected: &BTreeMap<String, i64>) -> AppResult<()> {
    let conn = open_connection(path, true, Some(key))?;
    let check: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    if check != "ok" {
        return Err(AppError::msg("проверка целостности не пройдена"));
    }
    if &row_counts(&conn)? != expected {
        return Err(AppError::msg("число записей не совпадает с исходной базой"));
    }
    Ok(())
}

fn staging_path(p: &Path) -> PathBuf {
    with_suffix(p, ".encrypting")
}
fn plaintext_path(p: &Path) -> PathBuf {
    with_suffix(p, ".unencrypted")
}

/// Открывает базу по `path` с ключом. Незашифрованная база (версии до шифрования) сначала
/// переписывается в зашифрованную; данные проверяются до удаления исходного файла. Если программа
/// прервалась посреди замены, при следующем запуске замена доводится до конца или откатывается.
pub fn open_encrypted(path: &Path, key: &DbKey) -> AppResult<Connection> {
    recover_interrupted_migration(path, key)?;
    match file_state(path) {
        FileState::Missing | FileState::Empty | FileState::Encrypted => open_connection(path, false, Some(key)),
        FileState::Plaintext => {
            migrate_plaintext(path, key)?;
            open_connection(path, false, Some(key))
        }
    }
}

/// Переписывает незашифрованную базу `path` в зашифрованную на том же месте.
pub fn migrate_plaintext(path: &Path, key: &DbKey) -> AppResult<()> {
    let staging = staging_path(path);
    let plain = plaintext_path(path);
    remove_database_files(&staging);

    // 1. Зашифрованная копия рядом. Источник открыт обычным соединением: оно видит и данные из WAL.
    let source = open_connection(path, false, None)?;
    let counts = (|| -> AppResult<BTreeMap<String, i64>> {
        let counts = row_counts(&source)?;
        let user_version: i64 = source.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        source.execute("ATTACH DATABASE ?1 AS encrypted KEY ?2", rusqlite::params![staging.to_string_lossy(), key.attach_value()])?;
        source.query_row("SELECT sqlcipher_export('encrypted')", [], |_| Ok(()))?;
        // sqlcipher_export не переносит user_version.
        source.execute_batch(&format!("PRAGMA encrypted.user_version = {user_version}; DETACH DATABASE encrypted;"))?;
        Ok(counts)
    })();
    let counts = match counts {
        Ok(c) => c,
        Err(e) => {
            drop(source);
            remove_database_files(&staging);
            return Err(AppError::msg(format!(
                "Не удалось зашифровать базу {}: {e}. Исходный файл не изменён.",
                path.display()
            )));
        }
    };
    drop(source);

    // 2. Копия открывается ключом и совпадает с исходной по числу строк в каждой таблице.
    if let Err(e) = verify(&staging, key, &counts) {
        remove_database_files(&staging);
        return Err(AppError::msg(format!("Зашифрованная копия базы не прошла проверку: {e}. Исходный файл не изменён.")));
    }

    // 3. Замена: исходный файл (вместе с -wal/-shm) отходит в сторону, копия встаёт на его место.
    //    Старый -wal нельзя оставлять рядом с новой базой: SQLite попытался бы применить его к ней.
    remove_database_files(&plain);
    fs::rename(path, &plain)?;
    for s in ["-wal", "-shm"] {
        let p = with_suffix(path, s);
        if p.exists() {
            fs::rename(&p, with_suffix(&plain, s))?;
        }
    }
    if let Err(e) = fs::rename(&staging, path) {
        let _ = fs::rename(&plain, path);
        for s in ["-wal", "-shm"] {
            let _ = fs::rename(with_suffix(&plain, s), with_suffix(path, s));
        }
        return Err(e.into());
    }

    // 4. Исходный файл удаляется только после того, как база на месте открылась ключом.
    verify(path, key, &counts)?;
    remove_database_files(&plain);
    Ok(())
}

/// Доводит до конца или откатывает замену, прерванную на шаге 3–4.
pub fn recover_interrupted_migration(path: &Path, key: &DbKey) -> AppResult<()> {
    let staging = staging_path(path);
    let plain = plaintext_path(path);
    if !plain.exists() {
        remove_database_files(&staging); // недописанная копия с шагов 1–2: исходник не тронут
        return Ok(());
    }
    match file_state(path) {
        FileState::Missing | FileState::Empty => {
            // Исходник уже отодвинут, а копия не встала на место: возвращаем исходник.
            if path.exists() {
                fs::remove_file(path)?;
            }
            fs::rename(&plain, path)?;
            for s in ["-wal", "-shm"] {
                let from = with_suffix(&plain, s);
                if from.exists() {
                    let _ = fs::remove_file(with_suffix(path, s));
                    fs::rename(from, with_suffix(path, s))?;
                }
            }
            remove_database_files(&staging);
        }
        FileState::Encrypted => {
            // Копия уже на месте. Исходник удаляем, только если база открывается ключом.
            open_connection(path, true, Some(key))?;
            remove_database_files(&plain);
            remove_database_files(&staging);
        }
        FileState::Plaintext => {
            // На месте снова незашифрованная база (например, её вернули вручную): её данные новее,
            // отложенный файл оставляем под другим именем, чтобы ничего не потерять.
            let stamp = chrono::Utc::now().timestamp();
            fs::rename(&plain, with_suffix(path, &format!(".unencrypted-{stamp}")))?;
            remove_database_files(&staging);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn plain_db(path: &Path) {
        let c = open_connection(path, false, None).unwrap();
        c.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE t(a TEXT); INSERT INTO t VALUES('секрет-1'),('секрет-2'); PRAGMA user_version=7;").unwrap();
    }

    #[test]
    fn library_is_sqlcipher() {
        let d = tempdir().unwrap();
        let c = open_connection(&d.path().join("a.db"), false, None).unwrap();
        let v: String = c.query_row("PRAGMA cipher_version", [], |r| r.get(0)).unwrap();
        assert!(!v.is_empty());
    }

    #[test]
    fn secret_parsing_distinguishes_raw_and_passphrase() {
        let hex = "ab".repeat(32);
        assert_eq!(DbKey::from_secret(&hex), Some(DbKey::Raw(hex.clone())));
        assert_eq!(DbKey::from_secret(&hex.to_uppercase()), Some(DbKey::Raw(hex)));
        assert!(matches!(DbKey::from_secret("Zm9vYmFyYmF6"), Some(DbKey::Passphrase(_))));
        assert_eq!(DbKey::from_secret("  "), None);
        assert_ne!(DbKey::random(), DbKey::random());
        assert_eq!(format!("{:?}", DbKey::random()), "DbKey(…)");
    }

    #[test]
    fn new_database_is_encrypted_and_needs_the_key() {
        let d = tempdir().unwrap();
        let p = d.path().join("a.db");
        let key = DbKey::random();
        {
            let c = open_encrypted(&p, &key).unwrap();
            c.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE t(a TEXT); INSERT INTO t VALUES('секрет');").unwrap();
            // WAL открытой базы тоже зашифрован.
            for s in ["", "-wal"] {
                if let Ok(bytes) = fs::read(with_suffix(&p, s)) {
                    assert!(!String::from_utf8_lossy(&bytes).contains("секрет"));
                }
            }
        }
        assert_eq!(file_state(&p), FileState::Encrypted);
        assert!(open_connection(&p, false, None).and_then(|c| Ok(c.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0))?)).is_err());
        assert!(open_connection(&p, false, Some(&DbKey::random())).is_err());
        let c = open_connection(&p, false, Some(&key)).unwrap();
        assert_eq!(row_counts(&c).unwrap()["t"], 1);
    }

    #[test]
    fn passphrase_keys_work_like_windows_ones() {
        let d = tempdir().unwrap();
        let p = d.path().join("a.db");
        let key = DbKey::Passphrase("abc'DEF+/=".into());
        {
            let c = open_encrypted(&p, &key).unwrap();
            c.execute_batch("CREATE TABLE t(a); INSERT INTO t VALUES(1);").unwrap();
        }
        assert!(open_connection(&p, false, Some(&DbKey::Passphrase("other".into()))).is_err());
        assert!(open_connection(&p, false, Some(&key)).is_ok());
    }

    #[test]
    fn empty_file_becomes_encrypted_database() {
        let d = tempdir().unwrap();
        let p = d.path().join("a.db");
        fs::write(&p, b"").unwrap();
        assert_eq!(file_state(&p), FileState::Empty);
        let key = DbKey::random();
        open_encrypted(&p, &key).unwrap().execute_batch("CREATE TABLE t(a)").unwrap();
        assert_eq!(file_state(&p), FileState::Encrypted);
    }

    #[test]
    fn plaintext_database_is_migrated_without_loss() {
        let d = tempdir().unwrap();
        let p = d.path().join("a.db");
        plain_db(&p);
        assert_eq!(file_state(&p), FileState::Plaintext);
        let key = DbKey::random();
        let c = open_encrypted(&p, &key).unwrap();
        assert_eq!(row_counts(&c).unwrap()["t"], 2);
        let uv: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(uv, 7, "user_version переносится");
        drop(c);
        assert_eq!(file_state(&p), FileState::Encrypted);
        assert!(!with_suffix(&p, ".unencrypted").exists());
        assert!(!with_suffix(&p, ".encrypting").exists());
        assert!(!String::from_utf8_lossy(&fs::read(&p).unwrap()).contains("секрет"));
    }

    #[test]
    fn migration_reads_uncheckpointed_wal() {
        let d = tempdir().unwrap();
        let p = d.path().join("a.db");
        let c = open_connection(&p, false, None).unwrap();
        c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t(a); INSERT INTO t VALUES(1),(2),(3);").unwrap();
        // соединение не закрыто: данные только в WAL
        let key = DbKey::random();
        migrate_plaintext(&p, &key).unwrap();
        drop(c);
        let c2 = open_connection(&p, false, Some(&key)).unwrap();
        assert_eq!(row_counts(&c2).unwrap()["t"], 3);
    }

    #[test]
    fn failed_migration_leaves_original_untouched() {
        let d = tempdir().unwrap();
        let p = d.path().join("a.db");
        plain_db(&p);
        let before = fs::read(&p).unwrap();
        // Ключ-пароль с нулевым байтом не принимается SQLCipher как параметр: миграция должна упасть, не тронув файл.
        let bad = DbKey::Passphrase(String::new());
        let r = migrate_plaintext(&p, &bad);
        if r.is_err() {
            assert_eq!(fs::read(&p).unwrap(), before);
            assert!(!with_suffix(&p, ".encrypting").exists());
        }
    }

    #[test]
    fn recovery_when_crashed_after_original_was_moved_aside() {
        let d = tempdir().unwrap();
        let p = d.path().join("a.db");
        plain_db(&p);
        let key = DbKey::random();
        fs::rename(&p, with_suffix(&p, ".unencrypted")).unwrap();
        let c = open_encrypted(&p, &key).unwrap();
        assert_eq!(row_counts(&c).unwrap()["t"], 2);
        assert!(!with_suffix(&p, ".unencrypted").exists());
    }

    #[test]
    fn recovery_when_crashed_after_swap_before_cleanup() {
        let d = tempdir().unwrap();
        let p = d.path().join("a.db");
        plain_db(&p);
        let key = DbKey::random();
        fs::copy(&p, with_suffix(&p, ".unencrypted")).unwrap();
        // Зашифрованная копия уже на месте основной базы.
        let staged = d.path().join("staged.db");
        {
            let src = open_connection(&p, false, None).unwrap();
            src.execute("ATTACH DATABASE ?1 AS e KEY ?2", rusqlite::params![staged.to_string_lossy(), key.attach_value()]).unwrap();
            src.query_row("SELECT sqlcipher_export('e')", [], |_| Ok(())).unwrap();
        }
        remove_database_files(&p);
        fs::rename(&staged, &p).unwrap();
        let c = open_encrypted(&p, &key).unwrap();
        assert_eq!(row_counts(&c).unwrap()["t"], 2);
        assert!(!with_suffix(&p, ".unencrypted").exists());
    }

    #[test]
    fn recovery_keeps_both_files_if_encrypted_one_does_not_open() {
        let d = tempdir().unwrap();
        let p = d.path().join("a.db");
        plain_db(&p);
        fs::copy(&p, with_suffix(&p, ".unencrypted")).unwrap();
        let other = DbKey::random();
        {
            let c = open_connection(&d.path().join("x.db"), false, Some(&other)).unwrap();
            c.execute_batch("CREATE TABLE t(a); INSERT INTO t VALUES(1)").unwrap();
        }
        fs::copy(d.path().join("x.db"), &p).unwrap();
        assert!(open_encrypted(&p, &DbKey::random()).is_err());
        assert!(with_suffix(&p, ".unencrypted").exists(), "исходные данные не потеряны");
    }

    #[test]
    fn recovery_when_plaintext_was_put_back_keeps_both() {
        let d = tempdir().unwrap();
        let p = d.path().join("a.db");
        plain_db(&p);
        fs::copy(&p, with_suffix(&p, ".unencrypted")).unwrap();
        let key = DbKey::random();
        recover_interrupted_migration(&p, &key).unwrap();
        let leftovers: Vec<_> = fs::read_dir(d.path()).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| n.contains("unencrypted-")).collect();
        assert_eq!(leftovers.len(), 1);
        assert_eq!(file_state(&p), FileState::Plaintext);
    }
}
