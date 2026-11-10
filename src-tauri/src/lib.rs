mod commands;
mod state;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    commands::STARTED.get_or_init(std::time::Instant::now);
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state::AppState::default())
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            *app.state::<state::AppState>().config_dir.lock().unwrap() = Some(dir);
            if let Some(window) = app.get_webview_window("main") {
                commands::title_bar::hide_title_text(&window);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::core_version,
            commands::app_ready,
            commands::open_release_page,
            commands::clipboard::clipboard_files,
            commands::title_bar::set_title_bar_theme,
            commands::connection::ssh_connect,
            commands::editor::editor_open,
            commands::editor::editor_save,
            commands::files::sftp_list,
            commands::files::sftp_mkdir,
            commands::files::sftp_rename,
            commands::files::sftp_copy,
            commands::files::sftp_rename_replacing,
            commands::files::sftp_remove,
            commands::files::sftp_chmod,
            commands::files::transfer_upload,
            commands::files::transfer_download,
            commands::files::transfer_pause,
            commands::files::transfer_resume,
            commands::files::transfer_cancel,
            commands::files::transfers_clear,
            commands::files::transfers_subscribe,
            commands::hosts::hosts_list,
            commands::picker::pick_paths,
            commands::hosts::host_save,
            commands::hosts::host_delete,
            commands::hosts::host_move,
            commands::hosts::group_save,
            commands::hosts::group_delete,
            commands::hosts::ssh_config_preview,
            commands::hosts::ssh_config_import,
            commands::connection::ssh_disconnect,
            commands::connection::ssh_replace,
            commands::settings::settings_load,
            commands::settings::settings_save,
            commands::connection::answer_host_key,
            commands::connection::answer_prompt,
            commands::terminal::terminal_open,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_ack,
            commands::terminal::terminal_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
