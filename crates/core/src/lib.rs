pub mod connection;
pub mod terminal;

pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
