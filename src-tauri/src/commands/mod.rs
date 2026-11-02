pub mod connection;
pub mod files;
pub mod hosts;
pub mod terminal;

#[tauri::command]
pub fn core_version() -> &'static str {
    sshtool_core::version()
}
