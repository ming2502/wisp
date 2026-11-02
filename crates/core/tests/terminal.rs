mod common;

use std::time::Duration;

use common::*;
use sshtool_core::terminal::{TerminalEnd, TerminalError, TerminalEvent, TerminalSize};

/// Must stay above the core's high watermark plus one batch, and well below the flood size.
const PAUSED_LIMIT: usize = 1024 * 1024;

struct Fixture {
    _dir: tempfile::TempDir,
    server: TestServer,
    session: sshtool_core::connection::Session,
}

async fn fixture_with(refuse_shell: bool) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let server = start_server(ServerOptions {
        client_key: new_key().public_key().clone(),
        second_factor: false,
        refuse_shell,
        sha1_mac_only: false,
    })
    .await;
    let session = connected(&server, &dir.path().join("known_hosts")).await;
    Fixture {
        _dir: dir,
        server,
        session,
    }
}

async fn fixture() -> Fixture {
    fixture_with(false).await
}

#[tokio::test]
async fn requests_pty_with_size_type_and_erase_key() {
    let f = fixture().await;
    let mut term = open(
        &f.session,
        TerminalSize {
            cols: 100,
            rows: 30,
        },
    )
    .await;
    term.read_until(b"welcome").await;
    assert_eq!(
        *f.server.observed.pty.lock().unwrap(),
        Some(("xterm-256color".to_string(), 100, 30))
    );
    assert_eq!(*f.server.observed.erase_char.lock().unwrap(), Some(127));
}

#[tokio::test]
async fn input_is_delivered_in_order() {
    let f = fixture().await;
    let mut term = open(&f.session, SIZE).await;
    term.read_until(b"welcome").await;
    let expected: Vec<u8> = (0..500)
        .flat_map(|i| format!("<{i}>").into_bytes())
        .collect();
    for chunk in expected.chunks(5) {
        term.terminal.write(chunk.to_vec());
    }
    term.terminal.write(b"<end>".to_vec());
    let output = term.read_until(b"<end>").await;
    let start = output
        .windows(3)
        .position(|window| window == b"<0>")
        .unwrap();
    assert_eq!(&output[start..start + expected.len()], expected);
}

#[tokio::test]
async fn resize_reaches_server() {
    let f = fixture().await;
    let mut term = open(&f.session, SIZE).await;
    term.read_until(b"welcome").await;
    term.terminal.resize(TerminalSize {
        cols: 132,
        rows: 43,
    });
    term.terminal.write(b"sync".to_vec());
    term.read_until(b"sync").await;
    assert_eq!(*f.server.observed.resizes.lock().unwrap(), [(132, 43)]);
}

#[tokio::test]
async fn exit_status_is_reported_after_all_output() {
    let f = fixture().await;
    let mut term = open(&f.session, SIZE).await;
    term.read_until(b"welcome").await;
    term.terminal.write(b"exit".to_vec());
    let event = tokio::time::timeout(Duration::from_secs(5), term.events.recv()).await;
    assert_eq!(
        event.unwrap(),
        Some(TerminalEvent::End(TerminalEnd::Exited { status: Some(7) }))
    );
}

#[tokio::test]
async fn lost_connection_is_reported_as_disconnected() {
    let f = fixture().await;
    let mut term = open(&f.session, SIZE).await;
    term.read_until(b"welcome").await;
    term.terminal.write(b"die".to_vec());
    let event = tokio::time::timeout(Duration::from_secs(5), term.events.recv()).await;
    assert_eq!(
        event.unwrap(),
        Some(TerminalEvent::End(TerminalEnd::Disconnected))
    );
    assert!(f.session.is_closed());
}

#[tokio::test]
async fn refused_shell_is_an_error() {
    let f = fixture_with(true).await;
    let result = f.session.open_terminal(SIZE, |_| {}).await;
    assert!(matches!(result, Err(TerminalError::Refused)));
}

async fn next_output(term: &mut OpenTerminal, wait: Duration) -> Option<Vec<u8>> {
    match tokio::time::timeout(wait, term.events.recv()).await {
        Ok(Some(TerminalEvent::Output(bytes))) => Some(bytes),
        Ok(other) => panic!("unexpected {other:?}"),
        Err(_) => None,
    }
}

#[tokio::test]
async fn output_pauses_without_acks_and_completes_with_them() {
    let f = fixture().await;
    let mut term = open(&f.session, SIZE).await;
    term.read_until(b"welcome").await;
    term.terminal.write(b"flood".to_vec());

    // Without acknowledgements the reader must stall well short of the full flood.
    let mut unacked = 0;
    while let Some(bytes) = next_output(&mut term, Duration::from_millis(500)).await {
        unacked += bytes.len();
    }
    assert!(unacked > 0);
    assert!(unacked < PAUSED_LIMIT, "read {unacked} bytes without acks");

    // Acknowledging lets everything through, with no byte lost or duplicated.
    term.terminal.ack(unacked);
    let mut total = unacked;
    while total < FLOOD_BYTES {
        let bytes = next_output(&mut term, Duration::from_secs(15))
            .await
            .unwrap_or_else(|| panic!("stalled at {total} of {FLOOD_BYTES}"));
        assert!(bytes.iter().all(|byte| *byte == b'x'));
        term.terminal.ack(bytes.len());
        total += bytes.len();
    }
    assert_eq!(total, FLOOD_BYTES);
}

#[tokio::test]
async fn small_output_is_flushed_promptly() {
    let f = fixture().await;
    let mut term = open(&f.session, SIZE).await;
    term.read_until(b"welcome").await;
    term.terminal.write(b"x".to_vec());
    let bytes = next_output(&mut term, Duration::from_secs(1)).await;
    assert_eq!(bytes.as_deref(), Some(&b"x"[..]));
}

#[tokio::test]
async fn dropping_terminal_keeps_session_usable() {
    let f = fixture().await;
    let term = open(&f.session, SIZE).await;
    drop(term);
    let mut second = open(&f.session, SIZE).await;
    second.read_until(b"welcome").await;
    assert!(!f.session.is_closed());
}
