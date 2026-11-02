use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use sshtool_core::connection::Session;
use sshtool_core::terminal::Terminal;
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
    pub sessions: Mutex<HashMap<Id, Arc<Session>>>,
    pub terminals: Mutex<HashMap<Id, Terminal>>,
    pub prompts: Mutex<HashMap<Id, PendingPrompt>>,
}

impl AppState {
    pub fn new_id(&self) -> Id {
        self.next_id.fetch_add(1, Ordering::Relaxed) + 1
    }
}
