//! Shared library for the Calimero desktop crate. Both binaries - the host
//! (`src/main.rs`) and the per-app shell (`calimero-shell/src/main.rs`) - build
//! on these modules.

/// Data directory name; must match `identifier` in tauri.conf.json / tauri.dev.json.
/// Debug builds get their own so a dev run cannot take over the installed app's socket.
pub fn app_dir_name() -> &'static str {
    if cfg!(debug_assertions) {
        "network.calimero.desktop.dev"
    } else {
        "network.calimero.desktop"
    }
}

/// Chain-style poison recovery: every mutex here guards a plain collection with
/// no cross-field invariant, so the pre-poison data is always safe to reuse.
pub trait LockUnpoisoned<T> {
    fn lock_unpoisoned(&self) -> std::sync::MutexGuard<'_, T>;
}
impl<T> LockUnpoisoned<T> for std::sync::Mutex<T> {
    fn lock_unpoisoned(&self) -> std::sync::MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|p| p.into_inner())
    }
}

pub mod errors;
pub mod node_discovery;
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
pub use host_ipc::{ensure_host_running, host_socket_path, shell_instance_socket_path};

#[cfg(test)]
mod tests {
    use super::LockUnpoisoned;

    #[test]
    fn lock_unpoisoned_locks_and_recovers() {
        let m = std::sync::Mutex::new(1);
        *m.lock_unpoisoned() = 2;
        // Poison it, then confirm recovery instead of panic.
        let _ = std::panic::catch_unwind(|| {
            let _g = m.lock().unwrap();
            panic!("poison");
        });
        assert_eq!(*m.lock_unpoisoned(), 2);
    }
}
