//! Per-node merod version selection: id parsing, the shared binary store,
//! GitHub release listing, install and remove.

use crate::LockUnpoisoned;
use crate::{TauriError, TauriErrorCode};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::Manager;
use tokio::process::Command;
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

/// Check a download against the `sha256:...` digest GitHub publishes for the
/// asset. Catches corruption and a tampered CDN, not a malicious release itself.
pub(crate) fn verify_sha256(bytes: &[u8], expected: &str) -> Result<(), TauriError> {
    use sha2::{Digest, Sha256};
    // Refuse an algorithm we cannot compute: a digest we are unable to check is
    // not a digest that passed. An absent digest is handled by the caller.
    let Some(want) = expected.strip_prefix("sha256:") else {
        return Err(TauriError::with_details(
            TauriErrorCode::InternalError,
            "GitHub published a digest this build cannot verify",
            format!("expected a sha256: digest, got '{}'", expected),
        ));
    };
    let got = format!("{:x}", Sha256::digest(bytes));
    if got.eq_ignore_ascii_case(want) {
        Ok(())
    } else {
        Err(TauriError::with_details(
            TauriErrorCode::InternalError,
            "Downloaded merod archive does not match the digest GitHub published",
            format!("expected {}, got {}", want, got),
        ))
    }
}

fn github_get(url: &str) -> reqwest::RequestBuilder {
    crate::http_client()
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "calimero-desktop")
}

/// Asset downloads must stay on GitHub, on every redirect hop, not just the first.
fn is_allowed_asset_url(url: &url::Url) -> bool {
    let host = url.host_str().unwrap_or("");
    url.scheme() == "https"
        && (host == "github.com"
            || host.ends_with(".github.com")
            || host.ends_with(".githubusercontent.com"))
}

/// merod reports `merod <tag> (build ...) (commit ...) (rustc ...)`, so match the
/// version field rather than the whole line, which never equals the bare tag.
pub(crate) fn version_matches_tag(reported: &str, tag: &str) -> bool {
    let expected = format!("merod {}", tag);
    match reported.strip_prefix(&expected) {
        Some(rest) => rest.is_empty() || rest.starts_with(char::is_whitespace),
        None => false,
    }
}

/// Tags land in both a URL and a directory name. `.` and `..` need excluding
/// separately: both pass the charset yet resolve out of their own directory.
pub fn is_safe_tag(tag: &str) -> bool {
    !tag.is_empty()
        && tag != "."
        && tag != ".."
        // A release tagged "bundled" would round-trip through the pin file as
        // the shipped binary, silently running the wrong merod.
        && tag != BUNDLED_ID
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
    // Windows needs the extension: Command::new does not append .exe to an
    // explicit path the way PATH lookup does.
    let name = if cfg!(target_os = "windows") { "merod.exe" } else { "merod" };
    store_dir(app_data_dir).join(tag).join(name)
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

/// A missing or unreadable pin means the bundled binary: a node created before
/// this feature existed has none and must keep starting normally. A pin that
/// reads but names an id we cannot parse is different - it was written
/// deliberately, so refuse rather than silently start the wrong binary.
pub fn read_pin(home_dir: &Path, node_name: &str) -> Result<VersionId, TauriError> {
    match read_pin_raw(home_dir, node_name) {
        None => Ok(VersionId::Bundled),
        Some(pin) => parse_version_id(&pin.id).map_err(|_| {
            TauriError::with_details(
                TauriErrorCode::ConfigParseError,
                format!("Node '{}' is pinned to a merod version this app does not understand", node_name),
                format!("merod-version.json names '{}'", pin.id),
            )
        }),
    }
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

static RELEASE_CACHE: Mutex<Option<(Instant, ReleaseListing)>> = Mutex::new(None);

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
                                    .and_then(|n| score_merod_asset(n, target))
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

/// Releases plus whether they came from an expired cache after a failed fetch,
/// so the UI can say so rather than showing an empty list.
#[derive(Debug, Clone, Serialize)]
pub struct ReleaseListing {
    pub releases: Vec<ReleaseInfo>,
    pub stale: bool,
}

/// Serve whatever we last fetched when a refetch fails. The unauthenticated
/// GitHub limit is 60/hour, so a rate-limited user would otherwise see nothing.
/// Re-stamps the cache so a failure backs off for the TTL too - otherwise every
/// later call refires the request, retrying hardest while GitHub rate-limits.
fn stale_or_error(error: TauriError) -> Result<ReleaseListing, TauriError> {
    RELEASE_CACHE
        .lock()
        .ok()
        .and_then(|mut g| {
            let (fetched_at, listing) = g.as_mut()?;
            if listing.releases.is_empty() {
                return None;
            }
            listing.stale = true;
            *fetched_at = Instant::now();
            Some(listing.clone())
        })
        .ok_or(error)
}

#[tauri::command]
pub async fn list_merod_releases(refresh: Option<bool>) -> Result<ReleaseListing, TauriError> {
    if !refresh.unwrap_or(false) {
        if let Ok(guard) = RELEASE_CACHE.lock() {
            if let Some((fetched_at, cached)) = guard.as_ref() {
                if fetched_at.elapsed() < RELEASE_CACHE_TTL {
                    return Ok(cached.clone());
                }
            }
        }
    }

    let response = github_get("https://api.github.com/repos/calimero-network/core/releases?per_page=40")
        .send()
        .await;

    let response = match response {
        Ok(r) => r,
        Err(e) => {
            return stale_or_error(TauriError::new(
                TauriErrorCode::InternalError,
                format!("GitHub API: {}", e),
            ))
        }
    };

    let status = response.status();
    let body: serde_json::Value = match response.json().await {
        Ok(b) => b,
        Err(e) => {
            return stale_or_error(TauriError::new(
                TauriErrorCode::InternalError,
                format!("Parse releases JSON: {}", e),
            ))
        }
    };

    if !status.is_success() {
        let msg = body["message"].as_str().unwrap_or("unknown error");
        return stale_or_error(TauriError::new(
            TauriErrorCode::InternalError,
            format!("GitHub API returned {}: {}", status, msg),
        ));
    }

    let listing = ReleaseListing {
        releases: releases_from_json(&body, merod_target_triple()),
        stale: false,
    };
    if let Ok(mut guard) = RELEASE_CACHE.lock() {
        *guard = Some((Instant::now(), listing.clone()));
    }
    Ok(listing)
}

/// Repoint every node using `old_id` at a different local build. This is the
/// repair the "build is gone" error tells the user about, not a re-pin.
#[tauri::command]
pub async fn repoint_local_build(
    old_id: String,
    new_path: String,
    home_dir: Option<String>,
) -> Result<u32, TauriError> {
    if !old_id.starts_with(LOCAL_PREFIX) {
        return Err(TauriError::new(
            TauriErrorCode::InvalidInput,
            "Only a local build can be repointed",
        ));
    }
    let new_id = format!("{}{}", LOCAL_PREFIX, new_path);
    // new_id always carries LOCAL_PREFIX, so parse_version_id either errors on a
    // relative path or yields Local.
    let VersionId::Local(path) = parse_version_id(&new_id)? else {
        unreachable!("a local: id cannot parse to another variant")
    };
    if !path.is_file() {
        return Err(TauriError::new(
            TauriErrorCode::FileNotFound,
            format!("No file at {}", path.display()),
        ));
    }

    let home = crate::resolve_home_dir(home_dir)?;
    // Re-measure rather than carrying the old value over: this is a different
    // binary, so the previous version_at_init would report drift forever.
    let measured = get_merod_version_at(&path).await;

    // Keep going on a failure rather than stopping half way: aborting mid-loop
    // leaves some nodes repointed and some not, with no way to tell which.
    let mut changed = 0u32;
    let mut failed: Vec<String> = Vec::new();
    for node in nodes_using(&home, &old_id) {
        let pin = NodePin {
            id: new_id.clone(),
            version_at_init: measured.clone(),
        };
        match write_pin(&home, &node, &pin) {
            Ok(()) => changed += 1,
            Err(_) => failed.push(node),
        }
    }
    if !failed.is_empty() {
        return Err(TauriError::with_details(
            TauriErrorCode::FileWriteError,
            format!("Repointed {} node(s); {} could not be updated", changed, failed.len()),
            failed.join(", "),
        ));
    }
    Ok(changed)
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
    // Per tag, not global: two nodes pinned to different releases can now be
    // created concurrently, and one slow download must not stall the other.
    static IN_FLIGHT: std::sync::LazyLock<
        std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<AsyncMutex<()>>>>,
    > = std::sync::LazyLock::new(Default::default);

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
    let gate = {
        let mut gates = IN_FLIGHT.lock_unpoisoned();
        gates.entry(tag.to_string()).or_default().clone()
    };
    let _guard = gate.lock().await;
    if dest.exists() {
        return Ok(dest); // another caller finished while we waited
    }

    let target = merod_target_triple();
    let release_url = format!(
        "https://api.github.com/repos/calimero-network/core/releases/tags/{}",
        tag
    );
    let response = github_get(&release_url)
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

    let (asset_name, asset_url, asset_digest) = release["assets"]
        .as_array()
        .ok_or_else(|| {
            TauriError::new(TauriErrorCode::InternalError, "No assets in GitHub release")
        })?
        .iter()
        .filter_map(|a| {
            let name = a["name"].as_str()?;
            let url = a["browser_download_url"].as_str()?;
            let score = score_merod_asset(name, target)?;
            let digest = a["digest"].as_str().map(str::to_string);
            Some((score, name.to_string(), url.to_string(), digest))
        })
        .min_by_key(|(s, _, _, _)| *s)
        .map(|(_, n, u, d)| (n, u, d))
        .ok_or_else(|| {
            TauriError::new(
                TauriErrorCode::FileNotFound,
                format!("Release {} ships no merod build for {}", tag, target),
            )
        })?;

    let parsed = url::Url::parse(&asset_url)
        .map_err(|e| TauriError::new(TauriErrorCode::InvalidUrl, format!("asset URL: {}", e)))?;
    if !is_allowed_asset_url(&parsed) {
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
        // Re-check every hop: GitHub redirects assets to its CDN, and without a
        // custom policy only the first URL would be validated.
        let download_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(300))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 10 {
                    attempt.error("too many redirects")
                } else if is_allowed_asset_url(attempt.url()) {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
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
        // Require it: every merod asset GitHub currently publishes carries a
        // digest, so a missing one means a response we should not trust rather
        // than an old release we should accommodate.
        let Some(expected) = asset_digest.as_deref() else {
            return Err(TauriError::with_details(
                TauriErrorCode::InternalError,
                "GitHub published no digest for this merod asset",
                format!("refusing to install {} unverified", safe_asset_name),
            ));
        };
        verify_sha256(&bytes, expected)?;

        tokio::fs::write(&archive_path, &bytes).await.map_err(|e| {
            TauriError::new(TauriErrorCode::FileWriteError, format!("write archive: {}", e))
        })?;

        let extracted =
            extract_merod_binary(&archive_path, &safe_asset_name, &temp_dir).await?;

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

            let reported = get_merod_version_at(&staged).await;
            let expected = format!("merod {}", tag);
            match reported {
                Some(ref v) if version_matches_tag(v, tag) => {}
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
        VersionId::Bundled => get_bundled_merod_path(app_handle)
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

    // Measure concurrently: get_merod_version_at carries a 10s timeout, so one
    // hung build must not stall the panel for every other build in turn.
    let mut measuring = Vec::with_capacity(locals.len());
    for id in &locals {
        let path = PathBuf::from(id.trim_start_matches(LOCAL_PREFIX));
        measuring.push(tokio::spawn(
            async move { get_merod_version_at(&path).await },
        ));
    }
    let mut measurements = Vec::with_capacity(measuring.len());
    for handle in measuring {
        measurements.push(handle.await.unwrap_or(None));
    }

    for (id, measured) in locals.into_iter().zip(measurements) {
        let path = PathBuf::from(id.trim_start_matches(LOCAL_PREFIX));
        let users = nodes_using(&home, &id);
        // Drift means the binary reports something else, so both sides must be
        // readable: an unreadable build is a missing file, reported on start.
        let drifted_nodes: Vec<String> = users
            .iter()
            .filter(|node| {
                match (
                    read_pin_raw(&home, node).and_then(|p| p.version_at_init),
                    measured.as_ref(),
                ) {
                    (Some(at_init), Some(now)) => &at_init != now,
                    _ => false,
                }
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
    // A merod build is ~100MB of tree; the async form offloads it rather than
    // stalling a runtime worker for the whole recursive delete.
    tokio::fs::remove_dir_all(&dir).await.map_err(|e| {
        TauriError::with_details(
            TauriErrorCode::DirectoryError,
            format!("Failed to remove {}", tag),
            e.to_string(),
        )
    })
}


// ── merod binary helpers, moved here from main.rs so the module that owns
// version resolution also owns the primitives it is built on ──

/// Returns the Rust target triple for the running platform, used to pick the
/// right GitHub release asset.
pub(crate) fn merod_target_triple() -> &'static str {
    if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
        "aarch64-apple-darwin"
    } else if cfg!(target_os = "macos") && cfg!(target_arch = "x86_64") {
        "x86_64-apple-darwin"
    } else if cfg!(target_os = "linux") && cfg!(target_arch = "x86_64") {
        "x86_64-unknown-linux-gnu"
    } else if cfg!(target_os = "linux") && cfg!(target_arch = "aarch64") {
        "aarch64-unknown-linux-gnu"
    } else if cfg!(target_os = "windows") && cfg!(target_arch = "x86_64") {
        "x86_64-pc-windows-msvc"
    } else {
        "unknown"
    }
}


/// Scores a GitHub release asset name for the given target triple.
/// Lower score = better match. Returns `None` if the asset is not for this platform.
pub(crate) fn score_merod_asset(name: &str, target_triple: &str) -> Option<u32> {
    let lower = name.to_lowercase();
    // Releases use "merod-<triple>" or "merod_<triple>"; require a separator so
    // a name that merely starts with "merod" with no delimiter after it is rejected.
    let after_prefix = lower.strip_prefix("merod")?;
    if !after_prefix.starts_with('-') && !after_prefix.starts_with('_') {
        return None;
    }
    if !lower.contains(&target_triple.to_lowercase()) {
        return None;
    }
    if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        Some(0u32)
    } else if lower.ends_with(".zip") {
        Some(1)
    } else if lower.ends_with(".exe") {
        Some(2)
    } else {
        None // unknown extension - extract_merod_binary cannot handle it
    }
}


/// Recursively finds a `merod` / `merod.exe` binary inside a directory tree.
pub(crate) fn find_merod_binary_in_dir(dir: &std::path::Path) -> Option<std::path::PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(fname) = path.file_name() else {
            continue;
        };
        let name = fname.to_string_lossy().to_lowercase();
        if path.is_dir() && !path.is_symlink() {
            if let Some(found) = find_merod_binary_in_dir(&path) {
                return Some(found);
            }
        } else if (name == "merod" || name == "merod.exe") && !path.is_symlink() {
            return Some(path);
        }
    }
    None
}


/// Runs `<binary> --version` and returns the trimmed stdout, or `None` on failure or timeout.
pub(crate) async fn get_merod_version_at(path: &std::path::Path) -> Option<String> {
    // kill_on_drop: on timeout the future is dropped, and without this the hung
    // probe survives as an orphan (one per local build, per panel mount).
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        Command::new(path)
            .arg("--version")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    let raw = String::from_utf8_lossy(if output.stdout.is_empty() {
        &output.stderr
    } else {
        &output.stdout
    })
    .trim()
    .to_string();
    if raw.is_empty() {
        None
    } else {
        Some(raw)
    }
}


/// Extracts the merod binary from an archive (`.tar.gz` / `.zip`) into `temp_dir`.
/// Returns the path to the extracted binary.
pub(crate) async fn extract_merod_binary(
    archive_path: &std::path::Path,
    asset_name: &str,
    temp_dir: &std::path::Path,
) -> Result<std::path::PathBuf, TauriError> {
    let lower = asset_name.to_lowercase();
    let extract_dir = temp_dir.join("extracted");
    tokio::fs::create_dir_all(&extract_dir).await.map_err(|e| {
        TauriError::new(
            TauriErrorCode::DirectoryError,
            format!("create extract dir: {}", e),
        )
    })?;

    if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        let status = Command::new("tar")
            .args([
                "--no-same-owner",
                "--no-same-permissions",
                "-xzf",
                &archive_path.to_string_lossy(),
                "-C",
                &extract_dir.to_string_lossy(),
            ])
            .status()
            .await
            .map_err(|e| {
                TauriError::new(TauriErrorCode::InternalError, format!("tar failed: {}", e))
            })?;
        if !status.success() {
            return Err(TauriError::new(
                TauriErrorCode::InternalError,
                "tar extraction failed".to_string(),
            ));
        }
    } else if lower.ends_with(".zip") {
        #[cfg(windows)]
        {
            // Pass paths via env vars — avoids any string interpolation / injection in the command
            let status = Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command",
                       "Expand-Archive -LiteralPath $env:MEROD_ARCHIVE -DestinationPath $env:MEROD_DEST -Force"])
                .env("MEROD_ARCHIVE", archive_path.as_os_str())
                .env("MEROD_DEST", extract_dir.as_os_str())
                .status().await
                .map_err(|e| TauriError::new(TauriErrorCode::InternalError, format!("powershell failed: {}", e)))?;
            if !status.success() {
                return Err(TauriError::new(
                    TauriErrorCode::InternalError,
                    "zip extraction failed".to_string(),
                ));
            }
        }
        #[cfg(not(windows))]
        {
            let status = Command::new("unzip")
                .args([
                    "-o",
                    &archive_path.to_string_lossy(),
                    "-d",
                    &extract_dir.to_string_lossy(),
                ])
                .status()
                .await
                .map_err(|e| {
                    TauriError::new(
                        TauriErrorCode::InternalError,
                        format!("unzip failed: {}", e),
                    )
                })?;
            if !status.success() {
                return Err(TauriError::new(
                    TauriErrorCode::InternalError,
                    "unzip extraction failed".to_string(),
                ));
            }
        }
    } else if lower.ends_with(".exe") {
        // Windows bare executable — already a binary, no extraction needed
        return Ok(archive_path.to_path_buf());
    } else {
        return Err(TauriError::new(
            TauriErrorCode::InternalError,
            format!(
                "Unknown archive format '{}': expected .tar.gz, .tgz, .zip, or .exe",
                asset_name
            ),
        ));
    }

    let found = find_merod_binary_in_dir(&extract_dir).ok_or_else(|| {
        TauriError::new(
            TauriErrorCode::FileNotFound,
            "merod binary not found in extracted archive",
        )
    })?;

    // Guard against symlinks that escape the extraction directory (zip slip / symlink attack)
    let canonical_dir = extract_dir.canonicalize().map_err(|e| {
        TauriError::new(
            TauriErrorCode::DirectoryError,
            format!("canonicalize extract dir: {}", e),
        )
    })?;
    let canonical_bin = found.canonicalize().map_err(|e| {
        TauriError::new(
            TauriErrorCode::FileNotFound,
            format!("canonicalize binary path: {}", e),
        )
    })?;
    if !canonical_bin.starts_with(&canonical_dir) {
        return Err(TauriError::new(
            TauriErrorCode::PathNotAllowed,
            "Extracted binary path escapes extraction directory",
        ));
    }
    Ok(canonical_bin)
}


/// Get the path to the bundled merod binary
pub(crate) fn get_bundled_merod_path(
    app_handle: &tauri::AppHandle,
) -> Result<std::path::PathBuf, String> {
    let resource_candidates = if cfg!(target_os = "windows") {
        vec!["merod/merod.exe", "merod/merod"]
    } else {
        vec!["merod/merod", "merod/merod.exe"]
    };

    for candidate in &resource_candidates {
        if let Ok(resource_path) = app_handle
            .path()
            .resolve(candidate, tauri::path::BaseDirectory::Resource)
        {
            if resource_path.exists() {
                return Ok(resource_path);
            }
        }
    }

    Err(format!(
        "Merod resource not found. Checked: {:?}",
        resource_candidates
    ))
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_score_merod_asset_matches_published_underscore_names() {
        // Real published asset names use an underscore, not a dash.
        let triple = "aarch64-apple-darwin";
        assert!(
            score_merod_asset("merod_aarch64-apple-darwin.tar.gz", triple).is_some(),
            "published underscore asset name must match"
        );
    }

    #[test]
    fn test_score_merod_asset_prefers_tar_gz() {
        let triple = "aarch64-apple-darwin";
        let tar = score_merod_asset("merod_aarch64-apple-darwin.tar.gz", triple);
        let zip = score_merod_asset("merod_aarch64-apple-darwin.zip", triple);
        assert!(tar.is_some(), "tar.gz should match");
        assert!(zip.is_some(), "zip should match");
        assert!(tar.unwrap() < zip.unwrap(), "tar.gz should be preferred over zip");
    }

    #[test]
    fn test_score_merod_asset_accepts_both_separators() {
        let triple = "aarch64-apple-darwin";
        assert!(score_merod_asset("merod-aarch64-apple-darwin.tar.gz", triple).is_some());
        assert!(score_merod_asset("merod_aarch64-apple-darwin.tar.gz", triple).is_some());
    }

    #[test]
    fn test_score_merod_asset_rejects_wrong_platform() {
        assert!(
            score_merod_asset("merod_x86_64-apple-darwin.tar.gz", "aarch64-apple-darwin").is_none()
        );
        assert!(score_merod_asset(
            "merod_x86_64-unknown-linux-gnu.tar.gz",
            "aarch64-apple-darwin"
        )
        .is_none());
    }

    #[test]
    fn test_score_merod_asset_rejects_sibling_binaries() {
        // meroctl / mero-auth share the prefix up to "mero" and must not match.
        assert!(score_merod_asset("meroctl_aarch64-apple-darwin.tar.gz", "aarch64-apple-darwin").is_none());
        assert!(score_merod_asset("mero-auth_aarch64-apple-darwin.tar.gz", "aarch64-apple-darwin").is_none());
        assert!(score_merod_asset("something-else.tar.gz", "x86_64-apple-darwin").is_none());
    }

    #[test]
    fn test_score_merod_asset_requires_separator_after_prefix() {
        // Starts with the literal "merod" but has no "-" or "_" after it.
        assert!(
            score_merod_asset("merodhost_aarch64-apple-darwin.tar.gz", "aarch64-apple-darwin")
                .is_none()
        );
    }


    #[test]
    fn verify_sha256_matches_and_rejects() {
        // sha256("merod") - a known-good vector so the check itself is pinned.
        let bytes = b"merod";
        let good = format!("sha256:{:x}", <sha2::Sha256 as sha2::Digest>::digest(bytes));
        assert!(verify_sha256(bytes, &good).is_ok());
        assert!(verify_sha256(b"tampered", &good).is_err());
        // A digest we cannot compute must fail closed, not pass silently.
        assert!(verify_sha256(bytes, "sha512:whatever").is_err());
        assert!(verify_sha256(bytes, "not-a-digest").is_err());
    }

    #[test]
    fn version_check_tolerates_build_metadata_but_not_a_different_tag() {
        // What a real binary prints - the bare tag never appears alone.
        let real = "merod 0.11.0-rc.19 (build c2e8ec3) (commit c2e8ec3) (rustc 1.88.0)";
        assert!(version_matches_tag(real, "0.11.0-rc.19"));
        assert!(version_matches_tag("merod 0.11.0", "0.11.0"));

        // A tag that is a prefix of the reported one must not pass.
        assert!(!version_matches_tag(real, "0.11.0-rc.1"));
        assert!(!version_matches_tag(real, "0.11.0"));
        assert!(!version_matches_tag("meroctl 0.11.0-rc.19", "0.11.0-rc.19"));
        assert!(!version_matches_tag("", "0.11.0-rc.19"));
    }

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
        assert!(!is_safe_tag(BUNDLED_ID), "must not collide with the shipped id");
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
        assert_eq!(read_pin(&home, "node1").unwrap(), VersionId::Bundled);
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

        assert_eq!(read_pin(&home, "node1").unwrap(), VersionId::Release("0.11.0-rc.15".into()));
        let raw = read_pin_raw(&home, "node1").unwrap();
        assert_eq!(raw.version_at_init.as_deref(), Some("merod 0.11.0-rc.15"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_corrupt_pin_falls_back_to_bundled_instead_of_failing_the_start() {
        let home = temp_home();
        std::fs::write(pin_path(&home, "node1"), "{ not json").unwrap();
        assert_eq!(read_pin(&home, "node1").unwrap(), VersionId::Bundled);
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
