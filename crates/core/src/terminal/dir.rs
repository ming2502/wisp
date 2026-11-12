//! Where the shell in the terminal currently is, so the file view can follow it.
//!
//! Every channel of one SSH connection is served by the same server process, so a command run on
//! its own channel shares a parent with the terminal's shell. The command looks among its parent's
//! children for the one on a terminal, and reads the working directory of whatever runs in the
//! foreground there (the shell at its prompt, or a program started from it), falling back to the
//! shell itself when the foreground program belongs to someone else, such as after `sudo -i`.
//! Nothing is typed into the terminal, so this works with any shell and never shows up in it.

use std::time::Duration;

use russh::ChannelMsg;

use crate::connection::Session;

/// Run through `exec` so the POSIX shell takes over the login shell's process, whatever that shell
/// is, and $PPID is the server process. Linux has /proc; macOS and the BSDs have lsof.
const PROBE: &str = r#"exec sh -c 'ps -A -o pid= -o ppid= -o tpgid= -o tty= 2>/dev/null | while read -r pid ppid fg tty; do
  [ "$ppid" = "$PPID" ] || continue
  case "$tty" in ""|"?"|"??") continue ;; esac
  for p in "$fg" "$pid"; do
    case "$p" in ""|-*|0) continue ;; esac
    if [ -d /proc/$p ]; then d=$(readlink /proc/$p/cwd 2>/dev/null)
    else d=$(lsof -a -p "$p" -d cwd -Fn 2>/dev/null | sed -n "s/^n//p")
    fi
    if [ -n "$d" ]; then printf "wisp-cwd:%s\n" "$d"; exit 0; fi
  done
done'"#;

const TIMEOUT: Duration = Duration::from_secs(5);
const MAX_OUTPUT: usize = 64 * 1024;

impl Session {
    /// The terminal's current directory, or `None` when the server cannot say: no terminal is
    /// open, commands are not allowed, or the system has neither /proc nor lsof.
    pub async fn terminal_dir(&self) -> Option<String> {
        let output = tokio::time::timeout(TIMEOUT, self.run(PROBE))
            .await
            .ok()??;
        parse(&output)
    }

    /// Runs a command on a channel of its own and returns what it printed.
    async fn run(&self, command: &str) -> Option<Vec<u8>> {
        let mut channel = self.handle.channel_open_session().await.ok()?;
        channel.exec(true, command).await.ok()?;
        let mut output = Vec::new();
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } if output.len() < MAX_OUTPUT => {
                    output.extend_from_slice(&data)
                }
                ChannelMsg::Failure | ChannelMsg::Close => break,
                _ => {}
            }
        }
        let _ = channel.close().await;
        Some(output)
    }
}

/// Startup files may print before the probe runs, so its answer carries a marker.
const MARKER: &str = "wisp-cwd:";

fn parse(output: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(output);
    let dir = text.lines().find_map(|line| line.strip_prefix(MARKER))?;
    // A directory removed since the shell entered it is not somewhere the file view can go.
    (dir.starts_with('/') && !dir.ends_with(" (deleted)")).then(|| dir.to_owned())
}

#[cfg(test)]
mod tests {
    use super::parse;

    #[test]
    fn reads_the_marked_line() {
        assert_eq!(
            parse(b"wisp-cwd:/home/me/my files\n"),
            Some("/home/me/my files".into())
        );
        assert_eq!(parse(b"Welcome!\nwisp-cwd:/\n"), Some("/".into()));
    }

    #[test]
    fn rejects_anything_else() {
        assert_eq!(parse(b""), None);
        assert_eq!(parse(b"/etc\n"), None);
        assert_eq!(parse(b"sh: ps: not found\n"), None);
        assert_eq!(parse(b"wisp-cwd:/tmp/gone (deleted)\n"), None);
        assert_eq!(parse(b"wisp-cwd:relative\n"), None);
    }
}
