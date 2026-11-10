//! Секреты (ключ шифрования базы, токены, запомненный вход) хранятся в защищённом хранилище ОС:
//! в Связке ключей macOS и в файлах, зашифрованных Windows DPAPI. Имена секретов совпадают с теми,
//! что использовали прежние версии приложения, поэтому после обновления всё продолжает работать.
//! Секреты никогда не попадают в базу, настройки и журналы.

use crate::db::DbKey;
use crate::error::{AppError, AppResult};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub trait SecretStore: Send + Sync {
    /// `Ok(None)` — секрета нет. Любая другая причина (хранилище заблокировано, доступ отклонён) — ошибка:
    /// тогда нельзя считать, что секрета нет, и создавать вместо него новый.
    fn get(&self, name: &str) -> AppResult<Option<String>>;
    fn set(&self, name: &str, value: &str) -> AppResult<()>;
    fn delete(&self, name: &str) -> AppResult<()>;
}

/// Секрет в виде строки или пустая строка — для необязательных значений.
pub fn get_or_empty(store: &dyn SecretStore, name: &str) -> String {
    store.get(name).ok().flatten().unwrap_or_default()
}

/// Записать значение; пустое значение удаляет секрет.
pub fn put(store: &dyn SecretStore, name: &str, value: &str) -> AppResult<()> {
    if value.is_empty() {
        store.delete(name)
    } else {
        store.set(name, value)
    }
}

#[derive(Default)]
pub struct MemorySecretStore(Mutex<HashMap<String, String>>);

impl SecretStore for MemorySecretStore {
    fn get(&self, name: &str) -> AppResult<Option<String>> {
        Ok(self.0.lock().unwrap().get(name).cloned())
    }
    fn set(&self, name: &str, value: &str) -> AppResult<()> {
        self.0.lock().unwrap().insert(name.into(), value.into());
        Ok(())
    }
    fn delete(&self, name: &str) -> AppResult<()> {
        self.0.lock().unwrap().remove(name);
        Ok(())
    }
}

fn file_name(name: &str) -> String {
    let digest = Sha256::digest(name.as_bytes());
    format!("{}.sec", &hex::encode(digest)[..32])
}

fn write_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let tmp = path.with_extension("sec.tmp");
    std::fs::write(&tmp, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Секреты в файлах рядом с данными. Для платформ без своего защищённого хранилища (разработка на
/// Linux); в релизных сборках для macOS и Windows не используется.
pub struct FileSecretStore {
    dir: PathBuf,
}

impl FileSecretStore {
    pub fn new(dir: &Path) -> AppResult<Self> {
        std::fs::create_dir_all(dir)?;
        Ok(Self { dir: dir.to_path_buf() })
    }
}

impl SecretStore for FileSecretStore {
    fn get(&self, name: &str) -> AppResult<Option<String>> {
        match std::fs::read(self.dir.join(file_name(name))) {
            Ok(b) => Ok(Some(String::from_utf8_lossy(&b).into_owned())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }
    fn set(&self, name: &str, value: &str) -> AppResult<()> {
        write_atomic(&self.dir.join(file_name(name)), value.as_bytes())
    }
    fn delete(&self, name: &str) -> AppResult<()> {
        let _ = std::fs::remove_file(self.dir.join(file_name(name)));
        Ok(())
    }
}

// ------------------------------------------------------------------ macOS: Связка ключей

#[cfg(target_os = "macos")]
pub struct KeychainSecretStore {
    /// Сервис записей: у Stable прежний «LeadGenerator», у Beta свой, поэтому Beta не видит ключей Stable.
    service: &'static str,
}

#[cfg(target_os = "macos")]
impl KeychainSecretStore {
    pub const SERVICE: &'static str = "LeadGenerator";
    const NOT_FOUND: i32 = -25300; // errSecItemNotFound

    pub fn new(service: &'static str) -> Self {
        Self { service }
    }
}

#[cfg(target_os = "macos")]
impl SecretStore for KeychainSecretStore {
    fn get(&self, name: &str) -> AppResult<Option<String>> {
        use security_framework::passwords::get_generic_password;
        match get_generic_password(self.service, name) {
            Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
            Err(e) if e.code() == Self::NOT_FOUND => Ok(None),
            Err(e) => Err(AppError::msg(format!("Нет доступа к Связке ключей: {e}"))),
        }
    }
    fn set(&self, name: &str, value: &str) -> AppResult<()> {
        use security_framework::passwords::set_generic_password;
        set_generic_password(self.service, name, value.as_bytes()).map_err(|e| AppError::msg(format!("Не удалось сохранить в Связку ключей: {e}")))
    }
    fn delete(&self, name: &str) -> AppResult<()> {
        use security_framework::passwords::delete_generic_password;
        match delete_generic_password(self.service, name) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == Self::NOT_FOUND => Ok(()),
            Err(e) => Err(AppError::msg(format!("Не удалось удалить из Связки ключей: {e}"))),
        }
    }
}

// ------------------------------------------------------------------ Windows: DPAPI

#[cfg(windows)]
pub mod dpapi {
    //! Секреты в файлах, зашифрованных DPAPI для текущего пользователя Windows: расшифровать их может
    //! только он на этом компьютере. Формат файлов (энтропия, имя файла) совпадает с прежней версией.
    use super::*;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};

    /// Энтропия Stable (прежние версии). У Beta своя: файлы секретов разных каналов не расшифровываются друг другом.
    pub const ENTROPY: &[u8] = b"Customers.Secrets.v1";

    fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 }
    }

    pub fn protect(data: &[u8]) -> AppResult<Vec<u8>> {
        protect_with(data, ENTROPY)
    }

    pub fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
        unprotect_with(data, ENTROPY)
    }

    pub fn protect_with(data: &[u8], entropy: &[u8]) -> AppResult<Vec<u8>> {
        // SAFETY: входные буферы живут до конца вызова; выходной буфер выделяет система, копируем и освобождаем его.
        unsafe {
            let input = blob(data);
            let entropy = blob(entropy);
            let mut out = CRYPT_INTEGER_BLOB::default();
            CryptProtectData(&input, None, Some(&entropy), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
                .map_err(|e| AppError::msg(format!("DPAPI: {e}")))?;
            let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
            let _ = LocalFree(Some(HLOCAL(out.pbData as *mut _)));
            Ok(v)
        }
    }

    pub fn unprotect_with(data: &[u8], entropy: &[u8]) -> Option<Vec<u8>> {
        // SAFETY: как в `protect_with`.
        unsafe {
            let input = blob(data);
            let entropy = blob(entropy);
            let mut out = CRYPT_INTEGER_BLOB::default();
            CryptUnprotectData(&input, None, Some(&entropy), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out).ok()?;
            let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
            let _ = LocalFree(Some(HLOCAL(out.pbData as *mut _)));
            Some(v)
        }
    }

    pub struct DpapiSecretStore {
        dir: PathBuf,
        entropy: &'static [u8],
    }

    impl DpapiSecretStore {
        pub fn new(dir: &Path) -> AppResult<Self> {
            Self::with_entropy(dir, ENTROPY)
        }
        pub fn with_entropy(dir: &Path, entropy: &'static [u8]) -> AppResult<Self> {
            std::fs::create_dir_all(dir)?;
            Ok(Self { dir: dir.to_path_buf(), entropy })
        }
    }

    impl SecretStore for DpapiSecretStore {
        fn get(&self, name: &str) -> AppResult<Option<String>> {
            match std::fs::read(self.dir.join(file_name(name))) {
                Ok(b) => Ok(unprotect_with(&b, self.entropy).map(|p| String::from_utf8_lossy(&p).into_owned())),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(e.into()),
            }
        }
        fn set(&self, name: &str, value: &str) -> AppResult<()> {
            write_atomic(&self.dir.join(file_name(name)), &protect_with(value.as_bytes(), self.entropy)?)
        }
        fn delete(&self, name: &str) -> AppResult<()> {
            let _ = std::fs::remove_file(self.dir.join(file_name(name)));
            Ok(())
        }
    }
}

/// Хранилище секретов этой платформы. `root` — папка данных приложения.
pub fn platform_store(root: &Path) -> AppResult<Arc<dyn SecretStore>> {
    channel_store(crate::channel::Channel::Stable, root)
}

/// Хранилище секретов канала. Stable — прежнее (Связка ключей «LeadGenerator», DPAPI с прежней энтропией);
/// Beta — своё: свой сервис Связки ключей, своя энтропия DPAPI, файлы в своей папке данных.
pub fn channel_store(channel: crate::channel::Channel, root: &Path) -> AppResult<Arc<dyn SecretStore>> {
    let id = channel.identity();
    #[cfg(target_os = "macos")]
    {
        let _ = root;
        Ok(Arc::new(KeychainSecretStore::new(id.keychain_service)))
    }
    #[cfg(windows)]
    {
        Ok(Arc::new(dpapi::DpapiSecretStore::with_entropy(&root.join("secrets"), id.dpapi_entropy)?))
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = id;
        Ok(Arc::new(FileSecretStore::new(&root.join("secrets"))?))
    }
}

// ------------------------------------------------------------------ ключ шифрования базы

/// Ключи шифрования локальных баз. На macOS один ключ на все базы пользователя ОС (`database.key`),
/// на Windows — свой ключ для каждой учётной записи (`db.key.<имя>`). Формат ключа определяется по
/// значению (см. `DbKey::from_secret`), поэтому ключи прежних версий открываются без преобразования.
pub struct DatabaseKeys {
    store: Arc<dyn SecretStore>,
}

impl DatabaseKeys {
    pub fn new(store: Arc<dyn SecretStore>) -> Self {
        Self { store }
    }

    pub fn secret_name(account: &str) -> String {
        if cfg!(target_os = "macos") {
            "database.key".to_string()
        } else {
            format!("db.key.{}", account.to_lowercase())
        }
    }

    pub fn exists(&self, account: &str) -> bool {
        matches!(self.store.get(&Self::secret_name(account)), Ok(Some(v)) if !v.is_empty())
    }

    /// Ключ базы. Если ключа нет — создаётся новый; если хранилище недоступно — ошибка (новый ключ
    /// создавать нельзя, иначе существующую базу нечем будет открыть).
    pub fn key_for(&self, account: &str) -> AppResult<DbKey> {
        let name = Self::secret_name(account);
        if let Some(key) = self.store.get(&name)?.and_then(|v| DbKey::from_secret(&v)) {
            return Ok(key);
        }
        let key = DbKey::random();
        self.store.set(&name, &key.secret())?;
        // Базу шифруем только ключом, который действительно читается обратно.
        match self.store.get(&name)? {
            Some(v) if v == key.secret() => Ok(key),
            _ => Err(AppError::msg("Ключ базы не читается из защищённого хранилища после сохранения")),
        }
    }

    /// Забыть ключ учётной записи (после удаления её данных). На macOS ключ общий и не удаляется.
    pub fn forget(&self, account: &str) {
        if !cfg!(target_os = "macos") {
            let _ = self.store.delete(&Self::secret_name(account));
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn stable_secrets_keep_previous_names_and_beta_gets_its_own() {
        use crate::channel::Channel;
        #[cfg(target_os = "macos")]
        assert_eq!(Channel::Stable.identity().keychain_service, KeychainSecretStore::SERVICE);
        #[cfg(windows)]
        assert_eq!(Channel::Stable.identity().dpapi_entropy, dpapi::ENTROPY);
        assert_ne!(Channel::Beta.identity().keychain_service, Channel::Stable.identity().keychain_service);
        // Файловое хранилище (Linux) и DPAPI (Windows) лежат в папке данных канала: у Beta она своя.
        let dir = tempfile::tempdir().unwrap();
        let stable = channel_store(Channel::Stable, &dir.path().join("s")).unwrap();
        let beta = channel_store(Channel::Beta, &dir.path().join("b")).unwrap();
        if cfg!(not(target_os = "macos")) {
            stable.set("isolation-probe", "stable").unwrap();
            assert_eq!(beta.get("isolation-probe").unwrap(), None, "Beta не видит секреты Stable");
            stable.delete("isolation-probe").unwrap();
        }
    }

    use super::*;

    #[test]
    fn memory_store_roundtrip_and_put_empty_deletes() {
        let s = MemorySecretStore::default();
        put(&s, "a", "1").unwrap();
        assert_eq!(s.get("a").unwrap().as_deref(), Some("1"));
        put(&s, "a", "").unwrap();
        assert_eq!(s.get("a").unwrap(), None);
        assert_eq!(get_or_empty(&s, "a"), "");
    }

    #[test]
    fn file_store_hides_names_and_restricts_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let s = FileSecretStore::new(dir.path()).unwrap();
        s.set("vk.token.anna", "secret-value").unwrap();
        assert_eq!(s.get("vk.token.anna").unwrap().as_deref(), Some("secret-value"));
        let names: Vec<String> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names.len(), 1);
        assert!(names[0].ends_with(".sec") && names[0].len() == 36 && !names[0].contains("anna"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(dir.path().join(&names[0])).unwrap().permissions().mode() & 0o777, 0o600);
        }
        s.delete("vk.token.anna").unwrap();
        assert_eq!(s.get("vk.token.anna").unwrap(), None);
    }

    #[test]
    fn file_names_match_windows_scheme() {
        // SHA-256("db.key.anna") без изменений относительно прежней версии: первые 32 hex-символа.
        assert_eq!(file_name("abc"), "ba7816bf8f01cfea414140de5dae2223.sec");
    }

    #[test]
    fn database_key_is_created_once_and_reused() {
        let store: Arc<dyn SecretStore> = Arc::new(MemorySecretStore::default());
        let keys = DatabaseKeys::new(store.clone());
        assert!(!keys.exists("Anna"));
        let a = keys.key_for("Anna").unwrap();
        assert!(keys.exists("anna"));
        assert_eq!(keys.key_for("ANNA").unwrap().secret(), a.secret());
        assert_eq!(a.secret().len(), 64);
        keys.forget("anna");
    }

    #[test]
    fn legacy_windows_passphrase_is_kept_as_is() {
        let store: Arc<dyn SecretStore> = Arc::new(MemorySecretStore::default());
        store.set(&DatabaseKeys::secret_name("anna"), "dGhpcy1pcy1hLWJhc2U2NC1wYXNzcGhyYXNlLTMyLWJ5dGVz").unwrap();
        let key = DatabaseKeys::new(store).key_for("anna").unwrap();
        assert!(matches!(key, DbKey::Passphrase(_)));
    }

    struct Locked;
    impl SecretStore for Locked {
        fn get(&self, _: &str) -> AppResult<Option<String>> {
            Err(AppError::msg("заблокировано"))
        }
        fn set(&self, _: &str, _: &str) -> AppResult<()> {
            Ok(())
        }
        fn delete(&self, _: &str) -> AppResult<()> {
            Ok(())
        }
    }

    #[test]
    fn locked_store_never_creates_a_replacement_key() {
        assert!(DatabaseKeys::new(Arc::new(Locked)).key_for("anna").is_err());
    }
}
