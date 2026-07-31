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
/// Idempotent (overwrites).
pub fn extract_shell(src: &Path, dest: &Path) -> Result<(), LauncherError> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(src, dest)?;
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dest, std::fs::Permissions::from_mode(0o755))?;
    }

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
    let script = format!(
        "#!/bin/bash\n\
DIR=\"$(cd \"$(dirname \"$0\")/../Resources\" && pwd)\"\n\
exec \"{shell}\" --app-config \"$DIR/app.json\"\n",
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
