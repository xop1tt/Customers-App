//! Интеграции открытой учётной записи: облачные диски, почта, звонки, экспорт в CRM.
//! Токены, пароли и вебхуки лежат только в защищённом хранилище (запись на пользователя и сервис).

use super::session::{Core, Session};
use super::{CmdError, CmdResult};
use crate::contact;
use crate::crm::{self, Bitrix24, CrmDestination, CrmKind, ExportLedger, NotionDestination, NotionProperty, WebhookDestination};
use crate::drives::{self, DriveAuth, DriveConnection, DriveService, OAuthClient, OAuthKey, OAuthProvider};
use crate::export::ExportField;
use crate::mail::{self, MailAccount, MailProvider, OutgoingMail};
use crate::prefs::AccountPrefs;
use crate::search::http::HttpRequest;
use crate::secrets;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

/// Что сейчас делают интеграции: у какого сервиса идёт вход или выгрузка, идёт ли отправка в CRM.
#[derive(Default)]
pub struct IntegrationState {
    pub busy: Option<DriveService>,
    pub cancel: Option<CancellationToken>,
    pub crm_cancel: Option<CancellationToken>,
    pub crm_running: bool,
}

// ------------------------------------------------------------------ диски

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveInfo {
    pub service: &'static str,
    pub title: &'static str,
    pub subtitle: &'static str,
    /// "oauth" или "webdav".
    pub kind: &'static str,
    pub provider: Option<&'static str>,
    pub connected: bool,
    pub connected_at: Option<String>,
    /// Для OAuth нужен ключ приложения (из сборки или введённый пользователем).
    pub available: bool,
    pub default_url: &'static str,
    pub password_page: Option<&'static str>,
    pub password_optional: bool,
    pub webdav_url: Option<String>,
    pub login: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub provider: &'static str,
    pub client_id_label: &'static str,
    pub console_page: &'static str,
    pub needs_secret: bool,
    pub build_variable: &'static str,
    /// Ключ вшит в сборку: менять и удалять его из приложения нельзя.
    pub built_in: bool,
    pub has_key: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrivesState {
    pub drives: Vec<DriveInfo>,
    pub providers: Vec<ProviderInfo>,
    pub redirect: String,
    pub busy: Option<&'static str>,
}

impl Core {
    fn connection(&self, s: &Session, service: DriveService) -> Option<DriveConnection> {
        DriveConnection::decode(secrets::get_or_empty(self.env.secrets.as_ref(), &service.secret_name(&s.id)).as_str().pipe_some())
    }

    fn save_connection(&self, s: &Session, c: &DriveConnection) -> CmdResult<()> {
        secrets::put(self.env.secrets.as_ref(), &c.service.secret_name(&s.id), &c.encoded())?;
        Ok(())
    }

    fn stored_key(&self, provider: OAuthProvider) -> Option<OAuthKey> {
        OAuthKey::decode(secrets::get_or_empty(self.env.secrets.as_ref(), &provider.secret_name()).as_str().pipe_some())
    }

    fn oauth_client(&self, provider: OAuthProvider) -> Option<OAuthClient> {
        OAuthClient::resolve(provider, self.stored_key(provider).as_ref())
    }

    pub fn drives_state(&self) -> CmdResult<DrivesState> {
        let s = self.require()?;
        let drives = DriveService::ALL
            .into_iter()
            .map(|d| {
                let c = self.connection(&s, d);
                let (kind, provider, available, default_url, password_page) = match d.auth() {
                    DriveAuth::OAuth(p) => ("oauth", Some(p.raw()), self.oauth_client(p).is_some(), "", None),
                    DriveAuth::Webdav { default_url, password_page } => ("webdav", None, true, default_url, password_page),
                };
                DriveInfo {
                    service: d.raw(),
                    title: d.title(),
                    subtitle: d.subtitle(),
                    kind,
                    provider,
                    connected: c.is_some(),
                    connected_at: c.as_ref().map(|c| crate::util::format_date(&c.connected_at)),
                    available,
                    default_url,
                    password_page,
                    password_optional: d.password_optional(),
                    webdav_url: c.as_ref().and_then(|c| c.webdav_url.clone()),
                    login: c.as_ref().and_then(|c| c.login.clone()),
                }
            })
            .collect();
        let providers = OAuthProvider::ALL
            .into_iter()
            .map(|p| ProviderInfo {
                provider: p.raw(),
                client_id_label: p.client_id_label(),
                console_page: p.console_page(),
                needs_secret: p.needs_client_secret(),
                build_variable: p.build_variable(),
                built_in: OAuthClient::from_build(p).is_some(),
                has_key: self.stored_key(p).is_some(),
            })
            .collect();
        let busy = self.integ.lock().unwrap().busy.map(DriveService::raw);
        Ok(DrivesState { drives, providers, redirect: drives::redirect::uri(), busy })
    }

    fn drives_changed(&self) {
        self.env.emit("integrations-changed", Value::Null);
    }

    /// Сохраняет ключ приложения, введённый пользователем.
    pub fn save_oauth_key(&self, provider: &str, client_id: &str, client_secret: Option<&str>) -> CmdResult<()> {
        let p = OAuthProvider::parse(provider).ok_or("Неизвестный сервис")?;
        let key =
            OAuthKey { client_id: client_id.trim().into(), client_secret: client_secret.map(|s| s.trim().to_string()).filter(|_| p.needs_client_secret()) };
        if let Some(problem) = key.problem(p) {
            return Err(CmdError::msg(problem));
        }
        self.env.secrets.set(&p.secret_name(), &key.encoded()).map_err(|_| CmdError::msg("Не удалось сохранить ключ в защищённом хранилище"))?;
        self.drives_changed();
        Ok(())
    }

    /// Удаляет введённый ключ и подключения, сделанные с ним: токены без ключа бесполезны.
    pub fn remove_oauth_key(&self, provider: &str) -> CmdResult<()> {
        let s = self.require()?;
        let p = OAuthProvider::parse(provider).ok_or("Неизвестный сервис")?;
        let _ = self.env.secrets.delete(&p.secret_name());
        for d in DriveService::ALL {
            if d.auth() == DriveAuth::OAuth(p) {
                let _ = self.env.secrets.delete(&d.secret_name(&s.id));
            }
        }
        self.drives_changed();
        Ok(())
    }

    pub fn disconnect_drive(&self, service: &str) -> CmdResult<()> {
        let s = self.require()?;
        let d = DriveService::parse(service).ok_or("Неизвестный сервис")?;
        let _ = self.env.secrets.delete(&d.secret_name(&s.id));
        self.drives_changed();
        Ok(())
    }

    /// Отмена входа: сервер возврата закрывается, порт освобождается.
    pub fn cancel_integration(&self) {
        if let Some(c) = self.integ.lock().unwrap().cancel.take() {
            c.cancel();
        }
    }

    fn begin_drive(&self, service: DriveService) -> CmdResult<CancellationToken> {
        let mut st = self.integ.lock().unwrap();
        if st.busy.is_some() {
            return Err(CmdError::msg("Дождитесь окончания текущего действия."));
        }
        let token = CancellationToken::new();
        st.busy = Some(service);
        st.cancel = Some(token.clone());
        drop(st);
        self.drives_changed();
        Ok(token)
    }

    fn end_drive(&self) {
        let mut st = self.integ.lock().unwrap();
        st.busy = None;
        st.cancel = None;
        drop(st);
        self.drives_changed();
    }

    /// Вход через браузер (OAuth + PKCE).
    pub async fn connect_oauth(self: &Arc<Self>, service: &str) -> CmdResult<String> {
        let s = self.require()?;
        let d = DriveService::parse(service).ok_or("Неизвестный сервис")?;
        let DriveAuth::OAuth(provider) = d.auth() else {
            return Err(CmdError::msg("Для этого сервиса вход через браузер не нужен."));
        };
        let client = self.oauth_client(provider).ok_or_else(|| CmdError::msg(drives::IntegrationError::NotConfigured(provider).to_string()))?;
        let cancel = self.begin_drive(d)?;
        let opener = self.env.opener.clone();
        let open = move |url: &str| opener.open_url(url);
        let result = drives::connect_oauth(&client, &open, self.env.transport.as_ref(), &cancel).await;
        self.end_drive();
        let token = result.map_err(|e| CmdError::msg(format!("{}: {e}", d.title())))?;
        let mut c = DriveConnection::new(d);
        c.token = Some(token);
        self.save_connection(&s, &c)?;
        self.drives_changed();
        Ok(format!("{} подключён", d.title()))
    }

    /// Проверяет адрес и пароль запросом PROPFIND и сохраняет подключение.
    pub async fn connect_webdav(&self, service: &str, url: &str, login: &str, password: &str) -> CmdResult<String> {
        let s = self.require()?;
        let d = DriveService::parse(service).ok_or("Неизвестный сервис")?;
        let _guard = self.begin_drive(d)?;
        let result = async {
            let base = drives::webdav_base(url).map_err(|e| e.to_string())?;
            let mut headers = vec![("Depth".to_string(), "0".to_string())];
            if !login.is_empty() {
                headers.push(("Authorization".into(), drives::basic_auth(login, password)));
            }
            let r = self
                .env
                .transport
                .send(HttpRequest { method: "PROPFIND".into(), url: base.clone(), headers, body: None, timeout: 20.0 })
                .await
                .map_err(|e| e.message())?;
            match r.status {
                401 | 403 => Err("неверный логин или пароль приложения".to_string()),
                200..=299 => Ok(base),
                code => Err(drives::IntegrationError::Http(code, String::from_utf8_lossy(&r.data[..r.data.len().min(200)]).trim().to_string()).to_string()),
            }
        }
        .await;
        self.end_drive();
        let base = result.map_err(|e| CmdError::msg(format!("{}: {e}", d.title())))?;
        let mut c = DriveConnection::new(d);
        c.webdav_url = Some(base);
        c.login = Some(login.to_string());
        c.password = Some(password.to_string());
        self.save_connection(&s, &c)?;
        self.drives_changed();
        Ok(format!("{} подключён", d.title()))
    }

    /// Выгружает файл (копию базы) на диск. OAuth-токен при необходимости обновляется.
    pub async fn upload_to_drive(&self, service: &str, path: &Path) -> CmdResult<String> {
        let data = std::fs::read(path).map_err(|e| CmdError::msg(format!("Не удалось прочитать файл: {e}")))?;
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "backup.db".into());
        self.upload_data_to_drive(service, &name, &data).await
    }

    /// Выгружает данные файлом `name` на диск (копию базы или переносимую копию).
    pub async fn upload_data_to_drive(&self, service: &str, name: &str, data: &[u8]) -> CmdResult<String> {
        let s = self.require()?;
        let d = DriveService::parse(service).ok_or("Неизвестный сервис")?;
        let conn = self.connection(&s, d).ok_or_else(|| CmdError::msg(format!("{} не подключён", d.title())))?;
        let _guard = self.begin_drive(d)?;
        let client = match d.auth() {
            DriveAuth::OAuth(p) => self.oauth_client(p),
            _ => None,
        };
        let result = drives::upload_file(&conn, client.as_ref(), name, data, self.env.transport.as_ref()).await;
        self.end_drive();
        let updated = result.map_err(|e| CmdError::msg(format!("{}: {e}", d.title())))?;
        if updated.token != conn.token {
            self.save_connection(&s, &updated)?;
        }
        Ok(format!("Копия «{name}» выгружена в {}", d.title()))
    }

    // ------------------------------------------------------------------ почта

    fn mail_account_of(prefs: &AccountPrefs) -> Option<MailAccount> {
        MailAccount::decode(Some(prefs.mail_account.as_str()).filter(|t| !t.is_empty()))
    }

    fn mail_password_name(s: &Session) -> String {
        format!("mail.password.{}", s.key())
    }

    pub fn mail_providers(&self) -> Value {
        MailProvider::ALL
            .into_iter()
            .map(|p| json!({"id": p, "title": p.title(), "host": p.host(), "port": p.port(), "security": p.security(), "passwordPage": p.app_password_page(), "hint": p.hint()}))
            .collect()
    }

    pub fn mail_preset(&self, email: &str, name: &str) -> Value {
        serde_json::to_value(MailAccount::preset(email, name)).unwrap_or(Value::Null)
    }

    pub fn mail_state(&self) -> CmdResult<Value> {
        let s = self.require()?;
        let prefs = s.account_prefs();
        let account = Self::mail_account_of(&prefs);
        let has_password = !secrets::get_or_empty(self.env.secrets.as_ref(), &Self::mail_password_name(&s)).is_empty();
        let smtp_ready = prefs.mail_delivery == "smtp" && account.as_ref().map(|a| a.problem().is_none()).unwrap_or(false) && has_password;
        Ok(json!({"account": account, "delivery": prefs.mail_delivery, "hasPassword": has_password, "smtpReady": smtp_ready, "signature": prefs.signature}))
    }

    /// Сохраняет настройки ящика. Пароль: `None` — не менять, пустая строка — удалить.
    pub fn mail_save(self: &Arc<Self>, account: Option<MailAccount>, delivery: &str, password: Option<&str>) -> CmdResult<()> {
        let s = self.require()?;
        if let Some(a) = &account {
            if delivery == "smtp" {
                if let Some(p) = a.problem() {
                    return Err(CmdError::msg(p));
                }
            }
        }
        if let Some(p) = password {
            secrets::put(self.env.secrets.as_ref(), &Self::mail_password_name(&s), p)?;
        }
        self.patch_account_prefs(&json!({"mailAccount": account.map(|a| a.encoded()).unwrap_or_default(), "mailDelivery": delivery}))?;
        Ok(())
    }

    pub fn mail_forget(self: &Arc<Self>) -> CmdResult<()> {
        let s = self.require()?;
        let _ = self.env.secrets.delete(&Self::mail_password_name(&s));
        self.patch_account_prefs(&json!({"mailAccount": "", "mailDelivery": "mailApp"}))?;
        Ok(())
    }

    /// Отправка по SMTP. В «Историю» лида записывается событие.
    pub async fn mail_send(self: &Arc<Self>, mail: OutgoingMail, lead_id: Option<&str>) -> CmdResult<String> {
        let s = self.require()?;
        let prefs = s.account_prefs();
        let account = Self::mail_account_of(&prefs).ok_or("Почта не настроена: Настройки → Обращения")?;
        let password = secrets::get_or_empty(self.env.secrets.as_ref(), &Self::mail_password_name(&s));
        if password.is_empty() {
            return Err(CmdError::msg(mail::MailError::NoPassword.to_string()));
        }
        mail::send_via_smtp(&mail, &account, &password).await.map_err(|e| CmdError::msg(e.to_string()))?;
        if let Some(id) = lead_id {
            let _ = self.log_event(id, &format!("Письмо отправлено на {}", mail.to));
        }
        Ok(format!("Письмо отправлено на {}", mail.to))
    }

    /// Проверочное письмо самому себе.
    pub async fn mail_test(self: &Arc<Self>) -> CmdResult<String> {
        let s = self.require()?;
        let account = Self::mail_account_of(&s.account_prefs()).ok_or("Почта не настроена")?;
        let to = account.from_address.clone();
        self.mail_send(
            OutgoingMail {
                to: to.clone(),
                subject: "Проверка почты Customers".into(),
                body: "Это проверочное письмо: отправка из Customers настроена.".into(),
            },
            None,
        )
        .await?;
        Ok(format!("Проверочное письмо отправлено на {to}"))
    }

    /// Открывает письмо в почтовой программе по умолчанию: она сама сохранит его в «Отправленных».
    pub fn open_in_mail_app(self: &Arc<Self>, mail: &OutgoingMail, lead_id: Option<&str>) -> CmdResult<()> {
        let url = contact::mailto_url(&mail.to, &mail.subject, &mail.body).ok_or("Неверный адрес получателя")?;
        self.env.opener.open_url(&url).map_err(CmdError::msg)?;
        if let Some(id) = lead_id {
            let _ = self.log_event(id, &format!("Письмо открыто для {}", mail.to));
        }
        Ok(())
    }

    /// Звонок: открывает tel: в программе по умолчанию и записывает событие в «Историю».
    pub fn call(self: &Arc<Self>, phone: &str, lead_id: Option<&str>) -> CmdResult<()> {
        let app = self.session().map(|s| s.account_prefs().call_app).unwrap_or_default();
        let url = contact::call_url(&app, phone).ok_or("Не похоже на номер телефона")?;
        self.env
            .opener
            .open_url(&url)
            .map_err(|e| CmdError::msg(format!("{e}. Если программа не установлена, выберите другую в настройках: Способы связи → Звонки.")))?;
        if let Some(id) = lead_id {
            let _ = self.log_event(id, &format!("Звонок {phone}"));
        }
        Ok(())
    }

    // ------------------------------------------------------------------ экспорт в CRM

    fn crm_secret_name(kind: CrmKind, s: &Session) -> String {
        format!("{}.{}", kind.secret_name(), s.key())
    }

    fn crm_secret(&self, s: &Session, kind: CrmKind) -> Option<String> {
        Some(secrets::get_or_empty(self.env.secrets.as_ref(), &Self::crm_secret_name(kind, s))).filter(|v| !v.is_empty())
    }

    fn notion_link(&self, s: &Session) -> Option<NotionLink> {
        s.with_store(|st| st.value("export.notion")).and_then(|t| NotionLink::decode(&t))
    }

    pub fn crm_state(&self) -> CmdResult<Value> {
        let s = self.require()?;
        let bitrix = self.crm_secret(&s, CrmKind::Bitrix).and_then(|w| Bitrix24::new(&w).ok()).map(|d| d.target());
        let webhook = self.crm_secret(&s, CrmKind::Webhook).and_then(|w| WebhookDestination::new(&w).ok()).map(|d| d.target());
        let notion_connected = self.crm_secret(&s, CrmKind::Notion).is_some();
        let notion = match (notion_connected, self.notion_link(&s)) {
            (true, Some(l)) => {
                let props: Vec<Value> =
                    l.properties.iter().map(|p| json!({"name": p.name, "type": p.kind, "typeTitle": p.type_title(), "writable": p.is_writable()})).collect();
                let mapping: BTreeMap<&String, &'static str> = l.mapping.iter().map(|(k, f)| (k, f.key())).collect();
                let has_title = l.properties.iter().any(|p| p.kind == "title" && l.mapping.contains_key(&p.name));
                json!({"connected": true, "title": l.title, "database": l.database, "properties": props, "mapping": mapping, "hasTitle": has_title})
            }
            _ => json!({"connected": false}),
        };
        Ok(json!({
            "bitrix": {"connected": bitrix.is_some(), "target": bitrix},
            "webhook": {"connected": webhook.is_some(), "target": webhook},
            "notion": notion,
            "lastTab": s.account_prefs().export_last_tab,
        }))
    }

    /// Сколько из выбранных лидов уже отправлено в это назначение (для флажка «Отправить повторно»).
    pub fn crm_sent_count(&self, kind: &str, ids: &[String]) -> CmdResult<usize> {
        let s = self.require()?;
        let k = CrmKind::parse(kind).ok_or("Неизвестное назначение")?;
        let dest = self.destination(&s, k)?;
        let key = ExportLedger::storage_key(k, &dest.target());
        let ledger = ExportLedger::decode(s.with_store(|st| st.value(&key)).as_deref());
        Ok(ids.iter().filter(|id| ledger.sent.contains_key(*id)).count())
    }

    pub async fn connect_bitrix(&self, webhook: &str) -> CmdResult<()> {
        let s = self.require()?;
        let d = Bitrix24::new(webhook).map_err(|e| CmdError::msg(e.to_string()))?;
        d.check(self.env.transport.as_ref()).await.map_err(|e| CmdError::msg(e.to_string()))?;
        secrets::put(self.env.secrets.as_ref(), &Self::crm_secret_name(CrmKind::Bitrix, &s), &d.base)?;
        self.env.emit("crm-changed", Value::Null);
        Ok(())
    }

    pub fn connect_webhook(&self, url: &str) -> CmdResult<()> {
        let s = self.require()?;
        let d = WebhookDestination::new(url).map_err(|e| CmdError::msg(e.to_string()))?;
        secrets::put(self.env.secrets.as_ref(), &Self::crm_secret_name(CrmKind::Webhook, &s), &d.url)?;
        self.env.emit("crm-changed", Value::Null);
        Ok(())
    }

    pub fn disconnect_crm(&self, kind: &str) -> CmdResult<()> {
        let s = self.require()?;
        let k = CrmKind::parse(kind).ok_or("Неизвестное назначение")?;
        let _ = self.env.secrets.delete(&Self::crm_secret_name(k, &s));
        if k == CrmKind::Notion {
            let _ = s.with_store(|st| st.delete_value("export.notion"));
        }
        self.env.emit("crm-changed", Value::Null);
        Ok(())
    }

    /// Подключает базу Notion; сопоставление полей — автоматическое или прежнее (по имени свойства).
    pub async fn connect_notion(&self, token: &str, database: &str, keep_mapping: bool) -> CmdResult<()> {
        let s = self.require()?;
        let id = NotionDestination::database_id_from(database).map_err(|e| CmdError::msg(e.to_string()))?;
        let token = token.trim();
        let db = NotionDestination::fetch_database(token, &id, self.env.transport.as_ref()).await.map_err(|e| CmdError::msg(e.to_string()))?;
        let mut mapping = NotionDestination::auto_mapping(&db.properties);
        if keep_mapping {
            if let Some(old) = self.notion_link(&s) {
                let names: std::collections::HashSet<&str> = db.properties.iter().map(|p| p.name.as_str()).collect();
                mapping = old.mapping.into_iter().filter(|(k, _)| names.contains(k.as_str())).collect();
            }
        }
        let link = NotionLink { database: db.id.clone(), title: db.title.clone(), properties: db.properties.clone(), mapping };
        secrets::put(self.env.secrets.as_ref(), &Self::crm_secret_name(CrmKind::Notion, &s), token)?;
        s.with_store(|st| st.set_value("export.notion", &link.encoded()))?;
        self.env.emit("crm-changed", Value::Null);
        Ok(())
    }

    /// Обновляет схему базы Notion (после правок в Notion или после переноса настройки из другой версии).
    pub async fn refresh_notion(&self) -> CmdResult<()> {
        let s = self.require()?;
        let token = self.crm_secret(&s, CrmKind::Notion).ok_or("Notion не подключён")?;
        let link = self.notion_link(&s).ok_or("Notion не подключён")?;
        self.connect_notion(&token, &link.database, true).await
    }

    pub fn set_notion_mapping(&self, mapping: BTreeMap<String, String>) -> CmdResult<()> {
        let s = self.require()?;
        let mut link = self.notion_link(&s).ok_or("Notion не подключён")?;
        link.mapping = mapping.into_iter().filter_map(|(k, v)| ExportField::from_key(&v).map(|f| (k, f))).collect();
        s.with_store(|st| st.set_value("export.notion", &link.encoded()))?;
        self.env.emit("crm-changed", Value::Null);
        Ok(())
    }

    fn destination(&self, s: &Session, kind: CrmKind) -> CmdResult<Arc<dyn CrmDestination>> {
        let secret = self.crm_secret(s, kind).ok_or_else(|| CmdError::msg(format!("{} не подключён", kind.title())))?;
        let err = |e: crm::CrmError| CmdError::msg(e.to_string());
        Ok(match kind {
            CrmKind::Bitrix => crm::arc_dest(Bitrix24::new(&secret).map_err(err)?),
            CrmKind::Webhook => crm::arc_dest(WebhookDestination::new(&secret).map_err(err)?),
            CrmKind::Notion => {
                let link = self.notion_link(s).ok_or("Notion не настроен")?;
                crm::arc_dest(NotionDestination::new(&secret, &link.database, link.properties.clone(), link.mapping.clone()))
            }
        })
    }

    pub fn cancel_crm(&self) {
        if let Some(c) = self.integ.lock().unwrap().crm_cancel.take() {
            c.cancel();
        }
    }

    /// Отправка лидов в CRM. Журнал отправленного сохраняется и после отмены: отправленное уже лежит в CRM.
    pub async fn export_to_crm(self: &Arc<Self>, kind: &str, ids: &[String], resend: bool) -> CmdResult<Value> {
        let s = self.require()?;
        let k = CrmKind::parse(kind).ok_or("Неизвестное назначение")?;
        let dest = self.destination(&s, k)?;
        let cancel = {
            let mut st = self.integ.lock().unwrap();
            if st.crm_running {
                return Err(CmdError::msg("Отправка уже идёт."));
            }
            st.crm_running = true;
            let c = CancellationToken::new();
            st.crm_cancel = Some(c.clone());
            c
        };
        let all = s.with_store(|st| st.all_leads(false))?;
        let order: std::collections::HashMap<&String, usize> = ids.iter().enumerate().map(|(i, id)| (id, i)).collect();
        let mut items: Vec<_> = all.into_iter().filter(|l| order.contains_key(&l.id)).collect();
        items.sort_by_key(|l| order[&l.id]);
        let ledger_key = ExportLedger::storage_key(k, &dest.target());
        let ledger = ExportLedger::decode(s.with_store(|st| st.value(&ledger_key)).as_deref());
        let env = self.env.clone();
        let progress = move |done: usize, total: usize| env.emit("crm-progress", json!({"done": done, "total": total}));
        let (report, ledger) = crm::run_export(&items, dest.as_ref(), ledger, resend, self.env.transport.as_ref(), &self.env.sleeper, &cancel, &progress).await;
        let _ = s.with_store(|st| st.set_value(&ledger_key, &ledger.encoded()));
        {
            let mut st = self.integ.lock().unwrap();
            st.crm_running = false;
            st.crm_cancel = None;
        }
        if let Some(f) = report.failures.first() {
            self.env.log_error(&format!("{}: {}", k.title(), f.message));
        }
        Ok(json!({"report": report, "summary": report.summary()}))
    }
}

/// Вспомогательное: пустая строка → None.
trait PipeSome {
    fn pipe_some(&self) -> Option<&str>;
}
impl PipeSome for str {
    fn pipe_some(&self) -> Option<&str> {
        (!self.is_empty()).then_some(self)
    }
}

/// Настройка Notion в базе пользователя: база, её свойства и сопоставление «свойство → поле лида».
/// Читается и в формате Windows-версии (`database` + `mapping` с именами полей без схемы базы).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NotionLink {
    pub database: String,
    pub title: String,
    pub properties: Vec<NotionProperty>,
    pub mapping: BTreeMap<String, ExportField>,
}

impl NotionLink {
    pub fn encoded(&self) -> String {
        let mapping: BTreeMap<&String, &'static str> = self.mapping.iter().map(|(k, f)| (k, f.key())).collect();
        serde_json::to_string(&json!({"database": self.database, "title": self.title, "properties": self.properties, "mapping": mapping})).unwrap_or_default()
    }

    pub fn decode(text: &str) -> Option<Self> {
        #[derive(Deserialize)]
        struct Raw {
            #[serde(alias = "databaseID", alias = "databaseId", default)]
            database: String,
            #[serde(default)]
            title: String,
            #[serde(default)]
            properties: Vec<NotionProperty>,
            #[serde(default)]
            mapping: BTreeMap<String, String>,
        }
        let r: Raw = serde_json::from_str(text).ok()?;
        if r.database.is_empty() {
            return None;
        }
        // Поля: ключ экспорта (title) или имя варианта Windows-версии (Title, CustomerName).
        let field =
            |name: &str| ExportField::from_key(name).or_else(|| ExportField::ALL.iter().copied().find(|f| f.key().to_lowercase() == name.to_lowercase()));
        Some(Self {
            database: r.database,
            title: r.title,
            properties: r.properties,
            mapping: r.mapping.into_iter().filter_map(|(k, v)| field(&v).map(|f| (k, f))).collect(),
        })
    }
}

#[allow(dead_code)]
fn _unused(_: Mutex<()>) {}

#[cfg(test)]
mod tests {
    use super::super::testing::fixture;
    use super::*;
    use crate::search::http::HttpResponse;

    fn signed_in(f: &super::super::testing::Fixture) -> Arc<Core> {
        let core = Core::new(f.env.clone());
        core.sign_in_test_user("anna");
        core
    }

    #[tokio::test]
    async fn webdav_drive_connects_and_uploads_a_backup() {
        let f = fixture(false, vec![Ok(HttpResponse::new(207, "")), Ok(HttpResponse::new(201, "")), Ok(HttpResponse::new(201, ""))]);
        let core = signed_in(&f);
        assert!(core.drives_state().unwrap().drives.iter().all(|d| !d.connected));
        let msg = core.connect_webdav("webdav", "https://cloud.example/dav", "anna", "pw").await.unwrap();
        assert!(msg.contains("WebDAV"));
        let st = core.drives_state().unwrap();
        let d = st.drives.iter().find(|d| d.service == "webdav").unwrap();
        assert!(d.connected && d.login.as_deref() == Some("anna") && d.webdav_url.as_deref() == Some("https://cloud.example/dav/"));
        assert_eq!(f.transport.requests.lock().unwrap()[0].method, "PROPFIND");
        let file = f.dir.path().join("leadgen-2026-11-08_10-00-00.db");
        std::fs::write(&file, b"DATA").unwrap();
        let done = core.upload_to_drive("webdav", &file).await.unwrap();
        assert!(done.contains("leadgen-2026-11-08_10-00-00.db"));
        assert_eq!(f.transport.requests.lock().unwrap().last().unwrap().method, "PUT");
        core.disconnect_drive("webdav").unwrap();
        assert!(!core.drives_state().unwrap().drives.iter().find(|d| d.service == "webdav").unwrap().connected);
    }

    #[tokio::test]
    async fn webdav_rejects_bad_credentials_and_insecure_addresses() {
        let f = fixture(false, vec![Ok(HttpResponse::new(401, ""))]);
        let core = signed_in(&f);
        let e = core.connect_webdav("webdav", "https://cloud.example/dav", "anna", "bad").await.unwrap_err();
        assert!(e.message.contains("неверный логин или пароль"));
        let e = core.connect_webdav("webdav", "http://cloud.example/dav", "anna", "pw").await.unwrap_err();
        assert!(e.message.contains("Неверный адрес сервера"));
        assert!(core.drives_state().unwrap().busy.is_none(), "после ошибки сервис свободен");
    }

    #[tokio::test]
    async fn oauth_drive_needs_a_key_which_can_be_added_and_removed() {
        let f = fixture(false, vec![]);
        let core = signed_in(&f);
        let state = core.drives_state().unwrap();
        let google = state.drives.iter().find(|d| d.service == "googleDrive").unwrap();
        assert_eq!((google.kind, google.provider, google.available), ("oauth", Some("google"), false));
        assert!(core.connect_oauth("googleDrive").await.unwrap_err().message.contains("GOOGLE_OAUTH_CLIENT_ID"));
        assert!(core.save_oauth_key("google", "id", None).is_err(), "Google требует secret");
        core.save_oauth_key("google", " my-id ", Some(" my-secret ")).unwrap();
        let state = core.drives_state().unwrap();
        assert!(state.drives.iter().find(|d| d.service == "googleDrive").unwrap().available);
        assert!(state.providers.iter().find(|p| p.provider == "google").unwrap().has_key);
        core.remove_oauth_key("google").unwrap();
        assert!(!core.drives_state().unwrap().drives.iter().find(|d| d.service == "googleDrive").unwrap().available);
    }

    #[tokio::test]
    async fn mail_settings_password_and_send_checks() {
        let f = fixture(false, vec![]);
        let core = signed_in(&f);
        assert_eq!(core.mail_state().unwrap()["delivery"], "mailApp");
        let account = MailAccount::preset("anna@yandex.ru", "Анна");
        assert_eq!(account.host, "smtp.yandex.ru");
        core.mail_save(Some(account), "smtp", Some("app-password")).unwrap();
        let st = core.mail_state().unwrap();
        assert_eq!((st["hasPassword"].clone(), st["smtpReady"].clone(), st["delivery"].clone()), (json!(true), json!(true), json!("smtp")));
        assert_eq!(core.mail_providers().as_array().unwrap().len(), 5);
        core.mail_forget().unwrap();
        let st = core.mail_state().unwrap();
        assert_eq!((st["hasPassword"].clone(), st["account"].clone()), (json!(false), Value::Null));
        let e = core.mail_send(OutgoingMail { to: "x@y.ru".into(), subject: "s".into(), body: "b".into() }, None).await.unwrap_err();
        assert!(e.message.contains("Почта не настроена"));
        // неполные настройки SMTP не сохраняются
        let mut bad = MailAccount::preset("anna@yandex.ru", "Анна");
        bad.host = String::new();
        assert!(core.mail_save(Some(bad), "smtp", None).is_err());
    }

    #[tokio::test]
    async fn call_and_mail_app_open_links_and_write_history() {
        let f = fixture(false, vec![]);
        let core = signed_in(&f);
        let s = core.session().unwrap();
        let mut d = crate::models::LeadData::new(crate::models::LeadKind::Order, "fl_ru", "1", "Заказ");
        d.phone = Some("+7 999 111-22-33".into());
        let id = crate::search::text::lead_id(&d.source, &d.external_id);
        s.with_store(|st| st.save(&d, &id, &crate::search::text::fingerprint(&d))).unwrap();
        core.call("+7 999 111-22-33", Some(&id)).unwrap();
        core.open_in_mail_app(&OutgoingMail { to: "a@b.ru".into(), subject: "Тема".into(), body: "Текст".into() }, Some(&id)).unwrap();
        let opened = f.opener.0.lock().unwrap().clone();
        assert_eq!(opened[0], "tel:+79991112233");
        assert!(opened[1].starts_with("mailto:a@b.ru?"));
        let log = core.events(&id).unwrap().to_string();
        assert!(log.contains("Звонок +7 999 111-22-33") && log.contains("Письмо открыто для a@b.ru"), "{log}");
        assert!(core.call("abc", None).is_err());
    }

    #[tokio::test]
    async fn webhook_export_uses_ledger_and_reports() {
        let f = fixture(false, vec![Ok(HttpResponse::new(200, r#"{"id":"r1"}"#)), Ok(HttpResponse::new(200, r#"{"id":"r2"}"#))]);
        let core = signed_in(&f);
        let s = core.session().unwrap();
        let mut ids = vec![];
        for i in 1..=2 {
            let d = crate::models::LeadData::new(crate::models::LeadKind::Order, "fl_ru", &format!("{i}"), &format!("Заказ {i}"));
            let id = crate::search::text::lead_id(&d.source, &d.external_id);
            s.with_store(|st| st.save(&d, &id, &crate::search::text::fingerprint(&d))).unwrap();
            ids.push(id);
        }
        assert!(core.export_to_crm("webhook", &ids, false).await.is_err(), "не подключён");
        assert!(core.connect_webhook("http://insecure.example/hook").is_err());
        core.connect_webhook("https://hook.example/abc").unwrap();
        assert_eq!(core.crm_state().unwrap()["webhook"]["connected"], true);
        let r = core.export_to_crm("webhook", &ids, false).await.unwrap();
        assert_eq!(r["report"]["exported"], 2);
        assert!(f.events.count("crm-progress") >= 1);
        let again = core.export_to_crm("webhook", &ids, false).await.unwrap();
        assert_eq!((again["report"]["exported"].clone(), again["report"]["skipped"].clone()), (json!(0), json!(2)), "повторно отправленное пропускается");
        core.disconnect_crm("webhook").unwrap();
        assert_eq!(core.crm_state().unwrap()["webhook"]["connected"], false);
    }

    #[test]
    fn notion_link_reads_windows_and_own_formats() {
        let win = NotionLink::decode(r#"{"database":"0123","mapping":{"Name":"Title","Телефон":"Phone","X":"Нет такого"}}"#).unwrap();
        assert_eq!(win.database, "0123");
        assert_eq!(win.mapping.get("Name"), Some(&ExportField::Title));
        assert_eq!(win.mapping.get("Телефон"), Some(&ExportField::Phone));
        assert!(!win.mapping.contains_key("X"));
        let own = NotionLink {
            database: "db".into(),
            title: "Лиды".into(),
            properties: vec![NotionProperty { name: "Name".into(), kind: "title".into() }],
            mapping: [("Name".to_string(), ExportField::Title)].into(),
        };
        assert_eq!(NotionLink::decode(&own.encoded()), Some(own));
        assert!(NotionLink::decode("{}").is_none() && NotionLink::decode("не json").is_none());
    }
}
