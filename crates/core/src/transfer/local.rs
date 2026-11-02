use std::path::{Path, PathBuf};

use crate::sftp::SftpError;

pub(super) fn error(path: &Path, error: std::io::Error) -> SftpError {
    let path = path.display().to_string();
    match error.kind() {
        std::io::ErrorKind::NotFound => SftpError::NotFound(path),
        std::io::ErrorKind::PermissionDenied => SftpError::PermissionDenied(path),
        _ => SftpError::Failed {
            path,
            message: error.to_string(),
        },
    }
}

pub(super) fn file_name(path: &Path) -> Result<String, SftpError> {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| SftpError::InvalidName(path.display().to_string()))
}

#[derive(Default)]
pub(super) struct LocalWalk {
    /// Relative directories to create, with the top one as "".
    pub dirs: Vec<String>,
    /// Local path, relative path, size. A plain file has the relative path "".
    pub files: Vec<(PathBuf, String, u64)>,
    pub skipped: usize,
}

/// Symlinks are skipped, as on the remote side, so that a link loop cannot make this run forever.
pub(super) fn walk(path: &Path) -> Result<LocalWalk, SftpError> {
    let mut out = LocalWalk::default();
    let metadata = std::fs::symlink_metadata(path).map_err(|e| error(path, e))?;
    if metadata.is_file() {
        out.files
            .push((path.to_path_buf(), String::new(), metadata.len()));
    } else if metadata.is_dir() {
        walk_dir(path, String::new(), &mut out)?;
    } else {
        out.skipped += 1;
    }
    Ok(out)
}

fn walk_dir(dir: &Path, relative: String, out: &mut LocalWalk) -> Result<(), SftpError> {
    out.dirs.push(relative.clone());
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .map_err(|e| error(dir, e))?
        .collect::<Result<_, _>>()
        .map_err(|e| error(dir, e))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let child = if relative.is_empty() {
            name
        } else {
            format!("{relative}/{name}")
        };
        let metadata = entry.metadata().map_err(|e| error(&path, e))?;
        let file_type = entry.file_type().map_err(|e| error(&path, e))?;
        if file_type.is_dir() {
            walk_dir(&path, child, out)?;
        } else if file_type.is_file() {
            out.files.push((path, child, metadata.len()));
        } else {
            out.skipped += 1;
        }
    }
    Ok(())
}

pub(super) fn relative_local(base: &Path, relative: &str) -> PathBuf {
    relative
        .split('/')
        .filter(|part| !part.is_empty())
        .fold(base.to_path_buf(), |path, part| path.join(part))
}

/// `name`, or `name (1)`, `name (2)` and so on, keeping the extension, whichever is not taken.
pub(super) fn unused_path(dir: &Path, name: &str, taken: impl Fn(&Path) -> bool) -> PathBuf {
    let candidate = dir.join(name);
    if !taken(&candidate) {
        return candidate;
    }
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, format!(".{extension}")),
        _ => (name, String::new()),
    };
    (1..)
        .map(|n| dir.join(format!("{stem} ({n}){extension}")))
        .find(|path| !taken(path))
        .expect("some numbered name is free")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_names_that_are_taken() {
        let dir = tempfile::tempdir().unwrap();
        let exists = |path: &Path| path.exists();
        assert_eq!(
            unused_path(dir.path(), "a.txt", exists),
            dir.path().join("a.txt")
        );
        std::fs::write(dir.path().join("a.txt"), "").unwrap();
        std::fs::write(dir.path().join("a (1).txt"), "").unwrap();
        assert_eq!(
            unused_path(dir.path(), "a.txt", exists),
            dir.path().join("a (2).txt")
        );
        std::fs::write(dir.path().join(".bashrc"), "").unwrap();
        assert_eq!(
            unused_path(dir.path(), ".bashrc", exists),
            dir.path().join(".bashrc (1)")
        );
        let reserved = dir.path().join("b");
        assert_eq!(
            unused_path(dir.path(), "b", |path| path == reserved),
            dir.path().join("b (1)")
        );
    }

    #[test]
    fn remote_relative_paths_become_local_ones() {
        assert_eq!(relative_local(Path::new("/x"), ""), Path::new("/x"));
        assert_eq!(
            relative_local(Path::new("/x"), "a/b"),
            Path::new("/x").join("a").join("b")
        );
    }

    #[test]
    fn walks_folders_and_skips_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("a"), "12").unwrap();
        std::fs::write(root.join("sub").join("b"), "345").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&root, root.join("loop")).unwrap();
        let walk = walk(&root).unwrap();
        assert_eq!(walk.dirs, ["", "sub"]);
        let files: Vec<_> = walk
            .files
            .iter()
            .map(|(_, rel, size)| (rel.as_str(), *size))
            .collect();
        assert_eq!(files, [("a", 2), ("sub/b", 3)]);
        #[cfg(unix)]
        assert_eq!(walk.skipped, 1);
    }
}
