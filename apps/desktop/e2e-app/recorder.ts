import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Seen {
  host: string;
  method: string;
  path: string;
  status?: number;
  authorization?: string;
}

/** A pass-through proxy in front of the node that records what reaches it, with the Host each request carried. */
export async function startRecorder(nodeUrl: string): Promise<{ url: string; seen: Seen[]; close(): void }> {
  const node = new URL(nodeUrl);
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const entry: Seen = {
      host: req.headers.host ?? "",
      method: req.method ?? "",
      path: req.url ?? "",
      authorization: req.headers.authorization,
    };
    seen.push(entry);
    const upstream = request(
      { host: node.hostname, port: node.port, path: req.url, method: req.method, headers: req.headers },
      (r) => {
        entry.status = r.statusCode;
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    upstream.on("error", () => res.writeHead(502).end());
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://localhost:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => server.close(),
  };
}
