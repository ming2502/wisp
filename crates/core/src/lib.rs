use std::time::Duration;

const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);

pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

pub fn client_config() -> russh::client::Config {
    russh::client::Config {
        keepalive_interval: Some(KEEPALIVE_INTERVAL),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_config_enables_keepalive() {
        assert_eq!(client_config().keepalive_interval, Some(KEEPALIVE_INTERVAL));
    }
}
