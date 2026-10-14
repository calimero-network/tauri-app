//! Capabilities that follow a window onto whatever page it shows. A remote page
//! gets exactly the IPC listed here, so growth is a deliberate edit to this test.

use std::collections::BTreeSet;
use std::path::Path;

const REMOTE_CAPABILITIES: &[&str] = &[
    "capabilities/remote.json",
    "calimero-shell/capabilities/app.json",
];

// The injected proxy script listens for stream events and the page may manage its own window.
const ALLOWED_CORE: &[&str] = &[
    "core:event:allow-listen",
    "core:event:allow-unlisten",
    "core:window:allow-show",
    "core:window:allow-hide",
    "core:window:allow-close",
    "core:window:allow-set-focus",
    "core:window:allow-set-fullscreen",
];

fn permissions(file: &str) -> Vec<String> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(file);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{file}: {e}"));
    let json: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert!(
        json.get("remote").is_some(),
        "{file} is not a remote capability"
    );
    json["permissions"]
        .as_array()
        .unwrap_or_else(|| panic!("{file} has no permissions list"))
        .iter()
        .map(|p| {
            p.as_str()
                .unwrap_or_else(|| panic!("{file}: scoped permission objects are not allowed: {p}"))
                .to_string()
        })
        .collect()
}

#[test]
fn remote_capabilities_grant_only_allowlisted_core_permissions() {
    let allowed: BTreeSet<&str> = ALLOWED_CORE.iter().copied().collect();
    for file in REMOTE_CAPABILITIES {
        let extra: Vec<_> = permissions(file)
            .into_iter()
            .filter(|p| p.starts_with("core:") && !allowed.contains(p.as_str()))
            .collect();
        assert!(
            extra.is_empty(),
            "{file} grants core permissions to remote pages: {extra:?}"
        );
    }
}

#[test]
fn remote_capabilities_cannot_emit_events_into_the_host() {
    for file in REMOTE_CAPABILITIES {
        let emitting: Vec<_> = permissions(file)
            .into_iter()
            .filter(|p| p == "core:event:default" || p.contains("emit"))
            .collect();
        assert!(
            emitting.is_empty(),
            "{file} lets a remote page emit: {emitting:?}"
        );
    }
}

#[test]
fn remote_capabilities_still_grant_event_listening_to_the_proxy_script() {
    for file in REMOTE_CAPABILITIES {
        let perms = permissions(file);
        for needed in ["core:event:allow-listen", "core:event:allow-unlisten"] {
            assert!(perms.iter().any(|p| p == needed), "{file} lost {needed}");
        }
    }
}
