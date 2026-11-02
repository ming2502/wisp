//! Runs against a real OpenSSH server, which serves this machine's own files, so every remote
//! change can be checked through `std::fs`. Skipped where OpenSSH is not installed.
#![cfg(unix)]

mod common;

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use common::sshd::RealServer;
use rand::Rng;
use sshtool_core::sftp::{EntryKind, SftpError};
use sshtool_core::transfer::{Direction, TransferInfo, TransferQueue, TransferState};

fn random_file(path: &Path, bytes: usize) {
    let mut data = vec![0; bytes];
    rand::rng().fill_bytes(&mut data);
    std::fs::write(path, data).unwrap();
}

fn same_contents(a: &Path, b: &Path) -> bool {
    std::fs::read(a).unwrap() == std::fs::read(b).unwrap()
}

async fn wait_for(
    queue: &TransferQueue,
    what: &str,
    done: impl Fn(&[TransferInfo]) -> bool,
) -> Vec<TransferInfo> {
    tokio::time::timeout(Duration::from_secs(120), async {
        loop {
            let list = queue.list();
            if done(&list) {
                return list;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {what}: {:?}", queue.list()))
}

fn all_completed(list: &[TransferInfo]) -> bool {
    !list.is_empty() && list.iter().all(|t| t.state == TransferState::Completed)
}

#[tokio::test]
async fn browses_and_changes_remote_files() {
    let Some(server) = RealServer::start().await else {
        return;
    };
    let fs = server.session.open_sftp().await.unwrap();
    let (local, remote) = server.workspace("browse");
    std::fs::write(local.join("b.txt"), "hello").unwrap();
    std::fs::create_dir(local.join("z-dir")).unwrap();
    std::os::unix::fs::symlink(local.join("z-dir"), local.join("a-link")).unwrap();

    assert!(fs.home().await.unwrap().starts_with('/'));

    let created = fs.mkdir(&remote, "新建文件夹").await.unwrap();
    assert!(local.join("新建文件夹").is_dir());
    assert!(matches!(
        fs.mkdir(&remote, "../escape").await,
        Err(SftpError::InvalidName(_))
    ));

    let entries = fs.list(&remote).await.unwrap();
    let names: Vec<_> = entries.iter().map(|e| (e.name.as_str(), e.kind)).collect();
    // Folders and links to folders first, then files, each by name.
    assert_eq!(
        names,
        [
            ("a-link", EntryKind::Symlink),
            ("z-dir", EntryKind::Dir),
            ("新建文件夹", EntryKind::Dir),
            ("b.txt", EntryKind::File)
        ]
    );
    assert!(entries[0].link_to_dir);
    assert_eq!(entries[3].size, 5);

    let renamed = fs
        .rename(&format!("{remote}/b.txt"), "c.txt")
        .await
        .unwrap();
    assert!(local.join("c.txt").exists());
    let clash = fs.rename(&renamed, "z-dir").await;
    assert!(clash.is_err());
    assert!(
        local.join("c.txt").exists(),
        "a refused rename must not touch the file"
    );

    fs.chmod(&renamed, 0o640).await.unwrap();
    let mode = std::fs::metadata(local.join("c.txt"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o640);
    assert_eq!(fs.stat(&renamed).await.unwrap().permissions, Some(0o640));

    // Removing a link must leave what it points to alone.
    std::fs::write(local.join("z-dir").join("keep"), "x").unwrap();
    fs.remove(&format!("{remote}/a-link")).await.unwrap();
    assert!(local.join("z-dir").join("keep").exists());

    std::fs::create_dir_all(local.join("新建文件夹").join("deep").join("er")).unwrap();
    std::fs::write(
        local.join("新建文件夹").join("deep").join("er").join("f"),
        "x",
    )
    .unwrap();
    fs.remove(&created).await.unwrap();
    assert!(!local.join("新建文件夹").exists());

    assert!(matches!(
        fs.list(&format!("{remote}/missing")).await,
        Err(SftpError::NotFound(_))
    ));
}

#[tokio::test]
async fn upload_and_download_round_trip() {
    let Some(server) = RealServer::start().await else {
        return;
    };
    let fs = Arc::new(server.session.open_sftp().await.unwrap());
    let (local, remote) = server.workspace("round");
    let (downloads, _) = server.workspace("downloads");
    let source = local.join("data.bin");
    random_file(&source, 24 * 1024 * 1024 + 123);
    std::fs::write(local.join("empty"), "").unwrap();
    let remote_dir = format!("{remote}/remote");
    fs.mkdir(&remote, "remote").await.unwrap();

    let queue = TransferQueue::default();
    queue
        .upload(
            1,
            fs.clone(),
            vec![source.clone(), local.join("empty")],
            &remote_dir,
        )
        .await
        .unwrap();
    wait_for(&queue, "uploads", all_completed).await;
    assert!(same_contents(
        &source,
        &local.join("remote").join("data.bin")
    ));
    assert_eq!(
        std::fs::metadata(local.join("remote").join("empty"))
            .unwrap()
            .len(),
        0
    );

    queue.clear_finished();
    let remote_file = format!("{remote_dir}/data.bin");
    for _ in 0..2 {
        queue
            .download(1, fs.clone(), vec![remote_file.clone()], &downloads)
            .await
            .unwrap();
    }
    let list = wait_for(&queue, "downloads", all_completed).await;
    assert!(
        list.iter()
            .all(|t| t.direction == Direction::Download && t.transferred == t.size)
    );
    // The second download must not replace the first.
    assert!(same_contents(&source, &downloads.join("data.bin")));
    assert!(same_contents(&source, &downloads.join("data (1).bin")));
    assert!(!downloads.join("data.bin.sshtool-part").exists());
}

async fn pause_midway(queue: &TransferQueue) -> TransferInfo {
    wait_for(queue, "progress", |list| {
        list[0].transferred > 4 * 1024 * 1024
    })
    .await;
    let id = queue.list()[0].id;
    queue.pause(id);
    let list = wait_for(queue, "pause", |list| {
        list[0].state == TransferState::Paused
    })
    .await;
    list[0].clone()
}

#[tokio::test]
async fn paused_transfers_resume_without_starting_over() {
    let Some(server) = RealServer::start().await else {
        return;
    };
    let fs = Arc::new(server.session.open_sftp().await.unwrap());
    let (local, remote) = server.workspace("resume");
    let (downloads, _) = server.workspace("resume-downloads");
    let source = local.join("big.bin");
    random_file(&source, 96 * 1024 * 1024);
    fs.mkdir(&remote, "up").await.unwrap();

    let queue = TransferQueue::default();
    queue
        .upload(1, fs.clone(), vec![source.clone()], &format!("{remote}/up"))
        .await
        .unwrap();
    let paused = pause_midway(&queue).await;
    assert!(paused.transferred < paused.size, "{paused:?}");
    queue.resume(paused.id);
    wait_for(&queue, "resumed upload", all_completed).await;
    assert!(same_contents(&source, &local.join("up").join("big.bin")));

    queue.clear_finished();
    queue
        .download(
            1,
            fs.clone(),
            vec![format!("{remote}/up/big.bin")],
            &downloads,
        )
        .await
        .unwrap();
    let paused = pause_midway(&queue).await;
    let partial = std::fs::metadata(downloads.join("big.bin.sshtool-part"))
        .unwrap()
        .len();
    assert_eq!(partial, paused.transferred);
    queue.resume(paused.id);
    wait_for(&queue, "resumed download", all_completed).await;
    assert!(same_contents(&source, &downloads.join("big.bin")));
}

#[tokio::test]
async fn rebound_transfers_resume_on_the_new_channel() {
    let Some(server) = RealServer::start().await else {
        return;
    };
    let first = Arc::new(server.session.open_sftp().await.unwrap());
    let (local, remote) = server.workspace("rebind");
    let source = local.join("big.bin");
    random_file(&source, 96 * 1024 * 1024);
    first.mkdir(&remote, "up").await.unwrap();

    let queue = TransferQueue::default();
    queue
        .upload(
            1,
            first.clone(),
            vec![source.clone()],
            &format!("{remote}/up"),
        )
        .await
        .unwrap();
    let paused = pause_midway(&queue).await;

    // As after a reconnect: a new owner and a new SFTP channel take over.
    let second = Arc::new(server.session.open_sftp().await.unwrap());
    queue.rebind(1, 2, second);
    drop(first);
    let list = queue.list();
    assert_eq!(list[0].owner, 2);
    queue.resume(paused.id);
    wait_for(&queue, "resumed upload", all_completed).await;
    assert!(same_contents(&source, &local.join("up").join("big.bin")));

    // Finished transfers are not moved.
    queue.rebind(2, 3, Arc::new(server.session.open_sftp().await.unwrap()));
    assert_eq!(queue.list()[0].owner, 2);
}

#[tokio::test]
async fn cancelling_removes_partial_files() {
    let Some(server) = RealServer::start().await else {
        return;
    };
    let fs = Arc::new(server.session.open_sftp().await.unwrap());
    let (local, remote) = server.workspace("cancel");
    let (downloads, _) = server.workspace("cancel-downloads");
    let source = local.join("big.bin");
    random_file(&source, 96 * 1024 * 1024);
    fs.mkdir(&remote, "up").await.unwrap();

    let queue = TransferQueue::default();
    queue
        .upload(1, fs.clone(), vec![source.clone()], &format!("{remote}/up"))
        .await
        .unwrap();
    let paused = pause_midway(&queue).await;
    assert!(local.join("up").join("big.bin").exists());
    queue.cancel(paused.id);
    wait_for(&queue, "cancelled upload", |list| {
        list[0].state == TransferState::Cancelled
    })
    .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!local.join("up").join("big.bin").exists());

    queue.clear_finished();
    queue
        .download(
            1,
            fs.clone(),
            vec![source.to_string_lossy().into_owned()],
            &downloads,
        )
        .await
        .unwrap();
    wait_for(&queue, "progress", |list| {
        list[0].transferred > 4 * 1024 * 1024
    })
    .await;
    queue.cancel(queue.list()[0].id);
    wait_for(&queue, "cancelled download", |list| {
        list[0].state == TransferState::Cancelled
    })
    .await;
    assert!(!downloads.join("big.bin.sshtool-part").exists());
    assert!(!downloads.join("big.bin").exists());
}

#[tokio::test]
async fn folders_copy_both_ways_and_skip_links() {
    let Some(server) = RealServer::start().await else {
        return;
    };
    let fs = Arc::new(server.session.open_sftp().await.unwrap());
    let (local, remote) = server.workspace("folders");
    let (downloads, _) = server.workspace("folder-downloads");
    let tree = local.join("项目");
    std::fs::create_dir_all(tree.join("src").join("empty")).unwrap();
    std::fs::write(tree.join("README"), "readme").unwrap();
    random_file(&tree.join("src").join("lib.bin"), 300_000);
    std::os::unix::fs::symlink(&tree, tree.join("loop")).unwrap();
    fs.mkdir(&remote, "dest").await.unwrap();

    let queue = TransferQueue::default();
    let enqueued = queue
        .upload(1, fs.clone(), vec![tree.clone()], &format!("{remote}/dest"))
        .await
        .unwrap();
    assert_eq!((enqueued.files, enqueued.skipped), (2, 1));
    wait_for(&queue, "folder upload", all_completed).await;
    let uploaded = local.join("dest").join("项目");
    assert!(uploaded.join("src").join("empty").is_dir());
    assert!(same_contents(
        &tree.join("src").join("lib.bin"),
        &uploaded.join("src").join("lib.bin")
    ));

    queue.clear_finished();
    let enqueued = queue
        .download(
            1,
            fs.clone(),
            vec![format!("{remote}/dest/项目")],
            &downloads,
        )
        .await
        .unwrap();
    assert_eq!(enqueued.files, 2);
    wait_for(&queue, "folder download", all_completed).await;
    let downloaded = downloads.join("项目");
    assert_eq!(
        std::fs::read_to_string(downloaded.join("README")).unwrap(),
        "readme"
    );
    assert!(downloaded.join("src").join("empty").is_dir());
    assert!(same_contents(
        &tree.join("src").join("lib.bin"),
        &downloaded.join("src").join("lib.bin")
    ));
}

#[tokio::test]
async fn missing_source_fails_and_can_be_retried() {
    let Some(server) = RealServer::start().await else {
        return;
    };
    let fs = Arc::new(server.session.open_sftp().await.unwrap());
    let (local, remote) = server.workspace("retry");
    let (downloads, _) = server.workspace("retry-downloads");
    std::fs::write(local.join("f"), "first").unwrap();

    let queue = TransferQueue::default();
    queue
        .download(1, fs.clone(), vec![format!("{remote}/f")], &downloads)
        .await
        .unwrap();
    wait_for(&queue, "download", all_completed).await;
    queue.clear_finished();

    // The file disappears after being queued, so the transfer fails; once it is back, retrying works.
    std::fs::write(local.join("g"), "second").unwrap();
    queue
        .download(1, fs.clone(), vec![format!("{remote}/g")], &downloads)
        .await
        .unwrap();
    wait_for(&queue, "download", all_completed).await;
    queue.clear_finished();
    std::fs::write(local.join("h"), "third").unwrap();
    let enqueued = queue.download(1, fs.clone(), vec![format!("{remote}/h")], &downloads);
    std::fs::remove_file(local.join("h")).ok();
    match enqueued.await {
        Err(SftpError::NotFound(_)) => {}
        Ok(_) => {
            let list = wait_for(&queue, "failure", |list| {
                matches!(list[0].state, TransferState::Failed { .. })
            })
            .await;
            std::fs::write(local.join("h"), "third").unwrap();
            queue.resume(list[0].id);
            wait_for(&queue, "retry", all_completed).await;
        }
        Err(other) => panic!("{other}"),
    }
}

fn same_contents_streaming(a: &Path, b: &Path) -> bool {
    use std::io::Read;
    let (mut a, mut b) = (
        std::fs::File::open(a).unwrap(),
        std::fs::File::open(b).unwrap(),
    );
    let (mut x, mut y) = (vec![0; 1 << 20], vec![0; 1 << 20]);
    loop {
        let n = a.read(&mut x).unwrap();
        b.read_exact(&mut y[..n]).unwrap();
        if x[..n] != y[..n] {
            return false;
        }
        if n == 0 {
            return b.read(&mut y).unwrap() == 0;
        }
    }
}

/// The M3 acceptance check. Slow, so it only runs on request:
/// `cargo test --release -p sshtool-core --test sftp -- --ignored --nocapture`
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn one_gigabyte_round_trip() {
    let Some(server) = RealServer::start().await else {
        return;
    };
    let fs = Arc::new(server.session.open_sftp().await.unwrap());
    let (local, remote) = server.workspace("gigabyte");
    let (downloads, _) = server.workspace("gigabyte-downloads");
    let source = local.join("1g.bin");
    {
        use std::io::Write;
        let mut file = std::fs::File::create(&source).unwrap();
        let mut chunk = vec![0; 8 << 20];
        for _ in 0..128 {
            rand::rng().fill_bytes(&mut chunk);
            file.write_all(&chunk).unwrap();
        }
    }
    fs.mkdir(&remote, "up").await.unwrap();
    let queue = TransferQueue::default();

    let started = std::time::Instant::now();
    queue
        .upload(1, fs.clone(), vec![source.clone()], &format!("{remote}/up"))
        .await
        .unwrap();
    wait_for(&queue, "upload", all_completed).await;
    let upload = started.elapsed();
    queue.clear_finished();

    let started = std::time::Instant::now();
    queue
        .download(
            1,
            fs.clone(),
            vec![format!("{remote}/up/1g.bin")],
            &downloads,
        )
        .await
        .unwrap();
    wait_for(&queue, "download", all_completed).await;
    let download = started.elapsed();

    assert!(same_contents_streaming(
        &source,
        &local.join("up").join("1g.bin")
    ));
    assert!(same_contents_streaming(&source, &downloads.join("1g.bin")));
    let rate = |elapsed: Duration| 1024.0 / elapsed.as_secs_f64();
    eprintln!(
        "1 GiB upload {upload:?} ({:.0} MiB/s), download {download:?} ({:.0} MiB/s)",
        rate(upload),
        rate(download)
    );
}

/// Measures how much a running upload delays the terminal on the same connection. Only runs on
/// request: `cargo test --release -p sshtool-core --test sftp -- --ignored --nocapture`
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn terminal_latency_during_upload() {
    use sshtool_core::terminal::TerminalSize;
    let Some(server) = RealServer::start().await else {
        return;
    };
    let fs = Arc::new(server.session.open_sftp().await.unwrap());
    let (local, remote) = server.workspace("latency");
    let source = local.join("big.bin");
    random_file(&source, 512 * 1024 * 1024);
    fs.mkdir(&remote, "up").await.unwrap();
    let mut term = common::open(&server.session, TerminalSize { cols: 80, rows: 24 }).await;
    term.terminal
        .write(b"stty -echo; PS1=; echo ready$((1))\n".to_vec());
    term.read_until(b"ready1").await;

    async fn sample(term: &mut common::OpenTerminal, rounds: usize) -> Vec<Duration> {
        let mut times = Vec::new();
        for i in 0..rounds {
            let marker = format!("m{i}x");
            let started = std::time::Instant::now();
            term.terminal.write(format!("echo {marker}\n").into_bytes());
            term.read_until(marker.as_bytes()).await;
            times.push(started.elapsed());
        }
        times.sort();
        times
    }

    let idle = sample(&mut term, 30).await;
    let queue = TransferQueue::default();
    queue
        .upload(1, fs.clone(), vec![source], &format!("{remote}/up"))
        .await
        .unwrap();
    wait_for(&queue, "start", |list| {
        list[0].transferred > 16 * 1024 * 1024
    })
    .await;
    let busy = sample(&mut term, 30).await;
    let still_running = queue.list()[0].state == TransferState::Running;
    let median = |t: &[Duration]| t[t.len() / 2];
    eprintln!(
        "terminal echo median {:?} idle, {:?} during upload (p90 {:?}); upload still running: {still_running}",
        median(&idle),
        median(&busy),
        busy[busy.len() * 9 / 10]
    );
}
