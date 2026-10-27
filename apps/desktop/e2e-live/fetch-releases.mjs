#!/usr/bin/env node
// Downloads the three newest releases of PACKAGE that MEROD_VERSION can run, for
// the live upgrade suite (LIVE_BUNDLE_DIR). Two releases of one package from
// one publisher share an application id, which is what an upgrade needs.
//
//   REGISTRY_URL   default https://apps.calimero.network
//   PACKAGE        default com.calimero.kv-store
//   MEROD_VERSION  required: releases whose minRuntimeVersion is above it are skipped
//   OUT_DIR        required: where the three .mpk files go
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const registry = (process.env.REGISTRY_URL ?? "https://apps.calimero.network").replace(/\/+$/, "");
const pkg = process.env.PACKAGE ?? "com.calimero.kv-store";
const merod = process.env.MEROD_VERSION;
const out = process.env.OUT_DIR;
if (!merod || !out) {
  console.error("set MEROD_VERSION and OUT_DIR");
  process.exit(2);
}

// Semver precedence, pre-releases included (0.11.0-rc.9 < 0.11.0-rc.10 < 0.11.0).
function cmp(a, b) {
  const parse = (v) => {
    const [core, pre = ""] = v.replace(/^v/, "").split("+")[0].split(/-(.*)/s);
    return { core: core.split(".").map(Number), pre: pre ? pre.split(".") : [] };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.core[i] ?? 0) !== (y.core[i] ?? 0)) return (x.core[i] ?? 0) - (y.core[i] ?? 0);
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

const listUrl = `${registry}/api/v2/bundles?package=${encodeURIComponent(pkg)}&all_versions=true`;
const resp = await fetch(listUrl);
if (!resp.ok) throw new Error(`GET ${listUrl} -> ${resp.status}`);
const bundles = await resp.json();

const runnable = [
  ...new Set(
    (Array.isArray(bundles) ? bundles : [])
      .filter((b) => b.package === pkg && !b.yanked && typeof b.appVersion === "string")
      .filter((b) => !b.minRuntimeVersion || cmp(b.minRuntimeVersion, merod) <= 0)
      .map((b) => b.appVersion),
  ),
].sort((a, b) => cmp(b, a));

if (runnable.length < 3) {
  throw new Error(`${pkg}: need three releases merod ${merod} can run, the registry lists ${runnable.join(", ") || "none"}`);
}

mkdirSync(out, { recursive: true });
for (const version of runnable.slice(0, 3)) {
  const url = `${registry}/artifacts/${pkg}/${version}/${pkg}-${version}.mpk`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  const bytes = Buffer.from(await r.arrayBuffer());
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new Error(`${url} is not a gzipped bundle`);
  const file = path.join(out, `${pkg}-${version}.mpk`);
  writeFileSync(file, bytes);
  console.log(`${pkg} ${version} -> ${file} (${bytes.length} bytes)`);
}
