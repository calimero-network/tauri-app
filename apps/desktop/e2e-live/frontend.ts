import { request } from "node:http";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** The 52-character label of an application id (64 hex digits): its 32 bytes as unpadded base32. */
export function appLabel(appId: string): string {
  let label = "";
  let acc = 0;
  let bits = 0;
  for (const byte of Buffer.from(appId, "hex")) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      label += BASE32[(acc >> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  return bits > 0 ? label + BASE32[(acc << (5 - bits)) & 31] : label;
}

export interface Served {
  status: number;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * GET `path` of an app's frontend the way the desktop does: against the node's
 * address with `Host: {label}.localhost`, following redirects. `*.localhost`
 * is not resolved by every OS, so the connection goes to the node directly.
 */
export async function serveApp(label: string, nodeUrl: string, path = "/", method = "GET"): Promise<Served> {
  const node = new URL(nodeUrl);
  for (let hops = 0; hops <= 3; hops++) {
    const res = await new Promise<Served & { location?: string }>((resolve, reject) => {
      const req = request(
        { host: node.hostname, port: node.port, path, method, headers: { Host: `${label}.localhost:${node.port}` } },
        (r) => {
          const chunks: Buffer[] = [];
          r.on("data", (c: Buffer) => chunks.push(c));
          r.on("end", () =>
            resolve({
              status: r.statusCode ?? 0,
              path,
              headers: r.headers,
              body: Buffer.concat(chunks).toString("utf8"),
              location: r.headers.location,
            }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
    if (!res.location || res.status < 300 || res.status >= 400) return res;
    const next = new URL(res.location, `http://${label}.localhost:${node.port}`);
    path = next.pathname + next.search;
  }
  throw new Error(`${label}: more than 3 redirects from ${nodeUrl}`);
}

/** `calimero-app://{label}{landing path}` when the node serves the app's own frontend, as the shell's `app_bundled_frontend` answers. */
export async function bundledFrontend(appId: string, nodeUrl: string): Promise<string | null> {
  const label = appLabel(appId);
  const res = await serveApp(label, nodeUrl, "/", "HEAD");
  const csp = String(res.headers["content-security-policy"] ?? "");
  const ok = res.status >= 200 && res.status < 300 && csp.includes("default-src 'self'");
  return ok ? `calimero-app://${label}${res.path}` : null;
}
