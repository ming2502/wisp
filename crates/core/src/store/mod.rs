pub mod ssh_config;

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::connection::{Auth, ConnectError, ConnectOptions};
use crate::secrets::{SecretError, SecretStore};

const SCHEMA_VERSION: u32 = 1;
pub const DEFAULT_PORT: u16 = 22;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("无法读写配置文件 {path}：{source}")]
    Io {
        path: String,
        source: std::io::Error,
    },
    #[error("配置文件 {path} 已损坏，为避免覆盖已暂停保存：{reason}")]
    Corrupt { path: String, reason: String },
    #[error("配置文件 {path} 来自更新版本的 wisp，请升级后再使用")]
    TooNew { path: String },
    #[error("找不到该主机")]
    NotFound,
    #[error(transparent)]
    Invalid(#[from] ConnectError),
    #[error(transparent)]
    Secret(#[from] SecretError),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum HostAuth {
    Password,
    Key { path: PathBuf },
    Agent,
    KeyboardInteractive,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub group_id: Option<String>,
    pub auth: HostAuth,
    /// Whether a password or key passphrase is saved in the system keychain. Kept here so that
    /// listing hosts never has to query the keychain.
    #[serde(default)]
    pub saved_secret: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
}

/// What the editor sends: everything but the bookkeeping the store owns.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostDraft {
    pub id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub group_id: Option<String>,
    pub auth: HostAuth,
}

/// No `Debug`, as it carries a secret.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SecretChange {
    Keep,
    Set { value: Zeroizing<String> },
    Clear,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoreFile {
    schema_version: u32,
    #[serde(default)]
    groups: Vec<Group>,
    #[serde(default)]
    hosts: Vec<Host>,
}

pub struct HostStore {
    path: PathBuf,
    data: StoreFile,
}

fn secret_account(host_id: &str) -> String {
    format!("host:{host_id}")
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

impl HostStore {
    pub fn load(path: PathBuf) -> Result<Self, StoreError> {
        let display = path.display().to_string();
        let data = match std::fs::read(&path) {
            Ok(bytes) => {
                let data: StoreFile =
                    serde_json::from_slice(&bytes).map_err(|error| StoreError::Corrupt {
                        path: display.clone(),
                        reason: error.to_string(),
                    })?;
                if data.schema_version > SCHEMA_VERSION {
                    return Err(StoreError::TooNew { path: display });
                }
                data
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => StoreFile {
                schema_version: SCHEMA_VERSION,
                ..Default::default()
            },
            Err(source) => {
                return Err(StoreError::Io {
                    path: display,
                    source,
                });
            }
        };
        Ok(Self { path, data })
    }

    pub fn hosts(&self) -> &[Host] {
        &self.data.hosts
    }

    pub fn groups(&self) -> &[Group] {
        &self.data.groups
    }

    pub fn host(&self, id: &str) -> Result<&Host, StoreError> {
        self.data
            .hosts
            .iter()
            .find(|host| host.id == id)
            .ok_or(StoreError::NotFound)
    }

    /// The secret is written before the file, so that a failure never leaves `saved_secret` claiming
    /// a secret that is not there.
    pub fn save_host(
        &mut self,
        draft: HostDraft,
        secret: SecretChange,
        secrets: &dyn SecretStore,
    ) -> Result<Host, StoreError> {
        let host = draft.host.trim().to_string();
        let user = draft.user.trim().to_string();
        ConnectOptions {
            host: host.clone(),
            port: draft.port,
            user: user.clone(),
            known_hosts: PathBuf::new(),
        }
        .validate()?;
        let group_id = draft
            .group_id
            .filter(|id| self.data.groups.iter().any(|group| &group.id == id));
        let name = match draft.name.trim() {
            "" => format!("{user}@{host}"),
            name => name.to_string(),
        };
        let existing = match &draft.id {
            Some(id) => Some(self.host(id)?.clone()),
            None => None,
        };
        let id = existing
            .as_ref()
            .map_or_else(new_id, |existing| existing.id.clone());

        let uses_secret = matches!(draft.auth, HostAuth::Password | HostAuth::Key { .. });
        let mut saved_secret = existing.as_ref().is_some_and(|host| host.saved_secret);
        // A secret saved for another login method, or another key file, no longer applies.
        let auth_changed = existing
            .as_ref()
            .is_some_and(|host| host.auth != draft.auth);
        match secret {
            SecretChange::Set { value } if uses_secret && !value.is_empty() => {
                secrets.set(&secret_account(&id), &value)?;
                saved_secret = true;
            }
            SecretChange::Keep if uses_secret && !auth_changed => {}
            _ => {
                if saved_secret {
                    secrets.delete(&secret_account(&id))?;
                }
                saved_secret = false;
            }
        }

        let host = Host {
            id,
            name,
            host,
            port: draft.port,
            user,
            group_id,
            auth: draft.auth,
            saved_secret,
        };
        match self.data.hosts.iter_mut().find(|h| h.id == host.id) {
            Some(slot) => *slot = host.clone(),
            None => self.data.hosts.push(host.clone()),
        }
        self.persist()?;
        Ok(host)
    }

    pub fn delete_host(&mut self, id: &str, secrets: &dyn SecretStore) -> Result<(), StoreError> {
        let host = self.host(id)?.clone();
        self.data.hosts.retain(|h| h.id != id);
        self.persist()?;
        if host.saved_secret
            && let Err(error) = secrets.delete(&secret_account(id))
        {
            log::warn!("could not delete the saved secret of a removed host: {error}");
        }
        Ok(())
    }

    pub fn save_group(&mut self, id: Option<String>, name: &str) -> Result<Group, StoreError> {
        let name = name.trim();
        let name = if name.is_empty() {
            "未命名分组"
        } else {
            name
        }
        .to_string();
        let group = match id {
            Some(id) => {
                let slot = self
                    .data
                    .groups
                    .iter_mut()
                    .find(|group| group.id == id)
                    .ok_or(StoreError::NotFound)?;
                slot.name = name;
                slot.clone()
            }
            None => {
                let group = Group { id: new_id(), name };
                self.data.groups.push(group.clone());
                group
            }
        };
        self.persist()?;
        Ok(group)
    }

    /// Hosts in the group are kept and become ungrouped.
    pub fn delete_group(&mut self, id: &str) -> Result<(), StoreError> {
        self.data.groups.retain(|group| group.id != id);
        for host in &mut self.data.hosts {
            if host.group_id.as_deref() == Some(id) {
                host.group_id = None;
            }
        }
        self.persist()
    }

    /// Builds what the connection needs, filling in the saved secret if there is one.
    pub fn connect_target(
        &self,
        id: &str,
        secrets: &dyn SecretStore,
    ) -> Result<(Host, Auth), StoreError> {
        let host = self.host(id)?.clone();
        let saved = if host.saved_secret {
            secrets.get(&secret_account(id))?
        } else {
            None
        };
        let auth = match &host.auth {
            HostAuth::Password => match saved {
                Some(password) => Auth::Password { password },
                None => Auth::AskPassword,
            },
            HostAuth::Key { path } => Auth::Key {
                path: path.clone(),
                passphrase: saved,
            },
            HostAuth::Agent => Auth::Agent,
            HostAuth::KeyboardInteractive => Auth::KeyboardInteractive,
        };
        Ok((host, auth))
    }

    fn persist(&self) -> Result<(), StoreError> {
        let io = |source| StoreError::Io {
            path: self.path.display().to_string(),
            source,
        };
        let json = serde_json::to_vec_pretty(&self.data).expect("store data always serializes");
        write_atomically(&self.path, &json).map_err(io)
    }
}

/// Writes to a temporary file next to the target and renames it over, so that a crash midway
/// leaves either the old or the new file, never half of one.
pub fn write_atomically(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let directory = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(directory)?;
    let file_name = path.file_name().unwrap_or_default().to_string_lossy();
    let temporary = directory.join(format!(".{file_name}.{}.tmp", std::process::id()));
    let result = (|| {
        let mut file = std::fs::File::create(&temporary)?;
        file.write_all(contents)?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemorySecrets;

    fn draft(host: &str, auth: HostAuth) -> HostDraft {
        HostDraft {
            id: None,
            name: String::new(),
            host: host.into(),
            port: DEFAULT_PORT,
            user: "root".into(),
            group_id: None,
            auth,
        }
    }

    fn set(value: &str) -> SecretChange {
        SecretChange::Set {
            value: Zeroizing::new(value.into()),
        }
    }

    struct Fixture {
        dir: tempfile::TempDir,
        secrets: MemorySecrets,
        store: HostStore,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let store = HostStore::load(dir.path().join("config").join("hosts.json")).unwrap();
            Self {
                dir,
                secrets: MemorySecrets::default(),
                store,
            }
        }

        fn reload(&self) -> HostStore {
            HostStore::load(self.dir.path().join("config").join("hosts.json")).unwrap()
        }

        fn saved(&self, id: &str) -> Option<String> {
            self.secrets
                .get(&secret_account(id))
                .unwrap()
                .map(|secret| secret.to_string())
        }
    }

    #[test]
    fn saved_host_survives_reload_with_default_name() {
        let mut f = Fixture::new();
        let host = f
            .store
            .save_host(
                draft(" a.example ", HostAuth::Agent),
                SecretChange::Keep,
                &f.secrets,
            )
            .unwrap();
        assert_eq!(host.name, "root@a.example");
        assert_eq!(f.reload().hosts(), [host]);
    }

    #[test]
    fn password_goes_to_keychain_not_file() {
        let mut f = Fixture::new();
        let host = f
            .store
            .save_host(draft("a", HostAuth::Password), set("hunter2"), &f.secrets)
            .unwrap();
        assert!(host.saved_secret);
        assert_eq!(f.saved(&host.id).as_deref(), Some("hunter2"));
        let file = std::fs::read_to_string(f.dir.path().join("config").join("hosts.json")).unwrap();
        assert!(!file.contains("hunter2"));
    }

    #[test]
    fn keep_preserves_and_clear_removes_secret() {
        let mut f = Fixture::new();
        let host = f
            .store
            .save_host(draft("a", HostAuth::Password), set("p"), &f.secrets)
            .unwrap();
        let edit = |name: &str| HostDraft {
            id: Some(host.id.clone()),
            name: name.into(),
            ..draft("a", HostAuth::Password)
        };
        let kept = f
            .store
            .save_host(edit("renamed"), SecretChange::Keep, &f.secrets)
            .unwrap();
        assert!(kept.saved_secret);
        assert_eq!(f.saved(&host.id).as_deref(), Some("p"));
        let cleared = f
            .store
            .save_host(edit("renamed"), SecretChange::Clear, &f.secrets)
            .unwrap();
        assert!(!cleared.saved_secret);
        assert_eq!(f.saved(&host.id), None);
    }

    #[test]
    fn changing_auth_method_drops_old_secret() {
        let mut f = Fixture::new();
        let host = f
            .store
            .save_host(draft("a", HostAuth::Password), set("p"), &f.secrets)
            .unwrap();
        let key = HostAuth::Key {
            path: "~/.ssh/id".into(),
        };
        let changed = f
            .store
            .save_host(
                HostDraft {
                    id: Some(host.id.clone()),
                    ..draft("a", key)
                },
                SecretChange::Keep,
                &f.secrets,
            )
            .unwrap();
        assert!(!changed.saved_secret);
        assert_eq!(f.saved(&host.id), None);
    }

    #[test]
    fn agent_hosts_never_keep_a_secret() {
        let mut f = Fixture::new();
        let host = f
            .store
            .save_host(draft("a", HostAuth::Agent), set("p"), &f.secrets)
            .unwrap();
        assert!(!host.saved_secret);
        assert_eq!(f.saved(&host.id), None);
    }

    #[test]
    fn invalid_target_is_rejected_and_nothing_is_written() {
        let mut f = Fixture::new();
        let result = f
            .store
            .save_host(draft("bad host", HostAuth::Password), set("p"), &f.secrets);
        assert!(matches!(result, Err(StoreError::Invalid(_))));
        assert!(f.store.hosts().is_empty());
        assert!(!f.dir.path().join("config").join("hosts.json").exists());
    }

    #[test]
    fn delete_host_removes_secret() {
        let mut f = Fixture::new();
        let host = f
            .store
            .save_host(draft("a", HostAuth::Password), set("p"), &f.secrets)
            .unwrap();
        f.store.delete_host(&host.id, &f.secrets).unwrap();
        assert!(f.reload().hosts().is_empty());
        assert_eq!(f.saved(&host.id), None);
    }

    #[test]
    fn deleting_group_ungroups_its_hosts() {
        let mut f = Fixture::new();
        let group = f.store.save_group(None, " 生产 ").unwrap();
        assert_eq!(group.name, "生产");
        let host = f
            .store
            .save_host(
                HostDraft {
                    group_id: Some(group.id.clone()),
                    ..draft("a", HostAuth::Agent)
                },
                SecretChange::Keep,
                &f.secrets,
            )
            .unwrap();
        assert_eq!(host.group_id.as_deref(), Some(group.id.as_str()));
        f.store.delete_group(&group.id).unwrap();
        let reloaded = f.reload();
        assert!(reloaded.groups().is_empty());
        assert_eq!(reloaded.hosts()[0].group_id, None);
    }

    #[test]
    fn unknown_group_is_dropped() {
        let mut f = Fixture::new();
        let host = f
            .store
            .save_host(
                HostDraft {
                    group_id: Some("missing".into()),
                    ..draft("a", HostAuth::Agent)
                },
                SecretChange::Keep,
                &f.secrets,
            )
            .unwrap();
        assert_eq!(host.group_id, None);
    }

    #[test]
    fn connect_target_uses_saved_secret_or_asks() {
        let mut f = Fixture::new();
        let saved = f
            .store
            .save_host(draft("a", HostAuth::Password), set("p"), &f.secrets)
            .unwrap();
        let unsaved = f
            .store
            .save_host(
                draft("b", HostAuth::Password),
                SecretChange::Keep,
                &f.secrets,
            )
            .unwrap();
        let (_, auth) = f.store.connect_target(&saved.id, &f.secrets).unwrap();
        assert!(matches!(auth, Auth::Password { password } if password.as_str() == "p"));
        let (_, auth) = f.store.connect_target(&unsaved.id, &f.secrets).unwrap();
        assert!(matches!(auth, Auth::AskPassword));
    }

    #[test]
    fn corrupt_file_is_reported_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hosts.json");
        std::fs::write(&path, "{ not json").unwrap();
        assert!(matches!(
            HostStore::load(path.clone()),
            Err(StoreError::Corrupt { .. })
        ));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json");
    }

    #[test]
    fn newer_schema_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hosts.json");
        std::fs::write(&path, r#"{"schemaVersion": 99}"#).unwrap();
        assert!(matches!(
            HostStore::load(path),
            Err(StoreError::TooNew { .. })
        ));
    }

    #[test]
    fn atomic_write_leaves_no_temporary_files() {
        let mut f = Fixture::new();
        f.store
            .save_host(draft("a", HostAuth::Agent), SecretChange::Keep, &f.secrets)
            .unwrap();
        let entries: Vec<_> = std::fs::read_dir(f.dir.path().join("config"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(entries, ["hosts.json"]);
    }
}
