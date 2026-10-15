import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import path from "node:path";
import { readTomlString, setTomlKey } from "./toml";

/**
 * Real merod nodes for the live suite, after calimero-network/apps'
 * `packages/e2e-node` rig: embedded auth with a known admin login, peered
 * through the first node, and every node pointed at the same local registry.
 */

export const ADMIN_USER = "admin";
export const ADMIN_PASSWORD = "adminadmin";
export const ACCESS_TOKEN_TTL_S = 5; // short, so a session outlives its access token within one test
export const JWT_LEEWAY_S = 60; // core accepts and refuses to refresh a token this long past its expiry

export interface LiveNode {
  name: string;
  home: string;
  url: string;
  serverPort: number;
  swarmPort: number;
  log: string;
  pid: number;
}

export function resolveMerod(): string {
  const fromEnv = process.env["MEROD_BINARY"];
  if (fromEnv) return fromEnv;
  const local = path.join(process.env["HOME"] ?? "", ".local", "merod", "merod");
  if (existsSync(local)) return local;
  throw new Error(
    "no merod binary: set MEROD_BINARY (the version merod-config.json pins is what the desktop ships)",
  );
}

export function nodeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["MERO_AUTH_ADMIN_USER"];
  delete env["MERO_AUTH_ADMIN_PASSWORD"];
  return { ...env, RUST_LOG: process.env["LIVE_RUST_LOG"] ?? "merod=info,calimero_=info" };
}

export function configPath(node: Pick<LiveNode, "home" | "name">): string {
  return path.join(node.home, node.name, "config.toml");
}

async function healthy(url: string): Promise<boolean> {
  try {
    return (await fetch(`${url}/admin-api/health`)).ok;
  } catch {
    return false;
  }
}

export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined | false>,
  timeoutMs: number,
  intervalMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await probe();
      if (v !== undefined && v !== false) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`${what} did not happen within ${timeoutMs}ms${last ? `: ${String(last)}` : ""}`);
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
}

/** An admin session on `url`, as the desktop's login would get one. */
export async function mintTokens(url: string): Promise<TokenPair> {
  const resp = await fetch(`${url}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      auth_method: "user_password",
      public_key: randomBytes(32).toString("base64"),
      client_name: "desktop-live-e2e",
      timestamp: Date.now(),
      permissions: ["admin"],
      provider_data: { username: ADMIN_USER, password: ADMIN_PASSWORD },
    }),
  });
  if (!resp.ok) throw new Error(`POST ${url}/auth/token -> ${resp.status}: ${await resp.text()}`);
  const body = (await resp.json()) as { data?: TokenPair } & Partial<TokenPair>;
  const pair = body.data ?? (body as TokenPair);
  if (!pair.access_token || !pair.refresh_token) throw new Error(`POST ${url}/auth/token returned no token pair`);
  return pair;
}

async function peerCount(url: string, token: string): Promise<number> {
  const resp = await fetch(`${url}/admin-api/peers`, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) return 0;
  const body = (await resp.json()) as { data?: { count?: number }; count?: number };
  return Number(body.data?.count ?? body.count ?? 0);
}

export function swarmAddr(port: number, peerId: string): string {
  return `/ip4/127.0.0.1/tcp/${port}/p2p/${peerId}`;
}

/** Peers only with this run's nodes, and syncs fast: the suite's network, not the public one. */
export function isolateNetwork(toml: string, bootstrap: string[], rendezvous: string): string {
  toml = setTomlKey(toml, "bootstrap", "nodes", bootstrap);
  toml = setTomlKey(toml, "discovery", "mdns", true);
  toml = setTomlKey(toml, "discovery.rendezvous", "namespace", rendezvous);
  toml = setTomlKey(toml, "sync", "interval_ms", 500);
  return setTomlKey(toml, "sync", "frequency_ms", 1000);
}

/** Runs an initialised node detached, logging to `log`, and returns its pid. */
export function spawnMerod(merod: string, n: Pick<LiveNode, "home" | "name" | "log">): number {
  const out = openSync(n.log, "a");
  const proc = spawn(merod, ["--home", n.home, "--node", n.name, "run"], {
    stdio: ["ignore", out, out],
    env: nodeEnv(),
    detached: true,
  });
  proc.unref();
  if (!proc.pid) throw new Error(`could not start ${n.name}`);
  return proc.pid;
}

/** Ports the OS hands out as free, all held at once so no two are the same. */
export async function freePorts(count: number): Promise<number[]> {
  const servers = Array.from({ length: count }, () => createServer());
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve))));
  const ports = servers.map((s) => (s.address() as AddressInfo).port);
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  return ports;
}

export async function startNodes(opts: {
  merod: string;
  dataDir: string;
  count: number;
  registryUrl: string;
}): Promise<LiveNode[]> {
  rmSync(opts.dataDir, { recursive: true, force: true });
  mkdirSync(opts.dataDir, { recursive: true });
  const rendezvous = `/calimero/desktop-live/${randomBytes(4).toString("hex")}`;
  const ports = await freePorts(opts.count * 2);

  const planned = Array.from({ length: opts.count }, (_, i) => {
    const name = `live-${i + 1}`;
    const serverPort = ports[i * 2]!;
    return {
      name,
      home: path.join(opts.dataDir, name),
      serverPort,
      swarmPort: ports[i * 2 + 1]!,
      url: `http://127.0.0.1:${serverPort}`,
      log: path.join(opts.dataDir, `${name}.log`),
    };
  });

  const peerIds = planned.map((n) => {
    mkdirSync(n.home, { recursive: true });
    const passwordFile = path.join(n.home, "admin-password");
    writeFileSync(passwordFile, ADMIN_PASSWORD);
    execFileSync(
      opts.merod,
      [
        "--home", n.home,
        "--node", n.name,
        "init",
        "--server-host", "127.0.0.1",
        "--server-port", String(n.serverPort),
        "--swarm-host", "0.0.0.0",
        "--swarm-port", String(n.swarmPort),
        "--auth-mode", "embedded",
        "--auth-storage", "persistent",
        "--admin-user", ADMIN_USER,
        "--admin-password-file", passwordFile,
      ],
      { stdio: "pipe", env: nodeEnv() },
    );
    const peerId = readTomlString(readFileSync(configPath(n), "utf8"), "identity", "peer_id");
    if (!peerId) throw new Error(`no [identity] peer_id in ${configPath(n)}`);
    return peerId;
  });

  planned.forEach((n, i) => {
    let toml = readFileSync(configPath(n), "utf8");
    toml = isolateNetwork(
      toml,
      i === 0 ? [] : [swarmAddr(planned[0]!.swarmPort, peerIds[0]!)],
      rendezvous,
    );
    // Every node resolves releases from the suite's registry, as a member's
    // node resolves them from its own.
    toml = setTomlKey(toml, "registry", "mode", "http");
    toml = setTomlKey(toml, "registry", "base_url", opts.registryUrl);
    toml = setTomlKey(toml, "server.embedded_auth.jwt", "access_token_expiry", ACCESS_TOKEN_TTL_S);
    writeFileSync(configPath(n), toml);
  });

  const nodes: LiveNode[] = [];
  try {
    for (const n of planned) nodes.push({ ...n, pid: spawnMerod(opts.merod, n) });
    for (const node of nodes) {
      await waitFor(`${node.name} healthy on ${node.url}`, () => healthy(node.url), 60_000);
    }
    if (nodes.length > 1) {
      for (const node of nodes) {
        const { access_token } = await mintTokens(node.url);
        await waitFor(`${node.name} connected to a peer`, async () => (await peerCount(node.url, access_token)) > 0, 60_000);
      }
    }
    return nodes;
  } catch (e) {
    await stopNodes(nodes.map((n) => n.pid));
    const logs = nodes
      .map((n) => {
        try {
          return `--- ${n.name} (tail)\n${readFileSync(n.log, "utf8").split("\n").slice(-40).join("\n")}`;
        } catch {
          return `--- ${n.name}: no log`;
        }
      })
      .join("\n");
    throw new Error(`${e instanceof Error ? e.message : String(e)}\n${logs}`);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** SIGTERM, then SIGKILL whatever is still up after 10s. */
export async function stopNodes(pids: number[]): Promise<void> {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  const deadline = Date.now() + 10_000;
  while (pids.some(alive) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  for (const pid of pids.filter(alive)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}
