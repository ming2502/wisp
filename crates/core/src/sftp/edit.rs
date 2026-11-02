//! Opening remote text files for editing and saving them back without losing data: changes made on
//! the server meanwhile are detected, and the file is replaced in one step where possible.

use russh_sftp::protocol::{FileAttributes, OpenFlags, Packet, StatusCode};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use super::{RemoteFs, SftpError, file_name, join, parent};

pub const MAX_EDIT_BYTES: u64 = 5 * 1024 * 1024;
/// A NUL byte this early means the file is almost certainly not text.
const BINARY_SNIFF_BYTES: usize = 8 * 1024;
const UTF8_BOM: &[u8] = b"\xEF\xBB\xBF";

/// What identifies the file's state on the server. Modification times have one-second resolution,
/// so a same-size change within the same second as the last save goes unnoticed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub size: u64,
    pub modified: Option<u32>,
}

impl From<&FileAttributes> for Version {
    fn from(attributes: &FileAttributes) -> Self {
        Self {
            size: attributes.size.unwrap_or(0),
            modified: attributes.mtime,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LineEnding {
    Lf,
    Crlf,
}

/// How to turn the edited text back into the file's bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFormat {
    pub line_ending: LineEnding,
    pub bom: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    /// The resolved path, so that saving a symlink writes to its target and keeps the link.
    pub path: String,
    /// With `\n` line endings, whatever the file uses.
    pub content: String,
    pub format: TextFormat,
    /// The file mixes line endings, which saving will make uniform.
    pub mixed_line_endings: bool,
    /// Not valid UTF-8, so it is shown approximately and must not be saved.
    pub read_only: bool,
    pub version: Version,
}

#[derive(Debug, thiserror::Error, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EditError {
    #[error("不是普通文件，无法编辑")]
    NotAFile,
    #[error("文件过大（{size} 字节），只能编辑 5 MB 以内的文件")]
    TooLarge { size: u64 },
    #[error("这是二进制文件，无法以文本方式编辑")]
    Binary,
    #[error("文件已在服务器上被修改")]
    Conflict { current: Version },
    /// Nothing was changed; the caller may ask the user and retry with a direct write.
    #[error("无法安全替换文件：{reason}")]
    AtomicUnavailable { reason: String },
    #[error("{message}")]
    Failed { message: String },
}

impl From<SftpError> for EditError {
    fn from(error: SftpError) -> Self {
        Self::Failed {
            message: error.to_string(),
        }
    }
}

fn protocol(path: &str) -> impl FnOnce(russh_sftp::client::error::Error) -> EditError + '_ {
    move |error| SftpError::from_protocol(path, error).into()
}

fn io_failed(path: &str) -> impl FnOnce(std::io::Error) -> EditError + '_ {
    move |error| EditError::Failed {
        message: format!("{path}：{error}"),
    }
}

pub(crate) struct Decoded {
    content: String,
    format: TextFormat,
    mixed_line_endings: bool,
    read_only: bool,
}

pub(crate) fn decode(bytes: &[u8]) -> Result<Decoded, EditError> {
    if bytes[..bytes.len().min(BINARY_SNIFF_BYTES)].contains(&0) {
        return Err(EditError::Binary);
    }
    let (bom, body) = match bytes.strip_prefix(UTF8_BOM) {
        Some(body) => (true, body),
        None => (false, bytes),
    };
    let (text, read_only) = match std::str::from_utf8(body) {
        Ok(text) => (text.to_string(), false),
        Err(_) => (String::from_utf8_lossy(body).into_owned(), true),
    };
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count() - crlf;
    let line_ending = if crlf > lf {
        LineEnding::Crlf
    } else {
        LineEnding::Lf
    };
    Ok(Decoded {
        content: text.replace("\r\n", "\n"),
        format: TextFormat { line_ending, bom },
        mixed_line_endings: crlf > 0 && lf > 0,
        read_only,
    })
}

pub(crate) fn encode(content: &str, format: TextFormat) -> Vec<u8> {
    let normalized = content.replace("\r\n", "\n");
    let text = match format.line_ending {
        LineEnding::Lf => normalized,
        LineEnding::Crlf => normalized.replace('\n', "\r\n"),
    };
    let mut bytes = Vec::with_capacity(text.len() + 3);
    if format.bom {
        bytes.extend_from_slice(UTF8_BOM);
    }
    bytes.extend_from_slice(text.as_bytes());
    bytes
}

/// SSH wire encoding of a string: a big-endian length, then the bytes.
fn ssh_string(out: &mut Vec<u8>, value: &str) {
    out.extend_from_slice(&(value.len() as u32).to_be_bytes());
    out.extend_from_slice(value.as_bytes());
}

fn temporary_name(path: &str, purpose: &str) -> String {
    let unique = uuid::Uuid::new_v4().simple().to_string();
    join(
        &parent(path),
        &format!(".{}.sshtool-{}.{purpose}", file_name(path), &unique[..8]),
    )
}

impl RemoteFs {
    pub async fn open_text(&self, path: &str) -> Result<TextFile, EditError> {
        let path = self.canonicalize(path).await?;
        let attributes = self.sftp.metadata(&path).await.map_err(protocol(&path))?;
        if !attributes.is_regular() {
            return Err(EditError::NotAFile);
        }
        let size = attributes.size.unwrap_or(0);
        if size > MAX_EDIT_BYTES {
            return Err(EditError::TooLarge { size });
        }
        let bytes = self.sftp.read(&path).await.map_err(protocol(&path))?;
        let decoded = decode(&bytes)?;
        Ok(TextFile {
            path,
            content: decoded.content,
            format: decoded.format,
            mixed_line_endings: decoded.mixed_line_endings,
            read_only: decoded.read_only,
            version: Version::from(&attributes),
        })
    }

    /// Saves unless the file changed since `expected`, which `overwrite_changes` skips. Replaces the
    /// file in one step unless `direct` is set, which instead truncates and rewrites it in place.
    pub async fn save_text(
        &self,
        path: &str,
        content: &str,
        format: TextFormat,
        expected: Version,
        overwrite_changes: bool,
        direct: bool,
    ) -> Result<Version, EditError> {
        let original = self.sftp.metadata(path).await.map_err(protocol(path))?;
        if !overwrite_changes && Version::from(&original) != expected {
            return Err(EditError::Conflict {
                current: Version::from(&original),
            });
        }
        let bytes = encode(content, format);
        if direct {
            self.write_file(path, &bytes, OpenFlags::WRITE | OpenFlags::TRUNCATE)
                .await?;
        } else {
            self.replace_atomically(path, &bytes, &original).await?;
        }
        let saved = self.sftp.metadata(path).await.map_err(protocol(path))?;
        Ok(Version::from(&saved))
    }

    async fn write_file(
        &self,
        path: &str,
        bytes: &[u8],
        flags: OpenFlags,
    ) -> Result<(), EditError> {
        let mut file = self
            .sftp
            .open_with_flags(path, flags)
            .await
            .map_err(protocol(path))?;
        file.write_all(bytes).await.map_err(io_failed(path))?;
        file.shutdown().await.map_err(io_failed(path))
    }

    async fn replace_atomically(
        &self,
        path: &str,
        bytes: &[u8],
        original: &FileAttributes,
    ) -> Result<(), EditError> {
        let temporary = temporary_name(path, "tmp");
        let unavailable = |reason: &str| EditError::AtomicUnavailable {
            reason: reason.to_string(),
        };
        match self
            .write_file(
                &temporary,
                bytes,
                OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
            )
            .await
        {
            Ok(()) => {}
            Err(EditError::Failed { .. }) => {
                let _ = self.sftp.remove_file(&temporary).await;
                return Err(unavailable("无法在所在目录创建临时文件，可能没有写权限"));
            }
            Err(other) => return Err(other),
        }
        if let Err(reason) = self.match_original(&temporary, original).await {
            let _ = self.sftp.remove_file(&temporary).await;
            return Err(unavailable(reason));
        }
        if let Err(error) = self.rename_over(&temporary, path).await {
            let _ = self.sftp.remove_file(&temporary).await;
            return Err(error);
        }
        Ok(())
    }

    /// Gives the new file the original's permissions and owner, so that replacing it changes only
    /// its contents.
    async fn match_original(
        &self,
        temporary: &str,
        original: &FileAttributes,
    ) -> Result<(), &'static str> {
        if let Some(mode) = original.permissions {
            let attributes = FileAttributes {
                permissions: Some(mode & 0o7777),
                ..FileAttributes::empty()
            };
            self.sftp
                .set_metadata(temporary, attributes)
                .await
                .map_err(|_| "无法设置临时文件的权限")?;
        }
        let created = self
            .sftp
            .metadata(temporary)
            .await
            .map_err(|_| "无法读取临时文件")?;
        let owner = |a: &FileAttributes| (a.uid, a.gid);
        if owner(&created) != owner(original) {
            let attributes = FileAttributes {
                uid: original.uid,
                gid: original.gid,
                ..FileAttributes::empty()
            };
            let _ = self.sftp.set_metadata(temporary, attributes).await;
            let created = self
                .sftp
                .metadata(temporary)
                .await
                .map_err(|_| "无法读取临时文件")?;
            if owner(&created) != owner(original) {
                return Err("文件属于其他用户或用户组，替换会改变所有者");
            }
        }
        Ok(())
    }

    /// Plain SFTP renames refuse to replace an existing file on OpenSSH, so this uses OpenSSH's
    /// `posix-rename` extension when there is one, and otherwise moves the original aside first.
    async fn rename_over(&self, from: &str, to: &str) -> Result<(), EditError> {
        if let Some(extensions) = self.extensions().await
            && extensions.posix_rename
        {
            let mut data = Vec::new();
            ssh_string(&mut data, from);
            ssh_string(&mut data, to);
            return match extensions
                .raw
                .extended("posix-rename@openssh.com", data)
                .await
            {
                Ok(Packet::Status(status)) if status.status_code == StatusCode::Ok => Ok(()),
                Ok(Packet::Status(status)) => Err(EditError::Failed {
                    message: format!("{to}：{}", status.error_message),
                }),
                Ok(_) => Err(EditError::Failed {
                    message: format!("{to}：服务器返回了意外的响应"),
                }),
                Err(error) => Err(protocol(to)(error)),
            };
        }

        // Without the extension there is a moment with no file at `to`, but never a moment with
        // neither the old nor the new contents on disk.
        let backup = temporary_name(to, "bak");
        self.sftp.rename(to, &backup).await.map_err(protocol(to))?;
        if let Err(error) = self.sftp.rename(from, to).await {
            let _ = self.sftp.rename(&backup, to).await;
            return Err(protocol(to)(error));
        }
        let _ = self.sftp.remove_file(&backup).await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decoded(bytes: &[u8]) -> Decoded {
        decode(bytes).unwrap_or_else(|error| panic!("{error}"))
    }

    #[test]
    fn keeps_crlf_files_crlf() {
        let file = decoded(b"a\r\nb\r\n");
        assert_eq!(file.content, "a\nb\n");
        assert_eq!(file.format.line_ending, LineEnding::Crlf);
        assert!(!file.mixed_line_endings);
        assert_eq!(encode("a\nb\nc\n", file.format), b"a\r\nb\r\nc\r\n");
    }

    #[test]
    fn round_trips_lf_and_bom() {
        let bytes = b"\xEF\xBB\xBFhello\n\xE4\xB8\xAD\n";
        let file = decoded(bytes);
        assert!(file.format.bom);
        assert_eq!(file.content, "hello\n中\n");
        assert_eq!(encode(&file.content, file.format), bytes);
    }

    #[test]
    fn mixed_endings_follow_the_majority() {
        let file = decoded(b"a\r\nb\r\nc\n");
        assert!(file.mixed_line_endings);
        assert_eq!(file.format.line_ending, LineEnding::Crlf);
    }

    #[test]
    fn no_trailing_newline_is_preserved() {
        let file = decoded(b"x\r\ny");
        assert_eq!(encode(&file.content, file.format), b"x\r\ny");
    }

    #[test]
    fn nul_bytes_mean_binary() {
        assert!(matches!(decode(b"ELF\0\x01"), Err(EditError::Binary)));
    }

    #[test]
    fn invalid_utf8_is_read_only() {
        let file = decoded(b"caf\xE9\n");
        assert!(file.read_only);
        assert_eq!(file.content, "caf\u{FFFD}\n");
    }

    #[test]
    fn encodes_ssh_strings() {
        let mut out = Vec::new();
        ssh_string(&mut out, "ab");
        assert_eq!(out, [0, 0, 0, 2, b'a', b'b']);
    }

    #[test]
    fn errors_serialize_with_kind() {
        let json = serde_json::to_value(EditError::Conflict {
            current: Version {
                size: 3,
                modified: Some(9),
            },
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({"kind": "conflict", "current": {"size": 3, "modified": 9}})
        );
    }
}
