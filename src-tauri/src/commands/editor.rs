use serde::Serialize;
use sshtool_core::sftp::{EditError, TextFile, TextFormat, Version};
use tauri::State;

use super::files::browser;
use crate::state::{AppState, Id};

/// The error's fields, plus its message for display.
#[derive(Serialize)]
pub struct EditFailure {
    #[serde(flatten)]
    error: EditError,
    message: String,
}

impl From<EditError> for EditFailure {
    fn from(error: EditError) -> Self {
        Self {
            message: error.to_string(),
            error,
        }
    }
}

fn failed(message: String) -> EditFailure {
    EditError::Failed { message }.into()
}

#[tauri::command]
pub async fn editor_open(
    state: State<'_, AppState>,
    session_id: Id,
    path: String,
) -> Result<TextFile, EditFailure> {
    let fs = browser(&state, session_id).await.map_err(failed)?;
    Ok(fs.open_text(&path).await?)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn editor_save(
    state: State<'_, AppState>,
    session_id: Id,
    path: String,
    content: String,
    format: TextFormat,
    expected: Version,
    overwrite_changes: bool,
    direct: bool,
) -> Result<Version, EditFailure> {
    let fs = browser(&state, session_id).await.map_err(failed)?;
    Ok(fs
        .save_text(&path, &content, format, expected, overwrite_changes, direct)
        .await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failures_carry_kind_fields_and_message() {
        let json = serde_json::to_value(EditFailure::from(EditError::AtomicUnavailable {
            reason: "r".into(),
        }))
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({"kind": "atomicUnavailable", "reason": "r", "message": "无法安全替换文件：r"})
        );
    }
}
