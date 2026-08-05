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

/// Tags land in both a URL and a directory name. `.` and `..` need excluding
/// separately: both pass the charset yet resolve out of their own directory.
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

#[derive(Debug, Clone, Serialize)]
pub struct InstalledVersion {
    pub id: String,
    pub path: String,
    pub size_bytes: u64,
    /// Node names pinned to this id, so Remove can refuse and say what it would break.
    pub used_by: Vec<String>,
    /// What the binary reports right now. Only measured for local builds, where it
    /// changes on every rebuild; a release is verified against its tag at install.
    pub measured_version: Option<String>,
    /// Nodes whose pin recorded a different version at init than the binary now
    /// reports. Local builds only - an app update rebases bundled nodes by design.
    pub drifted_nodes: Vec<String>,
}

/// Node names under `home_dir` whose pin matches `id`.
pub(crate) fn nodes_using(home_dir: &Path, id: &str) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(home_dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let pin = read_pin_raw(home_dir, &name)?;
            (pin.id == id).then_some(name)
        })
        .collect();
    names.sort();
    names
}

/// Download and extract `tag` into the store unless it is already there.
/// Installs of the same tag are serialised so two nodes cannot race the download.
pub async fn ensure_release_installed(
    app_data_dir: &Path,
    tag: &str,
) -> Result<PathBuf, TauriError> {
    use tokio::sync::Mutex as AsyncMutex;
    static IN_FLIGHT: std::sync::OnceLock<AsyncMutex<()>> = std::sync::OnceLock::new();

    if !is_safe_tag(tag) {
        return Err(TauriError::new(
            TauriErrorCode::InvalidInput,
            format!("Unsafe release tag '{}'", tag),
        ));
    }

    let dest = release_binary_path(app_data_dir, tag);
    if dest.exists() {
        return Ok(dest);
    }

    // Serialise all installs. Downloads are rare and a few seconds each, so a
    // single gate is simpler than per-tag locks and cannot deadlock.
    let gate = IN_FLIGHT.get_or_init(|| AsyncMutex::new(()));
    let _guard = gate.lock().await;
    if dest.exists() {
        return Ok(dest); // another caller finished while we waited
    }

    let target = crate::merod_target_triple();
    let release_url = format!(
        "https://api.github.com/repos/calimero-network/core/releases/tags/{}",
        tag
    );
    let response = crate::http_client()
        .get(&release_url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "calimero-desktop")
        .send()
        .await
        .map_err(|e| TauriError::new(TauriErrorCode::InternalError, format!("GitHub API: {}", e)))?;
    let status = response.status();
    let release: serde_json::Value = response.json().await.map_err(|e| {
        TauriError::new(TauriErrorCode::InternalError, format!("Parse release JSON: {}", e))
    })?;
    if !status.is_success() {
        let msg = release["message"].as_str().unwrap_or("unknown error");
        return Err(TauriError::new(
            TauriErrorCode::InternalError,
            format!("GitHub API returned {}: {}", status, msg),
        ));
    }

    let (asset_name, asset_url) = release["assets"]
        .as_array()
        .ok_or_else(|| {
            TauriError::new(TauriErrorCode::InternalError, "No assets in GitHub release")
        })?
        .iter()
        .filter_map(|a| {
            let name = a["name"].as_str()?;
            let url = a["browser_download_url"].as_str()?;
            let score = crate::score_merod_asset(name, target)?;
            Some((score, name.to_string(), url.to_string()))
        })
        .min_by_key(|(s, _, _)| *s)
        .map(|(_, n, u)| (n, u))
        .ok_or_else(|| {
            TauriError::new(
                TauriErrorCode::FileNotFound,
                format!("Release {} ships no merod build for {}", tag, target),
            )
        })?;

    let parsed = url::Url::parse(&asset_url)
        .map_err(|e| TauriError::new(TauriErrorCode::InvalidUrl, format!("asset URL: {}", e)))?;
    let host = parsed.host_str().unwrap_or("");
    if parsed.scheme() != "https"
        || (host != "github.com"
            && !host.ends_with(".github.com")
            && !host.ends_with(".githubusercontent.com"))
    {
        return Err(TauriError::new(
            TauriErrorCode::UrlNotAllowed,
            format!("Asset URL is not an https github.com URL: {}", asset_url),
        ));
    }

    let safe_asset_name: String = Path::new(&asset_name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("merod-asset")
        .to_string();

    let temp_dir = std::env::temp_dir().join(format!(
        "merod-install-{}-{}",
        tag,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    tokio::fs::create_dir_all(&temp_dir).await.map_err(|e| {
        TauriError::new(TauriErrorCode::DirectoryError, format!("create temp dir: {}", e))
    })?;

    // temp_dir is removed once, unconditionally, after this block - not at each
    // `?` - so a dropped connection or a mid-flight failure never leaks it.
    let install_result: Result<PathBuf, TauriError> = async {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&temp_dir, std::fs::Permissions::from_mode(0o700)).map_err(
                |e| TauriError::new(TauriErrorCode::DirectoryError, format!("temp dir perms: {}", e)),
            )?;
        }

        let archive_path = temp_dir.join(&safe_asset_name);
        let download_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(300))
            .build()
            .map_err(|e| {
                TauriError::new(TauriErrorCode::InternalError, format!("download client: {}", e))
            })?;
        let dl = download_client
            .get(&asset_url)
            .header("User-Agent", "calimero-desktop")
            .send()
            .await
            .map_err(|e| {
                TauriError::new(TauriErrorCode::InternalError, format!("download: {}", e))
            })?;
        if !dl.status().is_success() {
            return Err(TauriError::new(
                TauriErrorCode::InternalError,
                format!("Asset download returned HTTP {}", dl.status()),
            ));
        }
        let bytes = dl.bytes().await.map_err(|e| {
            TauriError::new(TauriErrorCode::InternalError, format!("read download: {}", e))
        })?;
        tokio::fs::write(&archive_path, &bytes).await.map_err(|e| {
            TauriError::new(TauriErrorCode::FileWriteError, format!("write archive: {}", e))
        })?;

        let extracted =
            crate::extract_merod_binary(&archive_path, &safe_asset_name, &temp_dir).await?;

        let dest_dir = dest.parent().ok_or_else(|| {
            TauriError::new(TauriErrorCode::DirectoryError, "store path has no parent")
        })?;
        tokio::fs::create_dir_all(dest_dir).await.map_err(|e| {
            TauriError::new(TauriErrorCode::DirectoryError, format!("create store dir: {}", e))
        })?;

        // Copy to a sibling then rename, so a crash mid-copy cannot leave a
        // truncated binary at the path other nodes resolve.
        let staged = dest.with_extension("staged");
        let staged_result: Result<PathBuf, TauriError> = async {
            tokio::fs::copy(&extracted, &staged).await.map_err(|e| {
                TauriError::new(TauriErrorCode::InternalError, format!("stage binary: {}", e))
            })?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755)).map_err(
                    |e| TauriError::new(TauriErrorCode::InternalError, format!("set +x: {}", e)),
                )?;
            }

            let reported = crate::get_merod_version_at(&staged).await;
            let expected = format!("merod {}", tag);
            match reported {
                Some(v) if v == expected => {}
                other => {
                    return Err(TauriError::new(
                        TauriErrorCode::InternalError,
                        format!(
                            "Downloaded binary reports '{}', expected '{}'",
                            other.unwrap_or_else(|| "nothing".to_string()),
                            expected
                        ),
                    ));
                }
            }

            tokio::fs::rename(&staged, &dest).await.map_err(|e| {
                TauriError::new(TauriErrorCode::InternalError, format!("install binary: {}", e))
            })?;
            Ok(dest.clone())
        }
        .await;

        // Unconditional, same reasoning as temp_dir: any failure past the copy
        // could otherwise leave `.staged` sitting in the persistent store.
        if staged_result.is_err() {
            let _ = tokio::fs::remove_file(&staged).await;
        }
        staged_result
    }
    .await;

    let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    install_result
}

fn app_data(app_handle: &tauri::AppHandle) -> Result<PathBuf, TauriError> {
    use tauri::Manager;
    app_handle.path().app_data_dir().map_err(|e| {
        TauriError::with_details(
            TauriErrorCode::DirectoryError,
            "Failed to resolve the app data directory",
            e.to_string(),
        )
    })
}

fn file_size(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// Turn an id into a binary path, downloading a release on first use.
pub async fn resolve_binary(
    app_handle: &tauri::AppHandle,
    id: &VersionId,
) -> Result<PathBuf, TauriError> {
    match id {
        VersionId::Bundled => crate::get_bundled_merod_path(app_handle)
            .map_err(|e| TauriError::new(TauriErrorCode::FileNotFound, e)),
        VersionId::Release(tag) => {
            let base = app_data(app_handle)?;
            ensure_release_installed(&base, tag).await
        }
        VersionId::Local(path) => {
            if !path.exists() {
                return Err(TauriError::new(
                    TauriErrorCode::FileNotFound,
                    format!(
                        "The local merod build at {} is gone. Rebuild it, or point this node at another build from the Versions panel.",
                        path.display()
                    ),
                ));
            }
            Ok(path.clone())
        }
    }
}

#[tauri::command]
pub async fn install_merod_version(
    tag: String,
    app_handle: tauri::AppHandle,
) -> Result<InstalledVersion, TauriError> {
    let base = app_data(&app_handle)?;
    let path = ensure_release_installed(&base, &tag).await?;
    Ok(InstalledVersion {
        id: tag,
        path: path.to_string_lossy().into_owned(),
        size_bytes: file_size(&path),
        used_by: Vec::new(),
        measured_version: None,
        drifted_nodes: Vec::new(),
    })
}

#[tauri::command]
pub async fn list_installed_merod_versions(
    home_dir: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<Vec<InstalledVersion>, TauriError> {
    let base = app_data(&app_handle)?;
    let home = crate::resolve_home_dir(home_dir)?;

    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(store_dir(&base)) {
        for entry in entries.flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            let tag = entry.file_name().to_string_lossy().to_string();
            let binary = release_binary_path(&base, &tag);
            if !binary.exists() {
                continue;
            }
            out.push(InstalledVersion {
                used_by: nodes_using(&home, &tag),
                size_bytes: file_size(&binary),
                path: binary.to_string_lossy().into_owned(),
                id: tag,
                measured_version: None,
                drifted_nodes: Vec::new(),
            });
        }
    }

    // Every distinct local build in use, so the panel can offer a repair per node.
    let mut locals: Vec<String> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&home) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(pin) = read_pin_raw(&home, &name) {
                if pin.id.starts_with(LOCAL_PREFIX) && !locals.contains(&pin.id) {
                    locals.push(pin.id);
                }
            }
        }
    }
    locals.sort();
    for id in locals {
        let path = PathBuf::from(id.trim_start_matches(LOCAL_PREFIX));
        let users = nodes_using(&home, &id);
        let measured = crate::get_merod_version_at(&path).await;
        // A node with no recorded version_at_init predates this check - nothing to compare.
        let drifted_nodes: Vec<String> = users
            .iter()
            .filter(|node| match read_pin_raw(&home, node).and_then(|p| p.version_at_init) {
                Some(v) => Some(v) != measured,
                None => false,
            })
            .cloned()
            .collect();
        out.push(InstalledVersion {
            used_by: users,
            size_bytes: file_size(&path),
            path: path.to_string_lossy().into_owned(),
            id,
            measured_version: measured,
            drifted_nodes,
        });
    }

    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

#[tauri::command]
pub async fn remove_merod_version(
    tag: String,
    home_dir: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<(), TauriError> {
    if !is_safe_tag(&tag) {
        return Err(TauriError::new(
            TauriErrorCode::InvalidInput,
            format!("Unsafe release tag '{}'", tag),
        ));
    }
    let base = app_data(&app_handle)?;
    let home = crate::resolve_home_dir(home_dir)?;

    let users = nodes_using(&home, &tag);
    if !users.is_empty() {
        return Err(TauriError::new(
            TauriErrorCode::InvalidInput,
            format!("{} is still used by: {}", tag, users.join(", ")),
        ));
    }

    let root = store_dir(&base);
    let dir = root.join(&tag);
    // Defence in depth behind is_safe_tag: this call deletes a tree, so confirm
    // the resolved path is still inside the store before recursing.
    if dir.parent() != Some(root.as_path()) {
        return Err(TauriError::new(
            TauriErrorCode::PathNotAllowed,
            format!("Refusing to remove a path outside the merod store: {}", dir.display()),
        ));
    }
    std::fs::remove_dir_all(&dir).map_err(|e| {
        TauriError::with_details(
            TauriErrorCode::DirectoryError,
            format!("Failed to remove {}", tag),
            e.to_string(),
        )
    })
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

    #[test]
    fn nodes_using_a_version_are_found_by_scanning_pins() {
        let home = temp_home();
        std::fs::create_dir_all(home.join("node2")).unwrap();
        write_pin(&home, "node1", &NodePin { id: "0.11.0-rc.15".into(), version_at_init: None }).unwrap();
        write_pin(&home, "node2", &NodePin { id: "bundled".into(), version_at_init: None }).unwrap();

        let users = nodes_using(&home, "0.11.0-rc.15");
        assert_eq!(users, vec!["node1".to_string()]);
        assert!(nodes_using(&home, "0.11.0-rc.18").is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }
}
