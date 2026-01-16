#!/usr/bin/env node
/**
 * Collect and normalize release assets from Tauri build output.
 *
 * Usage:
 *   node collect-assets.js --version 1.0.0 --platform macos --output release-assets/
 *
 * This script:
 * 1. Finds build artifacts in Tauri's output directories
 * 2. Renames them to stable, predictable names (no spaces, consistent format)
 * 3. Copies them to a staging directory for upload
 */

const fs = require("fs");
const path = require("path");

const PRODUCT_NAME = "CalimeroDesktop";

// Platform artifact configurations
const PLATFORM_CONFIG = {
  macos: {
    searchPaths: [
      "apps/desktop/src-tauri/target/universal-apple-darwin/release/bundle",
      "apps/desktop/src-tauri/target/release/bundle",
    ],
    artifacts: [
      { pattern: /\.dmg$/, suffix: "_macos_universal.dmg", type: "installer" },
      {
        pattern: /\.app\.tar\.gz$/,
        suffix: "_macos_universal.app.tar.gz",
        type: "updater",
      },
      {
        pattern: /\.app\.tar\.gz\.sig$/,
        suffix: "_macos_universal.app.tar.gz.sig",
        type: "signature",
      },
    ],
  },
  windows: {
    searchPaths: ["apps/desktop/src-tauri/target/release/bundle"],
    artifacts: [
      {
        pattern: /_x64-setup\.exe$/,
        suffix: "_windows_x64_setup.exe",
        type: "installer",
      },
      { pattern: /_x64\.msi$/, suffix: "_windows_x64.msi", type: "installer" },
      {
        pattern: /_x64-setup\.nsis\.zip$/,
        suffix: "_windows_x64.nsis.zip",
        type: "updater",
      },
      {
        pattern: /_x64-setup\.nsis\.zip\.sig$/,
        suffix: "_windows_x64.nsis.zip.sig",
        type: "signature",
      },
    ],
  },
  linux: {
    searchPaths: ["apps/desktop/src-tauri/target/release/bundle"],
    artifacts: [
      {
        pattern: /\.AppImage$/,
        suffix: "_linux_x64.AppImage",
        type: "installer",
      },
      {
        pattern: /\.AppImage\.tar\.gz$/,
        suffix: "_linux_x64.AppImage.tar.gz",
        type: "updater",
      },
      {
        pattern: /\.AppImage\.tar\.gz\.sig$/,
        suffix: "_linux_x64.AppImage.tar.gz.sig",
        type: "signature",
      },
      { pattern: /\.deb$/, suffix: "_linux_x64.deb", type: "installer" },
      { pattern: /\.rpm$/, suffix: "_linux_x64.rpm", type: "installer" },
    ],
  },
};

function findFiles(dir, pattern) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  function walk(currentDir) {
    const files = fs.readdirSync(currentDir);
    for (const file of files) {
      const filePath = path.join(currentDir, file);
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        walk(filePath);
      } else if (pattern.test(file)) {
        results.push(filePath);
      }
    }
  }

  walk(dir);
  return results;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { version: null, platform: null, output: "release-assets" };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--version" && args[i + 1]) {
      result.version = args[++i];
    } else if (args[i] === "--platform" && args[i + 1]) {
      result.platform = args[++i];
    } else if (args[i] === "--output" && args[i + 1]) {
      result.output = args[++i];
    }
  }

  return result;
}

function main() {
  const args = parseArgs();

  if (!args.version) {
    console.error("Error: --version is required");
    process.exit(1);
  }

  if (!args.platform || !PLATFORM_CONFIG[args.platform]) {
    console.error(
      `Error: --platform must be one of: ${Object.keys(PLATFORM_CONFIG).join(
        ", "
      )}`
    );
    process.exit(1);
  }

  const config = PLATFORM_CONFIG[args.platform];
  const outputDir = args.output;

  // Create output directory
  fs.mkdirSync(outputDir, { recursive: true });

  const collected = [];
  const missing = [];

  for (const artifactDef of config.artifacts) {
    let found = false;

    for (const searchPath of config.searchPaths) {
      const files = findFiles(searchPath, artifactDef.pattern);
      if (files.length > 0) {
        // Use the first match
        const sourcePath = files[0];
        const targetName = `${PRODUCT_NAME}_${args.version}${artifactDef.suffix}`;
        const targetPath = path.join(outputDir, targetName);

        fs.copyFileSync(sourcePath, targetPath);
        const stats = fs.statSync(targetPath);

        collected.push({
          name: targetName,
          path: targetPath,
          type: artifactDef.type,
          size: stats.size,
          originalPath: sourcePath,
        });

        console.log(
          `Collected: ${targetName} (${(stats.size / 1024 / 1024).toFixed(
            2
          )} MB)`
        );
        found = true;
        break;
      }
    }

    // Only report missing for required types (installer, updater)
    if (
      !found &&
      (artifactDef.type === "installer" || artifactDef.type === "updater")
    ) {
      // Signature files are optional
      if (artifactDef.type !== "signature") {
        missing.push(artifactDef.pattern.toString());
      }
    }
  }

  // Write manifest of collected assets
  const manifest = {
    version: args.version,
    platform: args.platform,
    assets: collected,
    collectedAt: new Date().toISOString(),
  };

  const manifestPath = path.join(outputDir, `manifest-${args.platform}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Manifest written to: ${manifestPath}`);

  if (missing.length > 0) {
    console.warn(`Warning: Some artifacts not found: ${missing.join(", ")}`);
  }

  if (collected.length === 0) {
    console.error("Error: No artifacts collected");
    process.exit(1);
  }

  console.log(`\nTotal: ${collected.length} artifacts collected`);
}

main();
