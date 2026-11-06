//! Remote file operations over SFTP. Remote paths are POSIX paths kept as strings, since they
//! need not be valid paths on the local system.

mod edit;

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use russh::client::Handle;
use russh_sftp::client::error::Error as SftpProtocolError;
use russh_sftp::client::{Config, RawSftpSession, SftpSession};
use russh_sftp::protocol::{FileAttributes, OpenFlags, StatusCode};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::connection::{ClientHandler, Session};

pub use edit::{EditError, LineEnding, MAX_EDIT_BYTES, TextFile, TextFormat, Version};

/// Generous enough for slow disks on the server, which answer each request in turn.
const REQUEST_TIMEOUT_SECS: u64 = 30;
/// Uploads are limited by how much is in flight per round trip. 32 writes of 64 KiB fill the
/// 2 MiB channel window that OpenSSH servers grant, where the defaults would fill only 512 KiB.
const WRITE_PACKET_BYTES: u32 = 64 * 1024;
const CONCURRENT_WRITES: usize = 32;
/// Each read is a round trip, so copies read in large pieces.
const COPY_BUFFER_BYTES: usize = 256 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum SftpError {
    #[error("服务器不支持 SFTP，或拒绝了 SFTP 请求")]
    Unavailable,
    #[error("文件或目录不存在：{0}")]
    NotFound(String),
    #[error("没有权限：{0}")]
    PermissionDenied(String),
    #[error("名称无效：{0}")]
    InvalidName(String),
    #[error("目录不为空：{0}")]
    NotEmpty(String),
    #[error("{path}：{message}")]
    Failed { path: String, message: String },
}

impl SftpError {
    pub(crate) fn from_protocol(path: &str, error: SftpProtocolError) -> Self {
        let path = path.to_string();
        match error {
            SftpProtocolError::Status(status) => match status.status_code {
                StatusCode::NoSuchFile => Self::NotFound(path),
                StatusCode::PermissionDenied => Self::PermissionDenied(path),
                _ => Self::Failed {
                    path,
                    message: status.error_message,
                },
            },
            SftpProtocolError::Timeout => Self::Failed {
                path,
                message: "服务器响应超时".into(),
            },
            other => Self::Failed {
                path,
                message: other.to_string(),
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    File,
    Dir,
    Symlink,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    pub size: u64,
    /// Seconds since the Unix epoch.
    pub modified: Option<u32>,
    /// The permission bits, without the file type.
    pub permissions: Option<u32>,
    /// Whether a symlink points to a directory, so that it can be opened like one.
    pub link_to_dir: bool,
}

fn kind_of(attributes: &FileAttributes) -> EntryKind {
    if attributes.is_dir() {
        EntryKind::Dir
    } else if attributes.is_symlink() {
        EntryKind::Symlink
    } else if attributes.is_regular() {
        EntryKind::File
    } else {
        EntryKind::Other
    }
}

pub fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

pub fn parent(path: &str) -> String {
    match path.trim_end_matches('/').rsplit_once('/') {
        Some(("", _)) | None => "/".into(),
        Some((parent, _)) => parent.into(),
    }
}

pub fn file_name(path: &str) -> &str {
    path.trim_end_matches('/')
        .rsplit_once('/')
        .map_or(path, |(_, name)| name)
}

/// A single name inside a directory, as typed by the user for a new folder or a rename.
pub fn validate_name(name: &str) -> Result<(), SftpError> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\0']) {
        return Err(SftpError::InvalidName(name.to_string()));
    }
    Ok(())
}

pub struct RemoteFs {
    sftp: SftpSession,
    handle: Arc<Handle<ClientHandler>>,
    /// A raw session for protocol extensions the high-level client does not offer, opened on
    /// first use. `None` inside means the server would not open one.
    extensions: tokio::sync::OnceCell<Option<Extensions>>,
}

pub(crate) struct Extensions {
    raw: RawSftpSession,
    posix_rename: bool,
}

impl Session {
    pub async fn open_sftp(&self) -> Result<RemoteFs, SftpError> {
        let channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|_| SftpError::Unavailable)?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|_| SftpError::Unavailable)?;
        let config = Config {
            max_write_packet_len: WRITE_PACKET_BYTES,
            max_concurrent_writes: CONCURRENT_WRITES,
            request_timeout_secs: REQUEST_TIMEOUT_SECS,
            ..Config::default()
        };
        let sftp = SftpSession::new_with_config(channel.into_stream(), config)
            .await
            .map_err(|_| SftpError::Unavailable)?;
        Ok(RemoteFs {
            sftp,
            handle: self.handle.clone(),
            extensions: tokio::sync::OnceCell::new(),
        })
    }
}

impl RemoteFs {
    pub(crate) fn session(&self) -> &SftpSession {
        &self.sftp
    }

    pub(crate) async fn extensions(&self) -> Option<&Extensions> {
        self.extensions
            .get_or_init(|| async {
                let channel = self.handle.channel_open_session().await.ok()?;
                channel.request_subsystem(true, "sftp").await.ok()?;
                let raw = RawSftpSession::new(channel.into_stream());
                raw.set_timeout(REQUEST_TIMEOUT_SECS);
                let version = raw.init().await.ok()?;
                let posix_rename = version
                    .extensions
                    .get("posix-rename@openssh.com")
                    .is_some_and(|v| v == "1");
                Some(Extensions { raw, posix_rename })
            })
            .await
            .as_ref()
    }

    pub async fn home(&self) -> Result<String, SftpError> {
        self.sftp
            .canonicalize(".")
            .await
            .map_err(|e| SftpError::from_protocol(".", e))
    }

    pub async fn canonicalize(&self, path: &str) -> Result<String, SftpError> {
        self.sftp
            .canonicalize(path)
            .await
            .map_err(|e| SftpError::from_protocol(path, e))
    }

    /// Directories first, then by name.
    pub async fn list(&self, dir: &str) -> Result<Vec<RemoteEntry>, SftpError> {
        let read = self
            .sftp
            .read_dir(dir)
            .await
            .map_err(|e| SftpError::from_protocol(dir, e))?;
        let mut entries = Vec::new();
        for entry in read {
            let attributes = entry.metadata();
            let name = entry.file_name();
            let path = join(dir, &name);
            let kind = kind_of(&attributes);
            let link_to_dir = kind == EntryKind::Symlink
                && self
                    .sftp
                    .metadata(&path)
                    .await
                    .is_ok_and(|target| target.is_dir());
            entries.push(RemoteEntry {
                name,
                path,
                kind,
                size: attributes.size.unwrap_or(0),
                modified: attributes.mtime,
                permissions: attributes.permissions.map(|mode| mode & 0o7777),
                link_to_dir,
            });
        }
        entries.sort_by(|a, b| {
            let a_dir = a.kind == EntryKind::Dir || a.link_to_dir;
            let b_dir = b.kind == EntryKind::Dir || b.link_to_dir;
            b_dir.cmp(&a_dir).then_with(|| a.name.cmp(&b.name))
        });
        Ok(entries)
    }

    pub async fn stat(&self, path: &str) -> Result<RemoteEntry, SftpError> {
        let attributes = self
            .sftp
            .metadata(path)
            .await
            .map_err(|e| SftpError::from_protocol(path, e))?;
        Ok(RemoteEntry {
            name: file_name(path).to_string(),
            path: path.to_string(),
            kind: kind_of(&attributes),
            size: attributes.size.unwrap_or(0),
            modified: attributes.mtime,
            permissions: attributes.permissions.map(|mode| mode & 0o7777),
            link_to_dir: false,
        })
    }

    pub async fn exists(&self, path: &str) -> Result<bool, SftpError> {
        match self.sftp.symlink_metadata(path).await {
            Ok(_) => Ok(true),
            Err(SftpProtocolError::Status(status))
                if status.status_code == StatusCode::NoSuchFile =>
            {
                Ok(false)
            }
            Err(e) => Err(SftpError::from_protocol(path, e)),
        }
    }

    pub async fn mkdir(&self, dir: &str, name: &str) -> Result<String, SftpError> {
        validate_name(name)?;
        let path = join(dir, name);
        self.sftp
            .create_dir(&path)
            .await
            .map_err(|e| SftpError::from_protocol(&path, e))?;
        Ok(path)
    }

    /// Creates the directory unless it already exists, for copying folder trees.
    pub(crate) async fn ensure_dir(&self, path: &str) -> Result<(), SftpError> {
        match self.sftp.metadata(path).await {
            Ok(attributes) if attributes.is_dir() => Ok(()),
            Ok(_) => Err(SftpError::Failed {
                path: path.to_string(),
                message: "已存在同名文件".into(),
            }),
            Err(_) => self
                .sftp
                .create_dir(path)
                .await
                .map_err(|e| SftpError::from_protocol(path, e)),
        }
    }

    /// Renames within the same directory. Refuses to replace an existing entry, which plain SFTP
    /// renames do differently depending on the server.
    pub async fn rename(&self, path: &str, new_name: &str) -> Result<String, SftpError> {
        validate_name(new_name)?;
        let target = join(&parent(path), new_name);
        if target == path {
            return Ok(target);
        }
        if self.exists(&target).await? {
            return Err(SftpError::Failed {
                path: target,
                message: "已存在同名文件或目录".into(),
            });
        }
        self.sftp
            .rename(path, &target)
            .await
            .map_err(|e| SftpError::from_protocol(path, e))?;
        Ok(target)
    }

    /// Copies a file to `new_name` in the same directory with the same permissions, so that a copy
    /// of a private file stays private. Refuses to replace an existing entry.
    pub async fn copy_file(&self, path: &str, new_name: &str) -> Result<String, SftpError> {
        validate_name(new_name)?;
        let target = join(&parent(path), new_name);
        let source = self
            .sftp
            .metadata(path)
            .await
            .map_err(|e| SftpError::from_protocol(path, e))?;
        if !source.is_regular() {
            return Err(SftpError::Failed {
                path: path.to_string(),
                message: "只能复制普通文件".into(),
            });
        }
        if self.exists(&target).await? {
            return Err(SftpError::Failed {
                path: target,
                message: "已存在同名文件或目录".into(),
            });
        }
        let mut reader = self
            .sftp
            .open(path)
            .await
            .map_err(|e| SftpError::from_protocol(path, e))?;
        let attributes = FileAttributes {
            permissions: source.permissions.map(|mode| mode & 0o7777),
            ..FileAttributes::empty()
        };
        let mut writer = self
            .sftp
            .open_with_flags_and_attributes(
                &target,
                OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
                attributes,
            )
            .await
            .map_err(|e| SftpError::from_protocol(&target, e))?;
        let copied = async {
            let mut buffer = vec![0; COPY_BUFFER_BYTES];
            loop {
                let read = reader.read(&mut buffer).await?;
                if read == 0 {
                    break;
                }
                writer.write_all(&buffer[..read]).await?;
            }
            writer.shutdown().await
        };
        if let Err(error) = copied.await {
            let _ = self.sftp.remove_file(&target).await;
            return Err(SftpError::Failed {
                path: target,
                message: error.to_string(),
            });
        }
        Ok(target)
    }

    /// Renames within the same directory, replacing a file already called `new_name`. A directory
    /// of that name is left alone.
    pub async fn rename_replacing(&self, path: &str, new_name: &str) -> Result<String, SftpError> {
        validate_name(new_name)?;
        let target = join(&parent(path), new_name);
        if target == path {
            return Ok(target);
        }
        match self.sftp.symlink_metadata(&target).await {
            Ok(existing) if existing.is_dir() => Err(SftpError::Failed {
                path: target,
                message: "已存在同名目录".into(),
            }),
            Ok(_) => {
                self.rename_over(path, &target).await?;
                Ok(target)
            }
            Err(SftpProtocolError::Status(status))
                if status.status_code == StatusCode::NoSuchFile =>
            {
                self.sftp
                    .rename(path, &target)
                    .await
                    .map_err(|e| SftpError::from_protocol(path, e))?;
                Ok(target)
            }
            Err(e) => Err(SftpError::from_protocol(&target, e)),
        }
    }

    pub async fn chmod(&self, path: &str, mode: u32) -> Result<(), SftpError> {
        let attributes = FileAttributes {
            permissions: Some(mode & 0o7777),
            ..FileAttributes::empty()
        };
        self.sftp
            .set_metadata(path, attributes)
            .await
            .map_err(|e| SftpError::from_protocol(path, e))
    }

    /// Removes a file, a symlink (never what it points to), or a directory with everything in it.
    pub async fn remove(&self, path: &str) -> Result<(), SftpError> {
        let attributes = self
            .sftp
            .symlink_metadata(path)
            .await
            .map_err(|e| SftpError::from_protocol(path, e))?;
        if attributes.is_dir() {
            self.remove_tree(path.to_string()).await
        } else {
            self.sftp
                .remove_file(path)
                .await
                .map_err(|e| SftpError::from_protocol(path, e))
        }
    }

    fn remove_tree(
        &self,
        dir: String,
    ) -> Pin<Box<dyn Future<Output = Result<(), SftpError>> + Send + '_>> {
        Box::pin(async move {
            let read = self
                .sftp
                .read_dir(&dir)
                .await
                .map_err(|e| SftpError::from_protocol(&dir, e))?;
            for entry in read {
                let path = join(&dir, &entry.file_name());
                if entry.metadata().is_dir() {
                    self.remove_tree(path).await?;
                } else {
                    self.sftp
                        .remove_file(&path)
                        .await
                        .map_err(|e| SftpError::from_protocol(&path, e))?;
                }
            }
            self.sftp
                .remove_dir(&dir)
                .await
                .map_err(|e| SftpError::from_protocol(&dir, e))
        })
    }

    /// Every file below `dir`, with its path relative to `dir`, and the directories to create.
    /// Symlinks are skipped so that a link loop cannot make this run forever.
    pub(crate) fn walk<'a>(
        &'a self,
        dir: String,
        relative: String,
        out: &'a mut Walk,
    ) -> Pin<Box<dyn Future<Output = Result<(), SftpError>> + Send + 'a>> {
        Box::pin(async move {
            out.dirs.push(relative.clone());
            let read = self
                .sftp
                .read_dir(&dir)
                .await
                .map_err(|e| SftpError::from_protocol(&dir, e))?;
            for entry in read {
                let name = entry.file_name();
                let attributes = entry.metadata();
                let path = join(&dir, &name);
                let child = if relative.is_empty() {
                    name
                } else {
                    format!("{relative}/{name}")
                };
                if attributes.is_dir() {
                    self.walk(path, child, out).await?;
                } else if attributes.is_regular() {
                    out.files.push((path, child, attributes.size.unwrap_or(0)));
                } else {
                    out.skipped += 1;
                }
            }
            Ok(())
        })
    }
}

#[derive(Default)]
pub(crate) struct Walk {
    pub dirs: Vec<String>,
    /// Remote path, relative path, size.
    pub files: Vec<(String, String, u64)>,
    pub skipped: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_and_splits_posix_paths() {
        assert_eq!(join("/", "etc"), "/etc");
        assert_eq!(join("/home/me", "a b"), "/home/me/a b");
        assert_eq!(parent("/home/me/file"), "/home/me");
        assert_eq!(parent("/home"), "/");
        assert_eq!(parent("/"), "/");
        assert_eq!(parent("/home/me/"), "/home");
        assert_eq!(file_name("/home/me/文件.txt"), "文件.txt");
        assert_eq!(file_name("/home/me/"), "me");
    }

    #[test]
    fn rejects_names_that_escape_the_directory() {
        for name in ["", ".", "..", "a/b", "../x", "a\0b"] {
            assert!(validate_name(name).is_err(), "{name:?}");
        }
        assert!(validate_name("新建文件夹").is_ok());
        assert!(validate_name(".bashrc").is_ok());
    }
}
