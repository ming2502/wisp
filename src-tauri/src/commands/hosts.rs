use serde::Serialize;
use tauri::State;
use wisp_core::secrets::Keychain;
use wisp_core::store::{Group, Host, HostDraft, SecretChange};

use crate::state::AppState;

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

/// Places a host before another one, or last, in the given group or among ungrouped hosts.
#[tauri::command]
pub fn host_move(
    state: State<'_, AppState>,
    id: String,
    group_id: Option<String>,
    before: Option<String>,
) -> Result<Host, String> {
    state.with_store(|store| {
        store
            .move_host(&id, group_id, before.as_deref())
            .map_err(|e| e.to_string())
    })
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
