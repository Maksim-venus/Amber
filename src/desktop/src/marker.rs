//! Ownership markers: a small file whose first line names the kind of
//! directory and whose second line is the identifier of the build that wrote it, the same
//! format as `markerText` and `isMarkerText` in `src/shared/app-identity.ts`. The uninstaller deletes only
//! directories that carry one, so the shell checks them before reusing or claiming a directory.

use std::fs;
use std::path::Path;

use crate::identity::APP_IDENTIFIER;

/// A marker larger than this is not one Amber wrote.
const MARKER_MAX_BYTES: u64 = 4096;

/// The text of a marker with `magic`.
pub fn marker_text(magic: &str) -> String {
    format!("{magic}\n{APP_IDENTIFIER}\n")
}

/// Whether `text` is a valid marker with `magic`; trailing whitespace and CRLF are tolerated.
/// Only the first line decides: markers written under the legacy identifier stay valid.
pub fn is_marker_text(text: &str, magic: &str) -> bool {
    let mut lines = text.split('\n');
    lines.next().map(str::trim) == Some(magic) && lines.next().is_some_and(|line| !line.trim().is_empty())
}

/// Whether `dir` holds a regular file `name` (not a link) with a valid marker.
pub fn has_marker(dir: &Path, name: &str, magic: &str) -> bool {
    let path = dir.join(name);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() && metadata.len() <= MARKER_MAX_BYTES => {
            fs::read_to_string(&path).is_ok_and(|text| is_marker_text(&text, magic))
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::LEGACY_APP_IDENTIFIER;

    #[test]
    fn writes_and_recognizes_the_shared_format() {
        assert_eq!(marker_text("amber-data-root-v1"), "amber-data-root-v1\ncom.lifefindsitsway.amber\n");
        assert!(is_marker_text(&marker_text("amber-cache-root-v1"), "amber-cache-root-v1"));
        assert!(is_marker_text("amber-cache-root-v1 \r\ncom.lifefindsitsway.amber\r\n", "amber-cache-root-v1"));
        // Written by a build under the legacy identifier.
        assert!(is_marker_text(&format!("amber-data-root-v1\r\n{LEGACY_APP_IDENTIFIER}\r\n"), "amber-data-root-v1"));
        assert!(!is_marker_text(&marker_text("amber-data-root-v1"), "amber-cache-root-v1"));
        assert!(!is_marker_text("amber-cache-root-v1\n \n", "amber-cache-root-v1"));
        assert!(!is_marker_text("amber-cache-root-v1", "amber-cache-root-v1"));
        assert!(!is_marker_text("", "amber-cache-root-v1"));
    }
}
