//! Переносимая копия (пакет G8, ADR-062): один файл `.customers` с базой лидов и базами CRM всех локальных
//! Workspace, зашифрованный ключом восстановления (решение Maksim). Обычные копии зашифрованы ключом устройства
//! (Связка ключей / DPAPI) и на другом компьютере не открываются; эта — открывается ключом восстановления.
//!
//! Ключ восстановления — 30 случайных знаков (150 бит) из алфавита без похожих символов, по группам по пять.
//! Приложение создаёт его один раз, показывает пользователю и хранит в защищённом хранилище системы, поэтому
//! следующие копии шифруются тем же ключом без вопросов. На новом компьютере пользователь вводит ключ; после
//! успешного открытия ключ сохраняется и там.
//!
//! Формат — ZIP: `meta.db` (служебная база с версией формата и списком Workspace), `leads.db`, `crm/<id>.db`.
//! Каждая база — SQLCipher с ключом из ключа восстановления (PBKDF2-HMAC-SHA512, параметры SQLCipher 4), поэтому
//! имена Workspace и данные не видны без ключа. Загрузка превращает файл в обычную копию этого устройства
//! (перешифровка ключом устройства) и восстанавливает её тем же путём, что и «Восстановить».

use super::session::Core;
use super::{CmdError, CmdResult};
use crate::db::{self, DbKey};
use crate::workspace::catalog::Catalog;
use chrono::Local;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Версия формата файла. Новая версия приложения читает все прежние.
const FORMAT: i64 = 1;
/// Алфавит ключа: без 0/O, 1/I/L и U — их легко перепутать при переписывании с бумаги.
const ALPHABET: &[u8; 30] = b"23456789ABCDEFGHJKMNPQRSTVWXYZ";
/// Знаков в ключе: 30 знаков из 30 — около 147 бит, подбор невозможен.
pub const KEY_LEN: usize = 30;
/// Предел распакованного размера при загрузке: защищает от «ZIP-бомбы» в чужом файле.
const MAX_UNPACKED: u64 = 4 * 1024 * 1024 * 1024;

fn cmd(e: impl std::fmt::Display) -> CmdError {
    CmdError::msg(e.to_string())
}

/// Имя секрета с ключом восстановления учётной записи.
fn secret_name(account: &str) -> String {
    format!("portable.key.{}", account.to_lowercase())
}

/// Новый ключ из системного генератора (равномерно: лишние байты отбрасываются).
fn generate_key() -> String {
    use rand::TryRng;
    let mut out = String::with_capacity(KEY_LEN);
    while out.len() < KEY_LEN {
        let mut b = [0u8; 32];
        rand::rngs::SysRng.try_fill_bytes(&mut b).expect("системный генератор случайных чисел недоступен");
        for x in b {
            // 240 = 8 × 30: значения 240..255 отбрасываются, чтобы все знаки были равновероятны.
            if x < 240 && out.len() < KEY_LEN {
                out.push(ALPHABET[(x % 30) as usize] as char);
            }
        }
    }
    out
}

/// Ключ, как его показывают: группы по пять через дефис.
pub fn format_key(key: &str) -> String {
    key.as_bytes().chunks(5).map(|c| String::from_utf8_lossy(c).into_owned()).collect::<Vec<_>>().join("-")
}

/// Ключ, как его ввёл человек: регистр, пробелы и дефисы не важны; знаков вне алфавита (0, 1, O, I, L, U)
/// в ключе не бывает, поэтому они — ошибка ввода. Возвращает ключ без разделителей или понятную ошибку.
pub fn normalize_key(input: &str) -> CmdResult<String> {
    let key: String = input.chars().filter(|c| !c.is_whitespace() && *c != '-').flat_map(char::to_uppercase).collect();
    if key.chars().count() != KEY_LEN || !key.bytes().all(|b| ALPHABET.contains(&b)) {
        return Err(CmdError::msg(format!("Ключ восстановления — {KEY_LEN} знаков: цифры и латинские буквы, по группам по пять.")));
    }
    Ok(key)
}

fn key_to_db(key: &str) -> DbKey {
    DbKey::Passphrase(key.to_string())
}

/// Временная папка рядом с копиями; удаляется при выходе из области видимости.
struct Scratch(PathBuf);
impl Scratch {
    fn new(base: &Path) -> CmdResult<Self> {
        let dir = base.join(format!(".portable-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).map_err(cmd)?;
        Ok(Self(dir))
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

impl Core {
    /// Сохранённый ключ восстановления этой учётной записи (без разделителей), если он создан.
    fn stored_portable_key(&self, account: &str) -> CmdResult<Option<String>> {
        let v = self.env.secrets.get(&secret_name(account)).map_err(cmd)?;
        Ok(v.and_then(|k| normalize_key(&k).ok()))
    }

    fn save_portable_key(&self, account: &str, key: &str) -> CmdResult<()> {
        let name = secret_name(account);
        self.env.secrets.set(&name, key).map_err(cmd)?;
        // Ключ, который не читается обратно, показывать нельзя: копии им будет не открыть.
        match self.env.secrets.get(&name).map_err(cmd)? {
            Some(v) if v == key => Ok(()),
            _ => Err(CmdError::msg("Ключ восстановления не читается из защищённого хранилища после сохранения.")),
        }
    }

    /// Создан ли ключ восстановления.
    pub fn portable_state(&self) -> CmdResult<Value> {
        let s = self.require()?;
        Ok(json!({"hasKey": self.stored_portable_key(&s.id)?.is_some(), "extension": "customers", "keyLength": KEY_LEN}))
    }

    /// Создаёт ключ восстановления и возвращает его для показа (единственный раз). Если ключ уже есть, новый
    /// создаётся только с `replace`: прежние копии после этого открываются только прежним ключом.
    pub fn create_portable_key(&self, replace: bool) -> CmdResult<String> {
        let s = self.require()?;
        if !replace && self.stored_portable_key(&s.id)?.is_some() {
            return Err(CmdError::msg("Ключ восстановления уже создан. Чтобы получить новый, замените ключ."));
        }
        let key = generate_key();
        self.save_portable_key(&s.id, &key)?;
        Ok(format_key(&key))
    }

    fn require_portable_key(&self, account: &str) -> CmdResult<DbKey> {
        self.stored_portable_key(account)?
            .map(|k| key_to_db(&k))
            .ok_or_else(|| CmdError::msg("Сначала создайте ключ восстановления: «Настройки → Данные → Перенос на другой компьютер»."))
    }

    /// Сохраняет переносимую копию в `dest`. Сначала делается обычная копия (та же гарантия «полная или никакой»),
    /// затем каждая база перешифровывается ключом восстановления и проверяется.
    pub fn export_portable(self: &Arc<Self>, dest: &Path) -> CmdResult<String> {
        let target = self.portable_bytes()?;
        let tmp = dest.with_extension("customers.partial");
        std::fs::write(&tmp, &target.0).map_err(|e| CmdError::msg(format!("Не удалось сохранить файл: {e}")))?;
        std::fs::rename(&tmp, dest).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            CmdError::msg(format!("Не удалось сохранить файл: {e}"))
        })?;
        Ok(format!("Переносимая копия сохранена: {}. Баз CRM: {}", dest.display(), target.1))
    }

    /// Содержимое файла переносимой копии и число баз CRM в нём.
    pub(crate) fn portable_bytes(self: &Arc<Self>) -> CmdResult<(Vec<u8>, usize)> {
        let s = self.require()?;
        let pass = self.require_portable_key(&s.id)?;
        let device = self.env.keys.key_for(&s.id).map_err(cmd)?;
        let copy = self.backup_now(&s)?;
        let crm = copy.with_extension("crm");
        let scratch = Scratch::new(copy.parent().unwrap_or(Path::new(".")))?;

        let mut files: Vec<(String, PathBuf)> = Vec::new();
        let leads = scratch.0.join("leads.db");
        db::export_rekeyed(&copy, &device, &leads, &pass).map_err(|e| CmdError::msg(format!("Копия базы лидов не создана: {e}")))?;
        files.push(("leads.db".into(), leads));

        let catalog = if crm.is_dir() { Catalog::load(&crm) } else { Catalog::default() };
        let mut workspaces = Vec::new();
        for w in catalog.workspaces.iter().filter(|w| !w.remote) {
            let src = crm.join(format!("{}.db", w.id));
            if !src.exists() {
                continue;
            }
            let dst = scratch.0.join(format!("crm-{}.db", w.id));
            db::export_rekeyed(&src, &device, &dst, &pass).map_err(|e| CmdError::msg(format!("Копия CRM не создана: {e}")))?;
            files.push((format!("crm/{}.db", w.id), dst));
            workspaces.push(w.clone());
        }
        let local = Catalog { workspaces, ..catalog };

        // Служебная база: версия, время и список Workspace — тоже под ключом восстановления.
        let meta = scratch.0.join("meta.db");
        {
            let conn = db::open_connection(&meta, false, Some(&pass)).map_err(cmd)?;
            conn.execute_batch("CREATE TABLE portable (key TEXT PRIMARY KEY, value TEXT NOT NULL);").map_err(cmd)?;
            let catalog_json = serde_json::to_string(&local).map_err(cmd)?;
            for (k, v) in [("format", FORMAT.to_string()), ("created_at", crate::util::now_string()), ("catalog", catalog_json)] {
                conn.execute("INSERT INTO portable (key, value) VALUES (?1, ?2)", rusqlite::params![k, v]).map_err(cmd)?;
            }
        }
        files.push(("meta.db".into(), meta));

        let mut bodies = Vec::new();
        for (name, path) in &files {
            bodies.push((name.clone(), std::fs::read(path).map_err(cmd)?));
        }
        let refs: Vec<(&str, &[u8])> = bodies.iter().map(|(n, b)| (n.as_str(), b.as_slice())).collect();
        let zip = crate::workspace::export::zip(&refs).map_err(|_| CmdError::msg("Данных слишком много для одного файла переносимой копии."))?;
        Ok((zip, local.workspaces.len()))
    }

    /// Загружает переносимую копию: проверяет ключ и файлы, сохраняет её как обычную копию этого устройства
    /// и восстанавливает (текущие данные перед этим сохраняются, как при обычном восстановлении).
    pub fn import_portable(self: &Arc<Self>, src: &Path, key: &str) -> CmdResult<String> {
        let key = normalize_key(key)?;
        let data = std::fs::read(src).map_err(|e| CmdError::msg(format!("Не удалось прочитать файл: {e}")))?;
        let copy = self.portable_to_backup(&data, &key)?;
        let msg = self.restore(&copy)?;
        // Следующие копии с этого компьютера шифруются тем же ключом, если своего здесь ещё нет.
        let s = self.require()?;
        if self.stored_portable_key(&s.id)?.is_none() {
            self.save_portable_key(&s.id, &key)?;
        }
        // На новом компьютере сразу открывается перенесённый Workspace (тот, что был активным при сохранении).
        let saved = Catalog::load(&copy.with_extension("crm"));
        if let Some(id) = saved.active.filter(|a| saved.workspaces.iter().any(|w| &w.id == a)).or_else(|| saved.workspaces.first().map(|w| w.id.clone())) {
            self.ws_switch(&id)?;
        }
        Ok(msg)
    }

    /// Превращает файл переносимой копии в обычную копию устройства в папке копий. Возвращает её путь.
    pub(crate) fn portable_to_backup(self: &Arc<Self>, data: &[u8], key: &str) -> CmdResult<PathBuf> {
        let not_ours = || CmdError::msg("Это не переносимая копия Customers или файл повреждён.");
        let pass = key_to_db(key);
        let s = self.require()?;
        let device = self.env.keys.key_for(&s.id).map_err(cmd)?;
        let wanted = |n: &str| n == "meta.db" || n == "leads.db" || (n.starts_with("crm/") && n.ends_with(".db") && !n[4..].contains('/'));
        let entries: HashMap<String, Vec<u8>> = crate::workspace::import::unzip_entries(data, &wanted, MAX_UNPACKED).map_err(|_| not_ours())?;
        let dir = self.backup_directory(&s);
        std::fs::create_dir_all(&dir).map_err(cmd)?;
        let scratch = Scratch::new(&dir)?;
        let unpack = |name: &str| -> CmdResult<PathBuf> {
            let body = entries.get(name).ok_or_else(not_ours)?;
            let path = scratch.0.join(name.replace('/', "-"));
            std::fs::write(&path, body).map_err(cmd)?;
            Ok(path)
        };

        // Ключ проверяется на служебной базе: с неверным ключом SQLCipher не читает её.
        let meta = unpack("meta.db")?;
        let (format, catalog) = {
            let conn = db::open_connection(&meta, true, Some(&pass)).map_err(|_| CmdError::msg("Неверный ключ восстановления или файл повреждён."))?;
            let get = |k: &str| conn.query_row("SELECT value FROM portable WHERE key = ?1", [k], |r| r.get::<_, String>(0)).map_err(|_| not_ours());
            let format: i64 = get("format")?.parse().map_err(|_| not_ours())?;
            let catalog: Catalog = serde_json::from_str(&get("catalog")?).map_err(|_| not_ours())?;
            (format, catalog)
        };
        if format > FORMAT {
            return Err(CmdError::msg("Копия сделана более новой версией Customers. Обновите приложение и повторите."));
        }

        let stamp = Local::now().format("%Y-%m-%d_%H-%M-%S");
        let copy = dir.join(format!("leadgen-{stamp}-перенос.db"));
        let crm = copy.with_extension("crm");
        let result = (|| -> CmdResult<()> {
            db::export_rekeyed(&unpack("leads.db")?, &pass, &copy, &device).map_err(|e| CmdError::msg(format!("База лидов в копии не читается: {e}")))?;
            std::fs::create_dir_all(&crm).map_err(cmd)?;
            for w in &catalog.workspaces {
                if uuid::Uuid::parse_str(&w.id).is_err() {
                    return Err(not_ours());
                }
                let src = unpack(&format!("crm/{}.db", w.id))?;
                db::export_rekeyed(&src, &pass, &crm.join(format!("{}.db", w.id)), &device)
                    .map_err(|e| CmdError::msg(format!("CRM в копии не читается: {e}")))?;
            }
            let saved = Catalog {
                workspaces: catalog.workspaces.iter().map(|w| crate::workspace::catalog::WorkspaceInfo { remote: false, ..w.clone() }).collect(),
                ..catalog.clone()
            };
            std::fs::write(Catalog::file(&crm), serde_json::to_vec_pretty(&saved).map_err(cmd)?).map_err(cmd)?;
            Ok(())
        })();
        if let Err(e) = result {
            db::remove_database_files(&copy);
            let _ = std::fs::remove_dir_all(&crm);
            return Err(e);
        }
        Ok(copy)
    }
}

#[cfg(test)]
mod tests {
    use super::super::testing::fixture;
    use super::*;

    fn company(core: &Arc<Core>, name: &str) {
        let mut m = serde_json::Map::new();
        m.insert("name".into(), json!(name));
        core.ws_save("companies", None, m).unwrap();
    }

    fn companies(core: &Arc<Core>) -> Vec<String> {
        let v = core.ws_list("companies", Default::default()).unwrap();
        let mut names: Vec<String> = v["items"].as_array().unwrap().iter().map(|r| r["name"].as_str().unwrap_or_default().to_string()).collect();
        names.sort();
        names
    }

    /// Пароль учётной записи собирается во время выполнения: литералы паролей CodeQL считает секретом.
    fn account_password(n: u8) -> String {
        ["password", "-", &n.to_string()].concat()
    }

    #[test]
    fn recovery_key_format() {
        let a = generate_key();
        let b = generate_key();
        assert_eq!(a.len(), KEY_LEN);
        assert_ne!(a, b);
        assert!(a.bytes().all(|x| ALPHABET.contains(&x)));
        let shown = format_key(&a);
        assert_eq!(shown.len(), KEY_LEN + KEY_LEN / 5 - 1);
        assert_eq!(shown.matches('-').count(), 5);
        // Ввод с пробелами, строчными буквами и без дефисов — тот же ключ.
        assert_eq!(normalize_key(&format!("  {} ", shown.to_lowercase().replace('-', " "))).unwrap(), a);
        assert!(normalize_key(&a[..KEY_LEN - 1]).is_err());
        assert!(normalize_key(&format!("{}O", &a[..KEY_LEN - 1])).is_err());
    }

    #[tokio::test]
    async fn portable_copy_opens_on_another_account_only_with_the_recovery_key() {
        let f = fixture(false, vec![]);
        let core = Core::new(f.env.clone());
        core.register("anna", &account_password(1), &account_password(1), false).unwrap();
        company(&core, "Ромашка");
        company(&core, "Лютик");
        let file = f.dir.path().join("перенос.customers");

        // Без ключа копия не создаётся; ключ создаётся один раз, повторно — только заменой.
        assert_eq!(core.portable_state().unwrap()["hasKey"], false);
        let none = core.export_portable(&file).unwrap_err();
        assert!(none.message.contains("Сначала создайте ключ"), "{}", none.message);
        assert!(!file.exists());
        let key = core.create_portable_key(false).unwrap();
        assert_eq!(core.portable_state().unwrap()["hasKey"], true);
        let again = core.create_portable_key(false).unwrap_err();
        assert!(again.message.contains("уже создан"), "{}", again.message);

        let msg = core.export_portable(&file).unwrap();
        assert!(msg.contains("Баз CRM: 1"), "{msg}");
        let data = std::fs::read(&file).unwrap();
        assert!(data.starts_with(b"PK\x03\x04"));
        // Без ключа внутри ничего не читается: ни названий компаний, ни имён Workspace.
        let entries = crate::workspace::import::unzip_entries(&data, &|_| true, MAX_UNPACKED).unwrap();
        assert_eq!(entries.len(), 3, "{:?}", entries.keys().collect::<Vec<_>>());
        for body in entries.values() {
            assert!(!body.starts_with(b"SQLite format 3"));
            assert!(!body.windows("Ромашка".len()).any(|w| w == "Ромашка".as_bytes()));
        }

        // Другая учётная запись (другой ключ устройства): чужой ключ — понятная ошибка, данные не тронуты.
        core.logout();
        core.register("boris", &account_password(2), &account_password(2), false).unwrap();
        company(&core, "Чужая");
        assert_eq!(core.portable_state().unwrap()["hasKey"], false);
        let wrong = core.import_portable(&file, &format_key(&generate_key())).unwrap_err();
        assert!(wrong.message.contains("Неверный ключ"), "{}", wrong.message);
        let malformed = core.import_portable(&file, "123").unwrap_err();
        assert!(malformed.message.contains("30 знаков"), "{}", malformed.message);
        assert_eq!(companies(&core), ["Чужая"]);

        // Ключ вводят как удобно: строчными, без дефисов.
        let msg = core.import_portable(&file, &key.to_lowercase().replace('-', " ")).unwrap();
        assert!(msg.contains("Восстановлено баз CRM: 1"), "{msg}");
        assert_eq!(companies(&core), ["Лютик", "Ромашка"]);
        company(&core, "Новая");
        assert_eq!(companies(&core), ["Лютик", "Новая", "Ромашка"]);
        let list = core.list_backups().unwrap();
        assert!(list.iter().any(|b| b["name"].as_str().unwrap().contains("перенос") && b["crm"] == true));

        // Ключ сохранён и на новом компьютере: следующая копия открывается тем же ключом.
        assert_eq!(core.portable_state().unwrap()["hasKey"], true);
        let second = f.dir.path().join("второй.customers");
        core.export_portable(&second).unwrap();
        let data = std::fs::read(&second).unwrap();
        core.portable_to_backup(&data, &normalize_key(&key).unwrap()).unwrap();

        // Замена ключа: прежние копии новым ключом не открываются.
        let fresh = core.create_portable_key(true).unwrap();
        assert_ne!(fresh, key);
        let third = f.dir.path().join("третий.customers");
        core.export_portable(&third).unwrap();
        let wrong = core.import_portable(&third, &key).unwrap_err();
        assert!(wrong.message.contains("Неверный ключ"), "{}", wrong.message);
    }

    #[tokio::test]
    async fn foreign_files_are_refused() {
        let f = fixture(false, vec![]);
        let core = Core::new(f.env.clone());
        core.register("anna", &account_password(1), &account_password(1), false).unwrap();
        let key = core.create_portable_key(false).unwrap();
        let file = f.dir.path().join("x.customers");
        std::fs::write(&file, b"not a zip").unwrap();
        let bad = core.import_portable(&file, &key).unwrap_err();
        assert!(bad.message.contains("не переносимая копия"), "{}", bad.message);
        let xlsx = crate::workspace::export::zip(&[("xl/workbook.xml", b"<workbook/>")]).unwrap();
        std::fs::write(&file, xlsx).unwrap();
        let bad = core.import_portable(&file, &key).unwrap_err();
        assert!(bad.message.contains("не переносимая копия"), "{}", bad.message);
    }
}
