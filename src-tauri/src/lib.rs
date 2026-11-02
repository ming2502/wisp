mod commands;
mod state;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(state::AppState::default())
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            *app.state::<state::AppState>().config_dir.lock().unwrap() = Some(dir);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::core_version,
            commands::connection::ssh_connect,
            commands::hosts::hosts_list,
            commands::hosts::host_save,
            commands::hosts::host_delete,
            commands::hosts::group_save,
            commands::hosts::group_delete,
            commands::hosts::ssh_config_preview,
            commands::hosts::ssh_config_import,
            commands::connection::ssh_disconnect,
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
