#!/usr/bin/env node
/**
 * Copy one platform's Tauri bundles into a staging directory under stable names
 * and write the manifest generate-manifests.cjs reads.
 *
 * Usage:
 *   node collect-assets.cjs --version 1.0.0 --platform macos --output release-assets/
 */

const fs = require("fs");
const path = require("path");
const { parseArgs } = require("util");

const { PLATFORM_CONFIG, PRODUCT_NAME } = require("./platforms.cjs");

function findFiles(dir, pattern) {
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

function main() {
  const { values: args } = parseArgs({
    options: {
      version: { type: "string" },
      platform: { type: "string" },
      output: { type: "string", default: "release-assets" },
    },
  });

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

  fs.mkdirSync(outputDir, { recursive: true });

  const collected = [];
  const missing = [];

  for (const artifactDef of config.artifacts) {
    let found = false;

    for (const searchPath of config.searchPaths) {
      const files = findFiles(searchPath, artifactDef.pattern);
      if (files.length > 0) {
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

    // Signatures are optional; a missing installer or updater is worth saying.
    if (
      !found &&
      (artifactDef.type === "installer" || artifactDef.type === "updater")
    ) {
      missing.push(artifactDef.pattern.toString());
    }
  }

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
