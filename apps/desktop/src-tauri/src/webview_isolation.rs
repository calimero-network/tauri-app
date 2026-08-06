//! Per-(app, node) webview storage for cross-node app windows.
//!
//! A window pointed at a node the desktop is not signed into must not share
//! `localStorage` with the active session, or the two nodes overwrite each
//! other's tokens. macOS keys a `WKWebsiteDataStore` by a 16-byte identifier;
//! Linux uses a data directory. This module owns both, plus the set of windows
//! that got one - which the token broker consults before serving a window.

use crate::{TauriError, TauriErrorCode};
use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex};
use tauri::Manager;

/// Labels of windows created with their own webview store, i.e. windows pointed
/// at a node the desktop is not signed into.
pub type IsolatedWindows = Arc<Mutex<HashSet<String>>>;

pub fn remember(app_handle: &tauri::AppHandle, label: &str) {
    app_handle
        .state::<IsolatedWindows>()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(label.to_string());
}

pub fn forget(app_handle: &tauri::AppHandle, label: &str) {
    app_handle
        .state::<IsolatedWindows>()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(label);
}

pub fn is_isolated(state: &tauri::State<'_, IsolatedWindows>, label: &str) -> bool {
    state
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .contains(label)
}

/// Whether this platform can give a webview its own storage. Never guess: below
/// macOS 14 wry falls back to the shared store silently, merging two sessions.
///
/// Answered once: this is a sync command (so it runs on the main thread) and the
/// OS version cannot change under a running process.
#[tauri::command]
pub fn webview_isolation_supported() -> bool {
    static SUPPORTED: std::sync::LazyLock<bool> = std::sync::LazyLock::new(|| {
        #[cfg(target_os = "macos")]
        {
            // Matches wry's own gate for WKWebsiteDataStore::dataStoreForIdentifier.
            std::process::Command::new("sw_vers")
                .arg("-productVersion")
                .output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .and_then(|v| v.trim().split('.').next()?.parse::<u32>().ok())
                .map(|major| major >= 14)
                .unwrap_or(false)
        }
        #[cfg(target_os = "linux")]
        {
            true
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            false
        }
    });
    *SUPPORTED
}

/// Find or assign this key's identifier, reporting whether the map changed so
/// the caller only writes when it did. Slot 0 is skipped: an all-zero identifier
/// is not a valid data store id.
///
/// Slots are handed out in order and deliberately never reused or reclaimed -
/// recycling one would hand a new (app, node) pair another window's storage.
/// The map therefore grows with distinct pairs opened, a handful in practice.
/// Reclaiming an entry means also deleting its store via
/// `AppHandle::remove_data_store`, which belongs with node deletion.
fn store_id_for(map: &mut BTreeMap<String, u32>, key: &str) -> ([u8; 16], bool) {
    let (slot, changed) = match map.get(key) {
        Some(slot) => (*slot, false),
        None => {
            let next = map.values().copied().max().unwrap_or(0) + 1;
            map.insert(key.to_string(), next);
            (next, true)
        }
    };
    let mut id = [0u8; 16];
    id[..4].copy_from_slice(&slot.to_le_bytes());
    (id, changed)
}

/// Stable 16-byte store id for an isolation key, persisted so a window keeps its
/// storage across restarts.
pub fn store_id(app_handle: &tauri::AppHandle, key: &str) -> Result<[u8; 16], TauriError> {
    // Serialise the whole read-modify-write. Two concurrent first-time keys would
    // otherwise both compute max+1 from the same stale map and share one store.
    static SLOTS: Mutex<()> = Mutex::new(());
    let _guard = SLOTS.lock().unwrap_or_else(|p| p.into_inner());

    let dir = app_handle.path().app_data_dir().map_err(|e| {
        TauriError::with_details(
            TauriErrorCode::DirectoryError,
            "Failed to resolve app data dir for webview stores",
            e.to_string(),
        )
    })?;
    std::fs::create_dir_all(&dir).map_err(|e| {
        TauriError::with_details(
            TauriErrorCode::DirectoryError,
            "Failed to create app data dir",
            e.to_string(),
        )
    })?;
    let path = dir.join("webview-stores.json");

    let mut map: BTreeMap<String, u32> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();

    let (id, changed) = store_id_for(&mut map, key);
    if changed {
        let body = serde_json::to_string_pretty(&map).map_err(|e| {
            TauriError::with_details(
                TauriErrorCode::InternalError,
                "Failed to serialise the webview store map",
                e.to_string(),
            )
        })?;
        std::fs::write(&path, body).map_err(|e| {
            TauriError::with_details(
                TauriErrorCode::FileWriteError,
                "Failed to write the webview store map",
                e.to_string(),
            )
        })?;
    }
    Ok(id)
}

/// Directory name for the Linux data-directory form of the same id.
#[cfg(target_os = "linux")]
pub fn dir_name(id: &[u8; 16]) -> String {
    id.iter().map(|b| format!("{:02x}", b)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_stable_distinct_and_never_zero() {
        let mut map = BTreeMap::new();

        let (a, a_new) = store_id_for(&mut map, "drive@http://localhost:2528");
        let (b, b_new) = store_id_for(&mut map, "drive@http://localhost:2529");
        let (a_again, a_again_new) = store_id_for(&mut map, "drive@http://localhost:2528");

        assert!(a_new && b_new, "a first-time key must extend the map");
        assert!(!a_again_new, "a known key must not rewrite the map");
        assert_eq!(a, a_again, "the same key must keep its bucket across opens");
        assert_ne!(a, b, "two keys sharing a bucket would merge their storage");

        // An all-zero identifier is not a valid WKWebsiteDataStore identifier.
        assert_ne!(a, [0u8; 16]);
        assert_ne!(b, [0u8; 16]);
    }

    #[test]
    fn ids_survive_a_reloaded_map() {
        let mut map = BTreeMap::new();
        store_id_for(&mut map, "one");
        store_id_for(&mut map, "two");

        // Simulate the map being written, read back, and extended later.
        let mut reloaded = map.clone();
        let (third, _) = store_id_for(&mut reloaded, "three");
        let taken: Vec<[u8; 16]> = map
            .values()
            .map(|s| {
                let mut id = [0u8; 16];
                id[..4].copy_from_slice(&s.to_le_bytes());
                id
            })
            .collect();
        assert!(
            !taken.contains(&third),
            "a new key must not reuse an id already handed out"
        );
    }
}
