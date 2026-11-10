pub mod clipboard;
pub mod connection;
pub mod editor;
pub mod files;
pub mod hosts;
pub mod picker;
pub mod settings;
pub mod terminal;
pub mod title_bar;

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

/// Opens the release page of `version` in the browser, for installing by hand when updating in
/// the app fails. Only this one page can be opened, and only a plain version is accepted.
#[tauri::command]
pub fn open_release_page(version: String) -> Result<(), String> {
    if version.is_empty()
        || !version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return Err("版本号无效".into());
    }
    let url = format!("https://github.com/ming2502/wisp/releases/tag/v{version}");
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(windows)]
    let mut command = {
        let mut command = std::process::Command::new("rundll32");
        command.arg("url.dll,FileProtocolHandler");
        command
    };
    #[cfg(not(any(target_os = "macos", windows)))]
    let mut command = std::process::Command::new("xdg-open");
    command
        .arg(&url)
        .spawn()
        .map(drop)
        .map_err(|e| format!("无法打开浏览器：{e}"))
}
