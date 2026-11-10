pub mod accounts;
pub mod app;
pub mod channel;
pub mod cloud;
pub mod commands;
pub mod contact;
pub mod crm;
pub mod csvfmt;
pub mod db;
// Debug Menu — только в Beta (docs/DEBUG_MENU.md). release-check.cjs проверяет, что строка стоит под этим условием.
#[cfg(feature = "beta")]
pub mod debug;
pub mod drives;
pub mod error;
pub mod export;
pub mod mail;
pub mod models;
pub mod paths;
pub mod prefs;
pub mod reports;
pub mod search;
pub mod secrets;
pub mod shell;
pub mod store;
pub mod tray_text;
pub mod updates;
pub mod util;
pub mod whatsnew;
// Customers 2.0: базы Workspace и данные CRM (этапы 3–7).
pub mod workspace;

pub fn handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    let app = app_handler();
    #[cfg(feature = "beta")]
    {
        let debug = debug_handler();
        move |invoke: tauri::ipc::Invoke<tauri::Wry>| {
            if invoke.message.command().starts_with(debug::COMMAND_PREFIX) {
                debug(invoke)
            } else {
                app(invoke)
            }
        }
    }
    #[cfg(not(feature = "beta"))]
    app
}

/// Команды Debug Menu (только Beta).
#[cfg(feature = "beta")]
fn debug_handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    use debug::commands::*;
    tauri::generate_handler![
        debug_dashboard,
        debug_logs,
        debug_log,
        debug_clear_logs,
        debug_export_logs,
        debug_diagnostics,
        debug_export_diagnostics,
        debug_test_data_state,
        debug_mark_test_account,
        debug_generate_test_data,
        debug_clear_test_data,
        debug_reset_test_account,
        debug_scenarios,
        debug_run_scenarios,
        debug_set_window_size,
    ]
}

fn app_handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        commands::account_prefs,
        commands::ws_state,
        commands::ws_switch,
        commands::ws_list,
        commands::ws_card,
        commands::ws_save,
        commands::ws_delete,
        commands::ws_restore,
        commands::ws_duplicates,
        commands::ws_convert_lead,
        commands::ws_collections,
        commands::ws_roles,
        commands::ws_presence,
        commands::ws_upload_local,
        commands::ws_save_role,
        commands::ws_delete_role,
        commands::ws_delete_stage,
        commands::ws_collection_items,
        commands::ws_reorder_collections,
        commands::ws_hide_collection,
        commands::ws_conflicts,
        commands::ws_resolve_conflict,
        commands::ws_dismiss_rejected,
        commands::ws_create_workspace,
        commands::ws_refresh,
        commands::ws_sync_now,
        commands::ws_invite,
        commands::ws_accept_invitation,
        commands::ws_set_member_role,
        commands::ws_remove_member,
        commands::ws_leave,
        commands::ws_rename_workspace,
        commands::backup_now,
        commands::boot_info,
        commands::call_phone,
        commands::call_apps,
        commands::cancel_crm,
        commands::cancel_integration,
        commands::change_cloud_email,
        commands::change_cloud_password,
        commands::change_password,
        commands::check_updates,
        commands::set_ui_language,
        commands::clear_error_log,
        commands::cloud_confirm,
        commands::cloud_finish_reset,
        commands::cloud_request_reset,
        commands::cloud_resend_confirmation,
        commands::cloud_set_password_after_recovery,
        commands::cloud_sign_in,
        commands::cloud_sign_up,
        commands::set_profile,
        commands::cloud_stats,
        commands::confirm_cloud_email,
        commands::connect_bitrix,
        commands::connect_notion,
        commands::connect_oauth,
        commands::connect_webdav,
        commands::connect_webhook,
        commands::crash_report_text,
        commands::crash_reports,
        commands::crm_sent_count,
        commands::crm_state,
        commands::delete_cloud_account,
        commands::delete_leads,
        commands::device_prefs,
        commands::disconnect_crm,
        commands::disconnect_drive,
        commands::drives_state,
        commands::error_log,
        commands::exclude,
        commands::export_fields,
        commands::export_to_crm,
        commands::export_to_file,
        commands::handle_auth_url,
        commands::import_exclusions,
        commands::import_local,
        commands::install_update,
        commands::is_remembered,
        commands::issue_url,
        commands::lead_events,
        commands::list_backups,
        commands::local_accounts,
        commands::log_event,
        commands::login,
        commands::logout,
        commands::mail_forget,
        commands::mail_preset,
        commands::mail_providers,
        commands::mail_save,
        commands::mail_send,
        commands::mail_state,
        commands::mail_test,
        commands::mark_all_seen,
        commands::mark_seen,
        commands::mark_whats_new_seen,
        commands::move_database,
        commands::open_in_mail_app,
        commands::open_url,
        commands::patch_account_prefs,
        commands::patch_device_prefs,
        commands::paths_info,
        commands::power_state,
        commands::prepare_update,
        commands::quit_app,
        commands::recent_releases,
        commands::refresh_notion,
        commands::register,
        commands::remove_exclusion,
        commands::remove_oauth_key,
        commands::resend_cloud_email_change,
        commands::reset_source_memory,
        commands::restore_backup,
        commands::reveal_path,
        commands::run_search,
        commands::save_oauth_key,
        commands::search_overview,
        commands::search_status,
        commands::set_archived,
        commands::set_favorite,
        commands::set_note,
        commands::set_notion_mapping,
        commands::set_remembered,
        commands::set_search_settings,
        commands::set_zoom,
        commands::set_vk_token,
        commands::snapshot,
        commands::stop_search,
        commands::sync_now,
        commands::sync_status,
        commands::update_info,
        commands::update_intervals,
        commands::upload_backup_to_drive,
        commands::whats_new,
    ]
}

pub fn run() {
    shell::run();
}
