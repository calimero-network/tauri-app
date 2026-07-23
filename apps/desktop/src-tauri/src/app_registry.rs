//! Host-side registry of generated per-app launchers (persists caps across restarts).
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InstalledApp {
    pub id: String,
    pub name: String,
    pub url: String,
    pub node_url: String,
    pub cap: String,
    pub bundle_path: String,
    pub host_version: String,
}

pub fn installed_apps(store: &Path) -> Vec<InstalledApp> {
    std::fs::read(store)
        .ok()
        .and_then(|b| serde_json::from_slice::<Vec<InstalledApp>>(&b).ok())
        .unwrap_or_default()
}

pub fn persist_app(store: &Path, app: &InstalledApp) -> std::io::Result<()> {
    let mut apps = installed_apps(store);
    match apps.iter_mut().find(|a| a.id == app.id) {
        Some(existing) => *existing = app.clone(),
        None => apps.push(app.clone()),
    }
    let bytes = serde_json::to_vec_pretty(&apps)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    std::fs::write(store, bytes)
}

pub fn caps_map(store: &Path) -> std::collections::HashMap<String, String> {
    installed_apps(store)
        .into_iter()
        .map(|a| (a.cap, a.id))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static C: AtomicU32 = AtomicU32::new(0);
        let n = C.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("cal-reg-{}-{}-{}.json", std::process::id(), tag, n))
    }

    fn app(id: &str, cap: &str) -> InstalledApp {
        InstalledApp {
            id: id.into(),
            name: id.into(),
            url: "u".into(),
            node_url: "n".into(),
            cap: cap.into(),
            bundle_path: "/b".into(),
            host_version: "0.0.70".into(),
        }
    }

    #[test]
    fn persist_upsert_and_caps_map() {
        let store = tmp("s");
        let _ = std::fs::remove_file(&store);
        persist_app(&store, &app("mero-drive", "cap-a")).unwrap();
        persist_app(&store, &app("mero-meet", "cap-b")).unwrap();
        // upsert: same id, new cap replaces
        persist_app(&store, &app("mero-drive", "cap-a2")).unwrap();

        let all = installed_apps(&store);
        assert_eq!(all.len(), 2);

        let caps = caps_map(&store);
        assert_eq!(caps.get("cap-a2").map(String::as_str), Some("mero-drive"));
        assert_eq!(caps.get("cap-b").map(String::as_str), Some("mero-meet"));
        assert!(caps.get("cap-a").is_none(), "old cap replaced by upsert");
        let _ = std::fs::remove_file(&store);
    }
}
