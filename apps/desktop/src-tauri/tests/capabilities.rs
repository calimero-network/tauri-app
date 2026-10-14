//! Capabilities that follow a window onto whatever page it shows. A remote page
//! gets exactly the IPC listed here, so growth is a deliberate edit to this test.

use std::path::{Path, PathBuf};

const CAPABILITY_DIRS: &[&str] = &["capabilities", "calimero-shell/capabilities"];

// The injected proxy script listens for stream events and the page may manage its own window.
const ALLOWED: &[&str] = &[
    "core:event:allow-listen",
    "core:event:allow-unlisten",
    "core:window:allow-show",
    "core:window:allow-hide",
    "core:window:allow-close",
    "core:window:allow-set-focus",
    "core:window:allow-set-fullscreen",
    "allow-remote-proxy",
    "allow-broker-token-refresh",
    "allow-set-badge",
    "allow-notify",
    "allow-proxy-http-request",
    "allow-proxy-sse-stream",
    "allow-cancel-sse-stream",
];

/// Every capability file that applies to remote pages, with its permission list.
fn remote_capabilities() -> Vec<(PathBuf, Vec<String>)> {
    let mut found = Vec::new();
    for dir in CAPABILITY_DIRS {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join(dir);
        for entry in std::fs::read_dir(&dir).unwrap_or_else(|e| panic!("{dir:?}: {e}")) {
            let path = entry.unwrap().path();
            if path.extension().is_none_or(|e| e != "json") {
                continue;
            }
            let text = std::fs::read_to_string(&path).unwrap();
            let json: serde_json::Value = serde_json::from_str(&text).unwrap();
            if json.get("remote").is_none() {
                continue;
            }
            let permissions = json["permissions"]
                .as_array()
                .unwrap_or_else(|| panic!("{path:?} has no permissions list"))
                .iter()
                .map(|p| {
                    p.as_str()
                        .unwrap_or_else(|| panic!("{path:?}: scoped permission {p} is not allowed"))
                        .to_string()
                })
                .collect();
            found.push((path, permissions));
        }
    }
    assert!(
        found.len() >= 2,
        "expected the host and shell remote capabilities"
    );
    found
}

#[test]
fn remote_capabilities_grant_only_allowlisted_permissions() {
    for (path, permissions) in remote_capabilities() {
        let extra: Vec<_> = permissions
            .iter()
            .filter(|p| !ALLOWED.contains(&p.as_str()))
            .collect();
        assert!(extra.is_empty(), "{path:?} grants remote pages: {extra:?}");
    }
}

#[test]
fn remote_capabilities_still_grant_event_listening_to_the_proxy_script() {
    for (path, permissions) in remote_capabilities() {
        for needed in ["core:event:allow-listen", "core:event:allow-unlisten"] {
            assert!(
                permissions.iter().any(|p| p == needed),
                "{path:?} lost {needed}"
            );
        }
    }
}
