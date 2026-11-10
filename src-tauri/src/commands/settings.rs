use serde_json::Value;
use tauri::State;
use wisp_core::store::write_atomically;

use crate::state::AppState;

pub const FILE: &str = "settings.json";

/// The frontend owns the shape of the settings and fills in defaults, so they are stored as-is.
/// A missing or unreadable file yields `null`, which means all defaults.
#[tauri::command]
pub fn settings_load(state: State<'_, AppState>) -> Value {
    let Some(dir) = state.config_dir.lock().unwrap().clone() else {
        return Value::Null;
    };
    std::fs::read(dir.join(FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub fn settings_save(state: State<'_, AppState>, settings: Value) -> Result<(), String> {
    let dir = state
        .config_dir
        .lock()
        .unwrap()
        .clone()
        .ok_or("找不到应用配置目录")?;
    let json = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
    write_atomically(&dir.join(FILE), &json).map_err(|e| format!("无法保存设置：{e}"))
}
