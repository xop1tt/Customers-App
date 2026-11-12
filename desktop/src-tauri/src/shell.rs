//! Оболочка Tauri: окно, значок в трее, закрытие в трей, ссылки возврата из браузера, уведомления, автозапуск.
//! Всё, что зависит от окна, здесь; остальное приложение этого не знает.

use crate::app::session::Core;
use crate::app::{device_id, Env, Events, Opener, SecretSessionStore};
use crate::cloud::auth::CloudAuth;
use crate::cloud::config::CloudConfig;
use crate::identity::{self, APP};
use crate::paths::AppPaths;
use crate::prefs::PrefsFile;
use crate::reports::{self, ErrorLog};
use crate::search::http::{real_sleeper, ReqwestTransport};
use crate::secrets::{self, DatabaseKeys};
use crate::tray_text::{self, Lang};
use crate::util::AppVersion;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

pub const MAIN: &str = "main";

pub struct TauriEvents(pub AppHandle);

impl Events for TauriEvents {
    fn emit(&self, name: &str, payload: Value) {
        match name {
            "notify" => notify(&self.0, &payload),
            "exit-requested" => {
                // Установщик ждёт завершения процесса: закрываемся сразу после ответа интерфейсу.
                let app = self.0.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(400));
                    app.exit(0);
                });
            }
            _ => {}
        }
        let _ = self.0.emit(name, payload);
        if matches!(name, "search-state" | "data-changed" | "session-changed" | "session-ended") {
            refresh_tray(&self.0);
        }
    }
}

pub struct TauriOpener(pub AppHandle);

impl Opener for TauriOpener {
    fn open_url(&self, url: &str) -> Result<(), String> {
        self.0.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
    }
    fn reveal(&self, path: &Path) -> Result<(), String> {
        self.0.opener().reveal_item_in_dir(path).map_err(|e| e.to_string())
    }
}

/// Системное уведомление, когда окно не на виду: о новых лидах, ошибках поиска и синхронизации.
fn notify(app: &AppHandle, payload: &Value) {
    let visible = app.get_webview_window(MAIN).map(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false)).unwrap_or(false);
    if visible {
        return;
    }
    let title = payload["title"].as_str().unwrap_or(APP.product_name);
    let body = payload["body"].as_str().unwrap_or("");
    let _ = app.notification().builder().title(title).body(body).show();
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn home_dir(app: &AppHandle) -> PathBuf {
    app.path().home_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// Приложение внутри «.app» (macOS): …/Customers.app/Contents/MacOS/customers → …/Customers.app
fn app_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors().find(|p| p.extension().and_then(|e| e.to_str()) == Some("app")).map(Path::to_path_buf)
}

pub fn build_env(app: &AppHandle) -> Result<Arc<Env>, String> {
    let home = home_dir(app);
    let local = if cfg!(windows) { app.path().local_data_dir().ok() } else { None };
    let paths = AppPaths::for_system(&home, local.as_deref(), app.path().document_dir().ok());
    #[cfg(e2e)]
    let paths = crate::e2e::paths().unwrap_or(paths);
    // До создания любых файлов: идентификатор сборки совпадает с тем, под которым хранятся данные.
    identity::check_identifier(&app.config().identifier)?;
    std::fs::create_dir_all(&paths.root).map_err(|e| format!("Не удалось создать папку данных {}: {e}", paths.root.display()))?;
    let _ = std::fs::create_dir_all(&paths.logs);
    let version = AppVersion::parse(env!("CARGO_PKG_VERSION")).ok_or("неверная версия")?;
    reports::install_panic_hook(paths.logs.clone(), version.to_string());
    let secrets = secrets::platform_store(&paths.root).map_err(|e| e.to_string())?;
    let transport: Arc<dyn crate::search::http::HttpTransport> = Arc::new(ReqwestTransport::new());
    #[cfg(e2e)]
    let transport = crate::e2e::wrap_transport(transport);
    let device_id = device_id(secrets.as_ref());
    let cloud = CloudConfig::embedded()
        .map(|config| Arc::new(CloudAuth::new(config, transport.clone(), Arc::new(SecretSessionStore(secrets.clone())), device_id.clone())));
    let events: Arc<dyn crate::app::Events> = Arc::new(TauriEvents(app.clone()));
    let bundle = app_bundle();
    let can_update = !cfg!(debug_assertions) && if cfg!(target_os = "macos") { bundle.is_some() } else { cfg!(windows) };
    Ok(Arc::new(Env {
        device: Mutex::new(PrefsFile::load(&paths.device_prefs())),
        accounts: crate::accounts::LocalAccounts::open(&paths.root).map_err(|e| e.to_string())?,
        keys: DatabaseKeys::new(secrets.clone()),
        errors: ErrorLog::new(&paths.logs),
        paths,
        secrets,
        transport,
        events,
        opener: Arc::new(TauriOpener(app.clone())),
        cloud,
        version,
        device_id,
        bundle_id: app.config().identifier.clone(),
        app_bundle: bundle,
        can_update,
        sleeper: real_sleeper(),
    }))
}

/// Применить изменения настроек устройства, которые затрагивают систему: автозапуск.
pub fn apply_device_changes(app: &AppHandle, _core: &Core, changes: &Value) {
    if let Some(on) = changes.get("launchAtLogin").and_then(Value::as_bool) {
        let manager = app.autolaunch();
        let _ = if on { manager.enable() } else { manager.disable() };
    }
}

// ------------------------------------------------------------------ значок в строке меню / трее

static UI_LANG: Mutex<Lang> = Mutex::new(Lang::Ru);
/// Что показано в меню сейчас: меню пересобирается, только когда это меняется.
static TRAY_KEY: Mutex<String> = Mutex::new(String::new());

fn ui_lang() -> Lang {
    *UI_LANG.lock().unwrap()
}

/// Язык, который интерфейс определил сам (язык системы) или выбрал пользователь. Меню значка подстраивается.
pub fn set_ui_language(app: &AppHandle, code: &str) {
    *UI_LANG.lock().unwrap() = Lang::parse(code);
    refresh_tray(app);
}

fn build_tray_menu(app: &AppHandle, lang: Lang, status: &str, searching: bool, cloud: bool) -> tauri::Result<Menu<tauri::Wry>> {
    let t = tray_text::text(lang);
    let status_item = MenuItem::with_id(app, "status", status, false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", t.open, true, None::<&str>)?;
    let search =
        if searching { MenuItem::with_id(app, "stop", t.stop, true, None::<&str>)? } else { MenuItem::with_id(app, "search", t.search, true, None::<&str>)? };
    let new = MenuItem::with_id(app, "new", t.new_leads, true, None::<&str>)?;
    let updates = MenuItem::with_id(app, "updates", t.updates, true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", t.settings, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", t.quit, true, None::<&str>)?;
    let sep = || PredefinedMenuItem::separator(app);
    let (s1, s2, s3) = (sep()?, sep()?, sep()?);
    let mut items: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = vec![&status_item, &s1, &open, &search, &new];
    let sync = MenuItem::with_id(app, "sync", t.sync, true, None::<&str>)?;
    if cloud {
        items.push(&sync);
    }
    items.extend([&s2 as &dyn tauri::menu::IsMenuItem<tauri::Wry>, &updates, &settings, &s3, &quit]);
    Menu::with_items(app, &items)
}

/// Пересобирает меню и подсказку по состоянию: идёт ли поиск, сколько новых лидов, облачный ли аккаунт.
pub fn refresh_tray(app: &AppHandle) {
    let app = app.clone();
    // Вызывается из обработчиков событий, где могут быть заняты замки: работаем в отдельном потоке.
    std::thread::spawn(move || {
        let Some(core) = app.try_state::<Arc<Core>>() else { return };
        let lang = ui_lang();
        let (searching, new_leads, cloud) = match core.session() {
            Some(s) => (s.search_status().running, s.with_store(|st| st.new_lead_count()), s.is_cloud),
            None => (false, 0, false),
        };
        let status = tray_text::status(lang, searching, new_leads);
        let key = format!("{lang:?}|{status}|{cloud}");
        {
            let mut last = TRAY_KEY.lock().unwrap();
            if *last == key {
                return;
            }
            *last = key;
        }
        if let Some(tray) = app.tray_by_id("tray") {
            if let Ok(menu) = build_tray_menu(&app, lang, &status, searching, cloud) {
                let _ = tray.set_menu(Some(menu));
            }
            let _ = tray.set_tooltip(Some(tray_text::tooltip(lang, new_leads)));
        }
    });
}

fn setup_tray(app: &AppHandle, core: Arc<Core>) -> tauri::Result<()> {
    // Язык меню до первого сообщения интерфейса: явный выбор пользователя, иначе русский, как раньше.
    let pref = core.env.device_prefs().language;
    if pref != "system" {
        *UI_LANG.lock().unwrap() = Lang::parse(&pref);
    }
    let lang = ui_lang();
    let menu = build_tray_menu(app, lang, &tray_text::status(lang, false, 0), false, false)?;
    let mut builder = TrayIconBuilder::with_id("tray").tooltip(tray_text::text(lang).tooltip).menu(&menu).show_menu_on_left_click(false);
    // macOS: прозрачный «шаблонный» значок, система сама делает его светлым или тёмным под строку меню.
    #[cfg(target_os = "macos")]
    {
        if let Ok(icon) = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-template.png")) {
            builder = builder.icon(icon).icon_as_template(true);
        }
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "search" => {
                let _ = core.run_search(true, None, false);
            }
            "stop" => {
                let _ = core.stop_search();
            }
            "new" => {
                show_main(app);
                let _ = app.emit("tray-action", json!({"action": "new"}));
            }
            "settings" => {
                show_main(app);
                let _ = app.emit("tray-action", json!({"action": "settings"}));
            }
            "sync" => {
                let core = core.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = core.sync_everything_command().await;
                });
            }
            "updates" => {
                let core = core.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = core.check_updates(true).await;
                });
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    refresh_tray(app);
    Ok(())
}

// ------------------------------------------------------------------ значок в Dock (macOS)

/// Значок приложения в Dock: чёрная плитка в тёмной теме системы, белая в светлой.
#[cfg(target_os = "macos")]
pub fn set_dock_icon(dark: bool) {
    use objc2::AnyThread;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;
    let png: &[u8] = if dark { include_bytes!("../icons/dock-dark.png") } else { include_bytes!("../icons/dock-light.png") };
    let Some(mtm) = MainThreadMarker::new() else { return };
    let data = NSData::with_bytes(png);
    if let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) {
        // SAFETY: вызывается в главном потоке (проверено выше), изображение живёт до конца вызова.
        unsafe { NSApplication::sharedApplication(mtm).setApplicationIconImage(Some(&image)) };
    }
}

#[cfg(target_os = "macos")]
fn follow_system_theme(app: &AppHandle) {
    // Первый раз сразу, потом при каждой смене темы системы. Окно запрашивает тему у системы, пока её не задали явно.
    if let Some(w) = app.get_webview_window(MAIN) {
        let dark = !matches!(w.theme(), Ok(tauri::Theme::Light));
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || set_dock_icon(dark));
        w.on_window_event(move |event| {
            if let WindowEvent::ThemeChanged(theme) = event {
                let dark = !matches!(theme, tauri::Theme::Light);
                let _ = app2.run_on_main_thread(move || set_dock_icon(dark));
            }
        });
    }
}

/// Ссылка возврата из браузера (подтверждение почты, восстановление пароля).
fn handle_deep_links(app: &AppHandle, core: &Arc<Core>, urls: Vec<String>) {
    let prefix = format!("{}://", APP.url_scheme);
    for url in urls.into_iter().filter(|u| u.starts_with(&prefix)) {
        show_main(app);
        let (core, app) = (core.clone(), app.clone());
        tauri::async_runtime::spawn(async move {
            let payload = match core.handle_auth_url(&url).await {
                Ok(crate::app::session::CallbackOutcome::NewPassword) => json!({"kind": "newPassword"}),
                Ok(crate::app::session::CallbackOutcome::SignedIn) => json!({"kind": "signedIn"}),
                Ok(crate::app::session::CallbackOutcome::Message(m)) => json!({"kind": "message", "message": m}),
                Err(e) => json!({"kind": "error", "message": e.message}),
            };
            let _ = app.emit("auth-callback", payload);
        });
    }
}

/// Проверка идентификатора до создания любых файлов. При несовпадении — понятное окно и выход:
/// приложение не открывает базу, не пишет журналы и настройки.
fn refuse_if_wrong_identity(app: &AppHandle) -> bool {
    let Err(e) = identity::check_identifier(&app.config().identifier) else {
        return false;
    };
    eprintln!("{e}");
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    let exit = app.clone();
    app.dialog().message(e).title(APP.product_name).kind(MessageDialogKind::Error).show(move |_| exit.exit(1));
    true
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    if refuse_if_wrong_identity(&handle) {
        return Ok(());
    }
    let env = build_env(&handle)?;
    let core = Core::new(env.clone());
    tauri::async_runtime::block_on(async { core.startup() });
    core.start_update_loop();
    app.manage(core.clone());

    setup_tray(&handle, core.clone())?;
    #[cfg(e2e)]
    crate::e2e::install(&handle);
    #[cfg(target_os = "macos")]
    follow_system_theme(&handle);

    // Ссылки возврата: приложение уже открыто (macOS) или запущено второй копией (Windows, через single-instance).
    {
        let (h, c) = (handle.clone(), core.clone());
        app.deep_link().on_open_url(move |event| handle_deep_links(&h, &c, event.urls().iter().map(|u| u.to_string()).collect()));
        if let Ok(Some(urls)) = app.deep_link().get_current() {
            handle_deep_links(&handle, &core, urls.iter().map(|u| u.to_string()).collect());
        }
        #[cfg(any(windows, target_os = "linux"))]
        let _ = app.deep_link().register_all();
    }

    // Окно: закрытие в трей, запуск свёрнутым при автозапуске.
    let minimized_launch = std::env::args().any(|a| a == "--minimized") && env.device_prefs().start_minimized;
    if let Some(window) = app.get_webview_window(MAIN) {
        let (h, c) = (handle.clone(), core.clone());
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let prefs = c.env.device_prefs();
                if prefs.close_to_tray {
                    api.prevent_close();
                    if let Some(w) = h.get_webview_window(MAIN) {
                        let _ = w.hide();
                    }
                    if !prefs.tray_hint_shown {
                        c.env.patch_device(&json!({"trayHintShown": true}));
                        let _ = h
                            .notification()
                            .builder()
                            .title("Customers работает в фоне")
                            .body("Поиск продолжается. Значок в области уведомлений открывает окно, меню значка — «Выйти».")
                            .show();
                    }
                }
            }
        });
        if !minimized_launch {
            show_main(&handle);
        }
    }
    Ok(())
}

/// Делает общий runtime tokio доступным на главном потоке.
/// Синхронные команды Tauri и setup идут на главном потоке без контекста tokio, а `tokio::spawn` без него паникует;
/// в релизной сборке (panic = abort) это молча роняет приложение, как при запуске 1.2.0 на macOS.
pub fn enter_async_runtime() -> tokio::runtime::EnterGuard<'static> {
    let handle: &'static tokio::runtime::Handle = Box::leak(Box::new(tauri::async_runtime::handle().inner().clone()));
    handle.enter()
}

pub fn run() {
    let _runtime = enter_async_runtime();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .setup(setup)
        .invoke_handler(crate::handler());
    #[cfg(e2e)]
    let builder = builder.on_page_load(crate::e2e::on_page_load);
    let app = builder.build(tauri::generate_context!()).expect("не удалось создать окно приложения");
    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            show_main(app);
        }
        let _ = (app, event);
    });
}
