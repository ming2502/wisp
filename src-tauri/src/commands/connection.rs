use std::sync::Arc;

use serde::Serialize;
use sshtool_core::connection::{
    ConnectEvent, ConnectOptions, HostKeyInfo, Prompt, Session, Stage, known_hosts,
};
use sshtool_core::secrets::Keychain;
use tauri::State;
use tauri::ipc::Channel;
use tokio::sync::mpsc;
use zeroize::Zeroizing;

use crate::state::{AppState, Id, PendingPrompt};

const EVENT_QUEUE: usize = 8;

#[derive(Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ConnectMessage {
    Stage { stage: Stage },
    HostKey { prompt_id: Id, info: HostKeyInfo },
    Prompt { prompt_id: Id, prompt: Prompt },
}

/// Connects to a saved host. Saved secrets are read here and never pass through the WebView.
#[tauri::command]
pub async fn ssh_connect(
    state: State<'_, AppState>,
    host_id: String,
    on_event: Channel<ConnectMessage>,
) -> Result<Id, String> {
    let known_hosts = known_hosts::default_path().ok_or("找不到用户主目录")?;
    let (host, auth) = state.with_store(|store| {
        store
            .connect_target(&host_id, &Keychain)
            .map_err(|e| e.to_string())
    })?;
    let options = ConnectOptions {
        host: host.host,
        port: host.port,
        user: host.user,
        known_hosts,
    };
    let (events, mut queue) = mpsc::channel(EVENT_QUEUE);
    let connecting = Session::connect(options, auth, events);
    tokio::pin!(connecting);

    let mut asked = Vec::new();
    let result = loop {
        tokio::select! {
            result = &mut connecting => break result,
            Some(event) = queue.recv() => forward(&state, event, &on_event, &mut asked),
        }
    };

    // Replies to prompts that the failed attempt never got an answer for are now meaningless.
    let mut prompts = state.prompts.lock().unwrap();
    for id in asked {
        prompts.remove(&id);
    }
    drop(prompts);

    let session = result.map_err(|error| error.to_string())?;
    let id = state.new_id();
    state.sessions.lock().unwrap().insert(id, Arc::new(session));
    Ok(id)
}

fn forward(
    state: &AppState,
    event: ConnectEvent,
    on_event: &Channel<ConnectMessage>,
    asked: &mut Vec<Id>,
) {
    let mut ask = |pending| {
        let id = state.new_id();
        state.prompts.lock().unwrap().insert(id, pending);
        asked.push(id);
        id
    };
    let message = match event {
        ConnectEvent::Stage(stage) => ConnectMessage::Stage { stage },
        ConnectEvent::HostKey { info, reply } => ConnectMessage::HostKey {
            prompt_id: ask(PendingPrompt::HostKey(reply)),
            info,
        },
        ConnectEvent::Prompt { prompt, reply } => ConnectMessage::Prompt {
            prompt_id: ask(PendingPrompt::Secrets(reply)),
            prompt,
        },
    };
    let _ = on_event.send(message);
}

#[tauri::command]
pub fn answer_host_key(state: State<'_, AppState>, prompt_id: Id, trust: bool) {
    if let Some(PendingPrompt::HostKey(reply)) = state.prompts.lock().unwrap().remove(&prompt_id) {
        let _ = reply.send(trust);
    }
}

/// `values` of `null` cancels the connection attempt.
#[tauri::command]
pub fn answer_prompt(
    state: State<'_, AppState>,
    prompt_id: Id,
    values: Option<Vec<Zeroizing<String>>>,
) {
    if let Some(PendingPrompt::Secrets(reply)) = state.prompts.lock().unwrap().remove(&prompt_id) {
        let _ = reply.send(values);
    }
}

/// Closes a session the user is done with, cancelling its transfers.
#[tauri::command]
pub async fn ssh_disconnect(state: State<'_, AppState>, session_id: Id) -> Result<(), String> {
    let session = state.sessions.lock().unwrap().remove(&session_id);
    super::files::forget_session(&state, session_id, true);
    if let Some(session) = session {
        session.disconnect().await;
    }
    Ok(())
}

/// Moves what belonged to a lost session over to the session that reconnected in its place.
#[tauri::command]
pub async fn ssh_replace(
    state: State<'_, AppState>,
    old_session_id: Id,
    new_session_id: Id,
) -> Result<(), String> {
    let old = state.sessions.lock().unwrap().remove(&old_session_id);
    super::files::forget_session(&state, old_session_id, false);
    if let Some(old) = old {
        old.disconnect().await;
    }
    super::files::rebind_transfers(&state, old_session_id, new_session_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sshtool_core::connection::PromptField;
    #[test]
    fn messages_match_the_frontend_types() {
        let to_json = |message| serde_json::to_value(message).unwrap();
        assert_eq!(
            to_json(ConnectMessage::Stage {
                stage: Stage::Authenticating
            }),
            json!({"kind": "stage", "stage": "authenticating"})
        );
        assert_eq!(
            to_json(ConnectMessage::HostKey {
                prompt_id: 1,
                info: HostKeyInfo {
                    host: "h".into(),
                    port: 22,
                    algorithm: "ssh-ed25519".into(),
                    fingerprint: "SHA256:x".into(),
                    other_algorithms_known: true,
                },
            }),
            json!({"kind": "hostKey", "promptId": 1, "info": {
                "host": "h", "port": 22, "algorithm": "ssh-ed25519",
                "fingerprint": "SHA256:x", "otherAlgorithmsKnown": true,
            }})
        );
        assert_eq!(
            to_json(ConnectMessage::Prompt {
                prompt_id: 2,
                prompt: Prompt::KeyboardInteractive {
                    name: "n".into(),
                    instructions: "i".into(),
                    fields: vec![PromptField {
                        label: "Code: ".into(),
                        echo: false,
                    }],
                },
            }),
            json!({"kind": "prompt", "promptId": 2, "prompt": {
                "kind": "keyboardInteractive", "name": "n", "instructions": "i",
                "fields": [{"label": "Code: ", "echo": false}],
            }})
        );
        assert_eq!(
            to_json(ConnectMessage::Prompt {
                prompt_id: 4,
                prompt: Prompt::Password { retry: false },
            }),
            json!({"kind": "prompt", "promptId": 4, "prompt": {"kind": "password", "retry": false}})
        );
        assert_eq!(
            to_json(ConnectMessage::Prompt {
                prompt_id: 3,
                prompt: Prompt::Passphrase {
                    path: "p".into(),
                    retry: true,
                },
            }),
            json!({"kind": "prompt", "promptId": 3, "prompt": {
                "kind": "passphrase", "path": "p", "retry": true,
            }})
        );
    }
}
