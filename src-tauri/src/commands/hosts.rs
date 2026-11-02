use std::path::PathBuf;

use serde::Serialize;
use tauri::State;
use wisp_core::secrets::Keychain;
use wisp_core::store::ssh_config::{self, Environment, ImportCandidate, ImportPreview};
use wisp_core::store::{Group, Host, HostDraft, SecretChange};

use crate::state::AppState;

const DEFAULT_IDENTITIES: [&str; 3] = ["id_ed25519", "id_ecdsa", "id_rsa"];

#[derive(Serialize)]
pub struct HostList {
    hosts: Vec<Host>,
    groups: Vec<Group>,
}

#[tauri::command]
pub fn hosts_list(state: State<'_, AppState>) -> Result<HostList, String> {
    state.with_store(|store| {
        Ok(HostList {
            hosts: store.hosts().to_vec(),
            groups: store.groups().to_vec(),
        })
    })
}

#[tauri::command]
pub fn host_save(
    state: State<'_, AppState>,
    draft: HostDraft,
    secret: SecretChange,
) -> Result<Host, String> {
    state.with_store(|store| {
        store
            .save_host(draft, secret, &Keychain)
            .map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub fn host_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.with_store(|store| store.delete_host(&id, &Keychain).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn group_save(
    state: State<'_, AppState>,
    id: Option<String>,
    name: String,
) -> Result<Group, String> {
    state.with_store(|store| store.save_group(id, &name).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn group_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.with_store(|store| store.delete_group(&id).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn ssh_config_preview() -> Result<ImportPreview, String> {
    let home = std::env::home_dir().ok_or("找不到用户主目录")?;
    let ssh_dir = home.join(".ssh");
    let text = match std::fs::read_to_string(ssh_dir.join("config")) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("无法读取 SSH 配置：{error}")),
    };
    let local_user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default();
    let default_identity = DEFAULT_IDENTITIES
        .iter()
        .map(|name| ssh_dir.join(name))
        .find(|path: &PathBuf| path.exists());
    Ok(ssh_config::preview(
        &text,
        &Environment {
            home: &home,
            local_user: &local_user,
            default_identity,
        },
    ))
}

/// Saves every candidate it can and reports how many failed, rather than stopping at the first.
#[tauri::command]
pub fn ssh_config_import(
    state: State<'_, AppState>,
    candidates: Vec<ImportCandidate>,
) -> Result<usize, String> {
    state.with_store(|store| {
        let mut failed = 0;
        for candidate in candidates {
            let draft = HostDraft {
                id: None,
                name: candidate.name,
                host: candidate.host,
                port: candidate.port,
                user: candidate.user,
                group_id: None,
                auth: candidate.auth,
            };
            if store
                .save_host(draft, SecretChange::Keep, &Keychain)
                .is_err()
            {
                failed += 1;
            }
        }
        Ok(failed)
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use wisp_core::store::{HostAuth, HostDraft, SecretChange};

    #[test]
    fn accepts_the_drafts_and_secret_changes_the_frontend_sends() {
        let draft: HostDraft = serde_json::from_value(json!({
            "id": null, "name": "web", "host": "h", "port": 22, "user": "u",
            "groupId": "g", "auth": {"kind": "key", "path": "~/.ssh/id"},
        }))
        .unwrap();
        assert_eq!(draft.group_id.as_deref(), Some("g"));
        assert_eq!(
            draft.auth,
            HostAuth::Key {
                path: "~/.ssh/id".into()
            }
        );
        for (value, expected) in [
            (json!({"kind": "keep"}), "keep"),
            (json!({"kind": "set", "value": "p"}), "set"),
            (json!({"kind": "clear"}), "clear"),
        ] {
            let change: SecretChange = serde_json::from_value(value).unwrap();
            let kind = match change {
                SecretChange::Keep => "keep",
                SecretChange::Set { .. } => "set",
                SecretChange::Clear => "clear",
            };
            assert_eq!(kind, expected);
        }
    }
}
