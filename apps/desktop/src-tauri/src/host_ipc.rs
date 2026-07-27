//! macOS-only: shared host-socket location + host auto-boot, used by both the
//! host bin (which binds the socket) and the shell bin (which connects to it).

use std::path::{Path, PathBuf};

/// Unix-domain socket the shell processes reach the host on (0700 dir, no TCP port).
pub fn host_socket_path() -> PathBuf {
    let base = dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("network.calimero.desktop");
    let _ = std::fs::create_dir_all(&base);
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700));
    }
    base.join("host.sock")
}

/// If `sock` is absent, boot the installed host headless and poll (bounded, ~5s)
/// for the socket to appear. No-op if the socket already exists or no installed
/// host binary can be found.
pub fn ensure_host_running(sock: &Path) {
    if sock.exists() {
        return;
    }
    if let Some(host) = installed_host_binary() {
        let _ = std::process::Command::new(host).arg("--headless-host").spawn();
    }
    for _ in 0..100 {
        if sock.exists() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

/// Resolve the installed host binary: /Applications/Calimero Desktop.app/Contents/MacOS/Calimero Desktop.
fn installed_host_binary() -> Option<PathBuf> {
    let p = Path::new("/Applications/Calimero Desktop.app/Contents/MacOS/Calimero Desktop");
    if p.exists() {
        Some(p.to_path_buf())
    } else {
        None
    }
}
