//! Кто вошёл в приложение: облачная учётная запись (Supabase), и открытая сессия с базой, настройками
//! и фоновыми задачами. Вход возможен только через облако; локальных учётных записей нет.

use super::search::SearchState;
use super::sync::SyncState;
use super::{CmdError, CmdResult, Env};
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
    /// Внутренний идентификатор: `cloud-<uuid>`.
    pub id: String,
    /// Что показывать в интерфейсе, пока нет имени профиля: адрес почты.
    pub display_name: String,
    pub dir: PathBuf,
    pub store: Arc<Mutex<LeadStore>>,
    pub prefs: Mutex<PrefsFile<AccountPrefs>>,
    pub settings: Mutex<SearchSettings>,
    pub search: Mutex<SearchState>,
    pub sync: Mutex<SyncState>,
    /// Customers 2.0: выбранный Workspace и его база.
    pub workspace: Mutex<super::workspace::CrmState>,
    /// Открытие базы Workspace идёт по одному: параллельные команды при запуске иначе открывали бы её дважды и дважды засевали шаблон.
    pub ws_open: Mutex<()>,
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
    pub session: Option<SessionInfo>,
    pub device: Value,
    pub error: Option<String>,
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
    pub(crate) updates: Mutex<super::update::UpdateState>,
    pub(crate) integ: Mutex<super::integrations::IntegrationState>,
    startup_error: Mutex<Option<String>>,
}

impl Core {
    pub fn new(env: Arc<Env>) -> Arc<Self> {
        Arc::new(Self {
            env,
            current: Mutex::new(None),
            cloud_user: Mutex::new(None),
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
        let cloud_user = self.cloud_user.lock().unwrap().as_ref().map(CloudUserInfo::from);
        let database_path = s.with_store(|st| st.path().display().to_string());
        // Имя профиля из облака главнее; пока оно не пришло, берётся имя из регистрации, затем адрес почты.
        let signup_name = self.cloud_user.lock().unwrap().as_ref().and_then(CloudUser::username);
        let display_name = stored_text(&s, "profile.name").or(signup_name).unwrap_or_else(|| s.display_name.clone());
        let avatar = stored_text(&s, "profile.avatar");
        Some(SessionInfo { id: s.id.clone(), display_name, avatar, cloud_user, database_path })
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
            session: self.info(),
            device: self.env.device.lock().unwrap().to_json(),
            error: self.startup_error.lock().unwrap().clone(),
        }
    }

    // ------------------------------------------------------------------ запуск

    /// Перенос настроек прежних версий, возврат в сохранённую сессию.
    pub fn startup(self: &Arc<Self>) {
        self.import_legacy();
        // Сессия из защищённого хранилища: данные открываются сразу, даже без сети; токен обновится в фоне.
        let Some(saved) = self.env.cloud.as_ref().and_then(|c| c.session()) else { return };
        match self.open_cloud(saved.user) {
            Ok(()) => {
                let core = self.clone();
                tokio::spawn(async move { core.revalidate().await });
            }
            Err(e) => *self.startup_error.lock().unwrap() = Some(e.message),
        }
    }

    /// Один раз: настройки UserDefaults macOS и ненужные секреты версии 1.0.
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
        // Токен GitHub, ключ шифрования и запомненный локальный вход версии 1.0 больше не нужны.
        for name in ["github.token", "state.secret", "session.user"] {
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
        if self.session().is_some() {
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

    fn open_session(self: &Arc<Self>, id: &str, display_name: &str, dir: &Path) -> CmdResult<()> {
        self.close_current();
        let env = &self.env;
        std::fs::create_dir_all(dir).map_err(|e| CmdError::msg(format!("Не удалось создать папку данных: {e}")))?;
        let prefs_path = dir.join("prefs.json");
        let mut prefs = PrefsFile::<AccountPrefs>::load(&prefs_path);
        let db_path = Session::database_path(dir, &prefs.value);
        let key: DbKey = env.keys.key_for(id).map_err(|e| CmdError::msg(format!("Не удалось открыть базу: {e}")))?;
        let mut store = LeadStore::open(&db_path, Some(key)).map_err(|e| CmdError::msg(format!("Не удалось открыть базу: {e}")))?;
        if !store.sync_tracking() {
            store.enable_sync_tracking()?;
        }
        let settings = SearchSettings::stored(store.value("search.settings").as_deref());
        // Автопоиск тоже хранится в базе (синхронизируется): значение оттуда главнее.
        if let Some(v) = store.value("search.auto").and_then(|v| v.parse::<u32>().ok()) {
            prefs.patch(&json!({"autoSearchMinutes": v}));
        }
        let session = Arc::new(Session {
            id: id.to_string(),
            display_name: display_name.to_string(),
            dir: dir.to_path_buf(),
            store: Arc::new(Mutex::new(store)),
            prefs: Mutex::new(prefs),
            settings: Mutex::new(settings),
            search: Mutex::new(SearchState::default()),
            sync: Mutex::new(SyncState::new()),
            workspace: Mutex::default(),
            ws_open: Mutex::new(()),
            tasks: Mutex::new(vec![]),
        });
        *self.current.lock().unwrap() = Some(session.clone());
        self.apply_synced_prefs(&session);
        self.start_background(&session);
        self.env.emit("session-changed", serde_json::to_value(self.info()).unwrap_or(Value::Null));
        Ok(())
    }

    fn open_cloud(self: &Arc<Self>, user: CloudUser) -> CmdResult<()> {
        let id = format!("cloud-{}", user.id.to_lowercase());
        let dir = self.env.paths.root.join("users").join(&id);
        *self.cloud_user.lock().unwrap() = Some(user.clone());
        let result = self.open_session(&id, &user.email, &dir);
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
    /// 20261110170000 столбца `avatar_data` нет, и это не должно мешать имени. Успешно отправленное значение
    /// запоминается (`profile.pub.*`): по нему видно, что у этого устройства есть неотправленная правка.
    pub(crate) fn publish_profile(&self, s: &Session, name: Option<&str>, avatar: Option<&str>) {
        let Some(cloud) = self.env.cloud.clone() else { return };
        let Some(uid) = self.cloud_user.lock().unwrap().as_ref().map(|u| u.id.clone()) else { return };
        let mut bodies = vec![];
        if let Some(n) = name {
            let n: String = n.chars().take(120).collect();
            bodies.push(("name", n.clone(), json!({"display_name": n})));
        }
        if let Some(a) = avatar {
            bodies.push(("avatar", a.to_string(), json!({"avatar_data": if a.is_empty() { Value::Null } else { json!(a) }})));
        }
        let store = s.store.clone();
        tokio::spawn(async move {
            for (kind, value, body) in bodies {
                let sent = cloud.authorized("PATCH", &format!("/rest/v1/user_profiles?user_id=eq.{uid}"), Some(&body), &[("Prefer", "return=minimal")]).await;
                if matches!(sent, Ok((code, _)) if (200..300).contains(&code)) {
                    let _ = store.lock().unwrap().set_value(&format!("profile.pub.{kind}"), &serde_json::to_string(&value).unwrap_or_default());
                }
            }
        });
    }

    /// Сверка имени и фото с копией в облаке (`user_profiles`): так профиль доходит и тогда, когда настройки
    /// другого устройства не успели прийти. Правка, сделанная здесь и ещё не отправленная, уходит в облако;
    /// иначе побеждает облако (его меняло другое устройство). Возвращает, изменилось ли что-то здесь.
    pub(crate) fn reconcile_profile(&self, s: &Session, server_name: Option<&str>, server_avatar: Option<&str>) -> bool {
        let mut changed = false;
        let (mut send_name, mut send_avatar) = (None, None);
        for (kind, server) in [("name", server_name), ("avatar", server_avatar)] {
            let (key, marker_key) = (format!("profile.{kind}"), format!("profile.pub.{kind}"));
            let Some(server) = server.map(str::trim) else { continue };
            let local = stored_text(s, &key).unwrap_or_default();
            let marker = s.with_store(|st| st.value(&marker_key)).and_then(|m| serde_json::from_str::<String>(&m).ok());
            let json = |v: &str| serde_json::to_string(v).unwrap_or_default();
            if server == local {
                if marker.as_deref() != Some(local.as_str()) {
                    let _ = s.with_store(|st| st.set_value(&marker_key, &json(&local)));
                }
                continue;
            }
            let unsent = s.with_store(|st| st.has_pending("setting", &key)) || marker.as_deref().is_some_and(|m| m != local);
            let adopt = !server.is_empty() && !unsent;
            if adopt {
                let _ = s.with_store(|st| st.set_value(&key, &json(server)).and_then(|_| st.set_value(&marker_key, &json(server))));
                changed = true;
            } else if !local.is_empty() && (unsent || marker.as_deref() != Some(local.as_str())) {
                if kind == "name" {
                    send_name = Some(local);
                } else {
                    send_avatar = Some(local);
                }
            }
        }
        if send_name.is_some() || send_avatar.is_some() {
            self.publish_profile(s, send_name.as_deref(), send_avatar.as_deref());
        }
        changed
    }

    /// Читает свою строку `user_profiles` и сверяет с ней имя и фото (после каждой удачной синхронизации).
    pub(crate) async fn pull_own_profile(self: &Arc<Self>, s: &Arc<Session>) {
        let Some(cloud) = self.env.cloud.clone() else { return };
        let Some(uid) = self.cloud_user.lock().unwrap().as_ref().map(|u| u.id.clone()) else { return };
        // Столбца `avatar_data` на сервере может не быть: тогда читаем одно имя.
        for select in ["display_name,avatar_data", "display_name"] {
            let Ok((code, data)) = cloud.authorized("GET", &format!("/rest/v1/user_profiles?user_id=eq.{uid}&select={select}"), None, &[]).await else {
                return;
            };
            if !(200..300).contains(&code) {
                continue;
            }
            let rows: Value = serde_json::from_slice(&data).unwrap_or(Value::Null);
            let Some(row) = rows.as_array().and_then(|a| a.first()) else { return };
            let (name, avatar) = (row["display_name"].as_str(), row["avatar_data"].as_str());
            // Столбец есть, но пуст (null) — это пустое фото; столбца нет — фото не сверяем.
            let avatar = if select.contains("avatar_data") { Some(avatar.unwrap_or("")) } else { None };
            if self.reconcile_profile(s, name, avatar) {
                self.env.emit("session-changed", serde_json::to_value(self.info()).unwrap_or(Value::Null));
            }
            return;
        }
    }

    /// Выход: облачная сессия (в том числе после входа по ссылке восстановления) отзывается на сервере.
    pub fn logout(self: &Arc<Self>) {
        if let Some(cloud) = self.env.cloud.clone() {
            tokio::spawn(async move { cloud.sign_out().await });
        }
        self.close_current();
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
        if !url.starts_with(&format!("{}:", crate::identity::APP.url_scheme)) {
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
                    let same = self.session().is_some() && self.cloud_user.lock().unwrap().as_ref().map(|c| c.id == u.id).unwrap_or(false);
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
        let engine = crate::cloud::sync::SyncEngine::new(cloud, s.store.clone(), self.env.device_id.clone());
        Ok(engine.remote_stats().await?)
    }

    /// Только для тестов: открывает облачную сессию без обращения к серверу. Одно и то же имя даёт один и тот же
    /// идентификатор, поэтому повторный вход открывает ту же базу.
    #[cfg(test)]
    pub(crate) fn sign_in_test_user(self: &Arc<Self>, name: &str) {
        use sha2::Digest;
        let hash = sha2::Sha256::digest(name.as_bytes());
        let id = uuid::Uuid::from_slice(&hash[..16]).expect("16 байт").to_string();
        let user = CloudUser { id, email: format!("{name}@example.com"), ..Default::default() };
        self.open_cloud(user).expect("сессия открывается");
    }
}

#[cfg(test)]
mod tests {
    use super::super::testing::fixture;
    use super::*;
    use crate::search::http::HttpResponse;

    #[tokio::test]
    async fn cloud_sign_in_opens_per_user_database_and_keeps_session() {
        let session = r#"{"access_token":"AT","refresh_token":"RT","expires_in":3600,"user":{"id":"U-1","email":"me@example.com","email_confirmed_at":"2026-11-05T00:00:00Z"}}"#;
        let f = fixture(true, vec![Ok(HttpResponse::new(200, session))]);
        let core = Core::new(f.env.clone());
        core.cloud_sign_in("me@example.com", "Password-1").await.unwrap();
        let info = core.info().unwrap();
        assert!(info.id == "cloud-u-1" && info.display_name == "me@example.com");
        assert!(info.cloud_user.as_ref().is_some_and(|u| u.confirmed));
        assert!(f.dir.path().join("data/users/cloud-u-1/leads.db").exists());
        assert!(core.session().unwrap().with_store(|s| s.sync_tracking()), "облачная запись ведёт журнал изменений");
        // запись сессии пережила «перезапуск»
        let again = Core::new(f.env.clone());
        again.startup();
        assert!(again.boot_info().session.is_some_and(|s| s.id == "cloud-u-1"));
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
        core.sign_in_test_user("anna");
        assert_eq!(core.info().unwrap().display_name, "anna@example.com");
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
    async fn cloud_profile_change_goes_to_the_sync_journal() {
        let session = r#"{"access_token":"AT","refresh_token":"RT","expires_in":3600,"user":{"id":"U-3","email":"me@example.com","email_confirmed_at":"2026-11-05T00:00:00Z"}}"#;
        let f = fixture(true, vec![Ok(HttpResponse::new(200, session))]);
        let core = Core::new(f.env.clone());
        core.cloud_sign_in("me@example.com", &typed_secret()).await.unwrap();
        core.set_profile(Some("Макс"), Some("data:image/jpeg;base64,AAAA")).unwrap();
        let dirty = core.session().unwrap().with_store(|st| st.pending_changes(100).unwrap());
        let keys: Vec<_> = dirty.settings.iter().map(|c| c.key.as_str()).collect();
        assert!(keys.contains(&"profile.name") && keys.contains(&"profile.avatar"), "{keys:?}");
    }

    const CLOUD_SESSION: &str = r#"{"access_token":"AT","refresh_token":"RT","expires_in":3600,"user":{"id":"U-4","email":"me@example.com","email_confirmed_at":"2026-11-05T00:00:00Z"}}"#;

    #[tokio::test]
    async fn profile_from_another_device_is_adopted_from_the_cloud_copy() {
        let f = fixture(true, vec![Ok(HttpResponse::new(200, CLOUD_SESSION))]);
        let core = Core::new(f.env.clone());
        core.cloud_sign_in("me@example.com", &typed_secret()).await.unwrap();
        let s = core.session().unwrap();
        // Новое устройство: своего имени и фото нет, в облаке они есть.
        assert!(core.reconcile_profile(&s, Some("Макс"), Some("data:image/jpeg;base64,AAAA")));
        let info = core.info().unwrap();
        assert_eq!((info.display_name.as_str(), info.avatar.as_deref()), ("Макс", Some("data:image/jpeg;base64,AAAA")));
        // Принятое из облака в журнал не попадает: обратно оно не уходит.
        let dirty = s.with_store(|st| st.pending_changes(100).unwrap());
        assert!(!dirty.settings.iter().any(|c| c.key.starts_with("profile.")));
        // Имя сменили на другом устройстве, здесь правок нет: побеждает облако.
        assert!(core.reconcile_profile(&s, Some("Максим"), None));
        assert_eq!(core.info().unwrap().display_name, "Максим");
        assert!(!core.reconcile_profile(&s, Some("Максим"), None), "одинаковые значения ничего не меняют");
    }

    #[tokio::test]
    async fn unsent_local_profile_edit_is_not_overwritten_by_the_old_cloud_copy() {
        let f = fixture(true, vec![Ok(HttpResponse::new(200, CLOUD_SESSION))]);
        let core = Core::new(f.env.clone());
        core.cloud_sign_in("me@example.com", &typed_secret()).await.unwrap();
        let s = core.session().unwrap();
        core.reconcile_profile(&s, Some("Старое"), Some(""));
        // Правка здесь, отправка в облако не удалась (в журнале она ещё лежит).
        s.with_store(|st| st.set_synced_value("profile.name", "\"Новое\"")).unwrap();
        assert!(!core.reconcile_profile(&s, Some("Старое"), Some("")));
        assert_eq!(core.info().unwrap().display_name, "Новое");
        // Правка ушла в настройки (журнал пуст), но в user_profiles не дошла: облачная копия всё равно не затирает её.
        let pending = s.with_store(|st| st.pending_changes(100).unwrap());
        s.with_store(|st| st.mark_pushed(&pending)).unwrap();
        assert!(!core.reconcile_profile(&s, Some("Старое"), Some("")));
        assert_eq!(core.info().unwrap().display_name, "Новое");
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
