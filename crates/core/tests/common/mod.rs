#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::keys::{Algorithm, PrivateKey, PublicKey};
use russh::server::{self, Auth as ServerAuth, Msg, Session as ServerSession};
use russh::{Channel, ChannelId, MethodKind, MethodSet, Pty};
use sshtool_core::connection::{
    Auth, ConnectError, ConnectEvent, ConnectOptions, HostKeyInfo, Prompt, Session, Stage,
};
use sshtool_core::terminal::{Terminal, TerminalEvent, TerminalSize};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use zeroize::Zeroizing;

pub const PASSWORD: &str = "correct horse";
pub const OTP: &str = "123456";
pub const FLOOD_CHUNK: usize = 32 * 1024;
pub const FLOOD_CHUNKS: usize = 512;
pub const FLOOD_BYTES: usize = FLOOD_CHUNK * FLOOD_CHUNKS;
pub const SIZE: TerminalSize = TerminalSize { cols: 80, rows: 24 };

pub fn new_key() -> PrivateKey {
    PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap()
}

#[derive(Default, Clone)]
pub struct Observed {
    pub pty: Arc<Mutex<Option<(String, u32, u32)>>>,
    pub resizes: Arc<Mutex<Vec<(u32, u32)>>>,
    pub erase_char: Arc<Mutex<Option<u32>>>,
}

#[derive(Clone)]
pub struct ServerOptions {
    pub client_key: PublicKey,
    /// Password login succeeds only partially, then requires keyboard-interactive.
    pub second_factor: bool,
    pub refuse_shell: bool,
}

pub struct TestServer {
    pub port: u16,
    pub host_key: PublicKey,
    pub observed: Observed,
    accept: tokio::task::JoinHandle<()>,
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.accept.abort();
    }
}

pub async fn start_server(options: ServerOptions) -> TestServer {
    start_server_with_key(options, new_key()).await
}

pub async fn start_server_with_key(options: ServerOptions, host_key: PrivateKey) -> TestServer {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let public = host_key.public_key().clone();
    let config = Arc::new(server::Config {
        keys: vec![host_key],
        auth_rejection_time: Duration::ZERO,
        auth_rejection_time_initial: Some(Duration::ZERO),
        ..Default::default()
    });
    let observed = Observed::default();
    let handler_observed = observed.clone();
    let accept = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let handler = ServerHandler {
                options: options.clone(),
                observed: handler_observed.clone(),
                otp_asked: false,
            };
            let config = config.clone();
            tokio::spawn(async move {
                if let Ok(session) = server::run_stream(config, stream, handler).await {
                    let _ = session.await;
                }
            });
        }
    });
    TestServer {
        port,
        host_key: public,
        observed,
        accept,
    }
}

struct ServerHandler {
    options: ServerOptions,
    observed: Observed,
    otp_asked: bool,
}

/// Offers the same methods again, as OpenSSH does after a failed attempt.
fn reject() -> ServerAuth {
    ServerAuth::Reject {
        proceed_with_methods: Some(MethodSet::from(
            &[
                MethodKind::Password,
                MethodKind::PublicKey,
                MethodKind::KeyboardInteractive,
            ][..],
        )),
        partial_success: false,
    }
}

impl server::Handler for ServerHandler {
    type Error = russh::Error;

    async fn auth_password(&mut self, _: &str, password: &str) -> Result<ServerAuth, Self::Error> {
        if password != PASSWORD {
            return Ok(reject());
        }
        if self.options.second_factor {
            return Ok(ServerAuth::Reject {
                proceed_with_methods: Some(MethodSet::from(&[MethodKind::KeyboardInteractive][..])),
                partial_success: true,
            });
        }
        Ok(ServerAuth::Accept)
    }

    async fn auth_publickey(
        &mut self,
        _: &str,
        key: server::VerifiedPublicKey<'_>,
    ) -> Result<ServerAuth, Self::Error> {
        Ok(if *key.public_key == self.options.client_key {
            ServerAuth::Accept
        } else {
            reject()
        })
    }

    async fn auth_keyboard_interactive<'a>(
        &'a mut self,
        _: &str,
        _: &str,
        response: Option<server::Response<'a>>,
    ) -> Result<ServerAuth, Self::Error> {
        if !self.otp_asked {
            self.otp_asked = true;
            return Ok(ServerAuth::Partial {
                name: "2FA".into(),
                instructions: "Enter code".into(),
                prompts: vec![("Code: ".into(), false)].into(),
            });
        }
        let accepted = response
            .and_then(|mut answers| {
                answers
                    .next()
                    .map(|answer| answer.as_ref() == OTP.as_bytes())
            })
            .unwrap_or(false);
        Ok(if accepted {
            ServerAuth::Accept
        } else {
            reject()
        })
    }

    async fn channel_open_session(
        &mut self,
        mut channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut ServerSession,
    ) -> Result<(), Self::Error> {
        // Unread channel messages would eventually block the whole server session.
        tokio::spawn(async move { while channel.wait().await.is_some() {} });
        reply.accept().await;
        Ok(())
    }

    async fn pty_request(
        &mut self,
        _: ChannelId,
        term: &str,
        cols: u32,
        rows: u32,
        _: u32,
        _: u32,
        modes: &[(Pty, u32)],
        _: &mut ServerSession,
    ) -> Result<(), Self::Error> {
        *self.observed.pty.lock().unwrap() = Some((term.to_string(), cols, rows));
        *self.observed.erase_char.lock().unwrap() = modes
            .iter()
            .find(|(mode, _)| *mode == Pty::VERASE)
            .map(|(_, value)| *value);
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut ServerSession,
    ) -> Result<(), Self::Error> {
        if self.options.refuse_shell {
            session.channel_failure(channel)?;
        } else {
            session.channel_success(channel)?;
            session.data(channel, b"welcome\r\n".to_vec())?;
        }
        Ok(())
    }

    async fn window_change_request(
        &mut self,
        _: ChannelId,
        cols: u32,
        rows: u32,
        _: u32,
        _: u32,
        _: &mut ServerSession,
    ) -> Result<(), Self::Error> {
        self.observed.resizes.lock().unwrap().push((cols, rows));
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut ServerSession,
    ) -> Result<(), Self::Error> {
        match data {
            b"exit" => {
                session.exit_status_request(channel, 7)?;
                session.close(channel)?;
            }
            b"die" => return Err(russh::Error::Disconnect),
            b"flood" => {
                let handle = session.handle();
                tokio::spawn(async move {
                    for _ in 0..FLOOD_CHUNKS {
                        if handle.data(channel, vec![b'x'; FLOOD_CHUNK]).await.is_err() {
                            return;
                        }
                    }
                });
            }
            echo => session.data(channel, echo.to_vec())?,
        }
        Ok(())
    }
}

pub fn options(port: u16, known_hosts: &Path) -> ConnectOptions {
    ConnectOptions {
        host: "127.0.0.1".into(),
        port,
        user: "tester".into(),
        known_hosts: known_hosts.to_path_buf(),
    }
}

pub fn password(value: &str) -> Auth {
    Auth::Password {
        password: Zeroizing::new(value.to_string()),
    }
}

#[derive(Clone)]
pub struct Answers {
    pub trust_host: bool,
    pub prompt_answers: Vec<Option<Vec<String>>>,
}

impl Default for Answers {
    fn default() -> Self {
        Self {
            trust_host: true,
            prompt_answers: Vec::new(),
        }
    }
}

#[derive(Default, Debug)]
pub struct Transcript {
    pub stages: Vec<Stage>,
    pub host_keys: Vec<HostKeyInfo>,
    pub prompts: Vec<Prompt>,
}

/// Connects while answering UI prompts from a script, and records what was asked.
pub async fn connect_scripted(
    options: ConnectOptions,
    auth: Auth,
    answers: Answers,
) -> (Result<Session, ConnectError>, Transcript) {
    let (events, mut queue) = mpsc::channel(8);
    let driver = tokio::spawn(async move {
        let mut transcript = Transcript::default();
        let mut scripted = answers.prompt_answers.into_iter();
        while let Some(event) = queue.recv().await {
            match event {
                ConnectEvent::Stage(stage) => transcript.stages.push(stage),
                ConnectEvent::HostKey { info, reply } => {
                    transcript.host_keys.push(info);
                    let _ = reply.send(answers.trust_host);
                }
                ConnectEvent::Prompt { prompt, reply } => {
                    transcript.prompts.push(prompt);
                    let answer = scripted
                        .next()
                        .flatten()
                        .map(|values| values.into_iter().map(Zeroizing::new).collect());
                    let _ = reply.send(answer);
                }
            }
        }
        transcript
    });
    let result = Session::connect(options, auth, events).await;
    (result, driver.await.unwrap())
}

pub async fn connected(server: &TestServer, known_hosts: &Path) -> Session {
    connect_scripted(
        options(server.port, known_hosts),
        password(PASSWORD),
        Answers::default(),
    )
    .await
    .0
    .unwrap_or_else(|error| panic!("{error}"))
}

pub struct OpenTerminal {
    pub terminal: Terminal,
    pub events: mpsc::UnboundedReceiver<TerminalEvent>,
}

pub async fn open(session: &Session, size: TerminalSize) -> OpenTerminal {
    let (sender, events) = mpsc::unbounded_channel();
    let terminal = session
        .open_terminal(size, move |event| {
            let _ = sender.send(event);
        })
        .await
        .unwrap();
    OpenTerminal { terminal, events }
}

impl OpenTerminal {
    /// Acknowledges output until `needle` shows up, and returns everything read so far.
    pub async fn read_until(&mut self, needle: &[u8]) -> Vec<u8> {
        let mut output = Vec::new();
        tokio::time::timeout(Duration::from_secs(15), async {
            let mut searched = 0;
            loop {
                if output[searched..]
                    .windows(needle.len())
                    .any(|window| window == needle)
                {
                    return;
                }
                searched = output.len().saturating_sub(needle.len() - 1);
                match self.events.recv().await {
                    Some(TerminalEvent::Output(bytes)) => {
                        self.terminal.ack(bytes.len());
                        output.extend_from_slice(&bytes);
                    }
                    other => panic!(
                        "expected {:?}, got {other:?} after {:?}",
                        String::from_utf8_lossy(needle),
                        String::from_utf8_lossy(&output)
                    ),
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out; got {:?}", String::from_utf8_lossy(&output)));
        output
    }
}

pub fn write_key(dir: &Path, name: &str, key: &PrivateKey) -> PathBuf {
    let path = dir.join(name);
    let encoded = key
        .to_openssh(russh::keys::ssh_key::LineEnding::LF)
        .unwrap();
    std::fs::write(&path, encoded.as_bytes()).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    path
}
