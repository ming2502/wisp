mod common;

use common::*;
use wisp_core::connection::{Auth, ConnectError, Prompt, Stage, known_hosts};
use zeroize::Zeroizing;

fn server_options(client_key: &russh::keys::PrivateKey) -> ServerOptions {
    ServerOptions {
        client_key: client_key.public_key().clone(),
        second_factor: false,
        refuse_shell: false,
        sha1_mac_only: false,
    }
}

struct Fixture {
    dir: tempfile::TempDir,
    client_key: russh::keys::PrivateKey,
    server: TestServer,
}

impl Fixture {
    async fn new() -> Self {
        let client_key = new_key();
        let server = start_server(server_options(&client_key)).await;
        Self {
            dir: tempfile::tempdir().unwrap(),
            client_key,
            server,
        }
    }

    fn known_hosts(&self) -> std::path::PathBuf {
        self.dir.path().join("known_hosts")
    }

    fn options(&self) -> wisp_core::connection::ConnectOptions {
        options(self.server.port, &self.known_hosts())
    }
}

#[tokio::test]
async fn password_login_reports_stages_and_host_key() {
    let f = Fixture::new().await;
    let (result, transcript) =
        connect_scripted(f.options(), password(PASSWORD), Answers::default()).await;
    assert!(result.is_ok());
    assert_eq!(
        transcript.stages,
        [Stage::Connecting, Stage::Authenticating, Stage::Ready]
    );
    let info = &transcript.host_keys[0];
    assert_eq!(info.port, f.server.port);
    assert!(info.fingerprint.starts_with("SHA256:"));
    assert!(!info.other_algorithms_known);
}

#[tokio::test]
async fn wrong_password_fails() {
    let f = Fixture::new().await;
    let (result, _) = connect_scripted(f.options(), password("nope"), Answers::default()).await;
    let error = result.err().map(|error| format!("{error:?}"));
    assert_eq!(error.as_deref(), Some("AuthFailed"));
}

#[tokio::test]
async fn asked_password_is_requested_after_host_key_and_retried() {
    let f = Fixture::new().await;
    let answers = Answers {
        prompt_answers: vec![Some(vec!["wrong".into()]), Some(vec![PASSWORD.into()])],
        ..Default::default()
    };
    let (result, transcript) = connect_scripted(f.options(), Auth::AskPassword, answers).await;
    assert!(result.is_ok(), "{:?}", result.err());
    assert_eq!(transcript.host_keys.len(), 1);
    assert_eq!(
        transcript.prompts,
        [
            Prompt::Password { retry: false },
            Prompt::Password { retry: true }
        ]
    );
}

#[tokio::test]
async fn asked_password_gives_up_after_three_attempts() {
    let f = Fixture::new().await;
    let answers = Answers {
        prompt_answers: vec![Some(vec!["wrong".into()]); 5],
        ..Default::default()
    };
    let (result, transcript) = connect_scripted(f.options(), Auth::AskPassword, answers).await;
    assert!(matches!(result, Err(ConnectError::AuthFailed)));
    assert_eq!(transcript.prompts.len(), 3);
}

#[tokio::test]
async fn plain_private_key_login() {
    let f = Fixture::new().await;
    let path = write_key(f.dir.path(), "id", &f.client_key);
    let auth = Auth::Key {
        path,
        passphrase: None,
    };
    let (result, transcript) = connect_scripted(f.options(), auth, Answers::default()).await;
    assert!(result.is_ok());
    assert!(transcript.prompts.is_empty());
}

#[tokio::test]
async fn unauthorized_private_key_fails() {
    let f = Fixture::new().await;
    let path = write_key(f.dir.path(), "other", &new_key());
    let auth = Auth::Key {
        path,
        passphrase: None,
    };
    let (result, _) = connect_scripted(f.options(), auth, Answers::default()).await;
    assert!(matches!(result, Err(ConnectError::AuthFailed)));
}

#[tokio::test]
async fn missing_key_file_is_reported() {
    let f = Fixture::new().await;
    let auth = Auth::Key {
        path: f.dir.path().join("missing"),
        passphrase: None,
    };
    let (result, _) = connect_scripted(f.options(), auth, Answers::default()).await;
    assert!(matches!(result, Err(ConnectError::KeyFile { .. })));
}

fn encrypted_key(f: &Fixture) -> std::path::PathBuf {
    let encrypted = f.client_key.encrypt(&mut rand::rng(), "secret").unwrap();
    write_key(f.dir.path(), "encrypted", &encrypted)
}

#[tokio::test]
async fn encrypted_key_prompts_then_retries_wrong_passphrase() {
    let f = Fixture::new().await;
    let auth = Auth::Key {
        path: encrypted_key(&f),
        passphrase: None,
    };
    let answers = Answers {
        prompt_answers: vec![Some(vec!["wrong".into()]), Some(vec!["secret".into()])],
        ..Default::default()
    };
    let (result, transcript) = connect_scripted(f.options(), auth, answers).await;
    assert!(result.is_ok(), "{:?}", result.err());
    let retries: Vec<_> = transcript
        .prompts
        .iter()
        .map(|prompt| matches!(prompt, Prompt::Passphrase { retry: true, .. }))
        .collect();
    assert_eq!(retries, [false, true]);
}

#[tokio::test]
async fn encrypted_key_with_saved_passphrase_does_not_prompt() {
    let f = Fixture::new().await;
    let auth = Auth::Key {
        path: encrypted_key(&f),
        passphrase: Some(Zeroizing::new("secret".to_string())),
    };
    let (result, transcript) = connect_scripted(f.options(), auth, Answers::default()).await;
    assert!(result.is_ok(), "{:?}", result.err());
    assert!(transcript.prompts.is_empty());
}

#[tokio::test]
async fn passphrase_attempts_are_limited() {
    let f = Fixture::new().await;
    let auth = Auth::Key {
        path: encrypted_key(&f),
        passphrase: None,
    };
    let answers = Answers {
        prompt_answers: vec![Some(vec!["x".into()]); 10],
        ..Default::default()
    };
    let (result, transcript) = connect_scripted(f.options(), auth, answers).await;
    assert!(matches!(result, Err(ConnectError::BadPassphrase)));
    assert_eq!(transcript.prompts.len(), 3);
}

#[tokio::test]
async fn cancelling_passphrase_cancels_connection() {
    let f = Fixture::new().await;
    let auth = Auth::Key {
        path: encrypted_key(&f),
        passphrase: None,
    };
    let answers = Answers {
        prompt_answers: vec![None],
        ..Default::default()
    };
    let (result, _) = connect_scripted(f.options(), auth, answers).await;
    assert!(matches!(result, Err(ConnectError::Cancelled)));
}

#[tokio::test]
async fn keyboard_interactive_login() {
    let f = Fixture::new().await;
    let answers = Answers {
        prompt_answers: vec![Some(vec![OTP.into()])],
        ..Default::default()
    };
    let (result, transcript) =
        connect_scripted(f.options(), Auth::KeyboardInteractive, answers).await;
    assert!(result.is_ok(), "{:?}", result.err());
    let Prompt::KeyboardInteractive { fields, .. } = &transcript.prompts[0] else {
        panic!("{:?}", transcript.prompts);
    };
    assert_eq!(fields[0].label, "Code: ");
    assert!(!fields[0].echo);
}

#[tokio::test]
async fn keyboard_interactive_wrong_code_fails() {
    let f = Fixture::new().await;
    let answers = Answers {
        prompt_answers: vec![Some(vec!["000000".into()])],
        ..Default::default()
    };
    let (result, _) = connect_scripted(f.options(), Auth::KeyboardInteractive, answers).await;
    assert!(matches!(result, Err(ConnectError::AuthFailed)));
}

#[tokio::test]
async fn password_then_second_factor() {
    let client_key = new_key();
    let server = start_server(ServerOptions {
        second_factor: true,
        ..server_options(&client_key)
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let answers = Answers {
        prompt_answers: vec![Some(vec![OTP.into()])],
        ..Default::default()
    };
    let (result, transcript) = connect_scripted(
        options(server.port, &dir.path().join("known_hosts")),
        password(PASSWORD),
        answers,
    )
    .await;
    assert!(result.is_ok(), "{:?}", result.err());
    assert_eq!(transcript.prompts.len(), 1);
}

#[tokio::test]
async fn connects_to_server_that_only_accepts_hmac_sha1() {
    let client_key = new_key();
    let server = start_server(ServerOptions {
        sha1_mac_only: true,
        ..server_options(&client_key)
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let (result, _) = connect_scripted(
        options(server.port, &dir.path().join("known_hosts")),
        password(PASSWORD),
        Answers::default(),
    )
    .await;
    let session = result.unwrap_or_else(|error| panic!("{error}"));
    let mut term = open(&session, SIZE).await;
    term.read_until(b"welcome").await;
}

#[tokio::test]
async fn trusted_host_key_is_persisted_and_not_asked_again() {
    let f = Fixture::new().await;
    connect_scripted(f.options(), password(PASSWORD), Answers::default())
        .await
        .0
        .unwrap_or_else(|error| panic!("{error}"));
    let (result, transcript) =
        connect_scripted(f.options(), password(PASSWORD), Answers::default()).await;
    assert!(result.is_ok());
    assert!(transcript.host_keys.is_empty());
}

#[tokio::test]
async fn rejecting_host_key_stops_before_auth_and_saves_nothing() {
    let f = Fixture::new().await;
    let answers = Answers {
        trust_host: false,
        ..Default::default()
    };
    let (result, transcript) = connect_scripted(f.options(), password(PASSWORD), answers).await;
    assert!(matches!(result, Err(ConnectError::HostKeyRejected)));
    assert!(!transcript.stages.contains(&Stage::Authenticating));
    assert!(!f.known_hosts().exists());
}

#[tokio::test]
async fn changed_host_key_is_blocked_without_asking() {
    let f = Fixture::new().await;
    known_hosts::remember(
        &f.known_hosts(),
        "127.0.0.1",
        f.server.port,
        new_key().public_key(),
    )
    .unwrap();
    let (result, transcript) =
        connect_scripted(f.options(), password(PASSWORD), Answers::default()).await;
    assert!(matches!(result, Err(ConnectError::HostKeyChanged { .. })));
    assert!(transcript.host_keys.is_empty());
    assert!(!transcript.stages.contains(&Stage::Authenticating));
}

#[tokio::test]
async fn connection_refused_is_a_network_error() {
    let dir = tempfile::tempdir().unwrap();
    let port = {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.local_addr().unwrap().port()
    };
    let (result, _) = connect_scripted(
        options(port, &dir.path().join("known_hosts")),
        password(PASSWORD),
        Answers::default(),
    )
    .await;
    assert!(matches!(result, Err(ConnectError::Network(_))));
}
