use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{Manager, State};
use wisp_core::sftp::{RemoteEntry, RemoteFs};
use wisp_core::transfer::{Enqueued, TransferId, TransferInfo, TransferState};

use crate::state::{AppState, Id};

async fn open_fs(
    state: &AppState,
    pick: impl Fn(&AppState) -> &Mutex<HashMap<Id, Arc<RemoteFs>>>,
    session_id: Id,
) -> Result<Arc<RemoteFs>, String> {
    if let Some(fs) = pick(state).lock().unwrap().get(&session_id) {
        return Ok(fs.clone());
    }
    let session = state
        .sessions
        .lock()
        .unwrap()
        .get(&session_id)
        .cloned()
        .ok_or("连接已关闭")?;
    let fs = Arc::new(session.open_sftp().await.map_err(|e| e.to_string())?);
    Ok(pick(state)
        .lock()
        .unwrap()
        .entry(session_id)
        .or_insert(fs)
        .clone())
}

pub async fn browser(state: &AppState, session_id: Id) -> Result<Arc<RemoteFs>, String> {
    open_fs(state, |s| &s.browsers, session_id).await
}

#[derive(Serialize)]
pub struct Listing {
    path: String,
    entries: Vec<RemoteEntry>,
}

/// Without a path, lists the home directory. The path is resolved first, so `..` and links work.
#[tauri::command]
pub async fn sftp_list(
    state: State<'_, AppState>,
    session_id: Id,
    path: Option<String>,
) -> Result<Listing, String> {
    let fs = browser(&state, session_id).await?;
    let path = match path {
        Some(path) => fs.canonicalize(&path).await,
        None => fs.home().await,
    }
    .map_err(|e| e.to_string())?;
    let entries = fs.list(&path).await.map_err(|e| e.to_string())?;
    Ok(Listing { path, entries })
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, AppState>,
    session_id: Id,
    dir: String,
    name: String,
) -> Result<String, String> {
    let fs = browser(&state, session_id).await?;
    fs.mkdir(&dir, &name).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    session_id: Id,
    path: String,
    new_name: String,
) -> Result<String, String> {
    let fs = browser(&state, session_id).await?;
    fs.rename(&path, &new_name).await.map_err(|e| e.to_string())
}

/// Stops at the first failure, reporting what was removed before it.
#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, AppState>,
    session_id: Id,
    paths: Vec<String>,
) -> Result<(), String> {
    let fs = browser(&state, session_id).await?;
    for (done, path) in paths.iter().enumerate() {
        if let Err(error) = fs.remove(path).await {
            return Err(if done == 0 {
                error.to_string()
            } else {
                format!("已删除 {done} 项，之后失败：{error}")
            });
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_chmod(
    state: State<'_, AppState>,
    session_id: Id,
    path: String,
    mode: u32,
) -> Result<(), String> {
    let fs = browser(&state, session_id).await?;
    fs.chmod(&path, mode).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn transfer_upload(
    state: State<'_, AppState>,
    session_id: Id,
    local_paths: Vec<PathBuf>,
    remote_dir: String,
) -> Result<Enqueued, String> {
    let fs = open_fs(&state, |s| &s.transfer_channels, session_id).await?;
    state
        .transfers
        .upload(session_id, fs, local_paths, &remote_dir)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn transfer_download(
    state: State<'_, AppState>,
    session_id: Id,
    remote_paths: Vec<String>,
    local_dir: PathBuf,
) -> Result<Enqueued, String> {
    let fs = open_fs(&state, |s| &s.transfer_channels, session_id).await?;
    state
        .transfers
        .download(session_id, fs, remote_paths, &local_dir)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn transfer_pause(state: State<'_, AppState>, id: TransferId) {
    state.transfers.pause(id);
}

#[tauri::command]
pub fn transfer_resume(state: State<'_, AppState>, id: TransferId) {
    state.transfers.resume(id);
}

#[tauri::command]
pub fn transfer_cancel(state: State<'_, AppState>, id: TransferId) {
    state.transfers.cancel(id);
}

#[tauri::command]
pub fn transfers_clear(state: State<'_, AppState>) {
    state.transfers.clear_finished();
}

/// The latest channel replaces any earlier one, so a reloaded page keeps getting updates.
#[tauri::command]
pub async fn transfers_subscribe(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    on_change: Channel<Vec<TransferInfo>>,
) -> Result<Vec<TransferInfo>, String> {
    let first = state
        .transfer_listener
        .lock()
        .unwrap()
        .replace(on_change)
        .is_none();
    if first {
        state.transfers.subscribe(move |list| {
            let state = app.state::<AppState>();
            if let Some(listener) = state.transfer_listener.lock().unwrap().as_ref() {
                let _ = listener.send(list);
            }
        });
    }
    Ok(state.transfers.list())
}

/// Forgets the session's SFTP channels. Its transfers are cancelled only when the user closed the
/// session; after a lost connection they stay, failed, so that a reconnect can resume them.
pub fn forget_session(state: &AppState, session_id: Id, cancel_transfers: bool) {
    state.browsers.lock().unwrap().remove(&session_id);
    state.transfer_channels.lock().unwrap().remove(&session_id);
    if cancel_transfers {
        state.transfers.cancel_owner(session_id);
    }
}

/// Hands the unfinished transfers of a lost session to the one that replaced it.
pub async fn rebind_transfers(state: &AppState, old: Id, new: Id) -> Result<(), String> {
    let pending = state.transfers.list().iter().any(|t| {
        t.owner == old && !matches!(t.state, TransferState::Completed | TransferState::Cancelled)
    });
    if pending {
        let fs = open_fs(state, |s| &s.transfer_channels, new).await?;
        state.transfers.rebind(old, new, fs);
    }
    Ok(())
}
