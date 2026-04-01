#!/usr/bin/env node
/**
 * Generate release.json for the download landing page.
 * 
 * Usage:
 *   node generate-release-json.js --version 1.0.0 --repo owner/repo --assets release-assets/ --output release.json
 * 
 * Generates a structured JSON file with all available downloads, making it
 * easy for the download page to display platform-specific options.
 */

const fs = require("fs");
const path = require("path");

// Map artifact suffixes to download metadata
const DOWNLOAD_META = {
  "_macos_universal.dmg": { os: "macos", arch: "universal", format: "dmg", label: "macOS (Universal)" },
  "_windows_x64_setup.exe": { os: "windows", arch: "x64", format: "exe", label: "Windows (64-bit)" },
  "_windows_x64.msi": { os: "windows", arch: "x64", format: "msi", label: "Windows MSI (64-bit)" },
  "_linux_x64.AppImage": { os: "linux", arch: "x64", format: "appimage", label: "Linux (AppImage)" },
  "_linux_x64.deb": { os: "linux", arch: "x64", format: "deb", label: "Linux (Debian/Ubuntu)" },
  "_linux_x64.rpm": { os: "linux", arch: "x64", format: "rpm", label: "Linux (Fedora/RHEL)" },
};

// Primary download format per OS
const PRIMARY_FORMAT = {
  macos: "dmg",
  windows: "exe",
  linux: "appimage",
};

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {
    version: null,
    repo: null,
    assets: "release-assets",
    output: "release.json",
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

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
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
  const baseUrl = `https://github.com/${args.repo}/releases/download/v${args.version}`;
  const downloads = [];

  for (const manifest of Object.values(manifests)) {
    for (const asset of manifest.assets) {
      // Only include installer types (not updater or signature)
      if (asset.type !== "installer") continue;

      // Find matching metadata
      let meta = null;
      for (const [suffix, m] of Object.entries(DOWNLOAD_META)) {
        if (asset.name.endsWith(suffix)) {
          meta = m;
          break;
        }
      }

      if (!meta) continue;

      downloads.push({
        os: meta.os,
        arch: meta.arch,
        format: meta.format,
        label: meta.label,
        url: `${baseUrl}/${asset.name}`,
        filename: asset.name,
        size: asset.size,
        sizeFormatted: formatBytes(asset.size),
        primary: PRIMARY_FORMAT[meta.os] === meta.format,
      });
    }
  }

  // Sort downloads: primary first, then by OS, then by format
  downloads.sort((a, b) => {
    if (a.primary !== b.primary) return b.primary - a.primary;
    if (a.os !== b.os) return a.os.localeCompare(b.os);
    return a.format.localeCompare(b.format);
  });

  const releaseJson = {
    version: args.version,
    tag: `v${args.version}`,
    publishedAt: new Date().toISOString(),
    releaseUrl: `https://github.com/${args.repo}/releases/tag/v${args.version}`,
    notesUrl: `https://github.com/${args.repo}/releases/tag/v${args.version}`,
    downloads,
  };

  fs.writeFileSync(args.output, JSON.stringify(releaseJson, null, 2));
  console.log(`\nGenerated: ${args.output}`);
  console.log(`Downloads: ${downloads.length} artifacts`);
  
  // Summary by OS
  const byOs = {};
  for (const d of downloads) {
    byOs[d.os] = (byOs[d.os] || 0) + 1;
  }
  for (const [os, count] of Object.entries(byOs)) {
    console.log(`  ${os}: ${count} format(s)`);
  }
}

main();
