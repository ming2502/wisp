pub mod connection;
pub mod secrets;
pub mod store;
pub mod terminal;

pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
