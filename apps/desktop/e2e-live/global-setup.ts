import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareSemverDesc } from "../src/utils/registry";
import { readRelease, startRegistry, type Release } from "./registry";
import { resolveMerod, startNodes, stopNodes } from "./nodes";

/**
 * Two releases of one application, a registry serving them, and two nodes.
 *
 * Bundles come from `LIVE_BUNDLES` (comma-separated `.mpk` paths) or every
 * `.mpk` in `LIVE_BUNDLE_DIR`. They must be two releases of one package from
 * one signer, so they share an application id: CI downloads the two newest
 * published releases of kv-store. The older is what the namespace starts on;
 * the newer is what it upgrades to.
 *
 * What the spec needs is handed over in `process.env`, which Playwright passes
 * to its workers: `LIVE_STATE` is the JSON of `LiveState`.
 */
export interface LiveState {
  registryUrl: string;
  package: string;
  older: string;
  newer: string;
  nodes: { name: string; url: string; log: string }[];
}

function bundlePaths(): string[] {
  const list = process.env["LIVE_BUNDLES"];
  if (list) return list.split(",").map((p) => p.trim()).filter(Boolean);
  const dir = process.env["LIVE_BUNDLE_DIR"];
  if (dir) return readdirSync(dir).filter((f) => f.endsWith(".mpk")).map((f) => path.join(dir, f));
  throw new Error("set LIVE_BUNDLES or LIVE_BUNDLE_DIR to two releases of one application");
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const releases: Release[] = bundlePaths().map(readRelease);
  const packages = new Set(releases.map((r) => r.package));
  if (releases.length < 2 || packages.size !== 1) {
    throw new Error(
      `need two releases of ONE package, got ${releases.map((r) => `${r.package}@${r.version}`).join(", ")}`,
    );
  }
  releases.sort((a, b) => compareSemverDesc(a.version, b.version));
  const newer = releases[0]!;
  const older = releases[releases.length - 1]!;
  if (newer.version === older.version) throw new Error(`both bundles are ${older.version}`);

  const registry = await startRegistry([older, newer]);
  const dataDir = process.env["LIVE_DATA_DIR"] ?? path.join(os.tmpdir(), "desktop-live-e2e");
  const nodes = await startNodes({
    merod: resolveMerod(),
    dataDir,
    count: 2,
    basePort: Number(process.env["LIVE_BASE_PORT"]) || 2840,
    registryUrl: registry.url,
  });

  const state: LiveState = {
    registryUrl: registry.url,
    package: newer.package,
    older: older.version,
    newer: newer.version,
    nodes: nodes.map((n) => ({ name: n.name, url: n.url, log: n.log })),
  };
  process.env["LIVE_STATE"] = JSON.stringify(state);

  return async () => {
    await stopNodes(nodes.map((n) => n.pid));
    await registry.close();
  };
}
