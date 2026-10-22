//! macOS master key store (fork-only): one file, `<data dir>/secrets/master.key`, instead of
//! the Keychain. An ad-hoc signed build changes its code signature on every rebuild, and the
//! Keychain then refuses (or prompts for) the item the previous build created. The file has
//! the same content as the Keychain entry: 32 CSPRNG bytes as padded Base64 (44 characters).
//!
//! `secrets/` is 0700 and the file 0600; writes go through a private temporary file, `fsync`
//! and a link/rename, so a crash never leaves a truncated key. The value is never logged and
//! error messages never contain it. Depends on `std` only so it can be unit-tested anywhere.

use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

pub const SECRETS_DIR: &str = "secrets";
pub const KEY_FILE: &str = "master.key";
const KEY_CHARS: usize = 44;

pub fn key_path(data_dir: &Path) -> PathBuf {
    data_dir.join(SECRETS_DIR).join(KEY_FILE)
}

/// A stored key is 44 characters of padded standard Base64 encoding 32 bytes.
fn is_valid(key: &str) -> bool {
    key.len() == KEY_CHARS
        && key.ends_with('=')
        && !key[..KEY_CHARS - 1].contains('=')
        && key[..KEY_CHARS - 1].chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/')
}

fn private_dir(data_dir: &Path) -> Result<PathBuf, String> {
    let dir = data_dir.join(SECRETS_DIR);
    fs::create_dir_all(&dir).map_err(|error| format!("create {SECRETS_DIR}/: {}", error.kind()))?;
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("chmod {SECRETS_DIR}/: {}", error.kind()))?;
    Ok(dir)
}

/// `Ok(None)` only when the file does not exist. A file that exists but is not a valid key
/// is an error: generating over it would orphan every secret sealed under it.
pub fn read(data_dir: &Path) -> Result<Option<String>, String> {
    let path = key_path(data_dir);
    let mut text = String::new();
    match File::open(&path) {
        Ok(mut file) => {
            file.read_to_string(&mut text)
                .map_err(|error| format!("read {SECRETS_DIR}/{KEY_FILE}: {}", error.kind()))?;
        }
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("open {SECRETS_DIR}/{KEY_FILE}: {}", error.kind())),
    }
    let key = text.trim();
    if !is_valid(key) {
        return Err(format!("{SECRETS_DIR}/{KEY_FILE} does not hold a valid master key"));
    }
    // Re-apply the mode in case it was loosened.
    let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    Ok(Some(key.to_owned()))
}

/// Writes `key` to a fresh 0600 temporary file in `secrets/` and syncs it.
fn write_temp(dir: &Path, key: &str, nonce: &str) -> Result<PathBuf, String> {
    let temp = dir.join(format!(".{KEY_FILE}.{nonce}.tmp"));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)
        .map_err(|error| format!("create temporary key file: {}", error.kind()))?;
    let written = file.write_all(key.as_bytes()).and_then(|()| file.sync_all());
    if let Err(error) = written {
        let _ = fs::remove_file(&temp);
        return Err(format!("write temporary key file: {}", error.kind()));
    }
    Ok(temp)
}

fn sync_dir(dir: &Path) {
    if let Ok(handle) = File::open(dir) {
        let _ = handle.sync_all();
    }
}

/// Stores `key` only if no key file exists yet (hard link: atomic create-once). Returns
/// `Ok(false)` when another key is already there; the caller then reads that one.
pub fn create(data_dir: &Path, key: &str, nonce: &str) -> Result<bool, String> {
    let dir = private_dir(data_dir)?;
    let temp = write_temp(&dir, key, nonce)?;
    let linked = fs::hard_link(&temp, dir.join(KEY_FILE));
    let _ = fs::remove_file(&temp);
    match linked {
        Ok(()) => {
            sync_dir(&dir);
            Ok(true)
        }
        Err(error) if error.kind() == ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(format!("store {SECRETS_DIR}/{KEY_FILE}: {}", error.kind())),
    }
}

/// Replaces the key file with `key` atomically (rename over the old file).
pub fn replace(data_dir: &Path, key: &str, nonce: &str) -> Result<(), String> {
    let dir = private_dir(data_dir)?;
    let temp = write_temp(&dir, key, nonce)?;
    if let Err(error) = fs::rename(&temp, dir.join(KEY_FILE)) {
        let _ = fs::remove_file(&temp);
        return Err(format!("replace {SECRETS_DIR}/{KEY_FILE}: {}", error.kind()));
    }
    sync_dir(&dir);
    Ok(())
}

/// The stored key, generating and storing one with `generate` when none exists.
/// Returns the key and whether it was generated now.
pub fn load_or_create(
    data_dir: &Path,
    generate: impl Fn() -> Result<String, String>,
    nonce: &str,
) -> Result<(String, bool), String> {
    if let Some(key) = read(data_dir)? {
        return Ok((key, false));
    }
    let key = generate()?;
    if create(data_dir, &key, nonce)? {
        return Ok((key, true));
    }
    // Lost a race with another writer: use what it stored.
    read(data_dir)?.map(|key| (key, false)).ok_or_else(|| format!("{SECRETS_DIR}/{KEY_FILE} vanished"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    const KEY_A: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const KEY_B: &str = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";

    fn temp_data_dir() -> PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "amber-key-file-test-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn mode(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn generates_once_with_private_modes_and_then_reads_the_same_key() {
        let data = temp_data_dir();
        let (key, generated) = load_or_create(&data, || Ok(KEY_A.to_owned()), "n1").unwrap();
        assert_eq!((key.as_str(), generated), (KEY_A, true));
        assert_eq!(mode(&data.join(SECRETS_DIR)), 0o700);
        assert_eq!(mode(&key_path(&data)), 0o600);
        assert_eq!(fs::read_to_string(key_path(&data)).unwrap(), KEY_A);
        let (again, generated) = load_or_create(&data, || Ok(KEY_B.to_owned()), "n2").unwrap();
        assert_eq!((again.as_str(), generated), (KEY_A, false));
        // No temporary files left behind.
        assert_eq!(fs::read_dir(data.join(SECRETS_DIR)).unwrap().count(), 1);
        fs::remove_dir_all(&data).unwrap();
    }

    #[test]
    fn create_never_overwrites_an_existing_key() {
        let data = temp_data_dir();
        assert!(create(&data, KEY_A, "n1").unwrap());
        assert!(!create(&data, KEY_B, "n2").unwrap());
        assert_eq!(read(&data).unwrap().as_deref(), Some(KEY_A));
        fs::remove_dir_all(&data).unwrap();
    }

    #[test]
    fn replace_swaps_the_key() {
        let data = temp_data_dir();
        assert!(create(&data, KEY_A, "n1").unwrap());
        replace(&data, KEY_B, "n2").unwrap();
        assert_eq!(read(&data).unwrap().as_deref(), Some(KEY_B));
        assert_eq!(mode(&key_path(&data)), 0o600);
        fs::remove_dir_all(&data).unwrap();
    }

    #[test]
    fn refuses_a_corrupt_key_file_without_replacing_it() {
        let data = temp_data_dir();
        fs::create_dir_all(data.join(SECRETS_DIR)).unwrap();
        fs::write(key_path(&data), "not a key").unwrap();
        let error = load_or_create(&data, || Ok(KEY_A.to_owned()), "n1").unwrap_err();
        assert!(!error.contains("not a key"));
        assert_eq!(fs::read_to_string(key_path(&data)).unwrap(), "not a key");
        fs::remove_dir_all(&data).unwrap();
    }

    #[test]
    fn tolerates_a_trailing_newline_and_tightens_a_loose_mode() {
        let data = temp_data_dir();
        fs::create_dir_all(data.join(SECRETS_DIR)).unwrap();
        fs::write(key_path(&data), format!("{KEY_A}\n")).unwrap();
        fs::set_permissions(key_path(&data), fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(read(&data).unwrap().as_deref(), Some(KEY_A));
        assert_eq!(mode(&key_path(&data)), 0o600);
        fs::remove_dir_all(&data).unwrap();
    }

    #[test]
    fn missing_file_reads_as_none() {
        let data = temp_data_dir();
        assert_eq!(read(&data).unwrap(), None);
        fs::remove_dir_all(&data).unwrap();
    }
}
