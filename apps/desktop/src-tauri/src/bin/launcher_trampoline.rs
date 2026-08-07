//! The per-app launcher bundle's executable: execs the installed shell with
//! this bundle's app.json. Must be a Mach-O - see launcher.rs.

#[cfg(target_os = "macos")]
fn main() {
    use std::os::unix::process::CommandExt;

    let exe = std::env::current_exe()
        .and_then(std::fs::canonicalize)
        .expect("launcher cannot resolve its own path");
    // <bundle>/Contents/MacOS/launch -> <bundle>/Contents/Resources/app.json
    let contents = exe
        .parent()
        .and_then(|macos| macos.parent())
        .expect("launcher executable is not inside a bundle");
    let cfg = contents.join("Resources/app.json");

    // Mirrors launcher::shell_install_path in the host.
    let shell = dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("network.calimero.desktop/shell/CalimeroShell");

    let err = std::process::Command::new(&shell)
        .arg("--app-config")
        .arg(&cfg)
        .exec();
    eprintln!("launcher failed to exec {}: {err}", shell.display());
    std::process::exit(1);
}

#[cfg(not(target_os = "macos"))]
fn main() {}
