//! Shared library for the Calimero desktop crate. Both binaries — the host
//! (`src/main.rs`) and the per-app shell (`calimero-shell/src/main.rs`) — build
//! on these modules.
//!
//! The host keeps its own inline v2 proxy/webview/errors in `main.rs` (untouched,
//! including the #152/#156 fixes and the in-flight-request drain for graceful
//! merod shutdown). These lib copies exist so the separate `calimero-shell`
//! binary can serve the same proxy commands + open the app webview without
//! reaching into the host binary.

/// Name of the app's own data directory, under the platform data dir.
///
/// A debug build gets its own, so a `tauri dev` run cannot share the installed
/// app's host socket, launcher registry, or icon cache. Sharing them meant a dev
/// build silently stole the running app's socket, and the single-instance plugin
/// routed `tauri dev` straight into the installed app and exited the dev build.
/// Keep this in step with `identifier` in tauri.conf.json / tauri.dev.json.
pub fn app_dir_name() -> &'static str {
    if cfg!(debug_assertions) {
        "network.calimero.desktop.dev"
    } else {
        "network.calimero.desktop"
    }
}

pub mod errors;
pub mod proxy;
pub mod webview;

pub mod node_discovery;

#[cfg(target_os = "macos")]
pub mod token_broker_ipc;

#[cfg(target_os = "macos")]
pub mod shell_config;

#[cfg(target_os = "macos")]
pub mod launcher;

#[cfg(target_os = "macos")]
pub mod app_registry;

#[cfg(target_os = "macos")]
pub mod host_ipc;

#[cfg(target_os = "macos")]
pub use host_ipc::{ensure_host_running, host_socket_path, shell_instance_socket_path};
