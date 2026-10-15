import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";

/** One release the local registry serves. */
export interface Release {
  package: string;
  version: string;
  path: string;
}

/**
 * Reads `manifest.json` out of a `.mpk` (a gzipped tar), for the package and
 * version the bundle declares. The registry must serve each release under the
 * coordinates its own manifest names: the node checks the bytes it fetched
 * against the coordinates it asked for.
 */
export function readRelease(path: string): Release {
  const tar = gunzipSync(readFileSync(path));
  for (let at = 0; at + 512 <= tar.length; ) {
    const name = tar.subarray(at, at + 100).toString("utf8").replace(/\0.*$/s, "");
    if (!name) break;
    const size = parseInt(tar.subarray(at + 124, at + 136).toString("utf8").replace(/\0.*$/s, "").trim() || "0", 8);
    const body = at + 512;
    if (name.replace(/^\.\//, "") === "manifest.json") {
      const manifest = JSON.parse(tar.subarray(body, body + size).toString("utf8"));
      const pkg = manifest.package as string | undefined;
      const version = (manifest.appVersion ?? manifest.app_version) as string | undefined;
      if (!pkg || !version) throw new Error(`${path}: manifest names no package or appVersion`);
      return { package: pkg, version, path };
    }
    at = body + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${path}: no manifest.json in the bundle`);
}

export interface LocalRegistry {
  url: string;
  close(): Promise<void>;
}

/**
 * The two routes a registry needs for an upgrade:
 *
 * - `GET /artifacts/{package}/{version}/{package}-{version}.mpk`, which every
 *   node fetches from its own `[registry] base_url`;
 * - `GET /api/v2/bundles?package=…`, the listing the desktop reads to find the
 *   newest published release.
 *
 * Served on 127.0.0.1: merod accepts plain http for a registry only on a local
 * or private address.
 */
export async function startRegistry(releases: Release[]): Promise<LocalRegistry> {
  const server: Server = createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://registry");

    if (req.method === "GET" && url.pathname === "/api/v2/bundles") {
      const pkg = url.searchParams.get("package");
      const list = releases
        .filter((r) => !pkg || r.package === pkg)
        .map((r) => ({ package: r.package, appVersion: r.version, yanked: false }));
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(list));
      return;
    }

    const artifact = url.pathname.match(/^\/artifacts\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (req.method === "GET" && artifact) {
      const [, pkg, version, file] = artifact;
      const release = releases.find(
        (r) => r.package === pkg && r.version === version && file === `${pkg}-${version}.mpk`,
      );
      if (release) {
        res.writeHead(200, { "Content-Type": "application/octet-stream" }).end(readFileSync(release.path));
        return;
      }
    }

    // The Marketplace records downloads; nothing here needs them.
    if (req.method === "POST" && url.pathname === "/api/v2/downloads/record") {
      res.writeHead(204).end();
      return;
    }

    res.writeHead(404).end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
