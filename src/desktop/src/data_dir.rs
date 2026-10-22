//! Claiming the data directory. `%APPDATA%\Amber` is a readable, generic
//! name another program or the user may already use, and "uninstall and delete all data"
//! removes whatever directory carries Amber's marker. So before anything is written there
//! the shell checks that the directory is Amber's own, and marks it when it is new: only the
//! shell writes the marker, which keeps server mode (no shell) out of this rule.

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::Path;

use crate::identity::{DATA_ROOT_MARKER, DATA_ROOT_MARKER_MAGIC};
use crate::marker::{has_marker, marker_text};
use crate::shell_copy::{SHELL_COPY_EN, SHELL_COPY_ZH_CN, ShellCopy};

/// Why the shell will not use the data directory.
#[derive(Debug)]
pub enum Refusal {
    /// A symbolic link, junction or other reparse point: removing "its" data would reach
    /// whatever it points to.
    Link,
    /// It exists, is not empty (or is not a directory) and carries no valid marker.
    Foreign,
    /// It could not be inspected, created or marked.
    Unusable(std::io::Error),
}

fn write_marker(dir: &Path) -> std::io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(dir.join(DATA_ROOT_MARKER))?;
    file.write_all(marker_text(DATA_ROOT_MARKER_MAGIC).as_bytes())?;
    file.sync_all()
}

/// Any reparse point counts: junctions and symlinks redirect, and other kinds are not
/// something Amber created either.
fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 || metadata.file_type().is_symlink()
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

/// Makes `dir` the shell's data directory or says why it cannot be:
/// missing → created and marked; a link → refused; marked → used; empty → marked;
/// anything else → refused, and nothing in it is touched.
pub fn claim(dir: &Path) -> Result<(), Refusal> {
    let metadata = match fs::symlink_metadata(dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            fs::create_dir_all(dir).map_err(Refusal::Unusable)?;
            return write_marker(dir).map_err(Refusal::Unusable);
        }
        Err(error) => return Err(Refusal::Unusable(error)),
    };
    if is_link(&metadata) {
        return Err(Refusal::Link);
    }
    if !metadata.is_dir() {
        return Err(Refusal::Foreign);
    }
    if has_marker(dir, DATA_ROOT_MARKER, DATA_ROOT_MARKER_MAGIC) {
        return Ok(());
    }
    let mut entries = fs::read_dir(dir).map_err(Refusal::Unusable)?;
    if entries.next().is_some() {
        return Err(Refusal::Foreign);
    }
    write_marker(dir).map_err(Refusal::Unusable)
}

/// Removes the WebView2 state directory of builds under the legacy identifier, part of the
/// legacy identifier migration: `Ok(true)` when it was removed, `Ok(false)` when there is
/// none. A link is refused, so only that directory itself is ever removed, never what a
/// link points to.
pub fn remove_legacy_state_dir(dir: &Path) -> Result<bool, String> {
    let metadata = match fs::symlink_metadata(dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("inspect: {error}")),
    };
    if is_link(&metadata) {
        return Err("it is a link; left alone".to_owned());
    }
    if !metadata.is_dir() {
        return Err("it is not a directory; left alone".to_owned());
    }
    fs::remove_dir_all(dir).map_err(|error| format!("remove: {error}"))?;
    Ok(true)
}

/// Copy in the user's UI language: Chinese for any Chinese locale, English otherwise.
fn shell_copy() -> &'static ShellCopy {
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetUserDefaultUILanguage() -> u16;
        }
        const LANG_CHINESE: u16 = 0x04;
        // SAFETY: takes no arguments and only returns a language identifier.
        let language = unsafe { GetUserDefaultUILanguage() };
        if language & 0x3ff == LANG_CHINESE {
            return &SHELL_COPY_ZH_CN;
        }
        &SHELL_COPY_EN
    }
    #[cfg(not(windows))]
    {
        &SHELL_COPY_EN
    }
}

/// The message for a refusal, with the directory and any error detail filled in.
fn refusal_message(copy: &ShellCopy, dir: &Path, refusal: &Refusal) -> String {
    let path = dir.display().to_string();
    match refusal {
        Refusal::Link => copy.data_dir_link.replace("{path}", &path),
        Refusal::Foreign => copy.data_dir_foreign.replace("{path}", &path),
        Refusal::Unusable(error) => copy.data_dir_unusable.replace("{path}", &path).replace("{error}", &error.to_string()),
    }
}

/// A blocking native error box. MessageBoxW runs its own modal loop, so it works during
/// `setup` on the main thread, before the event loop that the dialog plugin relies on.
#[cfg(windows)]
fn show_error(title: &str, text: &str) {
    #[link(name = "user32")]
    unsafe extern "system" {
        fn MessageBoxW(owner: *mut core::ffi::c_void, text: *const u16, caption: *const u16, kind: u32) -> i32;
    }
    const MB_ICONERROR: u32 = 0x0000_0010;
    const MB_SETFOREGROUND: u32 = 0x0001_0000;
    const MB_TOPMOST: u32 = 0x0004_0000;
    let wide = |text: &str| text.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (text, title) = (wide(text), wide(title));
    // SAFETY: both pointers are to NUL-terminated UTF-16 buffers that outlive the call, and a
    // null owner window is valid.
    unsafe {
        MessageBoxW(core::ptr::null_mut(), text.as_ptr(), title.as_ptr(), MB_ICONERROR | MB_SETFOREGROUND | MB_TOPMOST);
    }
}

#[cfg(not(windows))]
fn show_error(title: &str, text: &str) {
    eprintln!("{title}: {text}");
}

/// Tells the user why Amber does not start and ends the process; the sidecar never starts.
pub fn refuse_and_exit(app: &tauri::AppHandle, dir: &Path, refusal: &Refusal) -> ! {
    use tauri::Manager;
    // The configured main window already exists; an empty window behind the message would
    // look like Amber started.
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    let copy = shell_copy();
    show_error(copy.title, &refusal_message(copy, dir, refusal));
    std::process::exit(1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encoding::base64url;
    use crate::identity::LEGACY_APP_IDENTIFIER;
    use crate::sidecar::fill_random;
    use std::path::PathBuf;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let mut bytes = [0u8; 8];
            fill_random(&mut bytes).unwrap();
            let dir = std::env::temp_dir().join(format!("amber-{name}-{}", base64url(&bytes)));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn marker_of(dir: &Path) -> String {
        fs::read_to_string(dir.join(DATA_ROOT_MARKER)).unwrap()
    }

    #[test]
    fn creates_and_marks_a_missing_directory() {
        let temp = TempDir::new("claim-missing");
        let dir = temp.0.join("Amber");
        claim(&dir).unwrap();
        assert!(dir.is_dir());
        assert_eq!(marker_of(&dir), "amber-data-root-v1\ncom.lifefindsitsway.amber\n");
        // Claiming again is a no-op on the marked directory.
        fs::write(dir.join("amber.db"), b"db").unwrap();
        claim(&dir).unwrap();
        assert_eq!(fs::read(dir.join("amber.db")).unwrap(), b"db");
    }

    #[test]
    fn marks_an_existing_empty_directory() {
        let temp = TempDir::new("claim-empty");
        claim(&temp.0).unwrap();
        assert_eq!(marker_of(&temp.0), marker_text(DATA_ROOT_MARKER_MAGIC));
    }

    #[test]
    fn accepts_a_marker_with_crlf_and_trailing_spaces() {
        let temp = TempDir::new("claim-crlf");
        fs::write(temp.0.join(DATA_ROOT_MARKER), "amber-data-root-v1 \r\ncom.lifefindsitsway.amber\r\n").unwrap();
        fs::write(temp.0.join("amber.db"), b"db").unwrap();
        claim(&temp.0).unwrap();
    }

    /// The data directory a build under the legacy identifier marked is claimed as it is.
    #[test]
    fn accepts_the_marker_of_a_legacy_build_and_keeps_it() {
        let temp = TempDir::new("claim-legacy");
        let legacy = format!("amber-data-root-v1\n{LEGACY_APP_IDENTIFIER}\n");
        fs::write(temp.0.join(DATA_ROOT_MARKER), &legacy).unwrap();
        fs::write(temp.0.join("amber.db"), b"db").unwrap();
        claim(&temp.0).unwrap();
        assert_eq!(marker_of(&temp.0), legacy);
        assert_eq!(fs::read(temp.0.join("amber.db")).unwrap(), b"db");
    }

    #[test]
    fn removes_the_legacy_state_directory_once() {
        let temp = TempDir::new("legacy-state");
        let dir = temp.0.join(LEGACY_APP_IDENTIFIER);
        fs::create_dir_all(dir.join("EBWebView").join("Default")).unwrap();
        fs::write(dir.join("EBWebView").join("Default").join("Cookies"), b"x").unwrap();
        assert_eq!(remove_legacy_state_dir(&dir), Ok(true));
        assert!(!dir.exists());
        assert_eq!(remove_legacy_state_dir(&dir), Ok(false));
    }

    #[test]
    fn leaves_a_file_in_place_of_the_legacy_state_directory() {
        let temp = TempDir::new("legacy-state-file");
        let file = temp.0.join(LEGACY_APP_IDENTIFIER);
        fs::write(&file, b"x").unwrap();
        assert!(remove_legacy_state_dir(&file).is_err());
        assert_eq!(fs::read(&file).unwrap(), b"x");
    }

    #[test]
    fn refuses_a_foreign_directory_and_leaves_it_untouched() {
        let temp = TempDir::new("claim-foreign");
        fs::write(temp.0.join("notes.txt"), b"mine").unwrap();
        assert!(matches!(claim(&temp.0), Err(Refusal::Foreign)));
        assert!(!temp.0.join(DATA_ROOT_MARKER).exists());
        assert_eq!(fs::read(temp.0.join("notes.txt")).unwrap(), b"mine");

        // A marker with the wrong magic or no identifier line does not count, nor a directory named like it.
        fs::write(temp.0.join(DATA_ROOT_MARKER), "amber-cache-root-v1\ncom.lifefindsitsway.amber\n").unwrap();
        assert!(matches!(claim(&temp.0), Err(Refusal::Foreign)));
        fs::remove_file(temp.0.join(DATA_ROOT_MARKER)).unwrap();
        fs::write(temp.0.join(DATA_ROOT_MARKER), "amber-data-root-v1\n").unwrap();
        assert!(matches!(claim(&temp.0), Err(Refusal::Foreign)));
        fs::remove_file(temp.0.join(DATA_ROOT_MARKER)).unwrap();
        fs::create_dir(temp.0.join(DATA_ROOT_MARKER)).unwrap();
        assert!(matches!(claim(&temp.0), Err(Refusal::Foreign)));
    }

    #[test]
    fn refuses_a_file_in_place_of_the_directory() {
        let temp = TempDir::new("claim-file");
        let file = temp.0.join("Amber");
        fs::write(&file, b"x").unwrap();
        assert!(matches!(claim(&file), Err(Refusal::Foreign)));
        assert_eq!(fs::read(&file).unwrap(), b"x");
    }

    #[cfg(windows)]
    #[test]
    fn refuses_a_junction_even_to_a_marked_directory() {
        let temp = TempDir::new("claim-junction");
        let target = temp.0.join("real");
        fs::create_dir(&target).unwrap();
        fs::write(target.join(DATA_ROOT_MARKER), marker_text(DATA_ROOT_MARKER_MAGIC)).unwrap();
        let link = temp.0.join("Amber");
        // A directory junction needs no privilege, unlike a symlink.
        let status = std::process::Command::new("cmd")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&link)
            .arg(&target)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
        assert!(matches!(claim(&link), Err(Refusal::Link)));
        // Removing the junction leaves its target alone.
        fs::remove_dir(&link).unwrap();
        assert!(target.join(DATA_ROOT_MARKER).is_file());
    }

    #[cfg(windows)]
    #[test]
    fn leaves_a_junction_in_place_of_the_legacy_state_directory_and_its_target() {
        let temp = TempDir::new("legacy-state-junction");
        let target = temp.0.join("real");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("keep.txt"), b"x").unwrap();
        let link = temp.0.join(LEGACY_APP_IDENTIFIER);
        let status = std::process::Command::new("cmd")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&link)
            .arg(&target)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
        assert!(remove_legacy_state_dir(&link).is_err());
        assert!(target.join("keep.txt").is_file());
        fs::remove_dir(&link).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_even_to_a_marked_directory() {
        let temp = TempDir::new("claim-symlink");
        let target = temp.0.join("real");
        fs::create_dir(&target).unwrap();
        fs::write(target.join(DATA_ROOT_MARKER), marker_text(DATA_ROOT_MARKER_MAGIC)).unwrap();
        let link = temp.0.join("Amber");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(matches!(claim(&link), Err(Refusal::Link)));
    }

    #[test]
    fn fills_in_the_refusal_message() {
        let dir = Path::new("C:/Users/x/AppData/Roaming/Amber");
        for copy in [&SHELL_COPY_ZH_CN, &SHELL_COPY_EN] {
            let foreign = refusal_message(copy, dir, &Refusal::Foreign);
            assert!(foreign.contains("C:/Users/x/AppData/Roaming/Amber") && !foreign.contains("{path}"));
            let link = refusal_message(copy, dir, &Refusal::Link);
            assert!(link.contains("C:/Users/x/AppData/Roaming/Amber") && !link.contains("{path}"));
            let unusable = refusal_message(copy, dir, &Refusal::Unusable(std::io::Error::other("denied")));
            assert!(unusable.contains("denied") && !unusable.contains("{error}"));
        }
    }
}
