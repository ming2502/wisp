//! A real OpenSSH server for tests that the in-process russh server cannot stand in for.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use wisp_core::connection::{Auth, ConnectOptions, Session};

use super::*;

pub const SSHD: &str = "/usr/sbin/sshd";

pub struct Kill(Child);

impl Drop for Kill {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

pub fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    listener.local_addr().unwrap().port()
}

pub fn start_sshd(dir: &Path, port: u16, authorized: &str) -> Kill {
    let host_key = write_key(dir, "ssh_host_ed25519_key", &new_key());
    let authorized_keys = dir.join("authorized_keys");
    std::fs::write(&authorized_keys, authorized).unwrap();
    let config = dir.join("sshd_config");
    std::fs::write(
        &config,
        format!(
            "Port {port}\nListenAddress 127.0.0.1\nHostKey {}\nAuthorizedKeysFile {}\n\
             PidFile {}\nStrictModes no\nUsePAM no\nPasswordAuthentication no\n\
             KbdInteractiveAuthentication no\nSubsystem sftp internal-sftp\n",
            host_key.display(),
            authorized_keys.display(),
            dir.join("sshd.pid").display(),
        ),
    )
    .unwrap();
    let child = Command::new(SSHD)
        .args(["-D", "-e", "-f"])
        .arg(&config)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    Kill(child)
}

pub async fn wait_for_port(port: u16) {
    for _ in 0..100 {
        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok()
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("sshd did not start listening on {port}");
}

pub fn start_agent(dir: &Path) -> Option<(Kill, PathBuf)> {
    let socket = dir.join("agent.sock");
    let child = Command::new("ssh-agent")
        .args(["-D", "-a"])
        .arg(&socket)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let agent = Kill(child);
    for _ in 0..100 {
        if socket.exists() {
            return Some((agent, socket));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("ssh-agent did not create its socket");
}

pub fn current_user() -> String {
    let output = Command::new("id").arg("-un").output().unwrap();
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}

/// A real sshd that accepts one generated key, with a connected session. The server serves this
/// machine's file system, so tests can check remote changes with `std::fs`.
pub struct RealServer {
    pub dir: tempfile::TempDir,
    pub session: Session,
    _sshd: Kill,
}

impl RealServer {
    /// `None` where OpenSSH is not installed, so callers can skip.
    pub async fn start() -> Option<Self> {
        if !Path::new(SSHD).exists() {
            eprintln!("skipped: {SSHD} not found");
            return None;
        }
        let dir = tempfile::tempdir().unwrap();
        let key = new_key();
        let key_path = write_key(dir.path(), "id", &key);
        let authorized = format!("{}\n", key.public_key().to_openssh().unwrap());
        let port = free_port();
        let sshd = start_sshd(dir.path(), port, &authorized);
        wait_for_port(port).await;
        let options = ConnectOptions {
            host: "127.0.0.1".into(),
            port,
            user: current_user(),
            known_hosts: dir.path().join("known_hosts"),
        };
        let auth = Auth::Key {
            path: key_path,
            passphrase: None,
        };
        let session = connect_scripted(options, auth, Answers::default())
            .await
            .0
            .unwrap_or_else(|error| panic!("{error}"));
        Some(Self {
            dir,
            session,
            _sshd: sshd,
        })
    }

    /// A fresh directory for a test to work in, as both a local and a remote path.
    pub fn workspace(&self, name: &str) -> (PathBuf, String) {
        let path = self.dir.path().join(name);
        std::fs::create_dir_all(&path).unwrap();
        let path = path.canonicalize().unwrap();
        let remote = path.to_string_lossy().into_owned();
        (path, remote)
    }
}
