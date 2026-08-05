//! Per-node merod version selection: id parsing, the shared binary store,
//! GitHub release listing, install and remove.

use crate::{TauriError, TauriErrorCode};
use std::path::{Path, PathBuf};

/// Which merod binary a node runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VersionId {
    /// The binary shipped inside the app bundle.
    Bundled,
    /// A release tag downloaded into the shared store.
    Release(String),
    /// A build the developer points at. Re-read at every start so rebuilds are picked up.
    Local(PathBuf),
}

pub const BUNDLED_ID: &str = "bundled";
const LOCAL_PREFIX: &str = "local:";

/// Tags land in both a URL and a directory name, so restrict them to characters
/// that are unambiguous in each. `.` and `..` are excluded separately: both are
/// made only of allowed characters, and either would resolve a store path back
/// out of its per-tag directory.
pub fn is_safe_tag(tag: &str) -> bool {
    !tag.is_empty()
        && tag != "."
        && tag != ".."
        && tag
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
}

pub fn parse_version_id(raw: &str) -> Result<VersionId, TauriError> {
    if raw == BUNDLED_ID {
        return Ok(VersionId::Bundled);
    }

    if let Some(path) = raw.strip_prefix(LOCAL_PREFIX) {
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            return Err(TauriError::new(
                TauriErrorCode::InvalidInput,
                format!("Local merod path must be absolute, got '{}'", path.display()),
            ));
        }
        return Ok(VersionId::Local(path));
    }

    if is_safe_tag(raw) {
        return Ok(VersionId::Release(raw.to_string()));
    }

    Err(TauriError::new(
        TauriErrorCode::InvalidInput,
        format!("Unrecognised merod version id '{}'", raw),
    ))
}

pub fn version_id_to_string(id: &VersionId) -> String {
    match id {
        VersionId::Bundled => BUNDLED_ID.to_string(),
        VersionId::Release(tag) => tag.clone(),
        VersionId::Local(path) => format!("{}{}", LOCAL_PREFIX, path.display()),
    }
}

/// Root of the shared binary store. Deliberately under the app data directory:
/// writing into the app bundle would break its signature seal.
pub fn store_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("merod")
}

pub fn release_binary_path(app_data_dir: &Path, tag: &str) -> PathBuf {
    store_dir(app_data_dir).join(tag).join("merod")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_three_id_shapes() {
        assert!(matches!(parse_version_id("bundled").unwrap(), VersionId::Bundled));
        assert!(matches!(
            parse_version_id("0.11.0-rc.15").unwrap(),
            VersionId::Release(t) if t == "0.11.0-rc.15"
        ));
        assert!(matches!(
            parse_version_id("local:/tmp/merod").unwrap(),
            VersionId::Local(p) if p == PathBuf::from("/tmp/merod")
        ));
    }

    #[test]
    fn round_trips_every_id_shape() {
        for raw in ["bundled", "0.11.0-rc.15", "local:/tmp/merod"] {
            let parsed = parse_version_id(raw).unwrap();
            assert_eq!(version_id_to_string(&parsed), raw);
        }
    }

    #[test]
    fn rejects_a_relative_local_path() {
        // A relative path would resolve against the app's cwd, which is not the
        // directory the user picked from.
        assert!(parse_version_id("local:../merod").is_err());
        assert!(parse_version_id("local:merod").is_err());
    }

    #[test]
    fn rejects_an_empty_local_path() {
        assert!(parse_version_id("local:").is_err());
    }

    #[test]
    fn rejects_tags_that_are_unsafe_in_a_url_or_path() {
        assert!(is_safe_tag("0.11.0-rc.15"));
        assert!(is_safe_tag("0.11.0"));
        assert!(!is_safe_tag("../../etc/passwd"));
        assert!(!is_safe_tag("0.11.0/../x"));
        assert!(!is_safe_tag(""));
        assert!(!is_safe_tag("tag with space"));
        assert!(!is_safe_tag(".."));
        assert!(!is_safe_tag("."));
    }

    #[test]
    fn release_path_is_namespaced_by_tag() {
        let base = Path::new("/data");
        assert_eq!(
            release_binary_path(base, "0.11.0-rc.15"),
            PathBuf::from("/data/merod/0.11.0-rc.15/merod")
        );
    }
}
