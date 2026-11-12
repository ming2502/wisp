use tauri::State;
use tauri::ipc::{Channel, InvokeResponseBody};
use wisp_core::terminal::{TerminalEvent, TerminalSize};

use crate::state::{AppState, Id};

const FRAME_OUTPUT: u8 = 0;
const FRAME_END: u8 = 1;

fn encode(event: TerminalEvent) -> Vec<u8> {
    fn frame(tag: u8, payload: &[u8]) -> Vec<u8> {
        let mut frame = Vec::with_capacity(payload.len() + 1);
        frame.push(tag);
        frame.extend_from_slice(payload);
        frame
    }

    match event {
        TerminalEvent::Output(bytes) => frame(FRAME_OUTPUT, &bytes),
        TerminalEvent::End(end) => {
            let json = serde_json::to_vec(&end).unwrap_or_default();
            frame(FRAME_END, &json)
        }
    }
}

/// Output and the end of the stream share one ordered raw channel, so that the end can never
/// overtake output. Each frame starts with a tag byte.
#[tauri::command]
pub async fn terminal_open(
    state: State<'_, AppState>,
    session_id: Id,
    cols: u32,
    rows: u32,
    on_frame: Channel<InvokeResponseBody>,
) -> Result<Id, String> {
    let session = state
        .sessions
        .lock()
        .unwrap()
        .get(&session_id)
        .cloned()
        .ok_or("连接已关闭")?;
    let terminal = session
        .open_terminal(TerminalSize { cols, rows }, move |event| {
            let _ = on_frame.send(InvokeResponseBody::Raw(encode(event)));
        })
        .await
        .map_err(|error| error.to_string())?;
    let id = state.new_id();
    state.terminals.lock().unwrap().insert(id, terminal);
    Ok(id)
}

#[tauri::command]
pub fn terminal_write(state: State<'_, AppState>, terminal_id: Id, data: Vec<u8>) {
    if let Some(terminal) = state.terminals.lock().unwrap().get(&terminal_id) {
        terminal.write(data);
    }
}

#[tauri::command]
pub fn terminal_resize(state: State<'_, AppState>, terminal_id: Id, cols: u32, rows: u32) {
    if let Some(terminal) = state.terminals.lock().unwrap().get(&terminal_id) {
        terminal.resize(TerminalSize { cols, rows });
    }
}

#[tauri::command]
pub fn terminal_ack(state: State<'_, AppState>, terminal_id: Id, bytes: usize) {
    if let Some(terminal) = state.terminals.lock().unwrap().get(&terminal_id) {
        terminal.ack(bytes);
    }
}

/// The directory the session's shell is in, for the file view to follow; `None` when the server
/// cannot tell.
#[tauri::command]
pub async fn terminal_dir(
    state: State<'_, AppState>,
    session_id: Id,
) -> Result<Option<String>, String> {
    let session = state.sessions.lock().unwrap().get(&session_id).cloned();
    Ok(match session {
        Some(session) => session.terminal_dir().await,
        None => None,
    })
}

#[tauri::command]
pub fn terminal_close(state: State<'_, AppState>, terminal_id: Id) {
    state.terminals.lock().unwrap().remove(&terminal_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use wisp_core::terminal::TerminalEnd;

    #[test]
    fn output_frame_keeps_raw_bytes_after_tag() {
        let frame = encode(TerminalEvent::Output(vec![0xff, 0x00, b'a']));
        assert_eq!(frame, [FRAME_OUTPUT, 0xff, 0x00, b'a']);
    }

    #[test]
    fn end_frame_is_tagged_json() {
        let frame = encode(TerminalEvent::End(TerminalEnd::Exited { status: Some(3) }));
        assert_eq!(frame[0], FRAME_END);
        assert_eq!(&frame[1..], br#"{"kind":"exited","status":3}"#);
        let frame = encode(TerminalEvent::End(TerminalEnd::Disconnected));
        assert_eq!(&frame[1..], br#"{"kind":"disconnected"}"#);
    }
}
