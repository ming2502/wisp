pub mod connection;
pub mod secrets;
pub mod sftp;
pub mod store;
pub mod terminal;
pub mod transfer;

pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
