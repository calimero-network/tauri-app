import { mkdtempSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareSemverDesc } from "../src/utils/registry";
import { readRelease, startRegistry, type Release } from "./registry";
import { recordedPids, resolveMerod, startNodes, stopNodes, type LiveNode } from "./nodes";

/**
 * Three releases of one application, a registry serving them, and three nodes.
 *
 * Bundles come from `LIVE_BUNDLES` (comma-separated `.mpk` paths) or every
 * `.mpk` in `LIVE_BUNDLE_DIR`. They must be releases of one package from
 * one signer, so they share an application id: CI downloads the three newest
 * published releases of kv-store. The older is what the namespace starts on;
 * the newer is what it upgrades to, and the middle one lies between for a
 * spec that upgrades in two steps.
 *
 * `LIVE_FRONTEND_BUNDLE` and `LIVE_PLAIN_BUNDLE` are single releases of two more
 * packages (the app with its frontend in the bundle, and without) for the
 * bundled-frontend spec; the registry serves them like the others.
 *
 * What the spec needs is handed over in `process.env`, which Playwright passes
 * to its workers: `LIVE_STATE` is the JSON of `LiveState`.
 */
export interface AppRelease {
  package: string;
  version: string;
}

export interface LiveState {
  registryUrl: string;
  package: string;
  older: string;
  middle?: string;
  newer: string;
  frontend?: AppRelease;
  plain?: AppRelease;
  merod: string;
  nodes: LiveNode[];
}

function bundlePaths(): string[] {
  const list = process.env["LIVE_BUNDLES"];
  if (list) return list.split(",").map((p) => p.trim()).filter(Boolean);
  const dir = process.env["LIVE_BUNDLE_DIR"];
  if (dir) return readdirSync(dir).filter((f) => f.endsWith(".mpk")).map((f) => path.join(dir, f));
  throw new Error("set LIVE_BUNDLES or LIVE_BUNDLE_DIR to releases of one application");
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

  const extra = (name: string): Release | undefined => {
    const file = process.env[name];
    return file ? readRelease(file) : undefined;
  };
  const frontend = extra("LIVE_FRONTEND_BUNDLE");
  const plain = extra("LIVE_PLAIN_BUNDLE");

  const registry = await startRegistry([...releases, ...(frontend ? [frontend] : []), ...(plain ? [plain] : [])]);
  const dataDir = process.env["LIVE_DATA_DIR"] ?? mkdtempSync(path.join(os.tmpdir(), "desktop-live-e2e-"));
  const merod = resolveMerod();
  const nodes = await startNodes({
    merod,
    dataDir,
    // An admin, a member, and a third that only replicates: a high-availability node.
    count: 3,
    registryUrl: registry.url,
  });

  const state: LiveState = {
    registryUrl: registry.url,
    package: newer.package,
    older: older.version,
    middle: releases.length > 2 ? releases[1]!.version : undefined,
    newer: newer.version,
    frontend: frontend && { package: frontend.package, version: frontend.version },
    plain: plain && { package: plain.package, version: plain.version },
    merod,
    nodes,
  };
  process.env["LIVE_STATE"] = JSON.stringify(state);

  return async () => {
    await stopNodes(recordedPids(dataDir));
    await registry.close();
  };
}
