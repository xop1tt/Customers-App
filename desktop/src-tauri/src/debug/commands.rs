//! Команды Debug Menu. Регистрируются отдельным обработчиком только в сборке Beta (`lib.rs`); в Stable их нет,
//! и вызов из интерфейса получил бы «команда не найдена».

use super::dashboard::{Dashboard, WindowInfo};
use super::diagnostics::Check;
use super::log::{self, Entry, Level, Query};
use super::scenarios::{self, Host, Info, Report};
use super::testdata::{self, Generated, State};
use crate::app::session::Core;
use crate::app::{CmdError, CmdResult};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Manager, State as TauriState, WebviewWindow};

type C<'a> = TauriState<'a, Arc<Core>>;

fn window_info(w: &WebviewWindow) -> WindowInfo {
    let scale = w.scale_factor().ok();
    let size = w.inner_size().ok();
    WindowInfo {
        scale_factor: scale,
        physical_width: size.map(|s| s.width),
        physical_height: size.map(|s| s.height),
        logical_width: size.zip(scale).map(|(s, f)| s.width as f64 / f),
        logical_height: size.zip(scale).map(|(s, f)| s.height as f64 / f),
    }
}

fn identifier(w: &WebviewWindow) -> String {
    w.app_handle().config().identifier.clone()
}

#[tauri::command]
pub fn debug_dashboard(core: C<'_>, window: WebviewWindow) -> Dashboard {
    super::dashboard::collect(core.inner(), &identifier(&window), window_info(&window), tauri::webview_version().ok())
}

// ---------------------------------------------------------------- журнал

fn event_log() -> CmdResult<&'static log::EventLog> {
    log::global().ok_or_else(|| CmdError::msg("Журнал событий не включён."))
}

#[tauri::command]
pub fn debug_logs(query: Query) -> CmdResult<Vec<Entry>> {
    Ok(event_log()?.query(&query))
}

/// Запись из интерфейса (ошибки отрисовки, действия пользователя в Debug Menu).
#[tauri::command]
pub fn debug_log(level: Level, module: String, message: String) -> CmdResult<()> {
    event_log()?.record(level, &format!("ui:{}", module.chars().take(40).collect::<String>()), &message.chars().take(4000).collect::<String>());
    Ok(())
}

#[tauri::command]
pub fn debug_clear_logs() -> CmdResult<()> {
    event_log()?.clear();
    Ok(())
}

/// Сохранить журнал (с текущим фильтром) в файл: `.jsonl` — JSON Lines, иначе текст.
#[tauri::command]
pub fn debug_export_logs(core: C<'_>, query: Query, path: PathBuf) -> CmdResult<String> {
    core.env.guard_path(&path)?;
    let entries = event_log()?.query(&query);
    let json = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("jsonl") || e.eq_ignore_ascii_case("json"));
    let text = if json { log::to_jsonl(&entries) } else { log::to_text(&entries) };
    std::fs::write(&path, text).map_err(|e| CmdError::msg(format!("Не удалось сохранить журнал: {e}")))?;
    Ok(format!("Сохранено записей: {}", entries.len()))
}

// ---------------------------------------------------------------- диагностика

#[tauri::command]
pub async fn debug_diagnostics(core: C<'_>) -> CmdResult<Vec<Check>> {
    Ok(super::diagnostics::run(core.inner()).await)
}

#[tauri::command]
pub async fn debug_export_diagnostics(core: C<'_>, window: WebviewWindow, path: PathBuf) -> CmdResult<String> {
    let info = window_info(&window);
    let id = identifier(&window);
    let saved = super::diagnostics::export_zip(core.inner(), &path, &id, info, tauri::webview_version().ok()).await?;
    Ok(saved.display().to_string())
}

// ---------------------------------------------------------------- тестовые данные

#[tauri::command]
pub fn debug_test_data_state(core: C<'_>) -> State {
    testdata::state(core.inner())
}

#[tauri::command]
pub fn debug_mark_test_account(core: C<'_>, on: bool) -> CmdResult<State> {
    testdata::mark(core.inner(), on)
}

#[tauri::command]
pub async fn debug_generate_test_data(core: C<'_>, count: usize, seed: u64) -> CmdResult<Generated> {
    let core = core.inner().clone();
    tokio::task::spawn_blocking(move || testdata::generate(&core, count, seed)).await.map_err(|e| CmdError::msg(e.to_string()))?
}

#[tauri::command]
pub fn debug_clear_test_data(core: C<'_>) -> CmdResult<usize> {
    testdata::clear(core.inner())
}

#[tauri::command]
pub fn debug_reset_test_account(core: C<'_>, confirm: String) -> CmdResult<()> {
    testdata::reset(core.inner(), &confirm)
}

// ---------------------------------------------------------------- сценарии

#[tauri::command]
pub fn debug_scenarios() -> Vec<Info> {
    scenarios::all()
}

#[tauri::command]
pub async fn debug_run_scenarios(core: C<'_>, window: WebviewWindow, ids: Vec<String>) -> CmdResult<Report> {
    let host = Host::for_env(&core.env, &identifier(&window));
    core.env.guard_path(&host.root)?;
    tokio::task::spawn_blocking(move || scenarios::run(&host, &ids)).await.map_err(|e| CmdError::msg(e.to_string()))?.map_err(CmdError::msg)
}

// ---------------------------------------------------------------- проверка интерфейса

/// Размер окна в логических точках (как в настройках системы при масштабе 100 %).
#[tauri::command]
pub fn debug_set_window_size(window: WebviewWindow, width: f64, height: f64) -> CmdResult<()> {
    if !(400.0..=8000.0).contains(&width) || !(300.0..=8000.0).contains(&height) {
        return Err(CmdError::msg("Недопустимый размер окна."));
    }
    let _ = window.unmaximize();
    window.set_size(tauri::LogicalSize::new(width, height)).map_err(|e| CmdError::msg(e.to_string()))?;
    log::record(Level::Debug, "ui-testing", &format!("Размер окна {width}×{height}"));
    Ok(())
}
