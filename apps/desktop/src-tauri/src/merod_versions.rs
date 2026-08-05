//! Per-node merod version selection: id parsing, the shared binary store,
//! GitHub release listing, install and remove.

use crate::{TauriError, TauriErrorCode};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

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

/// Recorded in `<homeDir>/<node>/merod-version.json` when the node is created.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodePin {
    pub id: String,
    /// What the binary reported at init. Lets a `local:` build that silently moved
    /// backwards be surfaced later without blocking the start.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_at_init: Option<String>,
}

pub fn pin_path(home_dir: &Path, node_name: &str) -> PathBuf {
    home_dir.join(node_name).join("merod-version.json")
}

pub fn read_pin_raw(home_dir: &Path, node_name: &str) -> Option<NodePin> {
    let raw = std::fs::read_to_string(pin_path(home_dir, node_name)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// A missing or unreadable pin means the bundled binary. A node created before
/// this feature existed has no pin file and must keep starting normally.
pub fn read_pin(home_dir: &Path, node_name: &str) -> VersionId {
    read_pin_raw(home_dir, node_name)
        .and_then(|pin| parse_version_id(&pin.id).ok())
        .unwrap_or(VersionId::Bundled)
}

pub fn write_pin(home_dir: &Path, node_name: &str, pin: &NodePin) -> Result<(), TauriError> {
    let path = pin_path(home_dir, node_name);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            TauriError::with_details(
                TauriErrorCode::DirectoryError,
                "Failed to create node directory for the version pin",
                e.to_string(),
            )
        })?;
    }
    let body = serde_json::to_string_pretty(pin).map_err(|e| {
        TauriError::with_details(
            TauriErrorCode::InternalError,
            "Failed to serialise the version pin",
            e.to_string(),
        )
    })?;
    std::fs::write(&path, body).map_err(|e| {
        TauriError::with_details(
            TauriErrorCode::FileWriteError,
            "Failed to write the version pin",
            e.to_string(),
        )
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct ReleaseInfo {
    pub tag: String,
    pub prerelease: bool,
    /// Whether this release ships a merod build for the running platform.
    pub has_asset: bool,
}

/// One hour, matching GitHub's unauthenticated rate-limit window (60 requests/hour).
const RELEASE_CACHE_TTL: Duration = Duration::from_secs(3600);

static RELEASE_CACHE: Mutex<Option<(Instant, Vec<ReleaseInfo>)>> = Mutex::new(None);

pub(crate) fn releases_from_json(body: &serde_json::Value, target: &str) -> Vec<ReleaseInfo> {
    body.as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let tag = item["tag_name"].as_str()?;
                    if !is_safe_tag(tag) {
                        return None;
                    }
                    let has_asset = item["assets"]
                        .as_array()
                        .map(|assets| {
                            assets.iter().any(|a| {
                                a["name"]
                                    .as_str()
                                    .and_then(|n| crate::score_merod_asset(n, target))
                                    .is_some()
                            })
                        })
                        .unwrap_or(false);
                    Some(ReleaseInfo {
                        tag: tag.to_string(),
                        prerelease: item["prerelease"].as_bool().unwrap_or(false),
                        has_asset,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub async fn list_merod_releases(refresh: Option<bool>) -> Result<Vec<ReleaseInfo>, TauriError> {
    if !refresh.unwrap_or(false) {
        if let Ok(guard) = RELEASE_CACHE.lock() {
            if let Some((fetched_at, cached)) = guard.as_ref() {
                if fetched_at.elapsed() < RELEASE_CACHE_TTL {
                    return Ok(cached.clone());
                }
            }
        }
    }

    let response = crate::http_client()
        .get("https://api.github.com/repos/calimero-network/core/releases?per_page=40")
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "calimero-desktop")
        .send()
        .await
        .map_err(|e| {
            TauriError::new(TauriErrorCode::InternalError, format!("GitHub API: {}", e))
        })?;

    let status = response.status();
    let body: serde_json::Value = response.json().await.map_err(|e| {
        TauriError::new(
            TauriErrorCode::InternalError,
            format!("Parse releases JSON: {}", e),
        )
    })?;

    if !status.is_success() {
        let msg = body["message"].as_str().unwrap_or("unknown error");
        return Err(TauriError::new(
            TauriErrorCode::InternalError,
            format!("GitHub API returned {}: {}", status, msg),
        ));
    }

    let releases = releases_from_json(&body, crate::merod_target_triple());
    if let Ok(mut guard) = RELEASE_CACHE.lock() {
        *guard = Some((Instant::now(), releases.clone()));
    }
    Ok(releases)
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

    fn temp_home() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cal-pin-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("node1")).unwrap();
        dir
    }

    #[test]
    fn missing_pin_falls_back_to_bundled() {
        let home = temp_home();
        assert_eq!(read_pin(&home, "node1"), VersionId::Bundled);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn writes_then_reads_a_release_pin() {
        let home = temp_home();
        let pin = NodePin {
            id: "0.11.0-rc.15".to_string(),
            version_at_init: Some("merod 0.11.0-rc.15".to_string()),
        };
        write_pin(&home, "node1", &pin).unwrap();

        assert_eq!(read_pin(&home, "node1"), VersionId::Release("0.11.0-rc.15".into()));
        let raw = read_pin_raw(&home, "node1").unwrap();
        assert_eq!(raw.version_at_init.as_deref(), Some("merod 0.11.0-rc.15"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_corrupt_pin_falls_back_to_bundled_instead_of_failing_the_start() {
        let home = temp_home();
        std::fs::write(pin_path(&home, "node1"), "{ not json").unwrap();
        assert_eq!(read_pin(&home, "node1"), VersionId::Bundled);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn maps_release_json_to_release_info() {
        let body = serde_json::json!([
            { "tag_name": "0.11.0-rc.19", "prerelease": true,
              "assets": [{ "name": "merod_aarch64-apple-darwin.tar.gz" }] },
            { "tag_name": "0.10.0", "prerelease": false,
              "assets": [{ "name": "meroctl_aarch64-apple-darwin.tar.gz" }] },
            { "tag_name": "bad tag", "prerelease": false, "assets": [] }
        ]);

        let out = releases_from_json(&body, "aarch64-apple-darwin");

        // The unsafe tag is dropped entirely; the other two survive in order.
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].tag, "0.11.0-rc.19");
        assert!(out[0].prerelease);
        assert!(out[0].has_asset);
        assert_eq!(out[1].tag, "0.10.0");
        assert!(!out[1].prerelease);
        assert!(!out[1].has_asset, "meroctl is not a merod asset");
    }
}
