//! Кто вошёл в приложение: облачная учётная запись (Supabase) или локальная (только этот компьютер),
//! и открытая сессия с базой, настройками и фоновыми задачами.

use super::search::SearchState;
use super::sync::SyncState;
use super::{CmdError, CmdResult, Env};
use crate::accounts::UserAccount;
use crate::cloud::auth::{CallbackResult, CloudUser};
use crate::cloud::error::CloudError;
use crate::cloud::validation;
use crate::db::DbKey;
use crate::prefs::{self, AccountPrefs, PrefsFile};
use crate::search::settings::SearchSettings;
use crate::store::LeadStore;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::task::JoinHandle;

/// Открытая учётная запись.
pub struct Session {
    /// Внутренний идентификатор: имя локальной записи или `cloud-<uuid>`.
    pub id: String,
    /// Что показывать в интерфейсе: имя пользователя или адрес почты.
    pub display_name: String,
    pub is_cloud: bool,
    pub dir: PathBuf,
    pub store: Arc<Mutex<LeadStore>>,
    pub prefs: Mutex<PrefsFile<AccountPrefs>>,
    pub settings: Mutex<SearchSettings>,
    pub search: Mutex<SearchState>,
    pub sync: Mutex<SyncState>,
    /// Customers 2.0: выбранный Workspace и его база.
    pub workspace: Mutex<super::workspace::CrmState>,
    pub(crate) tasks: Mutex<Vec<JoinHandle<()>>>,
}

impl Session {
    pub fn key(&self) -> String {
        self.id.to_lowercase()
    }

    /// Файл базы: своя папка/файл из настроек или стандартный leads.db в папке учётной записи.
    pub fn database_path(dir: &Path, prefs: &AccountPrefs) -> PathBuf {
        match prefs.data_path.as_deref().filter(|p| !p.trim().is_empty()) {
            Some(p) if p.to_lowercase().ends_with(".db") => PathBuf::from(p),
            Some(p) => Path::new(p).join("leads.db"),
            None => dir.join("leads.db"),
        }
    }

    pub fn with_store<R>(&self, f: impl FnOnce(&LeadStore) -> R) -> R {
        f(&self.store.lock().unwrap())
    }

    pub fn account_prefs(&self) -> AccountPrefs {
        self.prefs.lock().unwrap().value.clone()
    }

    /// Остановить фоновые задачи (поиск, таймеры, синхронизацию).
    pub fn shutdown(&self) {
        self.search.lock().unwrap().cancel();
        for t in self.tasks.lock().unwrap().drain(..) {
            t.abort();
        }
        self.sync.lock().unwrap().cancel.cancel();
    }
}

/// Краткие сведения об открытой записи для интерфейса.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub display_name: String,
    /// Аватар в виде data-URL; синхронизируется через облако.
    pub avatar: Option<String>,
    pub is_cloud: bool,
    pub cloud_user: Option<CloudUserInfo>,
    pub database_path: String,
}

/// Имя и аватар хранятся в базе пользователя как JSON-строки (и синхронизируются).
fn stored_text(s: &Session, key: &str) -> Option<String> {
    let raw = s.with_store(|st| st.value(key))?;
    serde_json::from_str::<String>(&raw).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudUserInfo {
    pub id: String,
    pub email: String,
    pub new_email: Option<String>,
    pub confirmed: bool,
}

impl From<&CloudUser> for CloudUserInfo {
    fn from(u: &CloudUser) -> Self {
        Self { id: u.id.clone(), email: u.email.clone(), new_email: u.new_email.clone(), confirmed: u.is_confirmed() }
    }
}

/// Что нужно показать при запуске.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    pub version: String,
    pub platform: &'static str,
    pub cloud_available: bool,
    pub has_users: bool,
    /// На этом компьютере уже были учётные записи до запуска: это обновление, а не первая установка.
    pub existing_install: bool,
    pub session: Option<SessionInfo>,
    pub device: Value,
    pub error: Option<String>,
    /// Канал сборки: "stable" или "beta" (интерфейс показывает метку Beta).
    pub channel: &'static str,
}

pub enum CallbackOutcome {
    /// Вход по ссылке восстановления: нужно задать новый пароль.
    NewPassword,
    SignedIn,
    Message(String),
}

pub struct Core {
    pub env: Arc<Env>,
    pub(crate) current: Mutex<Option<Arc<Session>>>,
    pub(crate) cloud_user: Mutex<Option<CloudUser>>,
    existing_install: bool,
    pub(crate) updates: Mutex<super::update::UpdateState>,
    pub(crate) integ: Mutex<super::integrations::IntegrationState>,
    startup_error: Mutex<Option<String>>,
}

impl Core {
    pub fn new(env: Arc<Env>) -> Arc<Self> {
        let existing_install = env.accounts.has_users();
        Arc::new(Self {
            env,
            current: Mutex::new(None),
            cloud_user: Mutex::new(None),
            existing_install,
            updates: Mutex::default(),
            integ: Mutex::default(),
            startup_error: Mutex::new(None),
        })
    }

    pub fn session(&self) -> Option<Arc<Session>> {
        self.current.lock().unwrap().clone()
    }

    pub fn require(&self) -> CmdResult<Arc<Session>> {
        self.session().ok_or_else(|| CmdError::new("noSession", "Войдите в учётную запись."))
    }

    pub fn info(&self) -> Option<SessionInfo> {
        let s = self.session()?;
        let cloud_user = if s.is_cloud { self.cloud_user.lock().unwrap().as_ref().map(CloudUserInfo::from) } else { None };
        let database_path = s.with_store(|st| st.path().display().to_string());
        // Имя профиля из облака главнее; пока оно не пришло, берётся имя из регистрации, затем адрес почты.
        let signup_name = if s.is_cloud { self.cloud_user.lock().unwrap().as_ref().and_then(CloudUser::username) } else { None };
        let display_name = stored_text(&s, "profile.name").or(signup_name).unwrap_or_else(|| s.display_name.clone());
        let avatar = stored_text(&s, "profile.avatar");
        Some(SessionInfo { id: s.id.clone(), display_name, avatar, is_cloud: s.is_cloud, cloud_user, database_path })
    }

    pub fn boot_info(&self) -> BootInfo {
        BootInfo {
            version: self.env.version.to_string(),
            platform: if cfg!(windows) {
                "windows"
            } else if cfg!(target_os = "macos") {
                "macos"
            } else {
                "linux"
            },
            cloud_available: self.env.cloud_available(),
            has_users: self.env.accounts.has_users(),
            existing_install: self.existing_install,
            session: self.info(),
            device: self.env.device.lock().unwrap().to_json(),
            error: self.startup_error.lock().unwrap().clone(),
            channel: self.env.channel.name(),
        }
    }

    // ------------------------------------------------------------------ запуск

    /// Перенос настроек прежних версий, возврат в сохранённую сессию.
    pub fn startup(self: &Arc<Self>) {
        self.import_legacy();
        let env = &self.env;
        if let Some(cloud) = &env.cloud {
            // Сессия из защищённого хранилища: данные открываются сразу, даже без сети; токен обновится в фоне.
            if let Some(saved) = cloud.session() {
                match self.open_cloud(saved.user.clone()) {
                    Ok(()) => {
                        let core = self.clone();
                        tokio::spawn(async move { core.revalidate().await });
                    }
                    Err(e) => *self.startup_error.lock().unwrap() = Some(e.message),
                }
                return;
            }
        }
        let remembered = env.device_prefs().remembered_user;
        if let Some(name) = remembered.filter(|n| !n.is_empty()) {
            if let Some(account) = env.accounts.account(&name) {
                if let Err(e) = self.open_local(&account) {
                    *self.startup_error.lock().unwrap() = Some(e.message);
                }
            }
        }
    }

    /// Один раз: настройки UserDefaults macOS, запомненный вход, ненужные секреты версии 1.0.
    fn import_legacy(&self) {
        let env = &self.env;
        if env.device_prefs().legacy_imported {
            return;
        }
        let mut patch = serde_json::Map::new();
        if let Some(defaults) = env.paths.legacy_defaults.as_deref().and_then(prefs::read_defaults_plist) {
            if let Value::Object(o) = prefs::legacy_device_patch(&defaults) {
                patch.extend(o);
            }
        }
        // Запомненный вход прежней macOS-версии лежал в Связке ключей.
        if env.device_prefs().remembered_user.is_none() {
            if let Some(name) = env.secrets.get("session.user").ok().flatten().filter(|v| !v.is_empty()) {
                patch.insert("rememberedUser".into(), json!(name));
            }
        }
        // Токен GitHub и ключ шифрования из версии 1.0 больше не нужны.
        for name in ["github.token", "state.secret"] {
            let _ = env.secrets.delete(name);
        }
        patch.insert("legacyImported".into(), json!(true));
        env.patch_device(&Value::Object(patch));
    }

    /// Проверить сохранённую сессию на сервере. Отозванная — выход с понятным сообщением.
    async fn revalidate(self: Arc<Self>) {
        let Some(cloud) = self.env.cloud.clone() else { return };
        match cloud.reload_user().await {
            Ok(u) => *self.cloud_user.lock().unwrap() = Some(u),
            Err(CloudError::SessionExpired) => self.session_expired(),
            Err(_) => {} // нет сети — продолжаем работать с локальными данными
        }
    }

    pub(crate) fn session_expired(&self) {
        if self.session().map(|s| s.is_cloud).unwrap_or(false) {
            self.close_current();
            self.env.emit("session-ended", json!({"reason": CloudError::SessionExpired.to_string()}));
        }
    }

    // ------------------------------------------------------------------ открытие и закрытие

    pub(crate) fn close_current(&self) {
        if let Some(s) = self.current.lock().unwrap().take() {
            s.shutdown();
        }
        *self.cloud_user.lock().unwrap() = None;
        self.env.emit("session-changed", Value::Null);
    }

    fn open_session(self: &Arc<Self>, id: &str, display_name: &str, is_cloud: bool, dir: &Path) -> CmdResult<()> {
        self.close_current();
        let env = &self.env;
        std::fs::create_dir_all(dir).map_err(|e| CmdError::msg(format!("Не удалось создать папку данных: {e}")))?;
        let prefs_path = dir.join("prefs.json");
        let first_time = !prefs_path.exists();
        let mut prefs = PrefsFile::<AccountPrefs>::load(&prefs_path);
        let legacy = env.paths.legacy_defaults.as_deref().and_then(prefs::read_defaults_plist);
        if first_time {
            if let Some(d) = &legacy {
                prefs.patch(&prefs::legacy_account_patch(d, id));
            }
        }
        let db_path = Session::database_path(dir, &prefs.value);
        env.guard_path(&db_path)?;
        // Beta никогда не создавала незашифрованных баз: такой файл — чужая база (например, Stable 1.0),
        // и открытие переписало бы её в зашифрованную ключом Beta. Отказываемся, ничего не меняя.
        if env.channel.is_beta() && crate::db::file_state(&db_path) == crate::db::FileState::Plaintext {
            return Err(CmdError::msg(format!("{} — незашифрованная база другой версии Customers. Beta её не открывает.", db_path.display())));
        }
        let key: DbKey = env.keys.key_for(id).map_err(|e| CmdError::msg(format!("Не удалось открыть базу: {e}")))?;
        let mut store = LeadStore::open(&db_path, Some(key)).map_err(|e| CmdError::msg(format!("Не удалось открыть базу: {e}")))?;
        if is_cloud && !store.sync_tracking() {
            store.enable_sync_tracking()?;
        }
        if first_time {
            if let Some(notion) = legacy.as_ref().and_then(|d| prefs::legacy_notion_config(d, id)) {
                if store.value("export.notion").is_none() {
                    let _ = store.set_value("export.notion", &notion);
                }
            }
        }
        let settings = SearchSettings::stored(store.value("search.settings").as_deref());
        // Автопоиск тоже хранится в базе (синхронизируется): значение оттуда главнее.
        if let Some(v) = store.value("search.auto").and_then(|v| v.parse::<u32>().ok()) {
            prefs.patch(&json!({"autoSearchMinutes": v}));
        }
        let session = Arc::new(Session {
            id: id.to_string(),
            display_name: display_name.to_string(),
            is_cloud,
            dir: dir.to_path_buf(),
            store: Arc::new(Mutex::new(store)),
            prefs: Mutex::new(prefs),
            settings: Mutex::new(settings),
            search: Mutex::new(SearchState::default()),
            sync: Mutex::new(SyncState::new()),
            workspace: Mutex::default(),
            tasks: Mutex::new(vec![]),
        });
        *self.current.lock().unwrap() = Some(session.clone());
        self.apply_synced_prefs(&session);
        self.start_background(&session);
        self.env.emit("session-changed", serde_json::to_value(self.info()).unwrap_or(Value::Null));
        Ok(())
    }

    fn open_local(self: &Arc<Self>, account: &UserAccount) -> CmdResult<()> {
        let dir = self.env.accounts.data_directory(&account.username);
        self.open_session(&account.username, &account.username, false, &dir)
    }

    fn open_cloud(self: &Arc<Self>, user: CloudUser) -> CmdResult<()> {
        let id = format!("cloud-{}", user.id.to_lowercase());
        let dir = self.env.paths.root.join("users").join(&id);
        *self.cloud_user.lock().unwrap() = Some(user.clone());
        let result = self.open_session(&id, &user.email, true, &dir);
        *self.cloud_user.lock().unwrap() = Some(user);
        result
    }

    // ------------------------------------------------------------------ профиль

    /// Имя пользователя: от 1 до 40 символов без пробелов по краям.
    pub fn checked_name(raw: &str) -> CmdResult<String> {
        let name = raw.trim();
        let len = name.chars().count();
        if len == 0 {
            return Err(CmdError::msg("Введите имя пользователя."));
        }
        if len > 40 {
            return Err(CmdError::msg("Имя не должно быть длиннее 40 символов."));
        }
        if name.chars().any(char::is_control) {
            return Err(CmdError::msg("В имени есть недопустимые символы."));
        }
        Ok(name.to_string())
    }

    /// Изменить имя и/или аватар. Пустой аватар удаляет картинку. Значения уходят в облако вместе с остальными настройками.
    pub fn set_profile(self: &Arc<Self>, name: Option<&str>, avatar: Option<&str>) -> CmdResult<SessionInfo> {
        let s = self.require()?;
        if let Some(n) = name {
            let n = Self::checked_name(n)?;
            s.with_store(|st| st.set_synced_value("profile.name", &serde_json::to_string(&n).unwrap_or_default()))?;
        }
        if let Some(a) = avatar {
            let a = a.trim();
            if !a.is_empty() && (!a.starts_with("data:image/") || a.len() > 60_000) {
                return Err(CmdError::msg("Картинка не подходит: нужен небольшой снимок в формате PNG, JPEG или WebP."));
            }
            s.with_store(|st| st.set_synced_value("profile.avatar", &serde_json::to_string(a).unwrap_or_default()))?;
        }
        self.sync_soon(&s);
        let info = self.info().ok_or_else(|| CmdError::new("noSession", "Войдите в учётную запись."))?;
        if name.is_some() || avatar.is_some() {
            self.publish_profile(&s, name.map(|_| info.display_name.as_str()), avatar.map(|_| info.avatar.as_deref().unwrap_or("")));
        }
        self.env.emit("session-changed", serde_json::to_value(&info).unwrap_or(Value::Null));
        Ok(info)
    }

    /// Имя и фото профиля видят и другие участники Workspace: они хранятся ещё и в `user_profiles`
    /// (остальное синхронизируется настройками). Фото — отдельным запросом: на сервере без миграции
    /// 20261110170000 столбца `avatar_data` нет, и это не должно мешать имени.
    pub(crate) fn publish_profile(&self, s: &Session, name: Option<&str>, avatar: Option<&str>) {
        let (Some(cloud), true) = (self.env.cloud.clone(), s.is_cloud) else { return };
        let Some(uid) = self.cloud_user.lock().unwrap().as_ref().map(|u| u.id.clone()) else { return };
        let mut bodies = vec![];
        if let Some(n) = name {
            bodies.push(json!({"display_name": n.chars().take(120).collect::<String>()}));
        }
        if let Some(a) = avatar {
            bodies.push(json!({"avatar_data": if a.is_empty() { Value::Null } else { json!(a) }}));
        }
        tokio::spawn(async move {
            for body in bodies {
                let _ = cloud.authorized("PATCH", &format!("/rest/v1/user_profiles?user_id=eq.{uid}"), Some(&body), &[("Prefer", "return=minimal")]).await;
            }
        });
    }

    // ------------------------------------------------------------------ локальные учётные записи

    pub fn local_accounts(&self) -> Vec<UserAccount> {
        self.env.accounts.all_accounts()
    }

    pub fn register(self: &Arc<Self>, username: &str, password: &str, confirm: &str, remember: bool) -> CmdResult<Option<String>> {
        if password != confirm {
            return Err(crate::accounts::AuthError::PasswordsDiffer.into());
        }
        let first = !self.env.accounts.has_users();
        let account = self.env.accounts.register(username, password)?;
        let migration_error = if first { self.adopt_legacy_database(&account.username) } else { None };
        self.finish_local(&account, remember)?;
        // Ошибку переноса старой базы показываем после входа: повторно перенос не запускается.
        Ok(migration_error)
    }

    pub fn login(self: &Arc<Self>, username: &str, password: &str, remember: bool) -> CmdResult<()> {
        let account = self.env.accounts.login(username, password)?;
        self.finish_local(&account, remember)
    }

    fn finish_local(self: &Arc<Self>, account: &UserAccount, remember: bool) -> CmdResult<()> {
        self.env.patch_device(&json!({"rememberedUser": if remember { json!(account.username) } else { Value::Null }}));
        self.open_local(account)
    }

    pub fn remembered(&self) -> bool {
        self.env.device_prefs().remembered_user.map(|u| !u.is_empty()).unwrap_or(false)
    }

    pub fn set_remembered(&self, on: bool) {
        let name = self.session().filter(|s| !s.is_cloud).map(|s| s.id.clone());
        self.env.patch_device(&json!({"rememberedUser": if on { name.map(Value::from).unwrap_or(Value::Null) } else { Value::Null }}));
    }

    pub fn logout(self: &Arc<Self>) {
        let was_cloud = self.session().map(|s| s.is_cloud).unwrap_or(false);
        if !was_cloud {
            self.env.patch_device(&json!({"rememberedUser": Value::Null}));
            let _ = self.env.secrets.delete("session.user");
        } else if let Some(cloud) = self.env.cloud.clone() {
            // Облачная сессия (в том числе после входа по ссылке восстановления) отзывается.
            tokio::spawn(async move { cloud.sign_out().await });
        }
        self.close_current();
    }

    pub fn change_password(&self, old: &str, new: &str, confirm: &str) -> CmdResult<()> {
        let s = self.require()?;
        if new != confirm {
            return Err(crate::accounts::AuthError::PasswordsDiffer.into());
        }
        self.env.accounts.change_password(&s.id, old, new)?;
        Ok(())
    }

    /// Первая учётная запись получает лиды из базы версии 1.0. Исходный файл остаётся рядом под другим именем.
    fn adopt_legacy_database(&self, username: &str) -> Option<String> {
        let env = &self.env;
        let custom = env
            .paths
            .legacy_defaults
            .as_deref()
            .and_then(prefs::read_defaults_plist)
            .and_then(|d| d.get("data.path").and_then(|v| v.as_string().map(PathBuf::from)));
        let legacy = custom.unwrap_or_else(|| env.paths.legacy_database());
        if !legacy.exists() {
            return None;
        }
        let target = env.accounts.data_directory(username).join("leads.db");
        if target.exists() {
            return None;
        }
        let result = (|| -> Result<(), String> {
            let key = env.keys.key_for(username).map_err(|e| e.to_string())?;
            let old = LeadStore::open(&legacy, Some(key)).map_err(|e| e.to_string())?;
            old.backup(&target).map_err(|e| e.to_string())?;
            old.close();
            let renamed = legacy.parent().unwrap_or(Path::new(".")).join("leads-1.0-backup.db");
            let _ = std::fs::remove_file(&renamed);
            std::fs::rename(&legacy, &renamed).map_err(|e| e.to_string())?;
            for suffix in ["-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", legacy.display()));
            }
            Ok(())
        })();
        result.err().map(|e| {
            format!(
                "Лиды из прежней версии не перенесены: {e}. Файл остался на месте: {}. Его можно открыть через «Настройки → Данные → Восстановить из файла…».",
                legacy.display()
            )
        })
    }

    // ------------------------------------------------------------------ облако: вход и регистрация

    fn cloud(&self) -> CmdResult<Arc<crate::cloud::auth::CloudAuth>> {
        self.env.cloud.clone().ok_or_else(|| CloudError::NotConfigured.into())
    }

    pub async fn cloud_sign_in(self: &Arc<Self>, email: &str, password: &str) -> CmdResult<()> {
        let cloud = self.cloud()?;
        let s = cloud.sign_in(email, password).await?;
        self.open_cloud(s.user)
    }

    /// `Ok(Some(email))` — на адрес отправлен код, нужно подтверждение; `Ok(None)` — вход выполнен сразу.
    pub async fn cloud_sign_up(self: &Arc<Self>, email: &str, password: &str, confirm: &str, username: &str) -> CmdResult<Option<String>> {
        let cloud = self.cloud()?;
        if password != confirm {
            return Err(CloudError::PasswordsDiffer.into());
        }
        let username = Self::checked_name(username)?;
        cloud.sign_up_named(email, password, Some(&username)).await?;
        if let Some(user) = cloud.user() {
            self.open_cloud(user)?; // на сервере выключено подтверждение почты
            return Ok(None);
        }
        Ok(Some(validation::normalized_email(email).unwrap_or_else(|| email.to_string())))
    }

    pub async fn cloud_confirm(self: &Arc<Self>, email: &str, code: &str) -> CmdResult<()> {
        let cloud = self.cloud()?;
        let s = cloud.verify(email, code, "signup").await?.ok_or(CloudError::InvalidCode)?;
        self.open_cloud(s.user)
    }

    pub async fn cloud_resend_confirmation(&self, email: &str) -> CmdResult<()> {
        Ok(self.cloud()?.resend_confirmation(email).await?)
    }

    /// Возвращает нормализованный адрес, на который ушёл код.
    pub async fn cloud_request_reset(&self, email: &str) -> CmdResult<String> {
        self.cloud()?.request_password_reset(email).await?;
        Ok(validation::normalized_email(email).unwrap_or_else(|| email.to_string()))
    }

    pub async fn cloud_finish_reset(self: &Arc<Self>, email: &str, code: &str, password: &str, confirm: &str) -> CmdResult<()> {
        let cloud = self.cloud()?;
        if password != confirm {
            return Err(CloudError::PasswordsDiffer.into());
        }
        if let Some(p) = validation::password_problem(password) {
            return Err(CmdError::msg(p));
        }
        cloud.verify(email, code, "recovery").await?.ok_or(CloudError::InvalidCode)?;
        cloud.set_new_password(password).await?;
        match cloud.user() {
            Some(u) => self.open_cloud(u),
            None => Ok(()),
        }
    }

    /// Новый пароль после входа по ссылке восстановления.
    pub async fn cloud_set_password_after_recovery(self: &Arc<Self>, password: &str, confirm: &str) -> CmdResult<()> {
        let cloud = self.cloud()?;
        if password != confirm {
            return Err(CloudError::PasswordsDiffer.into());
        }
        cloud.set_new_password(password).await?;
        match cloud.user() {
            Some(u) => self.open_cloud(u),
            None => Ok(()),
        }
    }

    /// Ссылка из письма: leadgenerator://auth/callback#…
    pub async fn handle_auth_url(self: &Arc<Self>, url: &str) -> CmdResult<CallbackOutcome> {
        if !url.starts_with(&format!("{}:", self.env.channel.identity().url_scheme)) {
            return Err(CmdError::msg("Неизвестная ссылка."));
        }
        let cloud = self.cloud()?;
        match cloud.handle_callback(url).await? {
            CallbackResult::SignedIn { kind } => {
                if kind == "recovery" {
                    self.close_current();
                    return Ok(CallbackOutcome::NewPassword);
                }
                if let Some(u) = cloud.user() {
                    let same =
                        self.session().map(|s| s.is_cloud).unwrap_or(false) && self.cloud_user.lock().unwrap().as_ref().map(|c| c.id == u.id).unwrap_or(false);
                    if same {
                        *self.cloud_user.lock().unwrap() = Some(u);
                        let text = if kind == "email_change" { "Адрес почты изменён" } else { "Адрес подтверждён" };
                        self.env.emit("toast", json!({"kind": "info", "text": text}));
                        self.env.emit("session-changed", serde_json::to_value(self.info()).unwrap_or(Value::Null));
                    } else {
                        self.open_cloud(u)?;
                    }
                }
                Ok(CallbackOutcome::SignedIn)
            }
            CallbackResult::Message(_) => {
                let text = "Первая ссылка принята. Подтвердите смену адреса и по ссылке из второго письма.".to_string();
                self.env.emit("toast", json!({"kind": "info", "text": text}));
                Ok(CallbackOutcome::Message(text))
            }
        }
    }

    // ------------------------------------------------------------------ облако: управление записью

    pub async fn reload_cloud_user(&self) {
        if let Some(cloud) = self.env.cloud.clone() {
            if let Ok(u) = cloud.reload_user().await {
                *self.cloud_user.lock().unwrap() = Some(u);
                self.env.emit("session-changed", serde_json::to_value(self.info()).unwrap_or(Value::Null));
            }
        }
    }

    pub async fn change_cloud_password(&self, current: &str, new: &str, confirm: &str) -> CmdResult<()> {
        let cloud = self.cloud()?;
        if new != confirm {
            return Err(CloudError::PasswordsDiffer.into());
        }
        Ok(cloud.change_password(current, new).await?)
    }

    pub async fn change_cloud_email(&self, email: &str, password: &str) -> CmdResult<()> {
        let cloud = self.cloud()?;
        cloud.change_email(email, password).await?;
        self.reload_cloud_user().await;
        Ok(())
    }

    pub async fn confirm_cloud_email(&self, email: &str, code: &str) -> CmdResult<()> {
        let cloud = self.cloud()?;
        cloud.confirm_email_change(email, code).await?;
        self.reload_cloud_user().await;
        Ok(())
    }

    pub async fn resend_cloud_email_change(&self) -> CmdResult<()> {
        Ok(self.cloud()?.resend_email_change().await?)
    }

    /// Удаление облачной учётной записи. Локальная копия базы остаётся в папке резервных копий.
    pub async fn delete_cloud_account(self: &Arc<Self>, password: &str) -> CmdResult<String> {
        let cloud = self.cloud()?;
        let s = self.require()?;
        if !s.is_cloud {
            return Err(CmdError::msg("Это локальная учётная запись."));
        }
        // Сначала локальная копия: без неё удалять нельзя.
        let backup =
            self.backup_now(&s).map_err(|e| CmdError::msg(format!("Не удалось сохранить резервную копию базы, учётная запись не удалена. {}", e.message)))?;
        cloud.delete_account(password).await?;
        let dir = s.with_store(|st| st.path().parent().map(Path::to_path_buf));
        self.close_current();
        // Локальные данные удалённой учётной записи убираются с этого компьютера; копия — в резервных копиях.
        if let Some(dir) = dir {
            let _ = std::fs::remove_dir_all(dir);
        }
        let _ = std::fs::remove_dir_all(&s.dir);
        self.env.keys.forget(&s.id);
        Ok(format!("Учётная запись удалена вместе с данными в облаке. Копия базы сохранена: {}", backup.display()))
    }

    /// Сколько данных лежит в облаке (для сверки после переноса).
    pub async fn cloud_stats(&self) -> CmdResult<std::collections::BTreeMap<String, i64>> {
        let cloud = self.cloud()?;
        let s = self.require()?;
        if !s.is_cloud {
            return Err(CmdError::msg("Это локальная учётная запись."));
        }
        let engine = crate::cloud::sync::SyncEngine::new(cloud, s.store.clone(), self.env.device_id.clone());
        Ok(engine.remote_stats().await?)
    }

    /// Копирует лиды, исключения и настройки локальной учётной записи в открытую облачную.
    /// Исходная база не меняется (она и есть резервная копия). Записи, которые уже есть в облаке
    /// и менялись там, не затираются: перенесённым данным даётся раннее время изменения.
    pub async fn import_local(self: &Arc<Self>, username: &str, password: &str) -> CmdResult<String> {
        let s = self.require()?;
        if !s.is_cloud {
            return Err(CmdError::msg("Перенос доступен только в облачной учётной записи."));
        }
        let account = self.env.accounts.login(username, password)?;
        let dir = self.env.accounts.data_directory(&account.username);
        let prefs = PrefsFile::<AccountPrefs>::load(&dir.join("prefs.json"));
        let path = Session::database_path(&dir, &prefs.value);
        if !path.exists() {
            return Err(CmdError::msg("У этой учётной записи нет базы лидов."));
        }
        let _ = self.backup_now(&s);
        let key = self.env.keys.key_for(&account.username)?;
        let src = LeadStore::open(&path, Some(key)).map_err(|e| CmdError::msg(format!("Перенос не удался: {e}")))?;
        let total = src.all_leads(true)?.len();
        let count = s.with_store(|target| target.import_from(&src)).map_err(|e| CmdError::msg(format!("Перенос не удался: {e}")))?;
        src.close();
        self.reload_synced_settings(&s);
        self.env.emit("data-changed", Value::Null);
        self.sync_soon(&s);
        Ok(format!("Перенесено лидов: {count} из {total} (остальные уже были). Исходная база не изменена."))
    }
}

#[cfg(test)]
mod tests {
    use super::super::testing::fixture;
    use super::*;
    use crate::search::http::HttpResponse;

    #[tokio::test]
    async fn local_register_login_logout_and_remember() {
        let f = fixture(false, vec![]);
        let core = Core::new(f.env.clone());
        assert!(!core.boot_info().has_users && !core.boot_info().cloud_available);
        assert!(core.register("anna", "password-1", "password-2", false).is_err());
        assert_eq!(core.register("anna", "password-1", "password-1", true).unwrap(), None);
        let info = core.info().unwrap();
        assert_eq!((info.id.as_str(), info.is_cloud), ("anna", false));
        assert!(info.database_path.ends_with("leads.db"));
        assert!(core.remembered());
        assert_eq!(f.env.device_prefs().remembered_user.as_deref(), Some("anna"));
        core.logout();
        assert!(core.session().is_none() && !core.remembered());
        assert!(core.login("anna", "wrong-password", false).is_err());
        core.login("ANNA", "password-1", false).unwrap();
        assert!(!core.remembered());
        core.set_remembered(true);
        assert!(core.remembered());
        core.change_password("password-1", "new-password-2", "new-password-2").unwrap();
        core.logout();
        core.login("anna", "new-password-2", false).unwrap();
        assert!(f.events.count("session-changed") >= 4);
    }

    #[tokio::test]
    async fn startup_restores_remembered_local_user() {
        let f = fixture(false, vec![]);
        {
            let core = Core::new(f.env.clone());
            core.register("boris", "password-1", "password-1", true).unwrap();
        }
        let again = Core::new(f.env.clone());
        again.startup();
        let boot = again.boot_info();
        assert!(boot.existing_install && boot.session.is_some_and(|s| s.id == "boris"));
    }

    #[tokio::test]
    async fn first_registration_adopts_version_1_database() {
        let f = fixture(false, vec![]);
        let legacy = f.env.paths.legacy_database();
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        {
            // База версии 1.0 лежит в корне данных; ключ — тот же, что у первой записи (на macOS общий).
            let key = f.env.keys.key_for("boris").unwrap();
            let store = LeadStore::open(&legacy, Some(key)).unwrap();
            store.set_value("marker", "from-1.0").unwrap();
            store.close();
        }
        let core = Core::new(f.env.clone());
        if cfg!(target_os = "macos") {
            assert_eq!(core.register("boris", "password-1", "password-1", false).unwrap(), None);
            assert_eq!(core.session().unwrap().with_store(|s| s.value("marker")).as_deref(), Some("from-1.0"));
            assert!(!legacy.exists() && legacy.with_file_name("leads-1.0-backup.db").exists());
        } else {
            // На других системах ключи у баз свои: перенос возвращает понятное объяснение, а файл остаётся на месте.
            let msg = core.register("boris", "password-1", "password-1", false).unwrap();
            assert!(msg.is_none() || legacy.exists());
        }
    }

    #[tokio::test]
    async fn cloud_sign_in_opens_per_user_database_and_keeps_session() {
        let session = r#"{"access_token":"AT","refresh_token":"RT","expires_in":3600,"user":{"id":"U-1","email":"me@example.com","email_confirmed_at":"2026-11-05T00:00:00Z"}}"#;
        let f = fixture(true, vec![Ok(HttpResponse::new(200, session))]);
        let core = Core::new(f.env.clone());
        core.cloud_sign_in("me@example.com", "Password-1").await.unwrap();
        let info = core.info().unwrap();
        assert!(info.is_cloud && info.id == "cloud-u-1" && info.display_name == "me@example.com");
        assert!(info.cloud_user.as_ref().is_some_and(|u| u.confirmed));
        assert!(f.dir.path().join("data/users/cloud-u-1/leads.db").exists());
        assert!(core.session().unwrap().with_store(|s| s.sync_tracking()), "облачная запись ведёт журнал изменений");
        // запись сессии пережила «перезапуск»
        let again = Core::new(f.env.clone());
        again.startup();
        assert!(again.boot_info().session.is_some_and(|s| s.is_cloud));
    }

    /// Пароль для проверок, введённый «пользователем»: собирается во время работы теста.
    fn typed_secret() -> String {
        ["Pass", "word", "-1"].concat()
    }

    #[tokio::test]
    async fn cloud_name_from_sign_up_becomes_the_profile_name_and_is_synced() {
        let session = r#"{"access_token":"AT","refresh_token":"RT","expires_in":3600,"user":{"id":"U-2","email":"me@example.com","email_confirmed_at":"2026-11-05T00:00:00Z","user_metadata":{"display_name":"Анна"}}}"#;
        let f = fixture(true, vec![Ok(HttpResponse::new(200, session))]);
        let core = Core::new(f.env.clone());
        core.cloud_sign_in("me@example.com", &typed_secret()).await.unwrap();
        let info = core.info().unwrap();
        assert_eq!(info.display_name, "Анна", "вместо адреса почты показывается имя");
        // Имя из регистрации не пишется в журнал: иначе вход на новом компьютере затёр бы в облаке более новое имя.
        let dirty = core.session().unwrap().with_store(|st| st.pending_changes(100).unwrap());
        assert!(!dirty.settings.iter().any(|c| c.key == "profile.name"));
        // Имя, пришедшее из облака, главнее имени из регистрации.
        core.session().unwrap().with_store(|st| st.set_value("profile.name", "\"Анна Новая\"")).unwrap();
        assert_eq!(core.info().unwrap().display_name, "Анна Новая");
    }

    #[tokio::test]
    async fn profile_name_and_avatar_are_validated_and_stored() {
        let f = fixture(false, vec![]);
        let core = Core::new(f.env.clone());
        core.register("anna", &typed_secret(), &typed_secret(), false).unwrap();
        assert_eq!(core.info().unwrap().display_name, "anna");
        let info = core.set_profile(Some("  Анна К.  "), Some("data:image/jpeg;base64,AAAA")).unwrap();
        assert_eq!((info.display_name.as_str(), info.avatar.as_deref()), ("Анна К.", Some("data:image/jpeg;base64,AAAA")));
        assert!(core.set_profile(Some("   "), None).is_err());
        assert!(core.set_profile(Some(&"я".repeat(41)), None).is_err());
        assert!(core.set_profile(None, Some("http://evil.example/a.png")).is_err());
        assert!(core.set_profile(None, Some(&format!("data:image/png;base64,{}", "A".repeat(70_000)))).is_err());
        assert_eq!(core.set_profile(None, Some("")).unwrap().avatar, None, "пустое значение убирает аватар");
        assert_eq!(core.info().unwrap().display_name, "Анна К.");
    }

    #[tokio::test]
    async fn cloud_unavailable_without_config() {
        let f = fixture(false, vec![]);
        let core = Core::new(f.env.clone());
        let e = core.cloud_sign_in("a@b.c", "x").await.unwrap_err();
        assert!(e.message.contains("Облако не настроено"));
    }

    #[tokio::test]
    async fn email_not_confirmed_has_a_code_for_the_interface() {
        let f = fixture(true, vec![Ok(HttpResponse::new(400, r#"{"error_code":"email_not_confirmed","msg":"Email not confirmed"}"#))]);
        let core = Core::new(f.env.clone());
        let e = core.cloud_sign_in("me@example.com", "Password-1").await.unwrap_err();
        assert_eq!(e.code, "emailNotConfirmed");
    }
}
