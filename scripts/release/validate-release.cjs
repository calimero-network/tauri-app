#!/usr/bin/env node
/**
 * Validate release artifacts and manifests.
 * 
 * Usage:
 *   node validate-release.js --version 1.0.0 --repo owner/repo [--check-urls]
 * 
 * Validates:
 * 1. latest.json structure and platform entries
 * 2. release.json structure and download entries
 * 3. Signature presence for updater assets
 * 4. (optional) URL accessibility for all download links
 */

const fs = require("fs");
const path = require("path");

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {
    version: null,
    repo: null,
    assetsDir: "release-assets",
    checkUrls: false,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--version" && args[i + 1]) {
      result.version = args[++i];
    } else if (args[i] === "--repo" && args[i + 1]) {
      result.repo = args[++i];
    } else if (args[i] === "--assets" && args[i + 1]) {
      result.assetsDir = args[++i];
    } else if (args[i] === "--check-urls") {
      result.checkUrls = true;
    }
  }

  return result;
}

function validateLatestJson(filePath) {
  const errors = [];
  const warnings = [];

  if (!fs.existsSync(filePath)) {
    errors.push(`latest.json not found at ${filePath}`);
    return { errors, warnings };
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    errors.push(`Invalid JSON in latest.json: ${e.message}`);
    return { errors, warnings };
  }

  // Check required fields
  if (!manifest.version) {
    errors.push("latest.json missing 'version' field");
  } else if (!manifest.version.startsWith("v")) {
    warnings.push(
      `latest.json version should start with 'v', got: ${manifest.version}`
    );
  }

  if (!manifest.pub_date) {
    errors.push("latest.json missing 'pub_date' field");
  }

  if (!manifest.platforms || typeof manifest.platforms !== "object") {
    errors.push("latest.json missing or invalid 'platforms' field");
    return { errors, warnings };
  }

  // Check that at least one platform exists
  const platformCount = Object.keys(manifest.platforms).length;
  if (platformCount === 0) {
    errors.push("latest.json has no platform entries");
    return { errors, warnings };
  }

  // Validate all platform entries that exist (all platforms are optional for partial releases)
  for (const platform of Object.keys(manifest.platforms)) {
    const entry = manifest.platforms[platform];

    if (!entry.url) {
      errors.push(`latest.json platform ${platform} missing 'url'`);
    }
    if (!entry.signature) {
      warnings.push(`latest.json platform ${platform} missing 'signature'`);
    }
  }

  return { errors, warnings, manifest };
}

function validateReleaseJson(filePath) {
  const errors = [];
  const warnings = [];

  if (!fs.existsSync(filePath)) {
    warnings.push(`release.json not found at ${filePath} (download site will use GitHub API fallback)`);
    return { errors, warnings };
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    errors.push(`Invalid JSON in release.json: ${e.message}`);
    return { errors, warnings };
  }

  // Check required fields
  if (!manifest.version) {
    errors.push("release.json missing 'version' field");
  }

  if (!manifest.publishedAt) {
    warnings.push("release.json missing 'publishedAt' field");
  }

  if (!manifest.downloads || !Array.isArray(manifest.downloads)) {
    errors.push("release.json missing or invalid 'downloads' array");
    return { errors, warnings };
  }

  if (manifest.downloads.length === 0) {
    errors.push("release.json has empty 'downloads' array");
  }

  // Check download entries
  for (const download of manifest.downloads) {
    if (!download.os) {
      errors.push(`release.json download missing 'os': ${JSON.stringify(download)}`);
    }
    if (!download.url) {
      errors.push(`release.json download missing 'url': ${download.filename || "unknown"}`);
    }
    if (!download.filename) {
      warnings.push(`release.json download missing 'filename': ${download.url || "unknown"}`);
    }
  }

  // Check for at least one primary download
  const hasPrimary = manifest.downloads.some((d) => d.primary);
  if (!hasPrimary) {
    warnings.push("release.json has no primary downloads marked");
  }

  return { errors, warnings, manifest };
}

async function checkUrl(url) {
  try {
    const response = await fetch(url, { method: "HEAD" });
    return { ok: response.ok, status: response.status };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}

async function validateUrls(latestManifest, releaseManifest) {
  const results = [];

  // Check latest.json URLs
  if (latestManifest?.platforms) {
    for (const [platform, entry] of Object.entries(latestManifest.platforms)) {
      if (entry.url) {
        const result = await checkUrl(entry.url);
        results.push({
          source: "latest.json",
          platform,
          url: entry.url,
          ...result,
        });
      }
    }
  }

  // Check release.json URLs
  if (releaseManifest?.downloads) {
    for (const download of releaseManifest.downloads) {
      if (download.url) {
        const result = await checkUrl(download.url);
        results.push({
          source: "release.json",
          platform: download.os,
          format: download.format,
          url: download.url,
          ...result,
        });
      }
    }
  }

  return results;
}

async function main() {
  const args = parseArgs();
  let hasErrors = false;

  console.log("Release Validation\n");
  console.log(`Version: ${args.version || "not specified"}`);
  console.log(`Assets: ${args.assetsDir}`);
  console.log(`URL Check: ${args.checkUrls ? "enabled" : "disabled"}\n`);

  // Validate latest.json
  console.log("Validating latest.json...");
  const latestPath = path.join(args.assetsDir, "latest.json");
  const latestResult = validateLatestJson(latestPath);

  for (const error of latestResult.errors) {
    console.log(`  ERROR: ${error}`);
    hasErrors = true;
  }
  for (const warning of latestResult.warnings) {
    console.log(`  WARN: ${warning}`);
  }
  if (latestResult.errors.length === 0) {
    console.log("  OK: latest.json is valid");
  }

  // Validate release.json
  console.log("\nValidating release.json...");
  const releasePath = path.join(args.assetsDir, "release.json");
  const releaseResult = validateReleaseJson(releasePath);

  for (const error of releaseResult.errors) {
    console.log(`  ERROR: ${error}`);
    hasErrors = true;
  }
  for (const warning of releaseResult.warnings) {
    console.log(`  WARN: ${warning}`);
  }
  if (releaseResult.errors.length === 0 && !releaseResult.warnings.some(w => w.includes("not found"))) {
    console.log("  OK: release.json is valid");
  }

  // Validate URLs
  if (args.checkUrls) {
    console.log("\nValidating download URLs...");
    const urlResults = await validateUrls(latestResult.manifest, releaseResult.manifest);

    for (const result of urlResults) {
      const status = result.ok ? "OK" : "FAIL";
      const details = result.error || `HTTP ${result.status}`;
      console.log(`  ${status}: [${result.source}] ${result.platform} ${result.format || ""} - ${details}`);
      if (!result.ok) {
        console.log(`       URL: ${result.url}`);
        hasErrors = true;
      }
    }
  }

  // Summary
  console.log("\n" + "=".repeat(50));
  if (hasErrors) {
    console.log("VALIDATION FAILED - See errors above");
    process.exit(1);
  } else {
    console.log("VALIDATION PASSED");
  }
}

main().catch((e) => {
  console.error("Validation failed:", e);
  process.exit(1);
});
