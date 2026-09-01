import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createWriteStream, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import * as tar from "tar";

const CORE_REPO = "calimero-network/core";
const rootDir = path.resolve(import.meta.dirname, "../../..");
const desktopDir = path.resolve(import.meta.dirname, "..");
const configPath = path.join(rootDir, "merod-config.json");
const merodDir = path.join(desktopDir, "src-tauri", "merod");
const merodBinaryName = process.platform === "win32" ? "merod.exe" : "merod";
const merodBinaryPath = path.join(merodDir, merodBinaryName);

function envTruthy(name) {
  const v = String(process.env[name] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function shouldUseExistingMerodBinary() {
  if (!existsSync(merodBinaryPath)) {
    return false;
  }
  return envTruthy("MEROD_SKIP_IF_EXISTS");
}

function githubHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "calimero-desktop-merod-prep",
  };

  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  return headers;
}

async function readErrorBody(response) {
  try {
    const text = await response.text();
    const trimmed = text.trim();
    if (!trimmed) {
      return "";
    }
    return trimmed.length > 800 ? `${trimmed.slice(0, 800)}…` : trimmed;
  } catch {
    return "";
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: githubHeaders() });
  if (!response.ok) {
    const body = await readErrorBody(response);
    const detail = body ? ` — ${body}` : "";
    throw new Error(
      `GitHub API request failed (${response.status}) for ${url}${detail}`,
    );
  }

  return response.json();
}

async function readConfig() {
  if (!existsSync(configPath)) {
    return {};
  }

  const raw = await fs.readFile(configPath, "utf8");
  return JSON.parse(raw);
}

function resolveTarget() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "darwin" && arch === "arm64") {
    return {
      label: "macOS arm64",
      candidates: ["aarch64-apple-darwin", "arm64-apple-darwin"],
    };
  }

  if (platform === "darwin" && arch === "x64") {
    return {
      label: "macOS x64",
      candidates: ["x86_64-apple-darwin"],
    };
  }

  if (platform === "linux" && arch === "x64") {
    return {
      label: "Linux x64",
      candidates: ["x86_64-unknown-linux-gnu"],
    };
  }

  if (platform === "linux" && arch === "arm64") {
    return {
      label: "Linux arm64",
      candidates: ["aarch64-unknown-linux-gnu", "aarch64-unknown-linux-musl"],
    };
  }

  if (platform === "win32" && arch === "x64") {
    return {
      label: "Windows x64",
      candidates: [
        "x86_64-pc-windows-msvc",
        "x86_64-pc-windows-gnu",
        "x86_64-windows",
      ],
    };
  }

  if (platform === "win32" && arch === "arm64") {
    return {
      label: "Windows arm64",
      candidates: ["aarch64-pc-windows-msvc", "arm64-pc-windows-msvc"],
    };
  }

  throw new Error(`Unsupported platform/architecture: ${platform}/${arch}`);
}

async function resolveRelease(config) {
  if (process.env.MEROD_VERSION) {
    return {
      release: await fetchJson(
        `https://api.github.com/repos/${CORE_REPO}/releases/tags/${encodeURIComponent(
          process.env.MEROD_VERSION,
        )}`,
      ),
      source: `MEROD_VERSION=${process.env.MEROD_VERSION}`,
    };
  }

  if (process.env.MEROD_CHANNEL) {
    const channel = process.env.MEROD_CHANNEL.trim().toLowerCase();
    const releases = await fetchJson(
      `https://api.github.com/repos/${CORE_REPO}/releases?per_page=20`,
    );

    const release =
      channel === "prerelease"
        ? releases.find((item) => item.prerelease)
        : releases.find((item) => !item.prerelease);

    if (!release) {
      throw new Error(`No ${channel} release found in ${CORE_REPO}`);
    }

    return {
      release,
      source: `MEROD_CHANNEL=${channel}`,
    };
  }

  if (config.version) {
    return {
      release: await fetchJson(
        `https://api.github.com/repos/${CORE_REPO}/releases/tags/${encodeURIComponent(
          config.version,
        )}`,
      ),
      source: `merod-config.json version=${config.version}`,
    };
  }

  const release = await fetchJson(
    `https://api.github.com/repos/${CORE_REPO}/releases/latest`,
  );
  return {
    release,
    source: "latest stable release",
  };
}

function scoreAsset(name, target) {
  const lower = name.toLowerCase();
  const targetIndex = target.candidates.findIndex((candidate) =>
    lower.includes(candidate.toLowerCase()),
  );

  if (targetIndex === -1 || !lower.startsWith("merod")) {
    return Number.POSITIVE_INFINITY;
  }

  let score = targetIndex * 100;

  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    score += 1;
  } else if (lower.endsWith(".zip")) {
    score += 2;
  } else if (lower.endsWith(".exe")) {
    score += 3;
  } else {
    score += 4;
  }

  return score;
}

function pickAsset(release, target) {
  const ranked = release.assets
    .map((asset) => ({ asset, score: scoreAsset(asset.name, target) }))
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => a.score - b.score);

  if (ranked.length > 0) {
    return ranked[0].asset;
  }

  const assetNames = release.assets.map((asset) => asset.name).join(", ");
  throw new Error(
    `No merod asset found for ${target.label} in ${release.tag_name}. Available assets: ${
      assetNames || "none"
    }`,
  );
}

/**
 * When the pinned release omits a platform (e.g. no Windows zip yet), find a newer
 * release that ships merod for this target. Newest-first.
 */
async function findReleaseWithMerodForTarget(target) {
  const releases = await fetchJson(
    `https://api.github.com/repos/${CORE_REPO}/releases?per_page=40`,
  );

  for (const candidate of releases) {
    try {
      const asset = pickAsset(candidate, target);
      return { release: candidate, asset };
    } catch {
      continue;
    }
  }

  return null;
}

async function downloadToFile(url, destination) {
  const response = await fetch(url, { headers: githubHeaders() });
  if (!response.ok || !response.body) {
    const body = await readErrorBody(response);
    const detail = body ? ` — ${body}` : "";
    throw new Error(`Failed to download ${url} (${response.status})${detail}`);
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

function shellExtractZip(archivePath, destinationDir) {
  if (process.platform === "win32") {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destinationDir.replace(/'/g, "''")}' -Force`,
      ],
      { stdio: "inherit" },
    );
    return;
  }

  execFileSync("unzip", ["-o", archivePath, "-d", destinationDir], {
    stdio: "inherit",
  });
}

async function findBinary(startDir) {
  const entries = await fs.readdir(startDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }

    const fullPath = path.join(startDir, entry.name);

    if (entry.isDirectory()) {
      const nested = await findBinary(fullPath);
      if (nested) {
        return nested;
      }
      continue;
    }

    const lower = entry.name.toLowerCase();
    if (lower === "merod" || lower === "merod.exe") {
      return fullPath;
    }
  }

  return null;
}

async function extractBinary(assetPath, assetName) {
  const lower = assetName.toLowerCase();
  if (
    !lower.endsWith(".tar.gz") &&
    !lower.endsWith(".tgz") &&
    !lower.endsWith(".zip")
  ) {
    return assetPath;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "merod-extract-"));

  try {
    if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
      await tar.x({
        file: assetPath,
        cwd: tempDir,
      });
    } else {
      shellExtractZip(assetPath, tempDir);
    }

    const binaryPath = await findBinary(tempDir);
    if (!binaryPath) {
      throw new Error(`Could not find extracted merod binary inside ${assetName}`);
    }

    return { binaryPath, tempDir };
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  await fs.mkdir(merodDir, { recursive: true });

  if (shouldUseExistingMerodBinary()) {
    console.log(
      `[merod] ready: ${merodBinaryPath} (existing binary; skip GitHub download)`,
    );
    return;
  }

  const config = await readConfig();
  const target = resolveTarget();
  let { release, source } = await resolveRelease(config);
  let asset;

  try {
    asset = pickAsset(release, target);
  } catch (primaryError) {
    const allowFallback = envTruthy("MEROD_ASSET_FALLBACK");
    const isMissingAsset =
      primaryError instanceof Error &&
      primaryError.message.includes("No merod asset found");

    if (!allowFallback || !isMissingAsset) {
      throw primaryError;
    }

    const found = await findReleaseWithMerodForTarget(target);
    if (!found) {
      throw primaryError;
    }

    console.warn(
      `[merod] ${release.tag_name} has no ${target.label} asset; using fallback ${found.release.tag_name}`,
    );
    release = found.release;
    source = `${source} → fallback ${found.release.tag_name}`;
    asset = found.asset;
  }

  console.log(`[merod] target: ${target.label}`);
  console.log(`[merod] release: ${release.tag_name} (${source})`);
  console.log(`[merod] asset: ${asset.name}`);

  await fs.rm(merodBinaryPath, { force: true });
  if (process.platform === "win32") {
    await fs.rm(path.join(merodDir, "merod"), { force: true });
  } else {
    await fs.rm(path.join(merodDir, "merod.exe"), { force: true });
  }

  const tempDownloadDir = await fs.mkdtemp(path.join(os.tmpdir(), "merod-download-"));
  const assetPath = path.join(tempDownloadDir, asset.name);

  try {
    await downloadToFile(asset.browser_download_url, assetPath);
    const extracted = await extractBinary(assetPath, asset.name);
    try {
      const extractedBinaryPath =
        typeof extracted === "string" ? extracted : extracted.binaryPath;

      await fs.copyFile(extractedBinaryPath, merodBinaryPath);

      if (process.platform !== "win32") {
        await fs.chmod(merodBinaryPath, 0o755);
      }
    } finally {
      if (typeof extracted !== "string") {
        await fs.rm(extracted.tempDir, { recursive: true, force: true });
      }
    }
  } finally {
    await fs.rm(tempDownloadDir, { recursive: true, force: true });
  }

  console.log(`[merod] ready: ${merodBinaryPath}`);
}

main().catch((error) => {
  console.error(`[merod] ${error.message}`);
  process.exit(1);
});
