//! Runs against a real OpenSSH server and agent, which the in-process test server cannot stand in
//! for. Skipped where they are not installed.
#![cfg(unix)]

mod common;

use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use common::*;
use sshtool_core::connection::{Auth, ConnectOptions};
use sshtool_core::terminal::{TerminalEnd, TerminalEvent, TerminalSize};

const SSHD: &str = "/usr/sbin/sshd";

struct Kill(Child);

impl Drop for Kill {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    listener.local_addr().unwrap().port()
}

fn start_sshd(dir: &Path, port: u16, authorized: &str) -> Kill {
    let host_key = write_key(dir, "ssh_host_ed25519_key", &new_key());
    let authorized_keys = dir.join("authorized_keys");
    std::fs::write(&authorized_keys, authorized).unwrap();
    let config = dir.join("sshd_config");
    std::fs::write(
        &config,
        format!(
            "Port {port}\nListenAddress 127.0.0.1\nHostKey {}\nAuthorizedKeysFile {}\n\
             PidFile {}\nStrictModes no\nUsePAM no\nPasswordAuthentication no\n\
             KbdInteractiveAuthentication no\n",
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

async fn wait_for_port(port: u16) {
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

fn start_agent(dir: &Path) -> Option<(Kill, std::path::PathBuf)> {
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

fn current_user() -> String {
    let output = Command::new("id").arg("-un").output().unwrap();
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}

// A single test because SSH_AUTH_SOCK is process-wide state.
#[test]
fn real_openssh_server_and_agent() {
    if !Path::new(SSHD).exists() {
        eprintln!("skipped: {SSHD} not found");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let key_path_key = new_key();
    let agent_key = new_key();
    let key_path = write_key(dir.path(), "id_file", &key_path_key);
    let agent_key_path = write_key(dir.path(), "id_agent", &agent_key);
    let authorized = format!(
        "{}\n{}\n",
        key_path_key.public_key().to_openssh().unwrap(),
        agent_key.public_key().to_openssh().unwrap()
    );
    let port = free_port();
    let _sshd = start_sshd(dir.path(), port, &authorized);

    let agent = start_agent(dir.path());
    if let Some((_, socket)) = &agent {
        let status = Command::new("ssh-add")
            .arg(&agent_key_path)
            .env("SSH_AUTH_SOCK", socket)
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
        // SAFETY: set before the runtime starts, while this test is the only thread reading it.
        unsafe { std::env::set_var("SSH_AUTH_SOCK", socket) };
    }

    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        wait_for_port(port).await;
        let options = ConnectOptions {
            host: "127.0.0.1".into(),
            port,
            user: current_user(),
            known_hosts: dir.path().join("known_hosts"),
        };

        if agent.is_some() {
            let (result, _) =
                connect_scripted(options.clone(), Auth::Agent, Answers::default()).await;
            let session = result.unwrap_or_else(|error| panic!("agent login: {error}"));
            session.disconnect().await;
        }

        let auth = Auth::Key {
            path: key_path,
            passphrase: None,
        };
        let session = connect_scripted(options, auth, Answers::default())
            .await
            .0
            .unwrap_or_else(|error| panic!("key login: {error}"));

        let mut term = open(
            &session,
            TerminalSize {
                cols: 120,
                rows: 40,
            },
        )
        .await;

        term.terminal
            .write(b"stty size; echo TERM=$TERM; echo done$((1))\n".to_vec());
        let output = term.read_until(b"done1\r\n").await;
        let text = String::from_utf8_lossy(&output);
        assert!(text.contains("40 120"), "{text}");
        assert!(text.contains("TERM=xterm-256color"), "{text}");

        term.terminal.resize(TerminalSize { cols: 90, rows: 30 });
        term.terminal
            .write(b"stty size; echo done$((2))\n".to_vec());
        let output = term.read_until(b"done2\r\n").await;
        assert!(String::from_utf8_lossy(&output).contains("30 90"));

        // A full-screen program must get the alternate screen, and leave it again on exit.
        if Command::new("sh")
            .args(["-c", "command -v vim"])
            .stdout(Stdio::null())
            .status()
            .unwrap()
            .success()
        {
            term.terminal.write(b"vim -u NONE -n\n".to_vec());
            term.read_until(b"\x1b[?1049h").await;
            term.terminal.write(b":q\r".to_vec());
            term.read_until(b"\x1b[?1049l").await;
        }

        term.terminal
            .write("printf '中文%s\\n' ✓\n".as_bytes().to_vec());
        term.read_until("中文✓\r\n".as_bytes()).await;

        term.terminal
            .write(b"head -c 20000000 /dev/zero | tr '\\0' x; echo; echo done$((3))\n".to_vec());
        let started = std::time::Instant::now();
        let output = term.read_until(b"done3\r\n").await;
        assert!(output.len() > 20_000_000);
        eprintln!("20 MB of output took {:?}", started.elapsed());

        term.terminal.write(b"exit 3\n".to_vec());
        let end = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                match term.events.recv().await {
                    Some(TerminalEvent::Output(bytes)) => term.terminal.ack(bytes.len()),
                    Some(TerminalEvent::End(end)) => return end,
                    None => panic!("event stream ended"),
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(end, TerminalEnd::Exited { status: Some(3) });
    });
}
