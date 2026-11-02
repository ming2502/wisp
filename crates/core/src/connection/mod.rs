mod auth;
pub mod known_hosts;

use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, Handle, Handler};
use russh::keys::{self, HashAlg, PublicKey, PublicKeyOrCertificate};
use russh::{Disconnect, Preferred, mac};
use serde::Serialize;
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::sync::{Notify, mpsc, oneshot};
use zeroize::Zeroizing;

pub use auth::Auth;
use known_hosts::HostKeyVerdict;

const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);
const TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Time allowed from TCP connected until the server presents its host key.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Error)]
pub enum ConnectError {
    #[error("连接参数无效：{0}")]
    InvalidTarget(&'static str),
    #[error("无法连接服务器：{0}")]
    Network(#[from] std::io::Error),
    #[error("连接超时")]
    Timeout,
    #[error("SSH 协议错误：{0}")]
    Protocol(#[from] russh::Error),
    #[error(
        "服务器主机密钥已变化，已阻止连接。这可能是中间人攻击，也可能是服务器重装。\
         新指纹：{fingerprint}。确认安全后，请手动删除 {path} 第 {line} 行的旧记录"
    )]
    HostKeyChanged {
        fingerprint: String,
        path: String,
        line: usize,
    },
    #[error("服务器主机密钥已被吊销，已阻止连接。指纹：{fingerprint}")]
    HostKeyRevoked { fingerprint: String },
    #[error("未信任服务器主机密钥，已取消连接")]
    HostKeyRejected,
    #[error("无法读取 known_hosts：{0}")]
    KnownHosts(#[from] keys::Error),
    #[error("认证失败，请检查用户名和凭据")]
    AuthFailed,
    #[error("已取消")]
    Cancelled,
    #[error("无法使用私钥 {path}：{reason}")]
    KeyFile { path: String, reason: String },
    #[error("私钥口令不正确")]
    BadPassphrase,
    #[error("SSH Agent 不可用：{0}")]
    Agent(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    Connecting,
    Authenticating,
    Ready,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PromptField {
    pub label: String,
    pub echo: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Prompt {
    Passphrase {
        path: String,
        retry: bool,
    },
    KeyboardInteractive {
        name: String,
        instructions: String,
        fields: Vec<PromptField>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyInfo {
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint: String,
    pub other_algorithms_known: bool,
}

/// What a connection attempt needs from the UI. Dropping a reply counts as declining.
pub enum ConnectEvent {
    Stage(Stage),
    HostKey {
        info: HostKeyInfo,
        reply: oneshot::Sender<bool>,
    },
    Prompt {
        prompt: Prompt,
        reply: oneshot::Sender<Option<Vec<Zeroizing<String>>>>,
    },
}

#[derive(Debug, Clone)]
pub struct ConnectOptions {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub known_hosts: PathBuf,
}

impl ConnectOptions {
    /// The host is later written into known_hosts, where whitespace or a comma would change the
    /// meaning of the line.
    fn validate(&self) -> Result<(), ConnectError> {
        let bad_host = |c: char| c.is_whitespace() || c.is_control() || c == ',';
        if self.host.is_empty() || self.host.contains(bad_host) {
            return Err(ConnectError::InvalidTarget("主机地址"));
        }
        if self.user.is_empty() || self.user.contains(char::is_control) {
            return Err(ConnectError::InvalidTarget("用户名"));
        }
        if self.port == 0 {
            return Err(ConnectError::InvalidTarget("端口"));
        }
        Ok(())
    }
}

pub(crate) struct ClientHandler {
    options: ConnectOptions,
    // Weak because the handler lives as long as the session, while the events only matter during
    // the connection attempt.
    events: mpsc::WeakSender<ConnectEvent>,
    host_key_received: Arc<Notify>,
}

impl Handler for ClientHandler {
    type Error = ConnectError;

    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        self.host_key_received.notify_one();
        // A certificate is pinned by its underlying key, since no CA is configured.
        let key = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(certificate) => {
                PublicKey::from(certificate.public_key().clone())
            }
        };
        let ConnectOptions {
            host,
            port,
            known_hosts: path,
            ..
        } = &self.options;
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        match known_hosts::check(path, host, *port, &key)? {
            HostKeyVerdict::Trusted => Ok(true),
            HostKeyVerdict::Changed { line } => Err(ConnectError::HostKeyChanged {
                fingerprint,
                path: path.display().to_string(),
                line,
            }),
            HostKeyVerdict::Revoked => Err(ConnectError::HostKeyRevoked { fingerprint }),
            HostKeyVerdict::Unknown {
                other_algorithms_known,
            } => {
                let (reply, answer) = oneshot::channel();
                let info = HostKeyInfo {
                    host: host.clone(),
                    port: *port,
                    algorithm: key.algorithm().to_string(),
                    fingerprint,
                    other_algorithms_known,
                };
                let events = self.events.upgrade().ok_or(ConnectError::HostKeyRejected)?;
                let sent = events.send(ConnectEvent::HostKey { info, reply }).await;
                drop(events);
                if sent.is_err() || !answer.await.unwrap_or(false) {
                    return Err(ConnectError::HostKeyRejected);
                }
                // The user made a decision for this connection, so failing to persist it only
                // means being asked again next time.
                if let Err(error) = known_hosts::remember(path, host, *port, &key) {
                    log::warn!("could not update {}: {error}", path.display());
                }
                Ok(true)
            }
        }
    }
}

pub struct Session {
    pub(crate) handle: Arc<Handle<ClientHandler>>,
}

impl Session {
    pub async fn connect(
        options: ConnectOptions,
        auth: Auth,
        events: mpsc::Sender<ConnectEvent>,
    ) -> Result<Self, ConnectError> {
        options.validate()?;
        let _ = events.send(ConnectEvent::Stage(Stage::Connecting)).await;
        let address = (options.host.as_str(), options.port);
        let stream = tokio::time::timeout(TCP_CONNECT_TIMEOUT, TcpStream::connect(address))
            .await
            .map_err(|_| ConnectError::Timeout)??;
        stream.set_nodelay(true)?;
        Self::connect_over(stream, options, auth, events).await
    }

    /// Runs SSH over any byte stream, so that a jump host can later supply a tunnelled one.
    pub async fn connect_over<S>(
        stream: S,
        options: ConnectOptions,
        auth: Auth,
        events: mpsc::Sender<ConnectEvent>,
    ) -> Result<Self, ConnectError>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        options.validate()?;
        let user = options.user.clone();
        let host_key_received = Arc::new(Notify::new());
        let handler = ClientHandler {
            options,
            events: events.downgrade(),
            host_key_received: host_key_received.clone(),
        };
        let handshake = client::connect_stream(Arc::new(client_config()), stream, handler);
        tokio::pin!(handshake);
        // The user may take as long as they like to review the host key, so the timeout only
        // guards the phase before the key arrives.
        let mut handle = tokio::select! {
            result = &mut handshake => result?,
            _ = host_key_received.notified() => handshake.await?,
            _ = tokio::time::sleep(HANDSHAKE_TIMEOUT) => return Err(ConnectError::Timeout),
        };

        let _ = events
            .send(ConnectEvent::Stage(Stage::Authenticating))
            .await;
        auth::authenticate(&mut handle, &user, auth, &events).await?;
        let _ = events.send(ConnectEvent::Stage(Stage::Ready)).await;
        Ok(Self {
            handle: Arc::new(handle),
        })
    }

    pub fn is_closed(&self) -> bool {
        self.handle.is_closed()
    }

    pub async fn disconnect(&self) {
        let _ = self
            .handle
            .disconnect(Disconnect::ByApplication, "", "")
            .await;
    }
}

fn client_config() -> client::Config {
    client::Config {
        keepalive_interval: Some(KEEPALIVE_INTERVAL),
        preferred: preferred_algorithms(),
        ..Default::default()
    }
}

/// russh leaves out HMAC-SHA1, but OpenSSH clients still offer it and some servers accept nothing
/// else. It stays last, so it is only chosen when the server offers no SHA-2 MAC.
fn preferred_algorithms() -> Preferred {
    let mut macs = Preferred::DEFAULT.mac.into_owned();
    macs.extend([mac::HMAC_SHA1_ETM, mac::HMAC_SHA1]);
    Preferred {
        mac: Cow::Owned(macs),
        ..Preferred::DEFAULT
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(host: &str, user: &str, port: u16) -> ConnectOptions {
        ConnectOptions {
            host: host.into(),
            port,
            user: user.into(),
            known_hosts: PathBuf::new(),
        }
    }

    #[test]
    fn client_config_enables_keepalive() {
        assert_eq!(client_config().keepalive_interval, Some(KEEPALIVE_INTERVAL));
    }

    #[test]
    fn prefers_sha2_macs_and_falls_back_to_sha1() {
        let macs = preferred_algorithms().mac;
        let position = |name| macs.iter().position(|mac| *mac == name).unwrap();
        assert!(position(mac::HMAC_SHA256) < position(mac::HMAC_SHA1_ETM));
        assert_eq!(macs[macs.len() - 2..], [mac::HMAC_SHA1_ETM, mac::HMAC_SHA1]);
    }

    #[test]
    fn rejects_hosts_that_would_corrupt_known_hosts() {
        for host in ["", "a b", "a,b", "a\nb", "a\tb"] {
            assert!(options(host, "root", 22).validate().is_err(), "{host:?}");
        }
    }

    #[test]
    fn accepts_names_and_addresses() {
        for host in ["example.com", "10.0.0.1", "::1", "服务器.example"] {
            assert!(options(host, "root", 22).validate().is_ok(), "{host:?}");
        }
    }

    #[test]
    fn rejects_empty_user_and_zero_port() {
        assert!(options("a", "", 22).validate().is_err());
        assert!(options("a", "root", 0).validate().is_err());
    }
}
