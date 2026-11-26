//! Команды, которые вызывает интерфейс. Здесь нет логики: каждая команда вызывает метод `Core`.

use crate::app::session::{Core, SessionInfo};
use crate::app::{system, CmdError, CmdResult};
use crate::mail::{MailAccount, OutgoingMail};
use crate::{reports, updates};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

type C<'a> = State<'a, Arc<Core>>;

fn to_value<T: serde::Serialize>(v: T) -> CmdResult<Value> {
    serde_json::to_value(v).map_err(|e| CmdError::msg(e.to_string()))
}

macro_rules! sync_cmds {
    ($($name:ident($($arg:ident: $ty:ty),*) -> $ret:ty = $body:expr;)*) => {$(
        #[tauri::command]
        pub fn $name(core: C<'_>, $($arg: $ty),*) -> CmdResult<$ret> {
            let core: &Arc<Core> = core.inner();
            ($body)(core, $($arg),*)
        }
    )*};
}

// ---------------------------------------------------------------- запуск и сессия

sync_cmds! {
    boot_info() -> Value = |c: &Arc<Core>| to_value(c.boot_info());
}

#[tauri::command]
pub fn set_profile(core: C<'_>, name: Option<String>, avatar: Option<String>) -> CmdResult<SessionInfo> {
    core.inner().set_profile(name.as_deref(), avatar.as_deref())
}

// ---------------------------------------------------------------- данные

sync_cmds! {
    snapshot() -> Value = |c: &Arc<Core>| to_value(c.snapshot()?);
    lead_events(id: String) -> Value = |c: &Arc<Core>, id: String| c.events(&id);
    set_favorite(ids: Vec<String>, on: bool) -> () = |c: &Arc<Core>, ids: Vec<String>, on: bool| c.set_favorite(&ids, on);
    set_archived(ids: Vec<String>, on: bool) -> () = |c: &Arc<Core>, ids: Vec<String>, on: bool| c.set_archived(&ids, on);
    delete_leads(ids: Vec<String>) -> () = |c: &Arc<Core>, ids: Vec<String>| c.delete_leads(&ids);
    mark_seen(ids: Vec<String>) -> () = |c: &Arc<Core>, ids: Vec<String>| c.mark_seen(&ids);
    mark_all_seen() -> () = |c: &Arc<Core>| c.mark_all_seen();
    set_note(id: String, note: String) -> () = |c: &Arc<Core>, id: String, note: String| c.set_note(&id, &note);
    log_event(id: String, action: String) -> () = |c: &Arc<Core>, id: String, a: String| c.log_event(&id, &a);
    exclude(value: String, kind: Option<String>) -> String = |c: &Arc<Core>, v: String, k: Option<String>| c.exclude(&v, k.as_deref());
    remove_exclusion(id: i64) -> () = |c: &Arc<Core>, id: i64| c.remove_exclusion(id);
    import_exclusions(path: String) -> String = |c: &Arc<Core>, p: String| c.import_exclusions(&PathBuf::from(p));
    export_to_file(ids: Vec<String>, format: String, fields: Vec<String>, path: String) -> String = |c: &Arc<Core>, ids: Vec<String>, f: String, fields: Vec<String>, p: String| c.export_to_file(&ids, &f, &fields, &PathBuf::from(p));
    list_backups() -> Vec<Value> = |c: &Arc<Core>| c.list_backups();
    backup_now() -> String = |c: &Arc<Core>| c.backup_now_command();
    restore_backup(path: String) -> String = |c: &Arc<Core>, p: String| c.restore(&PathBuf::from(p));
    portable_state() -> Value = |c: &Arc<Core>| c.portable_state();
    create_portable_key(replace: bool) -> String = |c: &Arc<Core>, r: bool| c.create_portable_key(r);
    export_portable(path: String) -> String = |c: &Arc<Core>, p: String| c.export_portable(&PathBuf::from(p));
    import_portable(path: String, key: String) -> String = |c: &Arc<Core>, p: String, k: String| c.import_portable(&PathBuf::from(p), &k);
    move_database(dir: String) -> String = |c: &Arc<Core>, d: String| c.move_database(&PathBuf::from(d));
    account_prefs() -> Value = |c: &Arc<Core>| c.account_prefs();
    patch_account_prefs(changes: Value) -> Value = |c: &Arc<Core>, ch: Value| c.patch_account_prefs(&ch);
    export_fields() -> Value = |_c: &Arc<Core>| Ok(crate::export::fields_for_ui());
}

// ---------------------------------------------------------------- устройство

#[tauri::command]
pub fn device_prefs(core: C<'_>) -> Value {
    core.env.device.lock().unwrap().to_json()
}

#[tauri::command]
pub fn patch_device_prefs(core: C<'_>, app: tauri::AppHandle, changes: Value) -> Value {
    core.env.patch_device(&changes);
    crate::shell::apply_device_changes(&app, &core, &changes);
    core.env.device.lock().unwrap().to_json()
}

/// Язык интерфейса (после выбора пользователя или по языку системы): меню значка в строке меню подстраивается.
#[tauri::command]
pub fn set_ui_language(app: tauri::AppHandle, language: String) {
    crate::shell::set_ui_language(&app, &language);
}

// ---------------------------------------------------------------- поиск

sync_cmds! {
    search_overview() -> Value = |c: &Arc<Core>| c.search_overview();
    set_search_settings(settings: Value) -> () = |c: &Arc<Core>, s: Value| c.set_search_settings(&s);
    set_vk_token(token: String) -> () = |c: &Arc<Core>, t: String| c.set_vk_token(&t);
    reset_source_memory(source: String) -> () = |c: &Arc<Core>, s: String| c.reset_source_memory(&s);
    run_search(only: Option<Vec<String>>) -> () = |c: &Arc<Core>, only: Option<Vec<String>>| c.run_search(true, only.map(|v| v.into_iter().collect::<HashSet<_>>()), false);
    stop_search() -> () = |c: &Arc<Core>| c.stop_search();
    search_status() -> Value = |c: &Arc<Core>| to_value(c.search_status()?);
}

// ---------------------------------------------------------------- интеграции

#[tauri::command]
pub fn drives_state(core: C<'_>) -> CmdResult<Value> {
    to_value(core.drives_state()?)
}
#[tauri::command]
pub fn save_oauth_key(core: C<'_>, provider: String, client_id: String, client_secret: Option<String>) -> CmdResult<()> {
    core.save_oauth_key(&provider, &client_id, client_secret.as_deref())
}
#[tauri::command]
pub fn remove_oauth_key(core: C<'_>, provider: String) -> CmdResult<()> {
    core.remove_oauth_key(&provider)
}
#[tauri::command]
pub fn disconnect_drive(core: C<'_>, service: String) -> CmdResult<()> {
    core.disconnect_drive(&service)
}
#[tauri::command]
pub fn cancel_integration(core: C<'_>) {
    core.cancel_integration();
}
#[tauri::command]
pub async fn connect_oauth(core: C<'_>, service: String) -> CmdResult<String> {
    core.inner().connect_oauth(&service).await
}
#[tauri::command]
pub async fn connect_webdav(core: C<'_>, service: String, url: String, login: String, password: String) -> CmdResult<String> {
    core.connect_webdav(&service, &url, &login, &password).await
}
/// Выгружает свежую копию базы на выбранный диск.
#[tauri::command]
pub async fn upload_backup_to_drive(core: C<'_>, service: String) -> CmdResult<String> {
    let c = core.inner().clone();
    let s = c.require()?;
    let file = c.backup_now(&s)?;
    c.upload_to_drive(&service, &file).await
}
/// Выгружает на диск переносимую копию под ключом восстановления: лиды и CRM одним файлом (пакет G8).
#[tauri::command]
pub async fn upload_portable_to_drive(core: C<'_>, service: String) -> CmdResult<String> {
    let c = core.inner().clone();
    let (data, _) = c.portable_bytes()?;
    let name = format!("customers-{}.customers", crate::time::local_format(crate::time::now(), "%Y-%m-%d_%H-%M"));
    c.upload_data_to_drive(&service, &name, &data).await
}

#[tauri::command]
pub fn mail_providers(core: C<'_>) -> Value {
    core.mail_providers()
}
#[tauri::command]
pub fn mail_preset(core: C<'_>, email: String, name: String) -> Value {
    core.mail_preset(&email, &name)
}
#[tauri::command]
pub fn mail_state(core: C<'_>) -> CmdResult<Value> {
    core.mail_state()
}
#[tauri::command]
pub fn mail_save(core: C<'_>, account: Option<MailAccount>, delivery: String, password: Option<String>) -> CmdResult<()> {
    core.inner().mail_save(account, &delivery, password.as_deref())
}
#[tauri::command]
pub fn mail_forget(core: C<'_>) -> CmdResult<()> {
    core.inner().mail_forget()
}
#[tauri::command]
pub async fn mail_send(core: C<'_>, to: String, subject: String, body: String, lead_id: Option<String>) -> CmdResult<String> {
    core.inner().mail_send(OutgoingMail { to, subject, body }, lead_id.as_deref()).await
}
#[tauri::command]
pub async fn mail_test(core: C<'_>) -> CmdResult<String> {
    core.inner().mail_test().await
}
#[tauri::command]
pub fn open_in_mail_app(core: C<'_>, to: String, subject: String, body: String, lead_id: Option<String>) -> CmdResult<()> {
    core.inner().open_in_mail_app(&OutgoingMail { to, subject, body }, lead_id.as_deref())
}
#[tauri::command]
pub fn call_phone(core: C<'_>, phone: String, lead_id: Option<String>) -> CmdResult<()> {
    core.inner().call(&phone, lead_id.as_deref())
}

#[tauri::command]
pub fn call_apps() -> Vec<Value> {
    crate::contact::CALL_APPS
        .iter()
        .map(|a| json!({"id": a.id, "title": a.title, "installed": crate::contact::call_app_installed(a), "opensChat": a.opens_chat}))
        .collect()
}

#[tauri::command]
pub fn crm_state(core: C<'_>) -> CmdResult<Value> {
    core.crm_state()
}
#[tauri::command]
pub fn crm_sent_count(core: C<'_>, kind: String, ids: Vec<String>) -> CmdResult<usize> {
    core.crm_sent_count(&kind, &ids)
}
#[tauri::command]
pub async fn connect_bitrix(core: C<'_>, webhook: String) -> CmdResult<()> {
    core.connect_bitrix(&webhook).await
}
#[tauri::command]
pub fn connect_webhook(core: C<'_>, url: String) -> CmdResult<()> {
    core.connect_webhook(&url)
}
#[tauri::command]
pub async fn connect_notion(core: C<'_>, token: String, database: String, keep_mapping: bool) -> CmdResult<()> {
    core.connect_notion(&token, &database, keep_mapping).await
}
#[tauri::command]
pub async fn refresh_notion(core: C<'_>) -> CmdResult<()> {
    core.refresh_notion().await
}
#[tauri::command]
pub fn set_notion_mapping(core: C<'_>, mapping: BTreeMap<String, String>) -> CmdResult<()> {
    core.set_notion_mapping(mapping)
}
#[tauri::command]
pub fn disconnect_crm(core: C<'_>, kind: String) -> CmdResult<()> {
    core.disconnect_crm(&kind)
}
#[tauri::command]
pub fn cancel_crm(core: C<'_>) {
    core.cancel_crm();
}
#[tauri::command]
pub async fn export_to_crm(core: C<'_>, kind: String, ids: Vec<String>, resend: bool) -> CmdResult<Value> {
    core.inner().export_to_crm(&kind, &ids, resend).await
}

// ---------------------------------------------------------------- обновления

#[tauri::command]
pub fn update_info(core: C<'_>) -> Value {
    serde_json::to_value(core.update_info()).unwrap_or(Value::Null)
}
#[tauri::command]
pub async fn check_updates(core: C<'_>) -> CmdResult<Value> {
    to_value(core.inner().check_updates(true).await?)
}
#[tauri::command]
pub async fn prepare_update(core: C<'_>) -> CmdResult<Value> {
    to_value(core.inner().prepare_update().await?)
}
#[tauri::command]
pub fn install_update(core: C<'_>) -> CmdResult<()> {
    core.inner().install_update()
}
#[tauri::command]
pub async fn recent_releases(core: C<'_>) -> CmdResult<Value> {
    core.inner().recent_releases().await
}
#[tauri::command]
pub async fn whats_new(core: C<'_>) -> CmdResult<Value> {
    core.inner().whats_new().await
}
#[tauri::command]
pub fn mark_whats_new_seen(core: C<'_>) {
    core.mark_whats_new_seen();
}
#[tauri::command]
pub fn update_intervals() -> Value {
    Value::Array(updates::INTERVALS.iter().map(|(h, t)| json!({"hours": h, "title": t})).collect())
}

// ---------------------------------------------------------------- система, журнал, отчёты

#[tauri::command]
pub fn power_state() -> Value {
    serde_json::to_value(system::power_state()).unwrap_or(Value::Null)
}

#[tauri::command]
pub fn open_url(core: C<'_>, url: String) -> CmdResult<()> {
    if !(url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:") || url.starts_with("tel:")) {
        return Err(CmdError::msg("Эту ссылку открыть нельзя."));
    }
    core.env.opener.open_url(&url).map_err(CmdError::msg)
}

#[tauri::command]
pub fn reveal_path(core: C<'_>, path: String) -> CmdResult<()> {
    core.env.opener.reveal(&PathBuf::from(path)).map_err(CmdError::msg)
}

#[tauri::command]
pub fn paths_info(core: C<'_>) -> Value {
    let p = &core.env.paths;
    json!({"root": p.root, "logs": p.logs, "documents": p.documents, "errorLog": core.env.errors.path()})
}

#[tauri::command]
pub fn error_log(core: C<'_>, count: usize) -> Vec<String> {
    core.env.errors.recent(count.clamp(1, 500))
}

#[tauri::command]
pub fn clear_error_log(core: C<'_>) {
    core.env.errors.clear();
}

/// Свежие отчёты о сбоях: системные (macOS) и собственные (паника); новее, чем уже предлагалось.
#[tauri::command]
pub fn crash_reports(core: C<'_>) -> Value {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_default();
    let newer = core.env.device_prefs().reports_last_seen.as_deref().and_then(crate::util::parse_date);
    let system = if cfg!(target_os = "macos") { reports::system_report_dirs(&home) } else { vec![] };
    let found = reports::find(&system, Some(&core.env.paths.crashes()), newer);
    Value::Array(found.iter().map(|f| json!({"path": f.path, "date": crate::util::format_date(&f.date), "kind": f.kind})).collect())
}

/// Текст обращения: версия, система, главное из отчёта и (по настройке) журнал. Личные пути убираются.
#[tauri::command]
pub fn crash_report_text(core: C<'_>, path: Option<String>) -> String {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default();
    let user = std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_default();
    let mut text = format!("Customers {}, {} {}\n", core.env.version, std::env::consts::OS, std::env::consts::ARCH);
    // Читаются только отчёты о сбоях из тех же папок, что показывает crash_reports, а не любой файл.
    let home_dir = PathBuf::from(&home);
    let system = if cfg!(target_os = "macos") { reports::system_report_dirs(&home_dir) } else { vec![] };
    let allowed = reports::find(&system, Some(&core.env.paths.crashes()), None);
    if let Some(p) = path.filter(|p| allowed.iter().any(|f| f.path == std::path::Path::new(p))) {
        if let Ok(raw) = std::fs::read_to_string(&p) {
            text.push('\n');
            text.push_str(&reports::summary(&raw, 25, 4000));
            text.push('\n');
        }
    }
    if core.env.device_prefs().reports_include_log {
        let log = core.env.errors.recent(30);
        if !log.is_empty() {
            text.push_str("\nЖурнал ошибок:\n");
            text.push_str(&log.join("\n"));
        }
    }
    reports::redact(&text, &home, &user)
}

#[tauri::command]
pub fn issue_url(title: String, body: String) -> String {
    reports::default_issue_url(&title, &body)
}

#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Масштаб интерфейса: как масштаб страницы в браузере, поэтому вёрстка перестраивается под меньшую ширину.
#[tauri::command]
pub fn set_zoom(app: tauri::AppHandle, scale: f64) -> CmdResult<()> {
    use tauri::Manager;
    let scale = if scale.is_finite() { scale.clamp(0.7, 2.0) } else { 1.0 };
    if let Some(w) = app.get_webview_window(crate::shell::MAIN) {
        w.set_zoom(scale).map_err(|e| CmdError::msg(e.to_string()))?;
    }
    Ok(())
}

// ---------------------------------------------------------------- Customers 2.0: Workspace и CRM

use crate::workspace::convert::ConvertOptions;
use crate::workspace::import::ImportOptions;
use crate::workspace::query::Query;

sync_cmds! {
    ws_state() -> Value = |c: &Arc<Core>| c.ws_state();
    ws_switch(id: String) -> Value = |c: &Arc<Core>, id: String| c.ws_switch(&id);
    ws_list(entity: String, query: Option<Query>) -> Value = |c: &Arc<Core>, e: String, q: Option<Query>| c.ws_list(&e, q.unwrap_or_default());
    ws_card(entity: String, id: String) -> Value = |c: &Arc<Core>, e: String, id: String| c.ws_card(&e, &id);
    ws_save(entity: String, id: Option<String>, fields: serde_json::Map<String, Value>) -> Value = |c: &Arc<Core>, e: String, id: Option<String>, f| c.ws_save(&e, id.as_deref(), f);
    ws_delete(entity: String, id: String) -> Value = |c: &Arc<Core>, e: String, id: String| c.ws_delete(&e, &id);
    ws_restore(entity: String, id: String) -> Value = |c: &Arc<Core>, e: String, id: String| c.ws_restore(&e, &id);
    ws_duplicates(entity: String, fields: serde_json::Map<String, Value>, except: Option<String>) -> Value = |c: &Arc<Core>, e: String, f, x: Option<String>| c.ws_duplicates(&e, f, x.as_deref());
    ws_merge(request: crate::workspace::merge::MergeRequest) -> Value = |c: &Arc<Core>, r| c.ws_merge(r);
    ws_merge_last() -> Value = |c: &Arc<Core>| c.ws_merge_last();
    ws_merge_undo() -> Value = |c: &Arc<Core>| c.ws_merge_undo();
    ws_convert_lead(lead_id: String, options: Option<ConvertOptions>) -> Value = |c: &Arc<Core>, id: String, o: Option<ConvertOptions>| c.ws_convert_lead(&id, o.unwrap_or_default());
    ws_import_read(name: String, data: String) -> Value = |c: &Arc<Core>, n: String, d: String| c.ws_import_read(&n, &d);
    ws_import_preview(name: String, data: String, options: ImportOptions) -> Value = |c: &Arc<Core>, n: String, d: String, o: ImportOptions| c.ws_import_preview(&n, &d, o);
    ws_import_run(name: String, data: String, options: ImportOptions) -> Value = |c: &Arc<Core>, n: String, d: String, o: ImportOptions| c.ws_import_run(&n, &d, o);
    ws_import_history() -> Value = |c: &Arc<Core>| c.ws_import_history();
    ws_stage_history() -> Value = |c: &Arc<Core>| c.ws_stage_history();
    ws_import_undo(batch: String) -> Value = |c: &Arc<Core>, b: String| c.ws_import_undo(&b);
    ws_collections() -> Value = |c: &Arc<Core>| c.ws_collections();
    ws_collection_items(id: String, query: Option<Query>) -> Value = |c: &Arc<Core>, id: String, q: Option<Query>| c.ws_collection_items(&id, q.unwrap_or_default());
    ws_export_fields(entity: String, lang: String) -> Value = |c: &Arc<Core>, e: String, l: String| c.ws_export_fields(&e, &l);
    ws_reorder_collections(ids: Vec<String>) -> () = |c: &Arc<Core>, ids: Vec<String>| c.ws_reorder_collections(ids);
    ws_hide_collection(id: String, hidden: bool) -> () = |c: &Arc<Core>, id: String, h: bool| c.ws_hide_collection(&id, h);
    ws_create_workspace(name: String) -> Value = |c: &Arc<Core>, n: String| c.ws_create_workspace(&n);
    ws_rename_workspace(name: String) -> Value = |c: &Arc<Core>, n: String| c.ws_rename_workspace(&n);
    ws_set_local_details(name: String, currency: String) -> Value = |c: &Arc<Core>, n: String, cur: String| c.ws_set_local_details(&n, &cur);
    ws_delete_stage(stage: String, move_to: String) -> Value = |c: &Arc<Core>, st: String, to: String| c.ws_delete_stage(&st, &to);
    ws_attach_add(entity_type: String, entity_id: String, name: String, mime: String, data: String) -> Value =
        |c: &Arc<Core>, t: String, id: String, n: String, m: String, d: String| c.ws_attach_add(&t, &id, &n, &m, &d);
    ws_attach_save(id: String, path: String) -> String = |c: &Arc<Core>, id: String, p: String| c.ws_attach_save(&id, &p);
    ws_export(request: crate::workspace::export::Request, path: String) -> Value =
        |c: &Arc<Core>, r: crate::workspace::export::Request, p: String| c.ws_export(r, &PathBuf::from(p));
}

// ------------------------------------------------------------------ «Интеграции» и «Ai»

#[tauri::command]
pub fn hub_load(core: C<'_>) -> CmdResult<Value> {
    core.inner().hub_load()
}
#[tauri::command]
pub fn hub_save(core: C<'_>, value: Value) -> CmdResult<()> {
    core.inner().hub_save(value)
}
#[tauri::command]
pub async fn hub_send(core: C<'_>, service: String, text: String, config: Option<Value>) -> CmdResult<String> {
    core.inner().hub_send(&service, &text, config).await
}
#[tauri::command]
pub async fn ai_models(core: C<'_>, base_url: String, api_key: Option<String>) -> CmdResult<Vec<String>> {
    core.inner().ai_models(&base_url, api_key.as_deref().unwrap_or("")).await
}
#[tauri::command]
pub async fn ai_capabilities(core: C<'_>, base_url: String, api_key: Option<String>, model: String) -> CmdResult<Value> {
    to_value(core.inner().ai_capabilities(&base_url, api_key.as_deref().unwrap_or(""), &model).await?)
}
#[tauri::command]
pub fn ai_notify(core: C<'_>, title: String, body: String) -> CmdResult<()> {
    core.inner().ai_notify(&title, &body)
}
#[tauri::command]
pub async fn ai_chat(core: C<'_>, base_url: String, api_key: Option<String>, body: Value) -> CmdResult<Value> {
    core.inner().ai_chat(&base_url, api_key.as_deref().unwrap_or(""), body).await
}
