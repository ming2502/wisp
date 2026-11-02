use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use sshtool_core::connection::Session;
use sshtool_core::sftp::RemoteFs;
use sshtool_core::store::HostStore;
use sshtool_core::terminal::Terminal;
use sshtool_core::transfer::{TransferInfo, TransferQueue};
use tauri::ipc::Channel;
use tokio::sync::oneshot;
use zeroize::Zeroizing;

pub type Id = u64;

pub enum PendingPrompt {
    HostKey(oneshot::Sender<bool>),
    Secrets(oneshot::Sender<Option<Vec<Zeroizing<String>>>>),
}

#[derive(Default)]
pub struct AppState {
    next_id: AtomicU64,
    pub config_dir: Mutex<Option<PathBuf>>,
    store: Mutex<Option<HostStore>>,
    pub sessions: Mutex<HashMap<Id, Arc<Session>>>,
    pub terminals: Mutex<HashMap<Id, Terminal>>,
    pub prompts: Mutex<HashMap<Id, PendingPrompt>>,
    /// SFTP for browsing, and a second one for transfers so that a long upload never delays a
    /// directory listing. Both are opened on first use.
    pub browsers: Mutex<HashMap<Id, Arc<RemoteFs>>>,
    pub transfer_channels: Mutex<HashMap<Id, Arc<RemoteFs>>>,
    pub transfers: TransferQueue,
    pub transfer_listener: Mutex<Option<Channel<Vec<TransferInfo>>>>,
}

impl AppState {
    pub fn new_id(&self) -> Id {
        self.next_id.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// Loads the host store on first use, so that a broken file is reported where hosts are shown
    /// instead of stopping the app from starting.
    pub fn with_store<T>(
        &self,
        action: impl FnOnce(&mut HostStore) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut store = self.store.lock().unwrap();
        if store.is_none() {
            let dir = self
                .config_dir
                .lock()
                .unwrap()
                .clone()
                .ok_or("找不到应用配置目录")?;
            *store = Some(HostStore::load(dir.join("hosts.json")).map_err(|e| e.to_string())?);
        }
        action(store.as_mut().unwrap())
    }
}
