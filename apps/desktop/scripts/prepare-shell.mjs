// Build the slim `calimero-shell` bin and stage it as a Tauri resource so it
// ships inside the app bundle (Contents/Resources/shell/calimero-shell). The
// host extracts it to a loose path + ad-hoc-signs it at runtime.
//
// Note the placeholder: tauri-build validates that every declared resource
// exists during `cargo build`. Since the shell IS a resource of this very
// crate, a cold build would fail (the file isn't staged yet, and building it
// requires the crate to build). So we stage an empty placeholder first — with
// no cargo — then build the shell and overwrite it with the real binary.
import path from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, statSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";

const desktopDir = path.resolve(import.meta.dirname, "..");
const tauriDir = path.join(desktopDir, "src-tauri");
const shellDir = path.join(tauriDir, "shell");
const binName = process.platform === "win32" ? "calimero-shell.exe" : "calimero-shell";
const dest = path.join(shellDir, binName);

const target = (process.env.TAURI_TARGET_TRIPLE || process.env.CARGO_BUILD_TARGET || "").trim();

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

// 0) The shell crate's placeholder frontend. dist/ is gitignored (like the app's),
//    so generate it — tauri-build (calimero-shell/build.rs) needs distDir to exist.
const shellCrateDist = path.join(tauriDir, "calimero-shell", "dist");
mkdirSync(shellCrateDist, { recursive: true });
const shellIndex = path.join(shellCrateDist, "index.html");
if (!existsSync(shellIndex)) {
  writeFileSync(
    shellIndex,
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>Calimero Shell</title></head><body></body></html>\n"
  );
}

// 1) Empty placeholders (no cargo) so the crate's tauri-build resource check
//    passes on the cold build below.
const trampolineName = process.platform === "win32" ? "launcher-trampoline.exe" : "launcher-trampoline";
const trampolineDest = path.join(shellDir, trampolineName);
mkdirSync(shellDir, { recursive: true });
if (!existsSync(dest)) writeFileSync(dest, "");
if (!existsSync(trampolineDest)) writeFileSync(trampolineDest, "");

// 2) Real release build, then stage the optimized binary over the placeholder.
//    `universal-apple-darwin` is not a real rustc target — build both arches
//    and `lipo` them, matching what Tauri does for the main binary.
let built;
if (target === "universal-apple-darwin") {
  const arches = ["aarch64-apple-darwin", "x86_64-apple-darwin"];
  const slices = [];
  for (const arch of arches) {
    cargo(["build", "--release", "-p", "calimero-shell", "--target", arch]);
    slices.push(path.join(tauriDir, "target", arch, "release", binName));
  }
  const uniDir = path.join(tauriDir, "target", "universal-apple-darwin", "release");
  mkdirSync(uniDir, { recursive: true });
  built = path.join(uniDir, binName);
  console.log(`[prepare-shell] lipo -create -> ${built}`);
  execFileSync("lipo", ["-create", "-output", built, ...slices], { stdio: "inherit" });
} else {
  const releaseArgs = ["build", "--release", "-p", "calimero-shell"];
  if (target) releaseArgs.push("--target", target);
  cargo(releaseArgs);
  const releaseDir = target
    ? path.join(tauriDir, "target", target, "release")
    : path.join(tauriDir, "target", "release");
  built = path.join(releaseDir, binName);
}

if (!existsSync(built)) {
  throw new Error(`[prepare-shell] built binary not found at ${built}`);
}
mkdirSync(shellDir, { recursive: true });
copyFileSync(built, dest);
console.log(`[prepare-shell] staged ${built} -> ${dest}`);

// 3) The launcher trampoline: the per-app bundle's Mach-O executable (macOS 26
//    LaunchServices refuses script executables). Same target/lipo handling.
let builtTrampoline;
if (target === "universal-apple-darwin") {
  const arches = ["aarch64-apple-darwin", "x86_64-apple-darwin"];
  const slices = [];
  for (const arch of arches) {
    cargo(["build", "--release", "-p", "calimero-tauri-app", "--bin", "launcher-trampoline", "--target", arch]);
    slices.push(path.join(tauriDir, "target", arch, "release", trampolineName));
  }
  const uniDir = path.join(tauriDir, "target", "universal-apple-darwin", "release");
  mkdirSync(uniDir, { recursive: true });
  builtTrampoline = path.join(uniDir, trampolineName);
  console.log(`[prepare-shell] lipo -create -> ${builtTrampoline}`);
  execFileSync("lipo", ["-create", "-output", builtTrampoline, ...slices], { stdio: "inherit" });
} else {
  const releaseArgs = ["build", "--release", "-p", "calimero-tauri-app", "--bin", "launcher-trampoline"];
  if (target) releaseArgs.push("--target", target);
  cargo(releaseArgs);
  const releaseDir = target
    ? path.join(tauriDir, "target", target, "release")
    : path.join(tauriDir, "target", "release");
  builtTrampoline = path.join(releaseDir, trampolineName);
}
if (!existsSync(builtTrampoline)) {
  throw new Error(`[prepare-shell] built trampoline not found at ${builtTrampoline}`);
}
copyFileSync(builtTrampoline, trampolineDest);
console.log(`[prepare-shell] staged ${builtTrampoline} -> ${trampolineDest}`);
