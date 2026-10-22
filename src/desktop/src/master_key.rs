//! The local master key: one entry in the Windows Credential Manager, handed
//! to the sidecar only as `AMBER_SECRET_KEY`. Values and keyring error details are never
//! logged: some keyring errors carry the stored bytes.

use keyring::{Entry, Error};

use crate::encoding::base64_padded;
use crate::identity::{LEGACY_APP_IDENTIFIER, MASTER_KEY_ACCOUNT, MASTER_KEY_SERVICE};
use crate::sidecar::fill_random;

const KEY_BYTES: usize = 32;

/// A coarse, secret-free description of a keyring error for shell.log.
fn describe(error: &Error) -> &'static str {
    match error {
        Error::PlatformFailure(_) => "platform failure",
        Error::NoStorageAccess(_) => "no storage access",
        Error::NoEntry => "no entry",
        Error::BadEncoding(_) => "stored value is not UTF-8",
        Error::BadDataFormat(..) => "stored value has a bad format",
        Error::BadStoreFormat(_) => "bad store format",
        Error::TooLong(..) => "attribute too long",
        Error::Invalid(..) => "invalid parameter",
        Error::Ambiguous(_) => "ambiguous entry",
        Error::NoDefaultStore => "credential store unavailable",
        Error::NotSupportedByStore(_) => "not supported by the store",
        _ => "unknown error",
    }
}

/// The credential operations the master key needs, by service name. The keyring in the
/// shell; a map in tests, so the migration rules never touch the real Credential Manager.
trait KeyStore {
    /// `Ok(None)` only when the store answers that no entry exists.
    fn get(&self, service: &str) -> Result<Option<String>, String>;
    fn set(&self, service: &str, key: &str) -> Result<(), String>;
    fn delete(&self, service: &str) -> Result<(), String>;
}

struct Keyring;

fn entry(service: &str) -> Result<Entry, String> {
    Entry::new(service, MASTER_KEY_ACCOUNT).map_err(|error| format!("open keyring entry: {}", describe(&error)))
}

impl KeyStore for Keyring {
    fn get(&self, service: &str) -> Result<Option<String>, String> {
        match entry(service)?.get_password() {
            Ok(key) => Ok(Some(key)),
            Err(Error::NoEntry) => Ok(None),
            Err(error) => Err(format!("read master key: {}", describe(&error))),
        }
    }

    fn set(&self, service: &str, key: &str) -> Result<(), String> {
        entry(service)?
            .set_password(key)
            .map_err(|error| format!("store master key: {}", describe(&error)))
    }

    fn delete(&self, service: &str) -> Result<(), String> {
        match entry(service)?.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(error) => Err(format!("delete master key: {}", describe(&error))),
        }
    }
}

/// 32 bytes from the operating system's CSPRNG as padded Base64 (44 characters).
fn generate() -> Result<String, String> {
    let mut bytes = [0u8; KEY_BYTES];
    fill_random(&mut bytes)?;
    Ok(base64_padded(&bytes))
}

/// The master key, and what became of the credential of builds under the legacy identifier.
pub struct LoadedKey {
    pub key: String,
    /// No legacy credential is left, so its WebView2 state directory has no further use.
    pub legacy_gone: bool,
    /// Secret-free lines for shell.log.
    pub notes: Vec<String>,
}

/// Reads the master key, creating it only when the store answers that no entry exists.
/// Any other failure leaves the store untouched: generating a key over an unreadable one
/// would orphan every secret encrypted under it. A key stored under the legacy identifier
/// moves to the current credential first: written there, read back and compared before the
/// legacy entry is deleted.
pub fn load_or_create() -> Result<LoadedKey, String> {
    load_with(&Keyring)
}

/// Deletes the legacy credential, saying in `notes` when it stays.
fn drop_legacy(store: &impl KeyStore, notes: &mut Vec<String>) -> bool {
    match store.delete(LEGACY_APP_IDENTIFIER) {
        Ok(()) => {
            notes.push("legacy master key credential removed".to_owned());
            true
        }
        Err(reason) => {
            notes.push(format!("legacy master key credential kept: {reason}"));
            false
        }
    }
}

fn load_with(store: &impl KeyStore) -> Result<LoadedKey, String> {
    let mut notes = Vec::new();
    if let Some(key) = store.get(MASTER_KEY_SERVICE)? {
        let legacy_gone = match store.get(LEGACY_APP_IDENTIFIER) {
            Ok(None) => true,
            // A move whose deletion failed on an earlier start.
            Ok(Some(legacy)) if legacy == key => drop_legacy(store, &mut notes),
            Ok(Some(_)) => {
                notes.push("legacy master key credential differs from the current one; both kept".to_owned());
                false
            }
            Err(reason) => {
                notes.push(format!("legacy master key credential unreadable: {reason}"));
                false
            }
        };
        return Ok(LoadedKey { key, legacy_gone, notes });
    }
    // An unreadable legacy credential may hold the key of every stored secret: stop here.
    let Some(legacy) = store.get(LEGACY_APP_IDENTIFIER)? else {
        let key = generate()?;
        store.set(MASTER_KEY_SERVICE, &key).map_err(|reason| format!("store new master key: {reason}"))?;
        return Ok(LoadedKey { key, legacy_gone: true, notes });
    };
    store.set(MASTER_KEY_SERVICE, &legacy).map_err(|reason| format!("move legacy master key: {reason}"))?;
    if store.get(MASTER_KEY_SERVICE)?.as_deref() != Some(legacy.as_str()) {
        // Never leave a current credential that differs from the key the secrets need.
        let _ = store.delete(MASTER_KEY_SERVICE);
        return Err("move legacy master key: the stored copy does not read back".to_owned());
    }
    notes.push("master key moved from the legacy credential".to_owned());
    let legacy_gone = drop_legacy(store, &mut notes);
    Ok(LoadedKey { key: legacy, legacy_gone, notes })
}

/// Replaces the stored master key with a fresh one after a credential reset and returns it.
/// Nothing changes when the store refuses the write.
pub fn rotate() -> Result<String, String> {
    let key = generate()?;
    Keyring.set(MASTER_KEY_SERVICE, &key).map_err(|reason| format!("store new master key: {reason}"))?;
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::cell::RefCell;
    use std::collections::{BTreeMap, BTreeSet};

    /// Changing either name would orphan every secret encrypted under the stored key, and the
    /// uninstaller deletes the credential by the target name derived from them.
    #[test]
    fn keeps_the_credential_names() {
        assert_eq!(MASTER_KEY_SERVICE, "com.lifefindsitsway.amber");
        assert_eq!(LEGACY_APP_IDENTIFIER, "io.github.lifefindsitsway.amber");
        assert_eq!(MASTER_KEY_ACCOUNT, "master-key-v1");
    }

    /// Credentials by service, with operations that fail on demand.
    #[derive(Default)]
    struct FakeStore {
        entries: RefCell<BTreeMap<String, String>>,
        unreadable: BTreeSet<&'static str>,
        undeletable: BTreeSet<&'static str>,
        /// `set` stores something else under this service.
        garbled: BTreeSet<&'static str>,
    }

    impl FakeStore {
        fn with(entries: &[(&str, &str)]) -> Self {
            let store = Self::default();
            for (service, key) in entries {
                store.entries.borrow_mut().insert((*service).to_owned(), (*key).to_owned());
            }
            store
        }

        fn value(&self, service: &str) -> Option<String> {
            self.entries.borrow().get(service).cloned()
        }
    }

    impl KeyStore for FakeStore {
        fn get(&self, service: &str) -> Result<Option<String>, String> {
            if self.unreadable.contains(service) {
                return Err("read master key: platform failure".to_owned());
            }
            Ok(self.value(service))
        }

        fn set(&self, service: &str, key: &str) -> Result<(), String> {
            let stored = if self.garbled.contains(service) { "garbled".to_owned() } else { key.to_owned() };
            self.entries.borrow_mut().insert(service.to_owned(), stored);
            Ok(())
        }

        fn delete(&self, service: &str) -> Result<(), String> {
            if self.undeletable.contains(service) {
                return Err("delete master key: platform failure".to_owned());
            }
            self.entries.borrow_mut().remove(service);
            Ok(())
        }
    }

    const NEW: &str = MASTER_KEY_SERVICE;
    const OLD: &str = LEGACY_APP_IDENTIFIER;

    #[test]
    fn uses_the_current_credential_and_reports_no_legacy_one() {
        let store = FakeStore::with(&[(NEW, "k")]);
        let loaded = load_with(&store).unwrap();
        assert_eq!(loaded.key, "k");
        assert!(loaded.legacy_gone);
        assert!(loaded.notes.is_empty());
    }

    #[test]
    fn moves_the_legacy_key_and_deletes_the_legacy_credential() {
        let store = FakeStore::with(&[(OLD, "old")]);
        let loaded = load_with(&store).unwrap();
        assert_eq!(loaded.key, "old");
        assert!(loaded.legacy_gone);
        assert_eq!(store.value(NEW).as_deref(), Some("old"));
        assert_eq!(store.value(OLD), None);
        assert_eq!(loaded.notes, ["master key moved from the legacy credential", "legacy master key credential removed"]);
    }

    #[test]
    fn keeps_a_moved_legacy_credential_it_cannot_delete_and_retries_next_start() {
        let mut store = FakeStore::with(&[(OLD, "old")]);
        store.undeletable.insert(OLD);
        let loaded = load_with(&store).unwrap();
        assert_eq!(loaded.key, "old");
        assert!(!loaded.legacy_gone);
        assert_eq!(store.value(NEW).as_deref(), Some("old"));

        store.undeletable.clear();
        let again = load_with(&store).unwrap();
        assert_eq!(again.key, "old");
        assert!(again.legacy_gone);
        assert_eq!(store.value(OLD), None);
    }

    #[test]
    fn never_generates_a_key_while_the_legacy_credential_is_unreadable() {
        let mut store = FakeStore::default();
        store.unreadable.insert(OLD);
        assert!(load_with(&store).is_err());
        assert_eq!(store.value(NEW), None);
    }

    #[test]
    fn undoes_a_move_that_does_not_read_back() {
        let mut store = FakeStore::with(&[(OLD, "old")]);
        store.garbled.insert(NEW);
        assert!(load_with(&store).is_err());
        assert_eq!(store.value(NEW), None);
        assert_eq!(store.value(OLD).as_deref(), Some("old"));
    }

    #[test]
    fn keeps_a_legacy_credential_that_differs_from_the_current_one() {
        let store = FakeStore::with(&[(NEW, "new"), (OLD, "old")]);
        let loaded = load_with(&store).unwrap();
        assert_eq!(loaded.key, "new");
        assert!(!loaded.legacy_gone);
        assert_eq!(store.value(OLD).as_deref(), Some("old"));
    }

    #[test]
    fn generates_a_key_when_neither_credential_exists() {
        let store = FakeStore::default();
        let loaded = load_with(&store).unwrap();
        assert_eq!(loaded.key.len(), 44);
        assert!(loaded.legacy_gone);
        assert_eq!(store.value(NEW), Some(loaded.key));
    }

    #[test]
    fn fails_without_touching_anything_while_the_current_credential_is_unreadable() {
        let mut store = FakeStore::with(&[(OLD, "old")]);
        store.unreadable.insert(NEW);
        assert!(load_with(&store).is_err());
        assert_eq!(store.value(OLD).as_deref(), Some("old"));
    }

    #[test]
    fn generated_keys_are_44_character_padded_base64_and_vary() {
        let first = generate().unwrap();
        assert_eq!(first.len(), 44);
        assert!(first.ends_with('='));
        assert!(first[..43].chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/'));
        assert_ne!(first, generate().unwrap());
    }
}
