// Build the slim `calimero-shell` bin and stage it as a Tauri resource so it
// ships inside the app bundle (Contents/Resources/shell/calimero-shell). The
// host extracts it to a loose path + ad-hoc-signs it at runtime.
import path from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, statSync, mkdirSync, copyFileSync } from "node:fs";

const desktopDir = path.resolve(import.meta.dirname, "..");
const tauriDir = path.join(desktopDir, "src-tauri");
const shellDir = path.join(tauriDir, "shell");
const binName = process.platform === "win32" ? "calimero-shell.exe" : "calimero-shell";
const dest = path.join(shellDir, binName);

const target = (process.env.TAURI_TARGET_TRIPLE || "").trim();

function envTruthy(name) {
  const v = String(process.env[name] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function isRealBinary(p) {
  try {
    return existsSync(p) && statSync(p).size > 0;
  } catch {
    return false;
  }
}

// CI stages + code-signs the shell in a dedicated step, then runs the bundle
// build (whose beforeBuildCommand also calls this script). Skip the rebuild so
// the signed binary is preserved.
if (isRealBinary(dest) && envTruthy("SHELL_SKIP_IF_EXISTS")) {
  console.log(`[prepare-shell] keeping existing ${dest} (SHELL_SKIP_IF_EXISTS)`);
  process.exit(0);
}

function cargo(args) {
  console.log(`[prepare-shell] cargo ${args.join(" ")}`);
  execFileSync("cargo", args, { cwd: tauriDir, stdio: "inherit" });
}

const trampolineName = process.platform === "win32" ? "launcher-trampoline.exe" : "launcher-trampoline";
const trampolineDest = path.join(shellDir, trampolineName);
mkdirSync(shellDir, { recursive: true });

// `universal-apple-darwin` is not a real rustc target - build both arches and
// `lipo` them, matching what Tauri does for the main binary.
function buildBin(pkgArgs, name) {
  if (target === "universal-apple-darwin") {
    const slices = ["aarch64-apple-darwin", "x86_64-apple-darwin"].map((arch) => {
      cargo(["build", "--release", ...pkgArgs, "--target", arch]);
      return path.join(tauriDir, "target", arch, "release", name);
    });
    const out = path.join(tauriDir, "target", target, "release", name);
    mkdirSync(path.dirname(out), { recursive: true });
    console.log(`[prepare-shell] lipo -create -> ${out}`);
    execFileSync("lipo", ["-create", "-output", out, ...slices], { stdio: "inherit" });
    return out;
  }
  cargo(["build", "--release", ...pkgArgs, ...(target ? ["--target", target] : [])]);
  return path.join(tauriDir, "target", ...(target ? [target] : []), "release", name);
}

for (const [pkgArgs, name, out] of [
  [["-p", "calimero-shell"], binName, dest],
  // The per-app bundle's Mach-O executable: macOS 26 refuses script executables.
  [["-p", "calimero-tauri-app", "--bin", "launcher-trampoline"], trampolineName, trampolineDest],
]) {
  const built = buildBin(pkgArgs, name);
  if (!existsSync(built)) {
    throw new Error(`[prepare-shell] built binary not found at ${built}`);
  }
  copyFileSync(built, out);
  console.log(`[prepare-shell] staged ${built} -> ${out}`);
}
