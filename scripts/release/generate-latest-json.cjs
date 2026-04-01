#!/usr/bin/env node
/**
 * Generate latest.json manifest for Tauri updater.
 *
 * Usage:
 *   node generate-latest-json.js --version 1.0.0 --repo owner/repo --assets release-assets/ --output latest.json
 *
 * Reads platform manifests from the assets directory and generates a combined
 * latest.json with all platform entries.
 */

const fs = require("fs");
const path = require("path");

// Tauri v1 platform identifiers
const TAURI_PLATFORMS = {
  macos: ["darwin-universal", "darwin-x86_64", "darwin-aarch64"],
  windows: ["windows-x86_64"],
  linux: ["linux-x86_64"],
};

// Map our artifact types to Tauri updater expectations
const UPDATER_ASSET_SUFFIX = {
  macos: "_macos_universal.app.tar.gz",
  windows: "_windows_x64.nsis.zip",
  linux: "_linux_x64.AppImage.tar.gz",
};

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {
    version: null,
    repo: null,
    assets: "release-assets",
    output: "latest.json",
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--version" && args[i + 1]) {
      result.version = args[++i];
    } else if (args[i] === "--repo" && args[i + 1]) {
      result.repo = args[++i];
    } else if (args[i] === "--assets" && args[i + 1]) {
      result.assets = args[++i];
    } else if (args[i] === "--output" && args[i + 1]) {
      result.output = args[++i];
    }
  }

  return result;
}

function loadPlatformManifests(assetsDir) {
  const manifests = {};
  const platforms = ["macos", "windows", "linux"];

  for (const platform of platforms) {
    const manifestPath = path.join(assetsDir, `manifest-${platform}.json`);
    if (fs.existsSync(manifestPath)) {
      manifests[platform] = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    }
  }

  return manifests;
}

function findSignature(assetsDir, assetName) {
  const sigPath = path.join(assetsDir, `${assetName}.sig`);
  if (fs.existsSync(sigPath)) {
    return fs.readFileSync(sigPath, "utf8").trim();
  }
  return "";
}

function main() {
  const args = parseArgs();

  if (!args.version) {
    console.error("Error: --version is required");
    process.exit(1);
  }

  if (!args.repo) {
    console.error("Error: --repo is required (e.g., owner/repo)");
    process.exit(1);
  }

  const manifests = loadPlatformManifests(args.assets);
  const platforms = {};
  const baseUrl = `https://github.com/${args.repo}/releases/download/v${args.version}`;

  for (const [platform, manifest] of Object.entries(manifests)) {
    const suffix = UPDATER_ASSET_SUFFIX[platform];
    const updaterAsset = manifest.assets.find((a) => a.name.endsWith(suffix));

    if (!updaterAsset) {
      console.warn(`Warning: No updater asset found for ${platform}`);
      continue;
    }

    const url = `${baseUrl}/${updaterAsset.name}`;
    const signature = findSignature(args.assets, updaterAsset.name);

    // Add entries for all Tauri platform identifiers
    for (const tauriPlatform of TAURI_PLATFORMS[platform]) {
      platforms[tauriPlatform] = {
        url,
        signature,
      };
    }

    console.log(`Added ${platform}: ${updaterAsset.name}`);
  }

  if (Object.keys(platforms).length === 0) {
    console.error(
      "Error: No platforms found. Ensure build manifests exist in assets directory."
    );
    process.exit(1);
  }

  const latestJson = {
    version: `v${args.version}`,
    notes: `Release v${args.version}`,
    pub_date: new Date().toISOString(),
    platforms,
  };

  fs.writeFileSync(args.output, JSON.stringify(latestJson, null, 2));
  console.log(`\nGenerated: ${args.output}`);
  console.log(`Platforms: ${Object.keys(platforms).join(", ")}`);
}

main();
