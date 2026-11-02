//! Editing against a real OpenSSH server, which serves this machine's own files.
#![cfg(unix)]

mod common;

use std::os::unix::fs::{MetadataExt, PermissionsExt};

use common::sshd::RealServer;
use sshtool_core::sftp::{EditError, LineEnding};

#[tokio::test]
async fn edits_keep_format_permissions_and_links() {
    let Some(server) = RealServer::start().await else {
        return;
    };
    let fs = server.session.open_sftp().await.unwrap();
    let (local, remote) = server.workspace("edit");
    let file = local.join("config.ini");
    std::fs::write(&file, b"\xEF\xBB\xBF[main]\r\nname=old\r\n").unwrap();
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o640)).unwrap();
    std::os::unix::fs::symlink(&file, local.join("link.ini")).unwrap();

    // Opening through the link resolves to the real file.
    let opened = fs.open_text(&format!("{remote}/link.ini")).await.unwrap();
    assert_eq!(opened.path, format!("{remote}/config.ini"));
    assert_eq!(opened.content, "[main]\nname=old\n");
    assert_eq!(opened.format.line_ending, LineEnding::Crlf);
    assert!(opened.format.bom && !opened.read_only);

    let inode_before = std::fs::metadata(&file).unwrap().ino();
    let saved = fs
        .save_text(
            &opened.path,
            "[main]\nname=新\n",
            opened.format,
            opened.version,
            false,
            false,
        )
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(&file).unwrap(),
        "\u{feff}[main]\r\nname=新\r\n".as_bytes()
    );
    assert_eq!(
        std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o640
    );
    assert_ne!(
        std::fs::metadata(&file).unwrap().ino(),
        inode_before,
        "replaced, not rewritten"
    );
    assert!(
        std::fs::symlink_metadata(local.join("link.ini"))
            .unwrap()
            .is_symlink()
    );
    assert_eq!(saved.size, std::fs::metadata(&file).unwrap().len());

    // Nothing else is left behind in the directory.
    let mut names: Vec<_> = std::fs::read_dir(&local)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    assert_eq!(names, ["config.ini", "link.ini"]);
}

#[tokio::test]
async fn changes_on_the_server_are_detected() {
    let Some(server) = RealServer::start().await else {
        return;
    };
    let fs = server.session.open_sftp().await.unwrap();
    let (local, remote) = server.workspace("conflict");
    let file = local.join("a.txt");
    std::fs::write(&file, "one\n").unwrap();
    let opened = fs.open_text(&format!("{remote}/a.txt")).await.unwrap();

    std::fs::write(&file, "someone else\n").unwrap();
    let result = fs
        .save_text(
            &opened.path,
            "mine\n",
            opened.format,
            opened.version,
            false,
            false,
        )
        .await;
    let Err(EditError::Conflict { current }) = result else {
        panic!("{result:?}");
    };
    assert_eq!(current.size, 13);
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "someone else\n");

    // Saving against the version just reported, or forcing, goes through.
    let saved = fs
        .save_text(&opened.path, "mine\n", opened.format, current, false, false)
        .await
        .unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "mine\n");
    fs.save_text(
        &opened.path,
        "forced\n",
        opened.format,
        opened.version,
        true,
        false,
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "forced\n");
    assert_ne!(saved.size, 0);
}

#[tokio::test]
async fn read_only_directory_asks_before_writing_in_place() {
    let Some(server) = RealServer::start().await else {
        return;
    };
    let fs = server.session.open_sftp().await.unwrap();
    let (local, remote) = server.workspace("locked");
    let file = local.join("a.txt");
    std::fs::write(&file, "before\n").unwrap();
    std::fs::set_permissions(&local, std::fs::Permissions::from_mode(0o555)).unwrap();
    let opened = fs.open_text(&format!("{remote}/a.txt")).await.unwrap();
    let inode = std::fs::metadata(&file).unwrap().ino();

    let result = fs
        .save_text(
            &opened.path,
            "after\n",
            opened.format,
            opened.version,
            false,
            false,
        )
        .await;
    assert!(
        matches!(result, Err(EditError::AtomicUnavailable { .. })),
        "{result:?}"
    );
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "before\n");

    fs.save_text(
        &opened.path,
        "after\n",
        opened.format,
        opened.version,
        false,
        true,
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "after\n");
    assert_eq!(
        std::fs::metadata(&file).unwrap().ino(),
        inode,
        "written in place"
    );
    std::fs::set_permissions(&local, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[tokio::test]
async fn refuses_what_cannot_be_edited() {
    let Some(server) = RealServer::start().await else {
        return;
    };
    let fs = server.session.open_sftp().await.unwrap();
    let (local, remote) = server.workspace("refuse");
    std::fs::write(local.join("bin"), b"\x7fELF\0\0").unwrap();
    std::fs::write(local.join("big"), vec![b'a'; 5 * 1024 * 1024 + 1]).unwrap();
    std::fs::write(local.join("latin1"), b"caf\xe9\n").unwrap();

    assert!(matches!(
        fs.open_text(&format!("{remote}/bin")).await,
        Err(EditError::Binary)
    ));
    assert!(matches!(
        fs.open_text(&format!("{remote}/big")).await,
        Err(EditError::TooLarge { .. })
    ));
    assert!(matches!(
        fs.open_text(&remote).await,
        Err(EditError::NotAFile)
    ));
    assert!(
        fs.open_text(&format!("{remote}/latin1"))
            .await
            .unwrap()
            .read_only
    );
}
