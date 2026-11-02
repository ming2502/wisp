//! A queue of uploads and downloads that runs a few at a time and can pause, resume, retry and
//! cancel them. Resuming continues from where the destination left off instead of starting over.

mod local;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh_sftp::protocol::OpenFlags;
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::Notify;

use crate::sftp::{self, RemoteFs, SftpError, Walk};

const CONCURRENT_TRANSFERS: usize = 3;
const BUFFER_BYTES: usize = 256 * 1024;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
/// Writes are pipelined, so after a failure the server may hold bytes beyond a gap. Resuming a
/// little before the recorded position rewrites any such gap.
const UPLOAD_RESUME_MARGIN: u64 = 1024 * 1024;
const PARTIAL_SUFFIX: &str = ".wisp-part";

pub type TransferId = u64;
/// Lets the caller group transfers, for example by the session they belong to.
pub type Owner = u64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    Upload,
    Download,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TransferState {
    Queued,
    Running,
    Paused,
    Completed,
    Failed { message: String },
    Cancelled,
}

impl TransferState {
    fn is_finished(&self) -> bool {
        matches!(self, Self::Completed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferInfo {
    pub id: TransferId,
    pub owner: Owner,
    pub direction: Direction,
    pub name: String,
    pub local: String,
    pub remote: String,
    pub size: u64,
    pub transferred: u64,
    pub state: TransferState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
enum Stop {
    None,
    Pause,
    Cancel,
}

#[derive(Default)]
struct Control(AtomicU8);

impl Control {
    fn get(&self) -> Stop {
        match self.0.load(Ordering::Acquire) {
            1 => Stop::Pause,
            2 => Stop::Cancel,
            _ => Stop::None,
        }
    }

    fn set(&self, stop: Stop) {
        self.0.store(stop as u8, Ordering::Release);
    }
}

struct Entry {
    info: TransferInfo,
    local: PathBuf,
    fs: Arc<RemoteFs>,
    transferred: Arc<AtomicU64>,
    control: Arc<Control>,
    /// Whether the destination holds bytes written by an earlier attempt of this transfer.
    started: bool,
}

impl Entry {
    fn snapshot(&self) -> TransferInfo {
        TransferInfo {
            transferred: self.transferred.load(Ordering::Relaxed),
            ..self.info.clone()
        }
    }
}

#[derive(Default)]
struct Inner {
    entries: Vec<Entry>,
    running: usize,
    next_id: TransferId,
}

enum Outcome {
    Completed,
    Paused,
    Cancelled,
    Failed(String),
}

#[derive(Clone, Default)]
pub struct TransferQueue {
    inner: Arc<Mutex<Inner>>,
    changed: Arc<Notify>,
    /// Serializes choosing download names, so that two downloads never pick the same free name.
    enqueueing: Arc<tokio::sync::Mutex<()>>,
}

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Enqueued {
    pub files: usize,
    /// Symlinks and special files inside folders, which are not copied.
    pub skipped: usize,
}

impl TransferQueue {
    /// Calls `on_change` with every transfer whenever something changes, at most about ten times a
    /// second while transfers run.
    pub fn subscribe(&self, mut on_change: impl FnMut(Vec<TransferInfo>) + Send + 'static) {
        let queue = self.clone();
        tokio::spawn(async move {
            loop {
                queue.changed.notified().await;
                loop {
                    on_change(queue.list());
                    if queue.inner.lock().unwrap().running == 0 {
                        break;
                    }
                    tokio::time::sleep(PROGRESS_INTERVAL).await;
                }
            }
        });
    }

    pub fn list(&self) -> Vec<TransferInfo> {
        self.inner
            .lock()
            .unwrap()
            .entries
            .iter()
            .map(Entry::snapshot)
            .collect()
    }

    /// Uploads files and folders into `remote_dir`, replacing files of the same name.
    pub async fn upload(
        &self,
        owner: Owner,
        fs: Arc<RemoteFs>,
        local_paths: Vec<PathBuf>,
        remote_dir: &str,
    ) -> Result<Enqueued, SftpError> {
        let mut result = Enqueued::default();
        for path in local_paths {
            let name = local::file_name(&path)?;
            let walk = tokio::task::spawn_blocking({
                let path = path.clone();
                move || local::walk(&path)
            })
            .await
            .expect("walking a folder does not panic")?;
            result.skipped += walk.skipped;
            let target = sftp::join(remote_dir, &name);
            for dir in &walk.dirs {
                fs.ensure_dir(&relative_remote(&target, dir)).await?;
            }
            for (file, relative, size) in walk.files {
                let remote = relative_remote(&target, &relative);
                self.push(owner, &fs, Direction::Upload, file, remote, size);
                result.files += 1;
            }
        }
        self.schedule();
        Ok(result)
    }

    /// Downloads remote files and folders into `local_dir`. An existing local file is never
    /// replaced; the copy gets a numbered name instead.
    pub async fn download(
        &self,
        owner: Owner,
        fs: Arc<RemoteFs>,
        remote_paths: Vec<String>,
        local_dir: &Path,
    ) -> Result<Enqueued, SftpError> {
        let _enqueueing = self.enqueueing.lock().await;
        let mut result = Enqueued::default();
        for remote in remote_paths {
            let entry = fs.stat(&remote).await?;
            let target = local::unused_path(local_dir, sftp::file_name(&remote), |path| {
                path.exists() || partial_path(path).exists() || self.is_download_target(path)
            });
            if entry.kind != sftp::EntryKind::Dir {
                self.push(owner, &fs, Direction::Download, target, remote, entry.size);
                result.files += 1;
                continue;
            }
            let mut walk = Walk::default();
            fs.walk(remote.clone(), String::new(), &mut walk).await?;
            result.skipped += walk.skipped;
            for dir in &walk.dirs {
                let path = local::relative_local(&target, dir);
                tokio::fs::create_dir_all(&path)
                    .await
                    .map_err(|e| local::error(&path, e))?;
            }
            for (path, relative, size) in walk.files {
                let local = local::relative_local(&target, &relative);
                self.push(owner, &fs, Direction::Download, local, path, size);
                result.files += 1;
            }
        }
        self.schedule();
        Ok(result)
    }

    fn is_download_target(&self, path: &Path) -> bool {
        self.inner.lock().unwrap().entries.iter().any(|entry| {
            entry.info.direction == Direction::Download
                && !entry.info.state.is_finished()
                && entry.local.starts_with(path)
        })
    }

    fn push(
        &self,
        owner: Owner,
        fs: &Arc<RemoteFs>,
        direction: Direction,
        local: PathBuf,
        remote: String,
        size: u64,
    ) {
        let mut inner = self.inner.lock().unwrap();
        inner.next_id += 1;
        let name = match direction {
            Direction::Upload => local
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into(),
            Direction::Download => sftp::file_name(&remote).to_string(),
        };
        let info = TransferInfo {
            id: inner.next_id,
            owner,
            direction,
            name,
            local: local.display().to_string(),
            remote,
            size,
            transferred: 0,
            state: TransferState::Queued,
        };
        inner.entries.push(Entry {
            info,
            local,
            fs: fs.clone(),
            transferred: Arc::new(AtomicU64::new(0)),
            control: Arc::new(Control::default()),
            started: false,
        });
    }

    pub fn pause(&self, id: TransferId) {
        self.update(id, |entry| match entry.info.state {
            TransferState::Running => entry.control.set(Stop::Pause),
            TransferState::Queued => entry.info.state = TransferState::Paused,
            _ => {}
        });
    }

    /// Also retries a failed transfer.
    pub fn resume(&self, id: TransferId) {
        self.update(id, |entry| {
            if matches!(
                entry.info.state,
                TransferState::Paused | TransferState::Failed { .. }
            ) {
                entry.info.state = TransferState::Queued;
            }
        });
        self.schedule();
    }

    pub fn cancel(&self, id: TransferId) {
        let mut cleanup = None;
        self.update(id, |entry| match entry.info.state {
            TransferState::Running => entry.control.set(Stop::Cancel),
            TransferState::Queued | TransferState::Paused | TransferState::Failed { .. } => {
                entry.info.state = TransferState::Cancelled;
                if entry.started {
                    cleanup = Some((
                        entry.fs.clone(),
                        entry.info.direction,
                        entry.local.clone(),
                        entry.info.remote.clone(),
                    ));
                }
            }
            _ => {}
        });
        if let Some((fs, direction, local, remote)) = cleanup {
            tokio::spawn(remove_partial(fs, direction, local, remote));
        }
    }

    /// Stops everything that belongs to `owner`, for when its session goes away.
    pub fn cancel_owner(&self, owner: Owner) {
        let ids: Vec<_> = self
            .list()
            .into_iter()
            .filter(|info| info.owner == owner && !info.state.is_finished())
            .map(|info| info.id)
            .collect();
        for id in ids {
            self.cancel(id);
        }
    }

    /// Moves `old_owner`'s unfinished transfers to `new_owner` and its file system, so that after a
    /// reconnect they can be resumed instead of started over. Running ones are left to fail.
    pub fn rebind(&self, old_owner: Owner, new_owner: Owner, fs: Arc<RemoteFs>) {
        let mut inner = self.inner.lock().unwrap();
        for entry in &mut inner.entries {
            let movable = matches!(
                entry.info.state,
                TransferState::Queued | TransferState::Paused | TransferState::Failed { .. }
            );
            if entry.info.owner == old_owner && movable {
                entry.info.owner = new_owner;
                entry.fs = fs.clone();
            }
        }
        drop(inner);
        self.changed.notify_one();
    }

    pub fn clear_finished(&self) {
        self.inner
            .lock()
            .unwrap()
            .entries
            .retain(|entry| !entry.info.state.is_finished());
        self.changed.notify_one();
    }

    fn update(&self, id: TransferId, change: impl FnOnce(&mut Entry)) {
        if let Some(entry) = self
            .inner
            .lock()
            .unwrap()
            .entries
            .iter_mut()
            .find(|entry| entry.info.id == id)
        {
            change(entry);
        }
        self.changed.notify_one();
    }

    fn schedule(&self) {
        let mut inner = self.inner.lock().unwrap();
        while inner.running < CONCURRENT_TRANSFERS {
            let Some(entry) = inner
                .entries
                .iter_mut()
                .find(|entry| entry.info.state == TransferState::Queued)
            else {
                break;
            };
            entry.info.state = TransferState::Running;
            entry.control.set(Stop::None);
            let resume = entry.started;
            entry.started = true;
            let task = Task {
                id: entry.info.id,
                fs: entry.fs.clone(),
                direction: entry.info.direction,
                local: entry.local.clone(),
                remote: entry.info.remote.clone(),
                transferred: entry.transferred.clone(),
                control: entry.control.clone(),
                resume,
            };
            inner.running += 1;
            let queue = self.clone();
            tokio::spawn(async move {
                let id = task.id;
                let outcome = task.run().await;
                queue.finish(id, outcome);
            });
        }
        drop(inner);
        self.changed.notify_one();
    }

    fn finish(&self, id: TransferId, outcome: Outcome) {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.running -= 1;
            if let Some(entry) = inner.entries.iter_mut().find(|entry| entry.info.id == id) {
                entry.info.state = match outcome {
                    Outcome::Completed => TransferState::Completed,
                    Outcome::Paused => TransferState::Paused,
                    Outcome::Cancelled => TransferState::Cancelled,
                    Outcome::Failed(message) => TransferState::Failed { message },
                };
            }
        }
        self.schedule();
    }
}

fn relative_remote(base: &str, relative: &str) -> String {
    if relative.is_empty() {
        base.to_string()
    } else {
        sftp::join(base, relative)
    }
}

fn partial_path(local: &Path) -> PathBuf {
    let mut name = local.file_name().unwrap_or_default().to_os_string();
    name.push(PARTIAL_SUFFIX);
    local.with_file_name(name)
}

async fn remove_partial(fs: Arc<RemoteFs>, direction: Direction, local: PathBuf, remote: String) {
    let _ = match direction {
        Direction::Download => tokio::fs::remove_file(partial_path(&local))
            .await
            .map_err(drop),
        Direction::Upload => fs.session().remove_file(remote).await.map_err(drop),
    };
}

struct Task {
    id: TransferId,
    fs: Arc<RemoteFs>,
    direction: Direction,
    local: PathBuf,
    remote: String,
    transferred: Arc<AtomicU64>,
    control: Arc<Control>,
    resume: bool,
}

impl Task {
    async fn run(self) -> Outcome {
        let result = match self.direction {
            Direction::Download => self.download().await,
            Direction::Upload => self.upload().await,
        };
        match result {
            Ok(Outcome::Cancelled) => {
                remove_partial(
                    self.fs.clone(),
                    self.direction,
                    self.local.clone(),
                    self.remote.clone(),
                )
                .await;
                Outcome::Cancelled
            }
            Ok(outcome) => outcome,
            Err(message) => Outcome::Failed(message),
        }
    }

    async fn download(&self) -> Result<Outcome, String> {
        let partial = partial_path(&self.local);
        let offset = if self.resume {
            tokio::fs::metadata(&partial).await.map_or(0, |m| m.len())
        } else {
            0
        };
        let mut source = self
            .fs
            .session()
            .open(&self.remote)
            .await
            .map_err(|e| SftpError::from_protocol(&self.remote, e).to_string())?;
        source
            .seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| e.to_string())?;
        let mut target = tokio::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(&partial)
            .await
            .map_err(|e| local::error(&partial, e).to_string())?;
        target.set_len(offset).await.map_err(|e| e.to_string())?;
        target
            .seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| e.to_string())?;

        let outcome = self.copy(&mut source, &mut target, offset).await?;
        target.flush().await.map_err(|e| e.to_string())?;
        target.sync_all().await.map_err(|e| e.to_string())?;
        drop(target);
        if let Outcome::Completed = outcome {
            tokio::fs::rename(&partial, &self.local)
                .await
                .map_err(|e| local::error(&self.local, e).to_string())?;
        }
        Ok(outcome)
    }

    async fn upload(&self) -> Result<Outcome, String> {
        let session = self.fs.session();
        let remote_size = if self.resume {
            session
                .metadata(&self.remote)
                .await
                .ok()
                .and_then(|m| m.size)
        } else {
            None
        };
        let offset = remote_size
            .map_or(0, |size| size.min(self.transferred.load(Ordering::Relaxed)))
            .saturating_sub(UPLOAD_RESUME_MARGIN);
        let flags = if offset == 0 {
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE
        } else {
            OpenFlags::WRITE
        };
        let remote_error = |e| SftpError::from_protocol(&self.remote, e).to_string();
        let mut target = session
            .open_with_flags(&self.remote, flags)
            .await
            .map_err(remote_error)?;
        target
            .seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| e.to_string())?;
        let mut source = tokio::fs::File::open(&self.local)
            .await
            .map_err(|e| local::error(&self.local, e).to_string())?;
        source
            .seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| e.to_string())?;

        let outcome = self.copy(&mut source, &mut target, offset).await?;
        // Waits for the server to acknowledge every pipelined write.
        target.shutdown().await.map_err(|e| e.to_string())?;
        if let Outcome::Completed = outcome {
            let written = session
                .metadata(&self.remote)
                .await
                .map_err(remote_error)?
                .size
                .unwrap_or(0);
            let expected = self.transferred.load(Ordering::Relaxed);
            if written != expected {
                return Err(format!(
                    "上传后大小不一致：本地 {expected} 字节，远程 {written} 字节"
                ));
            }
        }
        Ok(outcome)
    }

    async fn copy<R, W>(
        &self,
        source: &mut R,
        target: &mut W,
        offset: u64,
    ) -> Result<Outcome, String>
    where
        R: tokio::io::AsyncRead + Unpin,
        W: tokio::io::AsyncWrite + Unpin,
    {
        let mut buffer = vec![0; BUFFER_BYTES];
        let mut position = offset;
        self.transferred.store(position, Ordering::Relaxed);
        loop {
            match self.control.get() {
                Stop::Pause => return Ok(Outcome::Paused),
                Stop::Cancel => return Ok(Outcome::Cancelled),
                Stop::None => {}
            }
            let read = source.read(&mut buffer).await.map_err(|e| e.to_string())?;
            if read == 0 {
                return Ok(Outcome::Completed);
            }
            target
                .write_all(&buffer[..read])
                .await
                .map_err(|e| e.to_string())?;
            position += read as u64;
            self.transferred.store(position, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_file_sits_next_to_the_target() {
        assert_eq!(
            partial_path(Path::new("/tmp/dir/a.tar.gz")),
            Path::new("/tmp/dir/a.tar.gz.wisp-part")
        );
    }

    #[test]
    fn relative_remote_paths() {
        assert_eq!(relative_remote("/srv/app", ""), "/srv/app");
        assert_eq!(relative_remote("/srv/app", "a/b.txt"), "/srv/app/a/b.txt");
    }
}
