use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use russh::MethodKind;
use russh::client::{AuthResult, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::agent::AgentIdentity;
use russh::keys::agent::client::AgentClient;
use russh::keys::{self, PrivateKey, PrivateKeyWithHashAlg};
use serde::Deserialize;
use tokio::sync::{mpsc, oneshot};
use zeroize::Zeroizing;

use super::{ClientHandler, ConnectError, ConnectEvent, Prompt};

/// Covers server replies and agent signing, which may wait for a hardware key touch.
/// Time the user spends answering a prompt is not counted.
const AUTH_STEP_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_PASSPHRASE_ATTEMPTS: usize = 3;
const MAX_PASSWORD_ATTEMPTS: usize = 3;
const MAX_KEYBOARD_INTERACTIVE_ROUNDS: usize = 32;

/// Deliberately has no `Debug` so that secrets cannot reach logs through formatting.
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Auth {
    Password {
        password: Zeroizing<String>,
    },
    Key {
        path: PathBuf,
        passphrase: Option<Zeroizing<String>>,
    },
    Agent,
    KeyboardInteractive,
    /// Asks for the password once the host key is settled, as ssh does, with a few retries.
    #[serde(skip)]
    AskPassword,
}

pub(super) async fn authenticate(
    handle: &mut Handle<ClientHandler>,
    user: &str,
    auth: Auth,
    events: &mpsc::Sender<ConnectEvent>,
) -> Result<(), ConnectError> {
    let result = match auth {
        Auth::Password { password } => {
            step(handle.authenticate_password(user, password.as_str())).await??
        }
        Auth::Key { path, passphrase } => {
            let key = load_key(&path, passphrase, events).await?;
            authenticate_key(handle, user, key).await?
        }
        Auth::Agent => authenticate_agent(handle, user).await?,
        Auth::AskPassword => ask_password(handle, user, events).await?,
        Auth::KeyboardInteractive => return keyboard_interactive(handle, user, events).await,
    };
    match result {
        AuthResult::Success => Ok(()),
        // The server wants a second factor, or only offers password login through PAM.
        AuthResult::Failure {
            remaining_methods,
            partial_success,
        } if remaining_methods.contains(&MethodKind::KeyboardInteractive)
            && (partial_success || !remaining_methods.contains(&MethodKind::Password)) =>
        {
            keyboard_interactive(handle, user, events).await
        }
        AuthResult::Failure { .. } => Err(ConnectError::AuthFailed),
    }
}

async fn step<F: Future>(future: F) -> Result<F::Output, ConnectError> {
    tokio::time::timeout(AUTH_STEP_TIMEOUT, future)
        .await
        .map_err(|_| ConnectError::Timeout)
}

async fn ask_password(
    handle: &mut Handle<ClientHandler>,
    user: &str,
    events: &mpsc::Sender<ConnectEvent>,
) -> Result<AuthResult, ConnectError> {
    for attempt in 0..MAX_PASSWORD_ATTEMPTS {
        let answer = ask(events, |reply| ConnectEvent::Prompt {
            prompt: Prompt::Password { retry: attempt > 0 },
            reply,
        })
        .await;
        let mut values = answer.flatten().ok_or(ConnectError::Cancelled)?;
        let password = values.pop().ok_or(ConnectError::Cancelled)?;
        let result = step(handle.authenticate_password(user, password.as_str())).await??;
        let wrong = matches!(
            &result,
            AuthResult::Failure { partial_success: false, remaining_methods }
                if remaining_methods.contains(&MethodKind::Password)
        );
        if !wrong || attempt + 1 == MAX_PASSWORD_ATTEMPTS {
            return Ok(result);
        }
    }
    unreachable!("the last attempt always returns")
}

async fn ask<T>(
    events: &mpsc::Sender<ConnectEvent>,
    build: impl FnOnce(oneshot::Sender<T>) -> ConnectEvent,
) -> Option<T> {
    let (reply, answer) = oneshot::channel();
    events.send(build(reply)).await.ok()?;
    answer.await.ok()
}

async fn load_key(
    path: &Path,
    mut passphrase: Option<Zeroizing<String>>,
    events: &mpsc::Sender<ConnectEvent>,
) -> Result<PrivateKey, ConnectError> {
    let path = expand_home(path);
    for attempt in 0..=MAX_PASSPHRASE_ATTEMPTS {
        let error = match keys::load_secret_key(&path, passphrase.as_ref().map(|p| p.as_str())) {
            Ok(key) => return Ok(key),
            Err(error @ keys::Error::IO(_)) => return Err(key_file_error(&path, error)),
            Err(error) => error,
        };
        let encrypted = passphrase.is_some() || matches!(error, keys::Error::KeyIsEncrypted);
        if !encrypted {
            return Err(key_file_error(&path, error));
        }
        if attempt == MAX_PASSPHRASE_ATTEMPTS {
            break;
        }
        let answer = ask(events, |reply| ConnectEvent::Prompt {
            prompt: Prompt::Passphrase {
                path: path.display().to_string(),
                retry: passphrase.is_some(),
            },
            reply,
        })
        .await;
        let mut values = answer.flatten().ok_or(ConnectError::Cancelled)?;
        passphrase = Some(values.pop().ok_or(ConnectError::Cancelled)?);
    }
    Err(ConnectError::BadPassphrase)
}

fn expand_home(path: &Path) -> PathBuf {
    match (path.strip_prefix("~"), std::env::home_dir()) {
        (Ok(rest), Some(home)) => home.join(rest),
        _ => path.to_path_buf(),
    }
}

fn key_file_error(path: &Path, error: keys::Error) -> ConnectError {
    ConnectError::KeyFile {
        path: path.display().to_string(),
        reason: error.to_string(),
    }
}

async fn authenticate_key(
    handle: &mut Handle<ClientHandler>,
    user: &str,
    key: PrivateKey,
) -> Result<AuthResult, ConnectError> {
    let hash = if key.algorithm().is_rsa() {
        step(handle.best_supported_rsa_hash()).await??.flatten()
    } else {
        None
    };
    let key = PrivateKeyWithHashAlg::new(Arc::new(key), hash);
    Ok(step(handle.authenticate_publickey(user, key)).await??)
}

async fn authenticate_agent(
    handle: &mut Handle<ClientHandler>,
    user: &str,
) -> Result<AuthResult, ConnectError> {
    let mut agent = connect_agent().await?;
    let identities = step(agent.request_identities())
        .await?
        .map_err(|error| ConnectError::Agent(error.to_string()))?;
    let keys: Vec<_> = identities
        .into_iter()
        .filter_map(|identity| match identity {
            AgentIdentity::PublicKey { key, .. } => Some(key),
            AgentIdentity::Certificate { .. } => None,
        })
        .collect();
    if keys.is_empty() {
        return Err(ConnectError::Agent("代理中没有可用的密钥".into()));
    }

    let mut last = None;
    for key in keys {
        let hash = if key.algorithm().is_rsa() {
            step(handle.best_supported_rsa_hash()).await??.flatten()
        } else {
            None
        };
        let result = step(handle.authenticate_publickey_with(user, key, hash, &mut agent))
            .await?
            .map_err(|error| ConnectError::Agent(error.to_string()))?;
        match result {
            AuthResult::Failure {
                partial_success: false,
                ..
            } => last = Some(result),
            done => return Ok(done),
        }
    }
    last.ok_or(ConnectError::AuthFailed)
}

type DynAgent = AgentClient<Box<dyn keys::agent::client::AgentStream + Send + Unpin + 'static>>;

#[cfg(unix)]
async fn connect_agent() -> Result<DynAgent, ConnectError> {
    AgentClient::connect_env()
        .await
        .map(AgentClient::dynamic)
        .map_err(|error| ConnectError::Agent(error.to_string()))
}

#[cfg(windows)]
async fn connect_agent() -> Result<DynAgent, ConnectError> {
    AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent")
        .await
        .map(AgentClient::dynamic)
        .map_err(|error| ConnectError::Agent(error.to_string()))
}

async fn keyboard_interactive(
    handle: &mut Handle<ClientHandler>,
    user: &str,
    events: &mpsc::Sender<ConnectEvent>,
) -> Result<(), ConnectError> {
    let mut response = step(handle.authenticate_keyboard_interactive_start(user, None)).await??;
    for _ in 0..MAX_KEYBOARD_INTERACTIVE_ROUNDS {
        let answers = match response {
            KeyboardInteractiveAuthResponse::Success => return Ok(()),
            KeyboardInteractiveAuthResponse::Failure { .. } => {
                return Err(ConnectError::AuthFailed);
            }
            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } if prompts.is_empty() => {
                Vec::new()
            }
            KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => {
                let answer = ask(events, |reply| ConnectEvent::Prompt {
                    prompt: Prompt::KeyboardInteractive {
                        name,
                        instructions,
                        fields: prompts
                            .into_iter()
                            .map(|prompt| super::PromptField {
                                label: prompt.prompt,
                                echo: prompt.echo,
                            })
                            .collect(),
                    },
                    reply,
                })
                .await;
                answer.flatten().ok_or(ConnectError::Cancelled)?
            }
        };
        let answers = answers.iter().map(|answer| answer.to_string()).collect();
        response = step(handle.authenticate_keyboard_interactive_respond(answers)).await??;
    }
    Err(ConnectError::AuthFailed)
}
