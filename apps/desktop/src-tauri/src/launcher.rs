//! macOS-only: per-app dock identity with NO per-app signing.
//! Per-app `.app` = an unsigned bash trampoline that execs a shared, loose,
//! ad-hoc-signed shell binary. Wired into the app in Plan 3.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct AppSpec {
    pub id: String,
    pub name: String,
    pub url: String,
    pub node_url: String,
    pub cap: String,
    pub icon: Option<PathBuf>,
}

#[derive(Debug, thiserror::Error)]
pub enum LauncherError {
    #[error("invalid app id: {0:?}")]
    InvalidId(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("codesign failed: {0}")]
    Codesign(String),
    #[error("serialize app.json failed: {0}")]
    Serialize(#[from] serde_json::Error),
}

pub fn validate_app_id(id: &str) -> Result<(), LauncherError> {
    if id.is_empty()
        || id.len() > 128
        || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(LauncherError::InvalidId(id.to_string()));
    }
    Ok(())
}

/// Loose path (no `.app` ancestor) where the shared shell is installed.
pub fn shell_install_path() -> PathBuf {
    let dir = dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("network.calimero.desktop")
        .join("shell");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("CalimeroShell")
}

/// True when `dest` already holds `src`'s build, so the copy + dequarantine +
/// codesign round-trip can be skipped. The copy stamps `dest` with "now", hence
/// `src <= dest` rather than equality. Errors read as "not current" (copy wins).
fn shell_is_current(src: &Path, dest: &Path) -> bool {
    let (Ok(s), Ok(d)) = (std::fs::metadata(src), std::fs::metadata(dest)) else {
        return false;
    };
    s.len() == d.len() && matches!((s.modified(), d.modified()), (Ok(sm), Ok(dm)) if sm <= dm)
}

/// Copy the shared shell binary to a loose `dest`, PRESERVING its signature.
///
/// The bundled shell is universal (arm64+x86_64) and Developer-ID signed, and a
/// plain file copy keeps that embedded Mach-O signature intact. We must NOT
/// re-sign it ad-hoc: an ad-hoc-signed x86_64 binary makes Rosetta fail to
/// attach the AOT code-signature supplement on macOS 26 ("Attachment of code
/// signature supplement failed"), which SIGABRTs the *second* per-app launcher
/// (the first wins the AOT, the second can't attach). Keeping the Developer-ID
/// signature also lets the binary run arm64-native on Apple Silicon — no Rosetta
/// at all. We only fall back to an ad-hoc signature when the copy arrives
/// unsigned, since arm64 refuses to execute a loose *unsigned* binary.
/// Idempotent (overwrites), and a no-op when `dest` already holds this build.
pub fn extract_shell(src: &Path, dest: &Path) -> Result<(), LauncherError> {
    // Serializes the startup migration against a concurrent `open_app_launcher`,
    // so neither can read a half-written copy; the loser re-checks and skips.
    static EXTRACT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = EXTRACT_LOCK.lock().unwrap_or_else(|p| p.into_inner());

    if shell_is_current(src, dest) {
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(src, dest)?;
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dest, std::fs::Permissions::from_mode(0o755))?;
    }
    // Drop the quarantine flag the copy inherits from a downloaded .app, or
    // Gatekeeper prompts on every launch of the loose shell.
    dequarantine(dest);

    // Keep the existing (Developer-ID) signature if the copy is validly signed.
    let already_signed = std::process::Command::new("codesign")
        .arg("--verify")
        .arg("--strict")
        .arg(dest)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if already_signed {
        return Ok(());
    }

    // Fallback: a loose unsigned binary needs at least an ad-hoc signature to
    // execute on arm64.
    let out = std::process::Command::new("codesign")
        .arg("--force")
        .arg("-s")
        .arg("-")
        .arg(dest)
        .output()?;
    if !out.status.success() {
        return Err(LauncherError::Codesign(
            String::from_utf8_lossy(&out.stderr).into_owned(),
        ));
    }
    Ok(())
}

/// Remove the `com.apple.quarantine` flag from `path`, if present.
///
/// A browser-downloaded Calimero Desktop.app carries the quarantine xattr, and
/// `std::fs::copy` propagates it to the extracted loose shell — so Gatekeeper
/// prompts "…is an app downloaded from the Internet. Are you sure…?" on every
/// launch of the shared shell. The parent .app is notarized (Gatekeeper already
/// cleared it on first open); the loose child inherits the flag without that
/// clearance, so we drop it explicitly. No-op / ignored if absent.
pub fn dequarantine(path: &Path) {
    let _ = std::process::Command::new("xattr")
        .arg("-d")
        .arg("com.apple.quarantine")
        .arg(path)
        .output();
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn write_app_json(resources: &Path, spec: &AppSpec) -> Result<PathBuf, LauncherError> {
    let path = resources.join("app.json");
    let doc = serde_json::json!({
        "id": spec.id,
        "name": spec.name,
        "url": spec.url,
        "node_url": spec.node_url,
        "cap": spec.cap,
    });
    std::fs::write(&path, serde_json::to_vec_pretty(&doc)?)?;
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(path)
}

fn write_info_plist(
    contents: &Path,
    spec: &AppSpec,
    has_icon: bool,
) -> Result<PathBuf, LauncherError> {
    let icon_key = if has_icon {
        "  <key>CFBundleIconFile</key><string>AppIcon</string>\n"
    } else {
        ""
    };
    let name = xml_escape(&spec.name);
    let plist = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
<plist version=\"1.0\"><dict>\n\
  <key>CFBundleExecutable</key><string>launch</string>\n\
  <key>CFBundleIdentifier</key><string>network.calimero.app.{id}</string>\n\
  <key>CFBundleName</key><string>{name}</string>\n\
  <key>CFBundleDisplayName</key><string>{name}</string>\n\
  <key>CFBundlePackageType</key><string>APPL</string>\n\
{icon}</dict></plist>\n",
        id = spec.id,
        name = name,
        icon = icon_key,
    );
    let path = contents.join("Info.plist");
    std::fs::write(&path, plist)?;
    Ok(path)
}

fn write_trampoline(macos: &Path, shell_path: &Path) -> Result<PathBuf, LauncherError> {
    // $0 is this script inside <bundle>/Contents/MacOS; resolve its sibling Resources/app.json.
    //
    // Run the shell under the Mac's NATIVE architecture. This launcher's bundle
    // executable is this shell SCRIPT (there's no Mach-O in Contents/MacOS), so
    // LaunchServices can't read a build-version to tell the app supports arm64 —
    // it defaults the whole process to x86_64/Rosetta on Apple Silicon. The loose
    // hardened-runtime shell then fails code-signing under translation and is
    // SIGKILLed ("Taskgated Invalid Signature" / Rosetta AOT supplement failure).
    // `arch -<native>` forces arm64 on Apple Silicon (no Rosetta) and x86_64 on
    // Intel — both slices exist in the universal shell.
    let script = format!(
        "#!/bin/bash\n\
DIR=\"$(cd \"$(dirname \"$0\")/../Resources\" && pwd)\"\n\
ARCH=\"$(/usr/bin/uname -m)\"\n\
exec /usr/bin/arch -\"$ARCH\" \"{shell}\" --app-config \"$DIR/app.json\"\n",
        shell = shell_path.display(),
    );
    let path = macos.join("launch");
    std::fs::write(&path, script)?;
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(path)
}

/// Rewrite an existing launcher's trampoline with the CURRENT format (e.g. the
/// native-arch exec). A cheap migration for launcher `.app`s generated by an
/// older desktop version — no icon/app-config churn, just the launch script.
/// `bundle` is the `.app`; no-op if it has no trampoline. Idempotent.
pub fn refresh_trampoline(bundle: &Path, shell_path: &Path) -> Result<(), LauncherError> {
    let macos = bundle.join("Contents/MacOS");
    if macos.join("launch").exists() {
        write_trampoline(&macos, shell_path)?;
    }
    Ok(())
}

/// Build `<dest_dir>/<name>.app`: an UNSIGNED bash-trampoline launcher that execs
/// `shell_path` with `--app-config <this-bundle>/Contents/Resources/app.json`.
/// Never signs the bundle — there is no Mach-O in it to sign.
pub fn generate_launcher(
    dest_dir: &Path,
    shell_path: &Path,
    spec: &AppSpec,
) -> Result<PathBuf, LauncherError> {
    validate_app_id(&spec.id)?;
    let app_dir = dest_dir.join(format!("{}.app", spec.name));
    if app_dir.exists() {
        std::fs::remove_dir_all(&app_dir)?;
    }
    let contents = app_dir.join("Contents");
    let macos = contents.join("MacOS");
    let resources = contents.join("Resources");
    std::fs::create_dir_all(&macos)?;
    std::fs::create_dir_all(&resources)?;

    let has_icon = match &spec.icon {
        Some(p) => {
            std::fs::copy(p, resources.join("AppIcon.icns"))?;
            true
        }
        None => false,
    };
    write_app_json(&resources, spec)?;
    write_info_plist(&contents, spec, has_icon)?;
    write_trampoline(&macos, shell_path)?;
    Ok(app_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_app_id_rules() {
        assert!(validate_app_id("mero-drive").is_ok());
        assert!(validate_app_id("").is_err());
        assert!(validate_app_id(&"a".repeat(129)).is_err());
        assert!(validate_app_id("has space").is_err());
        assert!(validate_app_id("a/b").is_err());
    }

    #[test]
    fn shell_path_is_loose_and_named() {
        let p = shell_install_path();
        assert!(p.ends_with("CalimeroShell"));
        assert!(
            !p.to_string_lossy().contains(".app/"),
            "shell must not live inside a .app"
        );
    }

    fn scratch(tag: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static C: AtomicU32 = AtomicU32::new(0);
        let n = C.fetch_add(1, Ordering::SeqCst);
        let d = std::env::temp_dir().join(format!(
            "cal-launcher-{}-{}-{}",
            std::process::id(),
            tag,
            n
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// The signing identity's CDHash, or None if unsigned / codesign missing.
    fn cdhash(path: &Path) -> Option<String> {
        let out = std::process::Command::new("codesign")
            .arg("-dvv")
            .arg(path)
            .output()
            .ok()?;
        // codesign prints signing info to stderr.
        String::from_utf8_lossy(&out.stderr)
            .lines()
            .find_map(|l| l.strip_prefix("CDHash=").map(str::to_owned))
    }

    fn verifies_strict(path: &Path) -> bool {
        std::process::Command::new("codesign")
            .arg("--verify")
            .arg("--strict")
            .arg(path)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    #[test]
    fn extract_shell_preserves_a_valid_signature() {
        let src = std::env::current_exe().unwrap(); // a real, signed Mach-O
        let dir = scratch("extract");
        let dest = dir.join("shell/CalimeroShell");
        extract_shell(&src, &dest).unwrap();
        assert!(dest.is_file());

        // The extracted shell must always end up validly signed…
        let out = std::process::Command::new("codesign")
            .arg("--verify")
            .arg("--verbose=2")
            .arg(&dest)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "extracted shell must pass codesign --verify: {}",
            String::from_utf8_lossy(&out.stderr)
        );

        // …and when the source was already strictly valid (as the bundled
        // Developer-ID shell is), its signature must be PRESERVED, not replaced
        // with an ad-hoc one — an ad-hoc x86_64 shell SIGABRTs the second
        // per-app launcher under Rosetta on macOS 26.
        if verifies_strict(&src) {
            assert_eq!(
                cdhash(&dest),
                cdhash(&src),
                "extract_shell must keep the source signature, not re-sign ad-hoc"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn extract_shell_skips_when_dest_is_current() {
        let src = std::env::current_exe().unwrap(); // a real, signed Mach-O
        let dir = scratch("current");
        let dest = dir.join("shell/CalimeroShell");

        assert!(
            !shell_is_current(&src, &dest),
            "a missing dest is not current"
        );
        extract_shell(&src, &dest).unwrap();
        assert!(shell_is_current(&src, &dest), "a fresh copy is current");

        // The re-extract on every launch must not touch the file at all.
        let before = std::fs::metadata(&dest).unwrap().modified().unwrap();
        extract_shell(&src, &dest).unwrap();
        assert_eq!(
            std::fs::metadata(&dest).unwrap().modified().unwrap(),
            before,
            "extract_shell must skip the copy when dest is already current"
        );

        // A different size is stale even when the dest is newer than the source.
        let short = dir.join("short");
        std::fs::write(&short, b"stale").unwrap();
        assert!(!shell_is_current(&src, &short));
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn sample() -> AppSpec {
        AppSpec {
            id: "mero-drive".into(),
            name: "MeroDrive".into(),
            url: "https://calimero.network".into(),
            node_url: "http://localhost:2528".into(),
            cap: "cap-123".into(),
            icon: None,
        }
    }

    fn shell_crash_count() -> usize {
        std::process::Command::new("bash")
            .arg("-c")
            .arg("ls ~/Library/Logs/DiagnosticReports/CalimeroShell* 2>/dev/null | wc -l")
            .output()
            .ok()
            .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok())
            .unwrap_or(0)
    }

    /// Real end-to-end: drive the actual `extract_shell` + `generate_launcher`
    /// against a universal Developer-ID shell, launch the generated `.app`, and
    /// assert it does NOT produce a codesign/Rosetta crash. The shell may still
    /// exit cleanly (Rust panic) on the synthetic app.json — that writes no crash
    /// report, so counting fresh CalimeroShell crash reports isolates the bug we
    /// fixed. Manual (`--ignored`): needs a real universal shell + launches a GUI.
    ///   CAL_TEST_UNIVERSAL_SHELL=/path/to/calimero-shell cargo test --lib \
    ///     launcher::tests::generated_launcher_runs_without_codesign_crash -- --ignored --nocapture
    #[test]
    #[ignore]
    fn generated_launcher_runs_without_codesign_crash() {
        let src = std::env::var("CAL_TEST_UNIVERSAL_SHELL")
            .expect("set CAL_TEST_UNIVERSAL_SHELL to a real universal signed calimero-shell");
        let dir = scratch("launch");
        let loose = dir.join("shell/CalimeroShell");
        extract_shell(Path::new(&src), &loose).unwrap();

        let before = shell_crash_count();
        let app = generate_launcher(&dir, &loose, &sample()).unwrap();
        let out = std::process::Command::new("open").arg(&app).output().unwrap();
        assert!(out.status.success(), "open failed: {}", String::from_utf8_lossy(&out.stderr));
        std::thread::sleep(std::time::Duration::from_secs(4));
        let after = shell_crash_count();
        let _ = std::process::Command::new("pkill").args(["-9", "-x", "CalimeroShell"]).output();

        assert_eq!(
            after, before,
            "the generated launcher SIGKILLed the shell (codesign/Rosetta crash) — {} new crash report(s)",
            after - before
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn helpers_write_expected_files() {
        let dir = scratch("helpers");
        let contents = dir.join("Contents");
        let resources = contents.join("Resources");
        let macos = contents.join("MacOS");
        std::fs::create_dir_all(&resources).unwrap();
        std::fs::create_dir_all(&macos).unwrap();

        let j = write_app_json(&resources, &sample()).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&std::fs::read(&j).unwrap()).unwrap();
        assert_eq!(v["id"], "mero-drive");
        assert_eq!(v["cap"], "cap-123");
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&j).unwrap().permissions().mode() & 0o777,
            0o600
        );

        let p = write_info_plist(&contents, &sample(), false).unwrap();
        let t = std::fs::read_to_string(&p).unwrap();
        assert!(t.contains("<key>CFBundleExecutable</key><string>launch</string>"));
        assert!(t.contains("network.calimero.app.mero-drive"));
        assert!(!t.contains("CFBundleIconFile"));

        let l = write_trampoline(
            &macos,
            Path::new("/Users/x/Library/Application Support/network.calimero.desktop/shell/CalimeroShell"),
        )
        .unwrap();
        let s = std::fs::read_to_string(&l).unwrap();
        assert!(s.starts_with("#!/bin/bash"));
        assert!(s.contains("shell/CalimeroShell"));
        assert!(s.contains("--app-config"));
        assert!(s.contains("Resources") && s.contains("app.json"));
        assert_eq!(
            std::fs::metadata(&l).unwrap().permissions().mode() & 0o777,
            0o755
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn generated_launcher_is_unsigned_and_wired() {
        let dir = scratch("gen");
        let shell = Path::new("/tmp/does-not-matter/shell/CalimeroShell");
        let app = generate_launcher(&dir, shell, &sample()).unwrap();

        assert!(app.ends_with("MeroDrive.app") && app.is_dir());
        let launch = app.join("Contents/MacOS/launch");
        assert!(launch.is_file());
        let s = std::fs::read_to_string(&launch).unwrap();
        assert!(s.contains("shell/CalimeroShell") && s.contains("--app-config"));
        // Must run the shell under the Mac's NATIVE arch, or a script-executable
        // launcher defaults to x86_64/Rosetta and the loose hardened-runtime
        // shell is SIGKILLed for an invalid signature under translation.
        assert!(
            s.contains("arch -") && s.contains("uname -m"),
            "trampoline must exec the shell under the native arch: {s}"
        );
        assert!(app.join("Contents/Resources/app.json").is_file());
        assert!(app.join("Contents/Info.plist").is_file());

        // The whole point: the bundle is NOT signed.
        let out = std::process::Command::new("codesign")
            .arg("--verify")
            .arg(&app)
            .output()
            .unwrap();
        assert!(!out.status.success(), "per-app launcher must be UNSIGNED");
        assert!(String::from_utf8_lossy(&out.stderr).contains("not signed"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
