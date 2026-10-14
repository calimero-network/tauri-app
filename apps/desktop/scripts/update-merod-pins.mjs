// Rewrites the sha256 pins in merod-config.json from the release it names.
// Run after changing `version`; CI fails when the committed pins differ.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  configPath,
  downloadToFile,
  fetchRelease,
  isMerodAsset,
  readConfig,
  sha256File,
} from "./merod-release.mjs";

async function main() {
  const config = await readConfig();
  const release = await fetchRelease(config.version);
  const assets = release.assets
    .filter((asset) => isMerodAsset(asset.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (assets.length === 0) {
    throw new Error(`${release.tag_name} has no merod assets to pin`);
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "merod-pins-"));
  try {
    const sha256 = {};
    for (const asset of assets) {
      const file = path.join(tempDir, asset.name);
      await downloadToFile(asset.browser_download_url, file);
      sha256[asset.name] = await sha256File(file);
      console.log(`[merod] ${asset.name} ${sha256[asset.name]}`);
    }
    config.sha256 = sha256;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  await fs.writeFile(configPath, `${JSON.stringify(config, null, 4)}\n`);
}

main().catch((error) => {
  console.error(`[merod] ${error.message}`);
  process.exit(1);
});
