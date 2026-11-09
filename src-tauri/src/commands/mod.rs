pub mod connection;
pub mod editor;
pub mod files;
pub mod hosts;
pub mod picker;
pub mod settings;
pub mod terminal;

use std::sync::OnceLock;
use std::time::Instant;

pub static STARTED: OnceLock<Instant> = OnceLock::new();

#[tauri::command]
pub fn core_version() -> &'static str {
    wisp_core::version()
}

/// Reports how long startup took once the interface is up, when `WISP_TIMING` is set.
#[tauri::command]
pub fn app_ready() {
    static REPORTED: OnceLock<()> = OnceLock::new();
    if std::env::var_os("WISP_TIMING").is_some()
        && REPORTED.set(()).is_ok()
        && let Some(started) = STARTED.get()
    {
        println!("wisp ready after {:?}", started.elapsed());
    }
}
