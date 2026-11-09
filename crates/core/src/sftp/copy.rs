//! Copying a file to another name on the same server. Where the server offers OpenSSH's
//! `copy-data` extension the data never leaves the server. Otherwise it is read and written back
//! with many requests in flight, since each request is a round trip.

use std::future::ready;
use std::sync::atomic::{AtomicU64, Ordering};

use futures_util::stream::{self, StreamExt, TryStreamExt};
use russh_sftp::client::RawSftpSession;
use russh_sftp::client::error::Error as SftpProtocolError;
use russh_sftp::protocol::{FileAttributes, OpenFlags, Packet, StatusCode};

use super::edit::{ssh_string, temporary_name};
use super::{RemoteFs, SftpError, join, parent, validate_name};

/// Small enough that each copy on the server ends well within the request timeout.
const COPY_DATA_BYTES: u64 = 64 * 1024 * 1024;
const PIPE_BYTES: u64 = 64 * 1024;
const PIPE_IN_FLIGHT: usize = 16;

impl RemoteFs {
    /// Copies a regular file to `new_name` in the same directory, with the same permissions so
    /// that a copy of a private file stays private. A file already called `new_name` is replaced
    /// only when `replace` is set, and only once the copy is complete. `progress` receives the
    /// bytes copied so far and the file's size.
    pub async fn copy_file(
        &self,
        path: &str,
        new_name: &str,
        replace: bool,
        progress: impl Fn(u64, u64) + Sync,
    ) -> Result<String, SftpError> {
        self.copy(path, new_name, replace, true, progress).await
    }

    /// Copies through this machine even where the server could copy on its own, for testing the
    /// path taken by servers without `copy-data`.
    #[doc(hidden)]
    pub async fn copy_file_through_client(
        &self,
        path: &str,
        new_name: &str,
        replace: bool,
        progress: impl Fn(u64, u64) + Sync,
    ) -> Result<String, SftpError> {
        self.copy(path, new_name, replace, false, progress).await
    }

    async fn copy(
        &self,
        path: &str,
        new_name: &str,
        replace: bool,
        on_server: bool,
        progress: impl Fn(u64, u64) + Sync,
    ) -> Result<String, SftpError> {
        validate_name(new_name)?;
        let target = join(&parent(path), new_name);
        let failed = |message: &str| SftpError::Failed {
            path: target.clone(),
            message: message.into(),
        };
        if target == path {
            return Err(failed("不能复制到自身"));
        }
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
        match self.sftp.symlink_metadata(&target).await {
            Ok(existing) if existing.is_dir() || !replace => {
                return Err(failed("已存在同名文件或目录"));
            }
            Ok(_) => {}
            Err(SftpProtocolError::Status(status))
                if status.status_code == StatusCode::NoSuchFile => {}
            Err(e) => return Err(SftpError::from_protocol(&target, e)),
        }
        let extensions = self.extensions().await.ok_or(SftpError::Unavailable)?;
        let raw = &extensions.raw;
        let size = source.size.unwrap_or(0);
        progress(0, size);

        // The copy is written under a hidden name and moved into place when complete, so the
        // target never holds half a file.
        let temporary = temporary_name(&target, "tmp");
        let from = raw
            .open(path, OpenFlags::READ, FileAttributes::empty())
            .await
            .map_err(|e| SftpError::from_protocol(path, e))?
            .handle;
        let attributes = FileAttributes {
            permissions: source.permissions.map(|mode| mode & 0o7777),
            ..FileAttributes::empty()
        };
        let to = match raw
            .open(
                &temporary,
                OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
                attributes,
            )
            .await
        {
            Ok(handle) => handle.handle,
            Err(e) => {
                let _ = raw.close(from).await;
                return Err(SftpError::from_protocol(&target, e));
            }
        };

        let copied = if on_server && extensions.copy_data {
            copy_on_server(raw, &from, &to, size, &target, &progress).await
        } else {
            pipe(raw, &from, &to, size, path, &target, &progress).await
        };
        // Closing the written file is where some servers report a failed write.
        let closed = raw.close(to).await;
        let _ = raw.close(from).await;
        let result = match (copied, closed) {
            (Err(error), _) => Err(error),
            (Ok(()), Err(e)) => Err(SftpError::from_protocol(&target, e)),
            (Ok(()), Ok(_)) if replace => {
                self.rename_replacing(&temporary, new_name).await.map(drop)
            }
            (Ok(()), Ok(_)) => self
                .sftp
                .rename(&temporary, &target)
                .await
                .map_err(|e| SftpError::from_protocol(&target, e)),
        };
        if result.is_err() {
            let _ = self.sftp.remove_file(&temporary).await;
        }
        result.map(|()| target)
    }
}

fn status_error(target: &str, packet: Result<Packet, SftpProtocolError>) -> Result<(), SftpError> {
    let failed = |message: String| SftpError::Failed {
        path: target.to_string(),
        message,
    };
    match packet {
        Ok(Packet::Status(status)) if status.status_code == StatusCode::Ok => Ok(()),
        Ok(Packet::Status(status)) => Err(failed(status.error_message)),
        Ok(_) => Err(failed("服务器返回了意外的响应".into())),
        Err(e) => Err(SftpError::from_protocol(target, e)),
    }
}

/// Asks the server to copy the file in pieces, reporting progress after each one.
async fn copy_on_server(
    raw: &RawSftpSession,
    from: &str,
    to: &str,
    size: u64,
    target: &str,
    progress: &(impl Fn(u64, u64) + Sync),
) -> Result<(), SftpError> {
    let mut offset = 0;
    while offset < size {
        let length = COPY_DATA_BYTES.min(size - offset);
        let mut data = Vec::new();
        ssh_string(&mut data, from);
        data.extend_from_slice(&offset.to_be_bytes());
        data.extend_from_slice(&length.to_be_bytes());
        ssh_string(&mut data, to);
        data.extend_from_slice(&offset.to_be_bytes());
        status_error(target, raw.extended("copy-data", data).await)?;
        offset += length;
        progress(offset, size);
    }
    Ok(())
}

/// Reads and writes back the file in pieces, several requests at a time. Writes land at their own
/// offsets, so they may finish in any order.
async fn pipe(
    raw: &RawSftpSession,
    from: &str,
    to: &str,
    size: u64,
    source: &str,
    target: &str,
    progress: &(impl Fn(u64, u64) + Sync),
) -> Result<(), SftpError> {
    let done = AtomicU64::new(0);
    stream::iter((0..size).step_by(PIPE_BYTES as usize))
        .map(|offset| async move {
            let want = PIPE_BYTES.min(size - offset) as usize;
            let mut data = Vec::with_capacity(want);
            // A server may return less than asked for, so the rest of the piece is asked again.
            while data.len() < want {
                let at = offset + data.len() as u64;
                match raw.read(from, at, (want - data.len()) as u32).await {
                    Ok(chunk) if !chunk.data.is_empty() => data.extend_from_slice(&chunk.data),
                    Ok(_) => break,
                    Err(SftpProtocolError::Status(status))
                        if status.status_code == StatusCode::Eof =>
                    {
                        break;
                    }
                    Err(e) => return Err(SftpError::from_protocol(source, e)),
                }
            }
            Ok((offset, data))
        })
        .buffered(PIPE_IN_FLIGHT)
        .map_ok(|(offset, data)| async move {
            let written = data.len() as u64;
            raw.write(to, offset, data)
                .await
                .map_err(|e| SftpError::from_protocol(target, e))?;
            Ok(written)
        })
        .try_buffer_unordered(PIPE_IN_FLIGHT)
        .try_for_each(|written| {
            progress(done.fetch_add(written, Ordering::Relaxed) + written, size);
            ready(Ok(()))
        })
        .await
}
