//! Оболочка Tauri: окно, значок в трее, закрытие в трей, ссылки возврата из браузера, уведомления, автозапуск.
//! Всё, что зависит от окна, здесь; остальное приложение этого не знает.

use crate::app::session::Core;
use crate::app::{device_id, Env, Events, Opener, SecretSessionStore};
use crate::channel::{Channel, Isolation};
use crate::cloud::auth::CloudAuth;
use crate::cloud::config::CloudConfig;
use crate::paths::AppPaths;
use crate::prefs::PrefsFile;
use crate::reports::{self, ErrorLog};
use crate::search::http::{real_sleeper, ReqwestTransport};
use crate::secrets::{self, DatabaseKeys};
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
    let title = payload["title"].as_str().unwrap_or(Channel::current().identity().product_name);
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
    let channel = Channel::current();
    let documents = app.path().document_dir().ok();
    let paths = AppPaths::for_channel(channel, &home, local.as_deref(), documents.clone());
    // До создания любых файлов: идентификатор совпадает с каналом, папки каналов не пересекаются,
    // папка данных не принадлежит другому каналу. Иначе запуск останавливается и ничего не пишется.
    let isolation = Isolation::for_system(channel, &home, local.as_deref(), documents);
    isolation.check_identifier(&app.config().identifier).map_err(|e| e.to_string())?;
    isolation.check_dirs().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&paths.root).map_err(|e| format!("Не удалось создать папку данных {}: {e}", paths.root.display()))?;
    isolation.check_marker().map_err(|e| e.to_string())?;
    let _ = std::fs::create_dir_all(&paths.logs);
    let version = AppVersion::parse(env!("CARGO_PKG_VERSION")).ok_or("неверная версия")?;
    reports::install_panic_hook(paths.logs.clone(), version.to_string());
    let secrets = secrets::channel_store(channel, &paths.root).map_err(|e| e.to_string())?;
    let transport: Arc<dyn crate::search::http::HttpTransport> = Arc::new(ReqwestTransport::new());
    let device_id = device_id(secrets.as_ref());
    let cloud = CloudConfig::embedded()
        .map(|config| Arc::new(CloudAuth::new(config, transport.clone(), Arc::new(SecretSessionStore(secrets.clone())), device_id.clone())));
    let events: Arc<dyn crate::app::Events> = Arc::new(TauriEvents(app.clone()));
    // Beta: журнал событий для Debug Menu (маскирование секретов и личных данных — до записи).
    #[cfg(feature = "beta")]
    let events: Arc<dyn crate::app::Events> = {
        use crate::debug::log;
        crate::debug::dashboard::mark_start();
        let user = std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_default();
        log::install(&paths.logs, &home.display().to_string(), &user).record(
            log::Level::Info,
            "app",
            &format!("Запуск {} {} ({}, {})", channel.identity().product_name, version, std::env::consts::OS, std::env::consts::ARCH),
        );
        Arc::new(log::LoggedEvents(events))
    };
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
        channel,
        isolation,
    }))
}

/// Применить изменения настроек устройства, которые затрагивают систему: автозапуск.
pub fn apply_device_changes(app: &AppHandle, _core: &Core, changes: &Value) {
    if let Some(on) = changes.get("launchAtLogin").and_then(Value::as_bool) {
        let manager = app.autolaunch();
        let _ = if on { manager.enable() } else { manager.disable() };
    }
}

fn setup_tray(app: &AppHandle, core: Arc<Core>) -> tauri::Result<()> {
    let product = Channel::current().identity().product_name;
    let open = MenuItem::with_id(app, "open", format!("Открыть {product}"), true, None::<&str>)?;
    let search = MenuItem::with_id(app, "search", "Найти лидов сейчас", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &search, &PredefinedMenuItem::separator(app)?, &quit])?;
    let mut builder = TrayIconBuilder::with_id("tray").tooltip(product).menu(&menu).show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "search" => {
                let _ = core.run_search(true, None, false);
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
    Ok(())
}

/// Ссылка возврата из браузера (подтверждение почты, восстановление пароля).
fn handle_deep_links(app: &AppHandle, core: &Arc<Core>, urls: Vec<String>) {
    let prefix = format!("{}://", Channel::current().identity().url_scheme);
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

/// Проверка разделения каналов до создания любых файлов. При нарушении — понятное окно и выход:
/// приложение не открывает базу, не пишет журналы и настройки.
fn refuse_if_not_isolated(app: &AppHandle) -> bool {
    let home = home_dir(app);
    let local = if cfg!(windows) { app.path().local_data_dir().ok() } else { None };
    let isolation = Isolation::for_system(Channel::current(), &home, local.as_deref(), app.path().document_dir().ok());
    let Err(e) = isolation.check_identifier(&app.config().identifier).and_then(|_| isolation.check_dirs()).and_then(|_| isolation.check_marker()) else {
        return false;
    };
    eprintln!("{e}");
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    let exit = app.clone();
    app.dialog().message(e.to_string()).title(Channel::current().identity().product_name).kind(MessageDialogKind::Error).show(move |_| exit.exit(1));
    true
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    if refuse_if_not_isolated(&handle) {
        return Ok(());
    }
    let env = build_env(&handle)?;
    let core = Core::new(env.clone());
    tauri::async_runtime::block_on(async { core.startup() });
    core.start_update_loop();
    app.manage(core.clone());

    setup_tray(&handle, core.clone())?;

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
    let app = builder.build(tauri::generate_context!()).expect("не удалось создать окно приложения");
    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            show_main(app);
        }
        let _ = (app, event);
    });
}
