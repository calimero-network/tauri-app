#!/usr/bin/env node
/**
 * Write the two release manifests from the per-platform manifests collect-assets
 * left in the assets directory: latest.json for the Tauri updater and
 * release.json for the download site.
 *
 * Usage:
 *   node generate-manifests.cjs --version 1.0.0 --repo owner/repo --assets release-assets/
 */

const fs = require("fs");
const path = require("path");
const { parseArgs } = require("util");

const { PLATFORM_CONFIG } = require("./platforms.cjs");

const SIZE_UNITS = ["B", "KB", "MB", "GB"];

function loadPlatformManifests(assetsDir) {
  const manifests = {};

  for (const platform of Object.keys(PLATFORM_CONFIG)) {
    const manifestPath = path.join(assetsDir, `manifest-${platform}.json`);
    if (fs.existsSync(manifestPath)) {
      manifests[platform] = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    }
  }

  return manifests;
}

/**
 * Read the hard-block floor from the repo root package.json. Absent or "0.0.0"
 * means no install is blocked, so the field is omitted from the manifest.
 */
function loadMinimumVersion() {
  const rootPkg = path.join(__dirname, "..", "..", "package.json");
  const { minimumAppVersion } = JSON.parse(fs.readFileSync(rootPkg, "utf8"));
  if (!minimumAppVersion || minimumAppVersion === "0.0.0") {
    return null;
  }
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(minimumAppVersion)) {
    console.error(`Error: minimumAppVersion '${minimumAppVersion}' is not a semver`);
    process.exit(1);
  }
  return minimumAppVersion;
}

function findSignature(assetsDir, assetName) {
  const sigPath = path.join(assetsDir, `${assetName}.sig`);
  if (fs.existsSync(sigPath)) {
    return fs.readFileSync(sigPath, "utf8").trim();
  }
  return "";
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + SIZE_UNITS[i];
}

function buildUpdaterPlatforms(manifests, assetsDir, baseUrl, errors) {
  const platforms = {};

  for (const [platform, manifest] of Object.entries(manifests)) {
    const updaterAsset = manifest.assets.find((a) => a.type === "updater");

    if (!updaterAsset) {
      console.warn(`Warning: No updater asset found for ${platform}`);
      continue;
    }

    const url = `${baseUrl}/${updaterAsset.name}`;
    const signature = findSignature(assetsDir, updaterAsset.name);
    // An entry without one is an update every client rejects; fail the release.
    if (!signature) {
      errors.push(`${platform}: no signature next to ${updaterAsset.name}`);
    }

    for (const tauriPlatform of PLATFORM_CONFIG[platform].updaterTargets) {
      platforms[tauriPlatform] = { url, signature };
    }

    console.log(`Added ${platform}: ${updaterAsset.name}`);
  }

  return platforms;
}

function buildDownloads(manifests, baseUrl) {
  const downloads = [];

  for (const [platform, manifest] of Object.entries(manifests)) {
    const { arch, artifacts } = PLATFORM_CONFIG[platform];

    for (const asset of manifest.assets) {
      const artifact = artifacts.find(
        (a) => a.type === "installer" && asset.name.endsWith(a.suffix)
      );
      if (!artifact) continue;

      downloads.push({
        os: platform,
        arch,
        format: artifact.format,
        label: artifact.label,
        url: `${baseUrl}/${asset.name}`,
        filename: asset.name,
        size: asset.size,
        sizeFormatted: formatBytes(asset.size),
        primary: artifact.primary === true,
      });
    }
  }

  downloads.sort((a, b) => {
    if (a.primary !== b.primary) return b.primary - a.primary;
    if (a.os !== b.os) return a.os.localeCompare(b.os);
    return a.format.localeCompare(b.format);
  });

  return downloads;
}

function main() {
  const { values: args } = parseArgs({
    options: {
      version: { type: "string" },
      repo: { type: "string" },
      assets: { type: "string", default: "release-assets" },
    },
  });

  if (!args.version) {
    console.error("Error: --version is required");
    process.exit(1);
  }

  if (!args.repo) {
    console.error("Error: --repo is required (e.g., owner/repo)");
    process.exit(1);
  }

  const manifests = loadPlatformManifests(args.assets);
  const baseUrl = `https://github.com/${args.repo}/releases/download/v${args.version}`;
  const errors = [];

  const platforms = buildUpdaterPlatforms(manifests, args.assets, baseUrl, errors);
  if (Object.keys(platforms).length === 0) {
    console.error(
      "Error: No platforms found. Ensure build manifests exist in assets directory."
    );
    process.exit(1);
  }

  const downloads = buildDownloads(manifests, baseUrl);
  if (downloads.length === 0) {
    errors.push("no installer downloads: the download site would show nothing");
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`Error: ${error}`);
    }
    process.exit(1);
  }

  const minimumVersion = loadMinimumVersion();

  const latestJson = {
    version: `v${args.version}`,
    notes: `Release v${args.version}`,
    pub_date: new Date().toISOString(),
    // Read by the app via Update.rawJson; ignored by the Tauri updater itself.
    ...(minimumVersion ? { minimumVersion } : {}),
    platforms,
  };

  const releaseJson = {
    version: args.version,
    tag: `v${args.version}`,
    publishedAt: new Date().toISOString(),
    releaseUrl: `https://github.com/${args.repo}/releases/tag/v${args.version}`,
    notesUrl: `https://github.com/${args.repo}/releases/tag/v${args.version}`,
    downloads,
  };

  const latestPath = path.join(args.assets, "latest.json");
  const releasePath = path.join(args.assets, "release.json");
  fs.writeFileSync(latestPath, JSON.stringify(latestJson, null, 2));
  fs.writeFileSync(releasePath, JSON.stringify(releaseJson, null, 2));

  console.log(`\nGenerated: ${latestPath}`);
  console.log(`Platforms: ${Object.keys(platforms).join(", ")}`);
  console.log(`Minimum version: ${minimumVersion ?? "none (no installs blocked)"}`);
  console.log(`\nGenerated: ${releasePath}`);
  console.log(`Downloads: ${downloads.length} artifacts`);
}

main();
