//! Shared library for the Calimero desktop crate. Both binaries — the host
//! (`src/main.rs`) and the per-app shell (`calimero-shell/src/main.rs`) — build
//! on these modules.
//!
//! The host keeps its own inline v2 proxy/webview/errors in `main.rs` (untouched,
//! including the #152/#156 fixes and the in-flight-request drain for graceful
//! merod shutdown). These lib copies exist so the separate `calimero-shell`
//! binary can serve the same proxy commands + open the app webview without
//! reaching into the host binary.

pub mod errors;
pub mod proxy;
pub mod webview;

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
pub use host_ipc::{ensure_host_running, host_socket_path};
