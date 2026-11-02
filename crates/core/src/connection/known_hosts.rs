use std::path::{Path, PathBuf};

use russh::keys::{self, PublicKey, known_hosts};

#[derive(Debug, PartialEq, Eq)]
pub enum HostKeyVerdict {
    Trusted,
    /// No recorded key of this algorithm. `other_algorithms_known` means the host has keys of other
    /// algorithms on record, which deserves a stronger warning than a host seen for the first time.
    Unknown {
        other_algorithms_known: bool,
    },
    Changed {
        line: usize,
    },
    Revoked,
}

pub fn default_path() -> Option<PathBuf> {
    std::env::home_dir().map(|home| home.join(".ssh").join("known_hosts"))
}

pub fn check(
    path: &Path,
    host: &str,
    port: u16,
    key: &PublicKey,
) -> Result<HostKeyVerdict, keys::Error> {
    // russh skips `@revoked` lines, so a revoked key would otherwise look like an unknown one.
    if is_revoked(path, key) {
        return Ok(HostKeyVerdict::Revoked);
    }
    let recorded = known_hosts::known_host_keys_path(host, port, path)?;
    Ok(match classify(&recorded, key) {
        HostKeyVerdict::Changed { line } => HostKeyVerdict::Changed {
            line: physical_line(path, line),
        },
        verdict => verdict,
    })
}

pub fn remember(path: &Path, host: &str, port: u16, key: &PublicKey) -> Result<(), keys::Error> {
    known_hosts::learn_known_hosts_path(host, port, key, path)
}

fn classify(recorded: &[(usize, PublicKey)], key: &PublicKey) -> HostKeyVerdict {
    if recorded.iter().any(|(_, known)| known == key) {
        return HostKeyVerdict::Trusted;
    }
    match recorded
        .iter()
        .find(|(_, known)| known.algorithm() == key.algorithm())
    {
        Some((line, _)) => HostKeyVerdict::Changed { line: *line },
        None => HostKeyVerdict::Unknown {
            other_algorithms_known: !recorded.is_empty(),
        },
    }
}

/// russh does not count comment lines, but people are told to go and edit this line by number.
fn physical_line(path: &Path, line: usize) -> usize {
    let Ok(contents) = std::fs::read_to_string(path) else {
        return line;
    };
    contents
        .lines()
        .enumerate()
        .filter(|(_, text)| !text.starts_with('#'))
        .nth(line.saturating_sub(1))
        .map_or(line, |(index, _)| index + 1)
}

fn is_revoked(path: &Path, key: &PublicKey) -> bool {
    let Ok(contents) = std::fs::read_to_string(path) else {
        return false;
    };
    contents.lines().any(|line| {
        let mut fields = line.split_whitespace();
        fields.next() == Some("@revoked")
            && fields
                .nth(2)
                .and_then(|encoded| keys::parse_public_key_base64(encoded).ok())
                .is_some_and(|revoked| revoked == *key)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::{Algorithm, PrivateKey};

    fn key(algorithm: Algorithm) -> PublicKey {
        PrivateKey::random(&mut rand::rng(), algorithm)
            .unwrap()
            .public_key()
            .clone()
    }

    fn ed25519() -> PublicKey {
        key(Algorithm::Ed25519)
    }

    fn ecdsa() -> PublicKey {
        key(Algorithm::Ecdsa {
            curve: russh::keys::EcdsaCurve::NistP256,
        })
    }

    #[test]
    fn unknown_when_nothing_recorded() {
        let dir = tempfile::tempdir().unwrap();
        let verdict = check(&dir.path().join("known_hosts"), "a", 22, &ed25519()).unwrap();
        assert_eq!(
            verdict,
            HostKeyVerdict::Unknown {
                other_algorithms_known: false
            }
        );
    }

    #[test]
    fn remembered_key_is_trusted_on_default_and_custom_ports() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("known_hosts");
        let key = ed25519();
        for port in [22, 2222] {
            remember(&path, "example.com", port, &key).unwrap();
            assert_eq!(
                check(&path, "example.com", port, &key).unwrap(),
                HostKeyVerdict::Trusted
            );
        }
    }

    #[test]
    fn port_is_part_of_host_identity() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let key = ed25519();
        remember(&path, "example.com", 2222, &key).unwrap();
        assert!(matches!(
            check(&path, "example.com", 22, &key).unwrap(),
            HostKeyVerdict::Unknown { .. }
        ));
    }

    #[test]
    fn different_key_of_same_algorithm_is_changed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let recorded = ed25519().to_openssh().unwrap();
        std::fs::write(&path, format!("example.com {recorded}\n")).unwrap();
        assert_eq!(
            check(&path, "example.com", 22, &ed25519()).unwrap(),
            HostKeyVerdict::Changed { line: 1 }
        );
    }

    #[test]
    fn changed_line_number_counts_comments_and_blank_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let recorded = ed25519().to_openssh().unwrap();
        let other = ed25519().to_openssh().unwrap();
        std::fs::write(
            &path,
            format!("# a comment\n\n# another\nother.com {other}\nexample.com {recorded}\n"),
        )
        .unwrap();
        assert_eq!(
            check(&path, "example.com", 22, &ed25519()).unwrap(),
            HostKeyVerdict::Changed { line: 5 }
        );
    }

    #[test]
    fn any_matching_line_is_trusted_despite_stale_entries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let current = ed25519();
        remember(&path, "example.com", 22, &ed25519()).unwrap();
        remember(&path, "example.com", 22, &current).unwrap();
        assert_eq!(
            check(&path, "example.com", 22, &current).unwrap(),
            HostKeyVerdict::Trusted
        );
    }

    #[test]
    fn other_algorithm_on_record_is_flagged() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        remember(&path, "example.com", 22, &ed25519()).unwrap();
        assert_eq!(
            check(&path, "example.com", 22, &ecdsa()).unwrap(),
            HostKeyVerdict::Unknown {
                other_algorithms_known: true
            }
        );
    }

    #[test]
    fn revoked_key_is_rejected_even_if_also_recorded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let key = ed25519();
        remember(&path, "example.com", 22, &key).unwrap();
        let mut contents = std::fs::read_to_string(&path).unwrap();
        contents.push_str(&format!("@revoked * {}\n", key.to_openssh().unwrap()));
        std::fs::write(&path, contents).unwrap();
        assert_eq!(
            check(&path, "example.com", 22, &key).unwrap(),
            HostKeyVerdict::Revoked
        );
    }
}
