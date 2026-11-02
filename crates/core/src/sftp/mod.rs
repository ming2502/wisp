//! Remote file operations over SFTP. Remote paths are POSIX paths kept as strings, since they
//! need not be valid paths on the local system.

use std::future::Future;
use std::pin::Pin;

use russh_sftp::client::error::Error as SftpProtocolError;
use russh_sftp::client::{Config, SftpSession};
use russh_sftp::protocol::{FileAttributes, StatusCode};
use serde::Serialize;

use crate::connection::Session;

/// Generous enough for slow disks on the server, which answer each request in turn.
const REQUEST_TIMEOUT_SECS: u64 = 30;
/// Uploads are limited by how much is in flight per round trip. 32 writes of 64 KiB fill the
/// 2 MiB channel window that OpenSSH servers grant, where the defaults would fill only 512 KiB.
const WRITE_PACKET_BYTES: u32 = 64 * 1024;
const CONCURRENT_WRITES: usize = 32;

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
        Ok(RemoteFs { sftp })
    }
}

impl RemoteFs {
    pub(crate) fn session(&self) -> &SftpSession {
        &self.sftp
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
