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

/// Per-app single-instance socket for shell processes. One socket per app id, so
/// a relaunch of the SAME app forwards to the running instance while different
/// apps coexist - a process-global lock here is what made every second launcher
/// exit silently. Ids are hashed short: raw 44-char ids overflow SUN_LEN (~104).
pub fn shell_instance_socket_path(app_id: &str) -> PathBuf {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(app_id.as_bytes());
    let short: String = digest[..6].iter().map(|b| format!("{b:02x}")).collect();
    host_socket_path().with_file_name(format!("shell-{short}.sock"))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instance_sockets_are_short_stable_and_distinct() {
        // Real app ids are 44-char base58 hashes; the raw id overflowed SUN_LEN.
        let a = shell_instance_socket_path("D4rz4jmKQngmnhTwUvc5rGFXQZ3VGYkrx5HaJjcW7sLh");
        let b = shell_instance_socket_path("9xKp2mVnQwYrTuLbNcRdSeWfGhJiOaZsXqEtDvCkMjBn");
        assert!(a.as_os_str().len() < 104, "must fit in sockaddr_un.sun_path");
        assert_ne!(a, b, "two apps sharing a socket would relink their instances");
        assert_eq!(a, shell_instance_socket_path("D4rz4jmKQngmnhTwUvc5rGFXQZ3VGYkrx5HaJjcW7sLh"));
    }
}
