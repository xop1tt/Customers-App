//! Scenario Runner: сценарии пользователя на настоящем ядре (`Core`), каждый — в отдельной временной папке
//! со своей учётной записью, секретами в памяти и без сети. Рабочие данные Beta сценарии не трогают; папка
//! сценария удаляется после прогона.
//!
//! Сценарий проверяет состояние данных (строки в базе, снимок, файлы), а не только отсутствие ошибки.
//! Те же сценарии запускаются без окна: `npm run debug:scenario` (`cargo test --features beta --test scenarios`).

use crate::accounts::LocalAccounts;
use crate::app::session::Core;
use crate::app::{Env, Events, Opener};
use crate::channel::{Channel, ChannelDirs, Isolation};
use crate::models::{LeadData, LeadKind, Relevance};
use crate::paths::AppPaths;
use crate::prefs::PrefsFile;
use crate::reports::ErrorLog;
use crate::search::http::{HttpRequest, HttpResponse, HttpTransport, SearchError};
use crate::secrets::{DatabaseKeys, MemorySecretStore, SecretStore};
use crate::util::AppVersion;
use serde::Serialize;
use serde_json::{json, Value};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Status {
    Pass,
    Fail,
    Skipped,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub id: &'static str,
    pub title: &'static str,
    pub status: Status,
    pub duration_ms: u128,
    pub error: Option<String>,
    pub details: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub run_id: String,
    pub started_at: String,
    pub duration_ms: u128,
    pub passed: usize,
    pub failed: usize,
    pub skipped: usize,
    pub results: Vec<Outcome>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub id: &'static str,
    pub group: &'static str,
    pub title: &'static str,
    pub description: &'static str,
}

type Run = fn(&mut Ctx) -> Result<(), String>;

pub struct Scenario {
    pub id: &'static str,
    pub group: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    run: Run,
}

impl Scenario {
    pub fn info(&self) -> Info {
        Info { id: self.id, group: self.group, title: self.title, description: self.description }
    }
}

// ---------------------------------------------------------------- окружение сценария

/// Сеть в сценариях выключена: любой запрос — понятная ошибка, а не обращение в интернет.
struct Offline;

#[async_trait::async_trait]
impl HttpTransport for Offline {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, SearchError> {
        Err(SearchError::Other(format!("сценарии работают без сети: {}", request.url)))
    }
}

#[derive(Default)]
pub struct Recorder(Mutex<Vec<String>>);

impl Recorder {
    pub fn count(&self, name: &str) -> usize {
        self.0.lock().unwrap().iter().filter(|n| *n == name).count()
    }
}

impl Events for Recorder {
    fn emit(&self, name: &str, _payload: Value) {
        self.0.lock().unwrap().push(name.to_string());
    }
}

struct NoOpener;

impl Opener for NoOpener {
    fn open_url(&self, _url: &str) -> Result<(), String> {
        Ok(())
    }
    fn reveal(&self, _path: &Path) -> Result<(), String> {
        Ok(())
    }
}

/// Где и от чьего имени запускаются сценарии.
#[derive(Clone)]
pub struct Host {
    /// Папка для временных папок сценариев (в Beta — `<данные Beta>/scenarios`).
    pub root: PathBuf,
    pub channel: Channel,
    pub version: AppVersion,
    pub identifier: String,
    /// Папки другого канала: сценарий проверяет, что туда ничего не попадает.
    pub other: ChannelDirs,
}

impl Host {
    pub fn for_env(env: &Env, identifier: &str) -> Self {
        Self {
            root: env.paths.root.join("scenarios"),
            channel: env.channel,
            version: env.version.clone(),
            identifier: identifier.to_string(),
            other: env.isolation.other_dirs().clone(),
        }
    }
}

pub struct Ctx {
    pub dir: PathBuf,
    host: Host,
    secrets: Arc<MemorySecretStore>,
    pub events: Arc<Recorder>,
    pub core: Arc<Core>,
    pub details: Vec<String>,
}

impl Ctx {
    fn new(host: &Host, dir: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&dir).map_err(|e| format!("папка сценария: {e}"))?;
        let secrets = Arc::new(MemorySecretStore::default());
        let events = Arc::new(Recorder::default());
        let core = Core::new(Self::env(host, &dir, secrets.clone(), events.clone())?);
        Ok(Self { dir, host: host.clone(), secrets, events, core, details: vec![] })
    }

    fn env(host: &Host, dir: &Path, secrets: Arc<MemorySecretStore>, events: Arc<Recorder>) -> Result<Arc<Env>, String> {
        let paths = AppPaths::under(dir);
        let isolation = Isolation::new(ChannelDirs::of(host.channel, &paths), host.other.clone());
        std::fs::create_dir_all(&paths.root).map_err(|e| e.to_string())?;
        let secrets: Arc<dyn SecretStore> = secrets;
        Ok(Arc::new(Env {
            device: Mutex::new(PrefsFile::load(&paths.device_prefs())),
            // Временная учётная запись: меньше итераций PBKDF2, чтобы прогон занимал секунды.
            accounts: LocalAccounts::open_with(&paths.root, 1000).map_err(|e| e.to_string())?,
            keys: DatabaseKeys::new(secrets.clone()),
            errors: ErrorLog::new(&paths.logs),
            paths,
            secrets,
            transport: Arc::new(Offline),
            events,
            opener: Arc::new(NoOpener),
            cloud: None,
            version: host.version.clone(),
            device_id: "SCENARIO".into(),
            bundle_id: host.identifier.clone(),
            app_bundle: None,
            can_update: false,
            sleeper: crate::search::http::no_sleep(),
            channel: host.channel,
            isolation,
        }))
    }

    /// Перезапуск приложения: сессия закрывается без выхода, новое ядро на тех же папках и секретах.
    pub fn restart(&mut self) -> Result<(), String> {
        if let Some(s) = self.core.session() {
            s.shutdown();
        }
        self.core = Core::new(Self::env(&self.host, &self.dir, self.secrets.clone(), self.events.clone())?);
        self.core.startup();
        Ok(())
    }

    pub fn note(&mut self, text: impl Into<String>) {
        self.details.push(text.into());
    }

    pub fn other_channel(&self) -> &ChannelDirs {
        &self.host.other
    }

    fn finish(self) {
        self.core.logout();
        drop(self.core);
        remove_dir(&self.dir);
    }
}

// ---------------------------------------------------------------- помощники

/// Удалить папку сценария. В Windows файлы базы освобождаются не мгновенно (фоновые задачи сессии
/// завершаются асинхронно), поэтому — несколько попыток в течение пары секунд.
fn remove_dir(dir: &Path) {
    for _ in 0..20 {
        if !dir.exists() || std::fs::remove_dir_all(dir).is_ok() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

macro_rules! ensure {
    ($cond:expr, $($msg:tt)+) => {
        if !$cond {
            return Err(format!($($msg)+));
        }
    };
}

fn e<T: std::fmt::Display>(err: T) -> String {
    err.to_string()
}

fn password() -> String {
    ["Scenario", "-pass-", "1"].concat()
}

fn register(ctx: &Ctx, name: &str, remember: bool) -> Result<(), String> {
    ctx.core.register(name, &password(), &password(), remember).map(|_| ()).map_err(|e| e.message)
}

fn sample(i: usize) -> LeadData {
    let mut d = LeadData::new(LeadKind::Order, "fl_ru", &format!("scn-{i}"), &format!("Сценарий: заявка {i}"));
    d.description = format!("Описание заявки {i}");
    d.url = format!("https://example.com/order/{i}");
    d.contacts.insert("email".into(), format!("client{i}@example.org"));
    d.score = 50.0 + i as f64;
    d.relevance = Relevance::Medium;
    d
}

/// Сохранить лиды так, как их сохраняет поиск. Возвращает идентификаторы.
fn save_leads(ctx: &Ctx, n: usize) -> Result<Vec<String>, String> {
    let s = ctx.core.require().map_err(|e| e.message)?;
    (0..n)
        .map(|i| {
            let d = sample(i);
            let id = crate::search::text::lead_id(&d.source, &d.external_id);
            s.with_store(|st| st.save(&d, &id, &crate::search::text::fingerprint(&d))).map_err(e)?;
            Ok(id)
        })
        .collect()
}

fn leads(ctx: &Ctx) -> Result<Vec<Value>, String> {
    Ok(ctx.core.snapshot().map_err(|e| e.message)?.leads)
}

fn lead_by_id(ctx: &Ctx, id: &str) -> Result<Value, String> {
    leads(ctx)?.into_iter().find(|l| l["id"] == id).ok_or_else(|| format!("лид {id} не найден в снимке"))
}

// ---------------------------------------------------------------- сценарии

fn first_run(ctx: &mut Ctx) -> Result<(), String> {
    ensure!(!ctx.core.boot_info().has_users, "у нового приложения уже есть пользователи");
    ensure!(ctx.core.boot_info().channel == ctx.host.channel.name(), "канал в boot_info не совпадает");
    register(ctx, "first", false)?;
    let s = ctx.core.require().map_err(|e| e.message)?;
    let path = s.with_store(|st| st.path().to_path_buf());
    ensure!(path.exists(), "файл базы не создан: {}", path.display());
    ensure!(crate::db::file_state(&path) == crate::db::FileState::Encrypted, "база не зашифрована");
    ensure!(s.with_store(|st| st.value("schema_version")).is_some(), "нет версии схемы");
    ensure!(leads(ctx)?.is_empty(), "новая база не пуста");
    ensure!(ctx.core.boot_info().has_users, "пользователь не появился в списке");
    ctx.note(format!("база: {}", path.file_name().unwrap_or_default().to_string_lossy()));
    Ok(())
}

fn login_logout(ctx: &mut Ctx) -> Result<(), String> {
    register(ctx, "anna", false)?;
    save_leads(ctx, 2)?;
    ctx.core.logout();
    ensure!(ctx.core.session().is_none(), "после выхода сессия осталась");
    ensure!(ctx.core.snapshot().is_err(), "данные доступны без входа");
    ensure!(ctx.core.login("anna", "wrong-password", false).is_err(), "вход с неверным паролем удался");
    ensure!(ctx.core.session().is_none(), "неверный пароль открыл сессию");
    ctx.core.login("anna", &password(), false).map_err(|e| e.message)?;
    ensure!(leads(ctx)?.len() == 2, "после повторного входа лидов не 2");
    ensure!(ctx.events.count("session-changed") >= 2, "интерфейс не получил событие о смене сессии");
    Ok(())
}

fn session_restore(ctx: &mut Ctx) -> Result<(), String> {
    register(ctx, "remembered", true)?;
    save_leads(ctx, 1)?;
    ctx.restart()?;
    let info = ctx.core.info().ok_or("после перезапуска сессия не восстановлена")?;
    ensure!(info.display_name == "remembered", "восстановлена чужая сессия: {}", info.display_name);
    ensure!(leads(ctx)?.len() == 1, "после восстановления сессии нет данных");
    // Без «запомнить» сессия после перезапуска не восстанавливается.
    ctx.core.set_remembered(false);
    ctx.restart()?;
    ensure!(ctx.core.session().is_none(), "сессия восстановилась без «запомнить меня»");
    Ok(())
}

fn lead_lifecycle(ctx: &mut Ctx) -> Result<(), String> {
    register(ctx, "leads", false)?;
    let ids = save_leads(ctx, 3)?;
    ensure!(leads(ctx)?.len() == 3, "сохранено не 3 лида");
    // Повторное сохранение того же лида из поиска не создаёт дубль.
    save_leads(ctx, 1)?;
    ensure!(leads(ctx)?.len() == 3, "повторное сохранение создало дубль");
    ctx.core.set_note(&ids[0], "Позвонить в понедельник").map_err(|e| e.message)?;
    ensure!(lead_by_id(ctx, &ids[0])?["note"] == "Позвонить в понедельник", "заметка не сохранилась");
    ctx.core.delete_leads(&[ids[1].clone()]).map_err(|e| e.message)?;
    let left = leads(ctx)?;
    ensure!(left.len() == 2 && left.iter().all(|l| l["id"] != ids[1].as_str()), "удалённый лид остался в списке");
    let events = ctx.core.events(&ids[1]).map_err(|e| e.message)?;
    ensure!(events.to_string().contains("Удалён"), "в истории лида нет удаления: {events}");
    Ok(())
}

fn statuses(ctx: &mut Ctx) -> Result<(), String> {
    register(ctx, "status", false)?;
    let ids = save_leads(ctx, 3)?;
    let one = std::slice::from_ref(&ids[0]);
    ctx.core.set_favorite(one, true).map_err(|e| e.message)?;
    ctx.core.set_archived(&[ids[1].clone()], true).map_err(|e| e.message)?;
    ctx.core.mark_seen(one).map_err(|e| e.message)?;
    let (a, b, c) = (lead_by_id(ctx, &ids[0])?, lead_by_id(ctx, &ids[1])?, lead_by_id(ctx, &ids[2])?);
    ensure!(a["favorite"] == true && a["seen"] == true, "избранное/просмотрено не сохранились: {a}");
    ensure!(b["archived"] == true && b["favorite"] == false, "архив не сохранился: {b}");
    ensure!(c["seen"] == false, "отметка просмотра попала на другой лид");
    ctx.core.mark_all_seen().map_err(|e| e.message)?;
    ensure!(leads(ctx)?.iter().all(|l| l["seen"] == true), "«отметить все» оставил непросмотренные");
    ctx.core.set_favorite(one, false).map_err(|e| e.message)?;
    ensure!(lead_by_id(ctx, &ids[0])?["favorite"] == false, "избранное не снялось");
    Ok(())
}

fn exclusions(ctx: &mut Ctx) -> Result<(), String> {
    register(ctx, "excl", false)?;
    let ids = save_leads(ctx, 3)?;
    ctx.core.exclude("client0@example.org", Some("email")).map_err(|e| e.message)?;
    ensure!(lead_by_id(ctx, &ids[0])?["excluded"] == true, "исключение по почте не применилось");
    ensure!(lead_by_id(ctx, &ids[1])?["excluded"] == false, "исключение задело другой лид");
    let csv = ctx.dir.join("exclusions.csv");
    std::fs::write(&csv, "value\nclient1@example.org\n").map_err(e)?;
    let msg = ctx.core.import_exclusions(&csv).map_err(|e| e.message)?;
    ensure!(lead_by_id(ctx, &ids[1])?["excluded"] == true, "импорт исключений не применился ({msg})");
    let list = ctx.core.snapshot().map_err(|e| e.message)?.exclusions;
    let n = list.as_array().map(Vec::len).unwrap_or(0);
    ensure!(n == 2, "исключений {n}, ожидалось 2");
    let first_id = list[0]["id"].as_i64().ok_or("нет id исключения")?;
    ctx.core.remove_exclusion(first_id).map_err(|e| e.message)?;
    ensure!(ctx.core.snapshot().map_err(|e| e.message)?.exclusions.as_array().map(Vec::len) == Some(1), "исключение не удалилось");
    Ok(())
}

fn export_files(ctx: &mut Ctx) -> Result<(), String> {
    register(ctx, "export", false)?;
    let ids = save_leads(ctx, 3)?;
    let json_path = ctx.dir.join("data/export.json");
    ctx.core.export_to_file(&ids[..2], "json", &["title".into(), "url".into()], &json_path).map_err(|e| e.message)?;
    let parsed: Value = serde_json::from_slice(&std::fs::read(&json_path).map_err(e)?).map_err(e)?;
    let rows = parsed.as_array().or_else(|| parsed["leads"].as_array()).ok_or("в JSON нет списка лидов")?;
    ensure!(rows.len() == 2, "в JSON {} строк вместо 2", rows.len());
    ensure!(parsed.to_string().contains("Сценарий: заявка 0"), "в JSON нет названия лида");
    let csv_path = ctx.dir.join("data/export.csv");
    ctx.core.export_to_file(&ids, "csv", &["title".into()], &csv_path).map_err(|e| e.message)?;
    let csv = String::from_utf8_lossy(&std::fs::read(&csv_path).map_err(e)?).into_owned();
    let lines = csv.lines().filter(|l| !l.trim().is_empty()).count();
    ensure!(lines == 4, "в CSV {lines} строк вместо 4 (заголовок + 3)");
    ensure!(ctx.core.export_to_file(&ids, "csv", &[], &csv_path).is_err(), "экспорт без полей не отклонён");
    ctx.note(format!("JSON {} байт, CSV {} байт", std::fs::metadata(&json_path).map_err(e)?.len(), csv.len()));
    Ok(())
}

fn backup_restore(ctx: &mut Ctx) -> Result<(), String> {
    register(ctx, "backup", false)?;
    let ids = save_leads(ctx, 3)?;
    let s = ctx.core.require().map_err(|e| e.message)?;
    let copy = ctx.core.backup_now(&s).map_err(|e| e.message)?;
    ensure!(copy.exists(), "копия не создана");
    ensure!(crate::db::file_state(&copy) == crate::db::FileState::Encrypted, "копия не зашифрована");
    ctx.core.delete_leads(&ids).map_err(|e| e.message)?;
    ensure!(leads(ctx)?.is_empty(), "лиды не удалились");
    ctx.core.restore(&copy).map_err(|e| e.message)?;
    ensure!(leads(ctx)?.len() == 3, "после восстановления лидов {} вместо 3", leads(ctx)?.len());
    ensure!(!ctx.core.list_backups().map_err(|e| e.message)?.is_empty(), "копия не видна в списке");
    Ok(())
}

fn settings_persist(ctx: &mut Ctx) -> Result<(), String> {
    register(ctx, "prefs", true)?;
    ctx.core.patch_account_prefs(&json!({"signature": "С уважением, сценарий", "keepBackups": 7, "notifySync": false})).map_err(|e| e.message)?;
    ctx.core.env.patch_device(&json!({"uiScale": 1.25, "navOpen": false}));
    ctx.restart()?;
    let prefs = ctx.core.account_prefs().map_err(|e| e.message)?;
    ensure!(
        prefs["signature"] == "С уважением, сценарий" && prefs["keepBackups"] == 7 && prefs["notifySync"] == false,
        "настройки учётной записи не сохранились: {prefs}"
    );
    let device = ctx.core.env.device_prefs();
    ensure!((device.ui_scale - 1.25).abs() < 1e-9 && !device.nav_open, "настройки устройства не сохранились");
    Ok(())
}

fn data_persist(ctx: &mut Ctx) -> Result<(), String> {
    register(ctx, "persist", false)?;
    let ids = save_leads(ctx, 5)?;
    ctx.core.set_favorite(&ids[..2], true).map_err(|e| e.message)?;
    ctx.restart()?;
    ensure!(ctx.core.session().is_none(), "без «запомнить» вход не должен восстанавливаться");
    ctx.core.login("persist", &password(), false).map_err(|e| e.message)?;
    let all = leads(ctx)?;
    ensure!(all.len() == 5, "после перезапуска лидов {} вместо 5", all.len());
    ensure!(all.iter().filter(|l| l["favorite"] == true).count() == 2, "избранное не пережило перезапуск");
    Ok(())
}

fn password_change(ctx: &mut Ctx) -> Result<(), String> {
    register(ctx, "pwchange", false)?;
    save_leads(ctx, 2)?;
    let next = ["Next", "-pass-", "2"].concat();
    ensure!(ctx.core.change_password("wrong", &next, &next).is_err(), "смена с неверным старым паролем удалась");
    ctx.core.change_password(&password(), &next, &next).map_err(|e| e.message)?;
    ctx.core.logout();
    ensure!(ctx.core.login("pwchange", &password(), false).is_err(), "старый пароль всё ещё подходит");
    ctx.core.login("pwchange", &next, false).map_err(|e| e.message)?;
    ensure!(leads(ctx)?.len() == 2, "после смены пароля данные недоступны");
    Ok(())
}

fn notifications(ctx: &mut Ctx) -> Result<(), String> {
    register(ctx, "events", false)?;
    let ids = save_leads(ctx, 1)?;
    let before = ctx.events.count("data-changed");
    ctx.core.set_favorite(&ids, true).map_err(|e| e.message)?;
    ctx.core.set_note(&ids[0], "x").map_err(|e| e.message)?;
    let after = ctx.events.count("data-changed");
    ensure!(after >= before + 2, "интерфейс не получил события об изменении данных ({before} → {after})");
    ctx.core.patch_account_prefs(&json!({"notifyErrors": false})).map_err(|e| e.message)?;
    ensure!(ctx.events.count("account-prefs") >= 1, "нет события об изменении настроек");
    Ok(())
}

fn isolation(ctx: &mut Ctx) -> Result<(), String> {
    register(ctx, "iso", false)?;
    let ids = save_leads(ctx, 1)?;
    let other = ctx.other_channel().clone();
    let target = other.root.join("customers-scenario-export.json");
    ensure!(ctx.core.export_to_file(&ids, "json", &["title".into()], &target).is_err(), "экспорт в папку другого канала не отклонён");
    ensure!(!target.exists(), "в папке другого канала появился файл");
    ensure!(ctx.core.restore(&other.root.join("leads.db")).is_err(), "восстановление из папки другого канала не отклонено");
    ensure!(ctx.core.move_database(&other.root).is_err(), "перенос базы в папку другого канала не отклонён");
    ctx.note(format!("другой канал: {}", other.root.display()));
    Ok(())
}

static SCENARIOS: &[Scenario] = &[
    Scenario {
        id: "app.first_run",
        group: "Запуск",
        title: "Первый запуск и создание базы",
        description: "Новое приложение без пользователей; регистрация создаёт зашифрованную базу со схемой.",
        run: first_run,
    },
    Scenario {
        id: "session.login_logout",
        group: "Вход",
        title: "Вход и выход",
        description: "Выход закрывает данные, неверный пароль не входит, повторный вход видит прежние данные.",
        run: login_logout,
    },
    Scenario {
        id: "session.restore",
        group: "Вход",
        title: "Восстановление сессии",
        description: "С «запомнить меня» вход восстанавливается после перезапуска, без него — нет.",
        run: session_restore,
    },
    Scenario {
        id: "password.change",
        group: "Вход",
        title: "Смена пароля",
        description: "Старый пароль перестаёт подходить, новый открывает те же данные.",
        run: password_change,
    },
    Scenario {
        id: "leads.lifecycle",
        group: "Лиды",
        title: "Создание, правка и удаление лида",
        description: "Лиды сохраняются без дублей, заметка сохраняется, удалённый лид пропадает и попадает в историю.",
        run: lead_lifecycle,
    },
    Scenario {
        id: "leads.statuses",
        group: "Лиды",
        title: "Избранное, архив, просмотр",
        description: "Отметки ставятся и снимаются у нужного лида и не задевают другие.",
        run: statuses,
    },
    Scenario {
        id: "leads.exclusions",
        group: "Лиды",
        title: "Исключения",
        description: "Исключение по почте и импорт из CSV помечают нужные лиды; исключение удаляется.",
        run: exclusions,
    },
    Scenario {
        id: "data.export",
        group: "Данные",
        title: "Экспорт JSON и CSV",
        description: "Файлы содержат выбранные лиды и поля; экспорт без полей отклоняется.",
        run: export_files,
    },
    Scenario {
        id: "data.backup_restore",
        group: "Данные",
        title: "Резервная копия и восстановление",
        description: "Копия зашифрована; после удаления лидов восстановление возвращает их.",
        run: backup_restore,
    },
    Scenario {
        id: "data.persist",
        group: "Данные",
        title: "Сохранность данных после перезапуска",
        description: "Лиды и отметки на месте после перезапуска и входа.",
        run: data_persist,
    },
    Scenario {
        id: "settings.persist",
        group: "Настройки",
        title: "Настройки после перезапуска",
        description: "Настройки учётной записи и устройства сохраняются между запусками.",
        run: settings_persist,
    },
    Scenario {
        id: "events.notifications",
        group: "Уведомления",
        title: "События для интерфейса",
        description: "Изменения данных и настроек отправляют интерфейсу события.",
        run: notifications,
    },
    Scenario {
        id: "isolation.other_channel",
        group: "Безопасность",
        title: "Изоляция от другого канала",
        description: "Экспорт, восстановление и перенос базы в папки другого канала отклоняются, файлы не появляются.",
        run: isolation,
    },
];

pub fn all() -> Vec<Info> {
    SCENARIOS.iter().map(Scenario::info).collect()
}

fn run_one(host: &Host, run_dir: &Path, s: &Scenario) -> Outcome {
    let started = Instant::now();
    let dir = run_dir.join(s.id.replace('.', "-"));
    let (status, error, details) = match Ctx::new(host, dir) {
        Err(err) => (Status::Fail, Some(err), vec![]),
        Ok(mut ctx) => {
            let result = catch_unwind(AssertUnwindSafe(|| (s.run)(&mut ctx)));
            let details = std::mem::take(&mut ctx.details);
            ctx.finish();
            match result {
                Ok(Ok(())) => (Status::Pass, None, details),
                Ok(Err(err)) => (Status::Fail, Some(err), details),
                Err(panic) => {
                    let msg = panic.downcast_ref::<String>().cloned().or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
                    (Status::Fail, Some(format!("сбой: {msg}")), details)
                }
            }
        }
    };
    Outcome { id: s.id, title: s.title, status, duration_ms: started.elapsed().as_millis(), error, details }
}

/// Запустить сценарии (`ids` пусто — все). Вызывать в среде tokio (ядро запускает фоновые задачи).
pub fn run(host: &Host, ids: &[String]) -> Result<Report, String> {
    let unknown: Vec<&String> = ids.iter().filter(|id| SCENARIOS.iter().all(|s| s.id != id.as_str())).collect();
    if !unknown.is_empty() {
        return Err(format!("Нет таких сценариев: {unknown:?}"));
    }
    let run_id = format!("run-{}", uuid::Uuid::new_v4().simple());
    let run_dir = host.root.join(&run_id);
    let started = Instant::now();
    let started_at = crate::util::now_string();
    let results: Vec<Outcome> = SCENARIOS.iter().filter(|s| ids.is_empty() || ids.iter().any(|id| id == s.id)).map(|s| run_one(host, &run_dir, s)).collect();
    remove_dir(&run_dir);
    let count = |st: Status| results.iter().filter(|r| r.status == st).count();
    let report = Report {
        run_id,
        started_at,
        duration_ms: started.elapsed().as_millis(),
        passed: count(Status::Pass),
        failed: count(Status::Fail),
        skipped: count(Status::Skipped),
        results,
    };
    for r in &report.results {
        let level = if r.status == Status::Fail { super::log::Level::Error } else { super::log::Level::Info };
        super::log::record(
            level,
            "scenario",
            &format!("{:?} {} ({} мс){}", r.status, r.id, r.duration_ms, r.error.as_ref().map(|e| format!(": {e}")).unwrap_or_default()),
        );
    }
    Ok(report)
}
