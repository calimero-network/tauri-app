//! macOS-only per-app launcher bundles: an ad-hoc-signed `.app` whose Mach-O
//! trampoline execs the shared, loose shell binary.

use std::path::{Path, PathBuf};

const MAX_NAME_SUFFIX: u32 = 99; // bounds the search for a free `<name> N.app`

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
    #[error("no free launcher name for {0:?}")]
    NameTaken(String),
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
        .join(crate::app_dir_name())
        .join("shell");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("CalimeroShell")
}

/// True when `dest` already holds `src`'s build, so the copy + dequarantine +
/// codesign round-trip can be skipped. Compared via the stamp recorded at
/// extraction: re-signing changes dest's size, so dest's own metadata cannot
/// testify to which build it came from. Errors read as "not current".
fn shell_is_current(src: &Path, dest: &Path) -> bool {
    let Ok(s) = std::fs::metadata(src) else {
        return false;
    };
    dest.exists()
        && std::fs::read_to_string(stamp_path(dest)).is_ok_and(|rec| rec == src_stamp(&s))
}

/// Sidecar recording which source build `dest` was extracted from.
fn stamp_path(dest: &Path) -> PathBuf {
    dest.with_extension("src-stamp")
}

fn src_stamp(src_meta: &std::fs::Metadata) -> String {
    let mtime = src_meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}:{}", src_meta.len(), mtime)
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
    // A failed extraction must not leave a stale claim of currency behind.
    let _ = std::fs::remove_file(stamp_path(dest));
    std::fs::copy(src, dest)?;
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dest, std::fs::Permissions::from_mode(0o755))?;
    }
    // Drop the quarantine flag the copy inherits from a downloaded .app, or
    // Gatekeeper prompts on every launch of the loose shell.
    dequarantine(dest);

    // Keep the existing (Developer-ID) signature if the copy is validly signed -
    // but not a linker-signed one: macOS 26 Taskgated SIGKILLs a LaunchServices-
    // spawned process that execs a merely linker-signed binary.
    let linker_signed = std::process::Command::new("codesign")
        .args(["-d", "-v"])
        .arg(dest)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stderr).contains("linker-signed"))
        .unwrap_or(false);
    let already_signed = !linker_signed
        && std::process::Command::new("codesign")
            .arg("--verify")
            .arg("--strict")
            .arg(dest)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
    if already_signed {
        record_stamp(src, dest);
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
    record_stamp(src, dest);
    Ok(())
}

fn record_stamp(src: &Path, dest: &Path) {
    if let Ok(s) = std::fs::metadata(src) {
        let _ = std::fs::write(stamp_path(dest), src_stamp(&s));
    }
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

fn write_trampoline(macos: &Path, trampoline_src: &Path) -> Result<PathBuf, LauncherError> {
    // macOS 26 LaunchServices silently refuses to spawn a bundle whose
    // executable is a script, so this must be a real Mach-O.
    let path = macos.join("launch");
    std::fs::copy(trampoline_src, &path)?;
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(path)
}

/// Ad-hoc sign the assembled bundle; macOS 26 LaunchServices refuses unsigned
/// bundles. Best-effort: a signing failure warns rather than failing creation.
fn sign_bundle(bundle: &Path) {
    let out = std::process::Command::new("codesign")
        .args(["--force", "-s", "-"])
        .arg(bundle)
        .output();
    match out {
        Ok(o) if !o.status.success() => log::warn!(
            "[Launcher] codesign failed for {}: {}",
            bundle.display(),
            String::from_utf8_lossy(&o.stderr)
        ),
        Err(e) => log::warn!("[Launcher] codesign spawn failed: {e}"),
        _ => {}
    }
}

/// Migrate an older launcher's executable in place; skips bundles this host did
/// not build for `id`. Re-signs: replacing the Mach-O invalidates the signature.
pub fn refresh_trampoline(
    bundle: &Path,
    id: &str,
    cap: &str,
    trampoline_src: &Path,
) -> Result<(), LauncherError> {
    let macos = bundle.join("Contents/MacOS");
    if is_own_launcher(bundle, id, cap) && macos.join("launch").exists() {
        write_trampoline(&macos, trampoline_src)?;
        sign_bundle(bundle);
    }
    Ok(())
}

/// True when `bundle` is a directory (not a link) this host built for `id`: its
/// `app.json` carries `cap`, a secret only the host's cap store and that bundle hold.
pub fn is_own_launcher(bundle: &Path, id: &str, cap: &str) -> bool {
    let is_dir = bundle.symlink_metadata().is_ok_and(|m| m.is_dir());
    is_dir
        && std::fs::read(bundle.join("Contents/Resources/app.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
            .is_some_and(|v| v["id"] == id && v["cap"] == cap)
}

/// Delete `bundle` only if it is this host's launcher for `id`; true if removed.
pub fn remove_own_launcher(bundle: &Path, id: &str, cap: &str) -> bool {
    is_own_launcher(bundle, id, cap) && std::fs::remove_dir_all(bundle).is_ok()
}

fn is_absent(path: &Path) -> bool {
    matches!(path.symlink_metadata(), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
}

/// Same directory entry, whatever the spelling: APFS matches names case-insensitively.
fn same_file(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (a.symlink_metadata(), b.symlink_metadata()) {
        (Ok(a), Ok(b)) => (a.dev(), a.ino()) == (b.dev(), b.ino()),
        _ => false,
    }
}

/// `<name>.app`, or `<name> N.app` when a bundle this host did not build for
/// `spec` already holds the name.
fn launcher_path(dest_dir: &Path, spec: &AppSpec) -> Result<PathBuf, LauncherError> {
    (1..=MAX_NAME_SUFFIX)
        .map(|n| match n {
            1 => dest_dir.join(format!("{}.app", spec.name)),
            n => dest_dir.join(format!("{} {n}.app", spec.name)),
        })
        .find(|p| is_absent(p) || is_own_launcher(p, &spec.id, &spec.cap))
        .ok_or_else(|| LauncherError::NameTaken(spec.name.clone()))
}

/// Build `<dest_dir>/<name>.app`: a launcher whose Mach-O trampoline execs
/// the installed shell with `--app-config <this-bundle>/Contents/Resources/app.json`,
/// then drop the app's `previous` launcher if it lives elsewhere and is ours.
/// Ad-hoc signed: macOS 26 LaunchServices refuses unsigned bundles.
pub fn generate_launcher(
    dest_dir: &Path,
    trampoline_src: &Path,
    spec: &AppSpec,
    previous: Option<&Path>,
) -> Result<PathBuf, LauncherError> {
    validate_app_id(&spec.id)?;
    let app_dir = launcher_path(dest_dir, spec)?;
    if !is_absent(&app_dir) {
        std::fs::remove_dir_all(&app_dir)?;
    }
    // create_dir, not _all: anything that appeared here since the check is not ours.
    std::fs::create_dir(&app_dir)?;
    // A half-built bundle carries no proof of ownership and would hold the name.
    if let Err(e) = fill_launcher(&app_dir, trampoline_src, spec) {
        let _ = std::fs::remove_dir_all(&app_dir);
        return Err(e);
    }
    if let Some(old) = previous.filter(|old| !same_file(old, &app_dir)) {
        remove_own_launcher(old, &spec.id, &spec.cap);
    }
    Ok(app_dir)
}

/// Write the bundle's contents, named after `app_dir` so a suffixed launcher shows its suffix.
fn fill_launcher(
    app_dir: &Path,
    trampoline_src: &Path,
    spec: &AppSpec,
) -> Result<(), LauncherError> {
    let shown = app_dir
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned());
    let spec = &AppSpec {
        name: shown.unwrap_or_else(|| spec.name.clone()),
        ..spec.clone()
    };
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
    write_trampoline(&macos, trampoline_src)?;
    sign_bundle(app_dir);
    Ok(())
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

        let tramp_src = dir.join("launcher-trampoline");
        std::fs::write(&tramp_src, b"\xcf\xfa\xed\xfefake mach-o").unwrap();
        let l = write_trampoline(&macos, &tramp_src).unwrap();
        assert_eq!(
            std::fs::read(&l).unwrap(),
            std::fs::read(&tramp_src).unwrap(),
            "launch must be a byte copy of the bundled trampoline"
        );
        assert_eq!(
            std::fs::metadata(&l).unwrap().permissions().mode() & 0o777,
            0o755
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn generated_launcher_is_wired() {
        let dir = scratch("gen");
        // A real Mach-O (this test binary) so the ad-hoc bundle signing succeeds.
        let tramp = std::env::current_exe().unwrap();
        let app = generate_launcher(&dir, &tramp, &sample(), None).unwrap();

        assert!(app.ends_with("MeroDrive.app") && app.is_dir());
        let launch = app.join("Contents/MacOS/launch");
        assert!(launch.is_file());
        // macOS 26 LaunchServices refuses script executables, so launch must be
        // a Mach-O (byte-identity does not survive the ad-hoc re-sign).
        let magic = &std::fs::read(&launch).unwrap()[..4];
        assert!(
            magic == b"\xcf\xfa\xed\xfe" || magic == b"\xca\xfe\xba\xbe",
            "launch must be a Mach-O, got {magic:02x?}"
        );
        assert!(app.join("Contents/Resources/app.json").is_file());
        assert!(app.join("Contents/Info.plist").is_file());

        // macOS 26 LaunchServices refuses unsigned bundles: must verify signed.
        let out = std::process::Command::new("codesign")
            .arg("--verify")
            .arg(&app)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "launcher bundle must be ad-hoc signed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn generate_launcher_never_replaces_a_bundle_it_did_not_build() {
        let dir = scratch("foreign");
        let tramp = std::env::current_exe().unwrap();
        let theirs = dir.join("MeroDrive.app/Contents/MacOS/MeroDrive");
        std::fs::create_dir_all(theirs.parent().unwrap()).unwrap();
        std::fs::write(&theirs, b"user's own app").unwrap();

        let app = generate_launcher(&dir, &tramp, &sample(), None).unwrap();

        assert_eq!(std::fs::read(&theirs).unwrap(), b"user's own app");
        assert!(app.ends_with("MeroDrive 2.app"), "got {}", app.display());
        assert!(is_own_launcher(&app, "mero-drive", "cap-123"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn generate_launcher_never_replaces_another_apps_launcher() {
        let dir = scratch("other-app");
        let tramp = std::env::current_exe().unwrap();
        let first = generate_launcher(&dir, &tramp, &sample(), None).unwrap();
        let other = AppSpec {
            id: "impostor".into(),
            cap: "cap-impostor".into(),
            ..sample()
        };

        let second = generate_launcher(&dir, &tramp, &other, None).unwrap();

        assert_ne!(first, second);
        assert!(is_own_launcher(&first, "mero-drive", "cap-123"));
        assert!(is_own_launcher(&second, "impostor", "cap-impostor"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn generate_launcher_rebuilds_its_own_launcher_in_place() {
        let dir = scratch("rebuild");
        let tramp = std::env::current_exe().unwrap();
        let first = generate_launcher(&dir, &tramp, &sample(), None).unwrap();
        let renamed_url = AppSpec {
            url: "https://example.com".into(),
            ..sample()
        };

        let second = generate_launcher(&dir, &tramp, &renamed_url, None).unwrap();

        assert_eq!(first, second);
        let v: serde_json::Value = serde_json::from_slice(
            &std::fs::read(second.join("Contents/Resources/app.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(v["url"], "https://example.com");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_renamed_app_drops_its_previous_launcher() {
        let dir = scratch("rename");
        let tramp = std::env::current_exe().unwrap();
        let first = generate_launcher(&dir, &tramp, &sample(), None).unwrap();
        let renamed = AppSpec {
            name: "Mero Drive".into(),
            ..sample()
        };

        let second = generate_launcher(&dir, &tramp, &renamed, Some(&first)).unwrap();

        assert!(second.ends_with("Mero Drive.app") && second.is_dir());
        assert!(!first.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_case_only_rename_keeps_the_rebuilt_launcher() {
        let dir = scratch("case");
        let tramp = std::env::current_exe().unwrap();
        let lower = AppSpec {
            name: "merodrive".into(),
            ..sample()
        };
        let first = generate_launcher(&dir, &tramp, &lower, None).unwrap();

        let second = generate_launcher(&dir, &tramp, &sample(), Some(&first)).unwrap();

        assert!(is_own_launcher(&second, "mero-drive", "cap-123"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_previous_path_holding_a_foreign_bundle_is_kept() {
        let dir = scratch("prev-foreign");
        let tramp = std::env::current_exe().unwrap();
        let theirs = dir.join("Theirs.app");
        std::fs::create_dir_all(theirs.join("Contents")).unwrap();

        generate_launcher(&dir, &tramp, &sample(), Some(&theirs)).unwrap();

        assert!(theirs.is_dir());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_suffixed_launcher_shows_its_suffix() {
        let dir = scratch("suffix-name");
        let tramp = std::env::current_exe().unwrap();
        std::fs::create_dir_all(dir.join("MeroDrive.app/Contents")).unwrap();

        let app = generate_launcher(&dir, &tramp, &sample(), None).unwrap();

        let plist = std::fs::read_to_string(app.join("Contents/Info.plist")).unwrap();
        assert!(plist.contains("<key>CFBundleDisplayName</key><string>MeroDrive 2</string>"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_build_does_not_keep_the_name() {
        let dir = scratch("failed");
        let tramp = std::env::current_exe().unwrap();
        let broken = AppSpec {
            icon: Some(dir.join("missing.icns")),
            ..sample()
        };
        assert!(generate_launcher(&dir, &tramp, &broken, None).is_err());

        let app = generate_launcher(&dir, &tramp, &sample(), None).unwrap();

        assert!(app.ends_with("MeroDrive.app"), "got {}", app.display());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_symlink_to_our_launcher_is_not_ours_to_replace() {
        let dir = scratch("symlink");
        let tramp = std::env::current_exe().unwrap();
        let ours = generate_launcher(&dir, &tramp, &sample(), None).unwrap();
        let link = dir.join("Link.app");
        std::os::unix::fs::symlink(&ours, &link).unwrap();

        assert!(!is_own_launcher(&link, "mero-drive", "cap-123"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn gives_up_when_every_name_is_taken() {
        let dir = scratch("taken");
        let tramp = std::env::current_exe().unwrap();
        for n in 1..=MAX_NAME_SUFFIX {
            let name = if n == 1 {
                "MeroDrive.app".into()
            } else {
                format!("MeroDrive {n}.app")
            };
            std::fs::create_dir(dir.join(name)).unwrap();
        }

        let err = generate_launcher(&dir, &tramp, &sample(), None).unwrap_err();

        assert!(matches!(err, LauncherError::NameTaken(_)), "got {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ownership_needs_the_matching_cap() {
        let dir = scratch("cap");
        let tramp = std::env::current_exe().unwrap();
        let app = generate_launcher(&dir, &tramp, &sample(), None).unwrap();

        assert!(is_own_launcher(&app, "mero-drive", "cap-123"));
        assert!(!is_own_launcher(&app, "mero-drive", "cap-other"));
        assert!(!is_own_launcher(&app, "other-id", "cap-123"));
        let missing = dir.join("Missing.app");
        assert!(!is_own_launcher(&missing, "mero-drive", "cap-123"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refresh_trampoline_leaves_foreign_bundles() {
        let dir = scratch("refresh");
        let tramp = std::env::current_exe().unwrap();
        let theirs = dir.join("Theirs.app/Contents/MacOS/launch");
        std::fs::create_dir_all(theirs.parent().unwrap()).unwrap();
        std::fs::write(&theirs, b"their binary").unwrap();

        refresh_trampoline(&dir.join("Theirs.app"), "mero-drive", "cap-123", &tramp).unwrap();

        assert_eq!(std::fs::read(&theirs).unwrap(), b"their binary");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_own_launcher_leaves_foreign_bundles() {
        let dir = scratch("remove");
        let tramp = std::env::current_exe().unwrap();
        let ours = generate_launcher(&dir, &tramp, &sample(), None).unwrap();
        let theirs = dir.join("Theirs.app");
        std::fs::create_dir_all(theirs.join("Contents")).unwrap();

        assert!(!remove_own_launcher(&theirs, "mero-drive", "cap-123"));
        assert!(theirs.is_dir());
        assert!(!remove_own_launcher(&ours, "mero-drive", "cap-other"));
        assert!(ours.is_dir());
        assert!(remove_own_launcher(&ours, "mero-drive", "cap-123"));
        assert!(!ours.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
