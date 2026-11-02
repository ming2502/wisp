use std::collections::HashMap;
use std::sync::Mutex;

use zeroize::Zeroizing;

const SERVICE: &str = "io.github.ming2502.wisp";

#[derive(Debug, thiserror::Error)]
#[error("系统钥匙串不可用：{0}")]
pub struct SecretError(String);

/// Where passwords and key passphrases live, so that they never touch the config file.
pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<Zeroizing<String>>, SecretError>;
    fn set(&self, account: &str, secret: &str) -> Result<(), SecretError>;
    /// Deleting a missing secret is not an error.
    fn delete(&self, account: &str) -> Result<(), SecretError>;
}

/// macOS Keychain or Windows Credential Manager.
pub struct Keychain;

impl Keychain {
    fn entry(account: &str) -> Result<keyring::Entry, SecretError> {
        keyring::Entry::new(SERVICE, account).map_err(|error| SecretError(error.to_string()))
    }
}

impl SecretStore for Keychain {
    fn get(&self, account: &str) -> Result<Option<Zeroizing<String>>, SecretError> {
        match Self::entry(account)?.get_password() {
            Ok(secret) => Ok(Some(Zeroizing::new(secret))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(SecretError(error.to_string())),
        }
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), SecretError> {
        Self::entry(account)?
            .set_password(secret)
            .map_err(|error| SecretError(error.to_string()))
    }

    fn delete(&self, account: &str) -> Result<(), SecretError> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(SecretError(error.to_string())),
        }
    }
}

#[derive(Default)]
pub struct MemorySecrets(Mutex<HashMap<String, Zeroizing<String>>>);

impl SecretStore for MemorySecrets {
    fn get(&self, account: &str) -> Result<Option<Zeroizing<String>>, SecretError> {
        Ok(self.0.lock().unwrap().get(account).cloned())
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), SecretError> {
        self.0
            .lock()
            .unwrap()
            .insert(account.to_string(), Zeroizing::new(secret.to_string()));
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), SecretError> {
        self.0.lock().unwrap().remove(account);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Touches the real keychain of whoever runs it, so it only runs on request.
    #[test]
    #[ignore]
    fn keychain_round_trip() {
        let account = format!("test:{}", uuid::Uuid::new_v4());
        let keychain = Keychain;
        assert_eq!(keychain.get(&account).unwrap(), None);
        keychain.set(&account, "s3cret ✓").unwrap();
        assert_eq!(
            keychain
                .get(&account)
                .unwrap()
                .as_deref()
                .map(String::as_str),
            Some("s3cret ✓")
        );
        keychain.delete(&account).unwrap();
        keychain.delete(&account).unwrap();
        assert_eq!(keychain.get(&account).unwrap(), None);
    }
}
