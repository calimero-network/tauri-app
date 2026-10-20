import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BrowserContext } from "@playwright/test";
import { readTomlString, setTomlKey } from "./toml";
import { configPath, isolateNetwork, nodeEnv, spawnMerod, stopNodes, swarmAddr } from "./nodes";

/**
 * The desktop's Rust node commands, done in Node for a browser session: the
 * same `merod init` and `merod run` the shell runs, but only under `root`.
 * Any other command fails as it does in a plain browser.
 */

interface BridgeNode {
  home: string;
  name: string;
  serverPort: number;
  swarmPort: number;
  log: string;
  pid: number;
}

type Args = Record<string, unknown>;

const DEFAULT_NODE = /^http:\/\/(localhost|127\.0\.0\.1):2528\//; // the desktop's default node, which on a dev machine is a real one

export class NodeBridge {
  private readonly nodes: BridgeNode[] = [];
  private readonly rendezvous = `/calimero/desktop-live/${randomBytes(4).toString("hex")}`;

  constructor(
    private readonly merod: string,
    readonly root: string,
  ) {}

  /** Answers `invoke` in every page of `context` from this bridge. */
  async attach(context: BrowserContext): Promise<void> {
    // First launch probes the default port; refuse it as a fresh machine would, so a local run matches CI.
    await context.route(DEFAULT_NODE, (route) => route.abort("connectionrefused"));
    await context.exposeBinding("__nodeBridge", (_source, cmd: string, args: Args) => this.invoke(cmd, args ?? {}));
    await context.addInitScript(() => {
      const bridge = (window as unknown as { __nodeBridge: (cmd: string, args: unknown) => Promise<unknown> }).__nodeBridge;
      (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        transformCallback: (cb: unknown) => cb,
        invoke: (cmd: string, args: unknown) => bridge(cmd, args),
      };
    });
  }

  /** The admin URL of the node a desktop created under `<root>/<label>`. */
  url(label: string): string {
    const node = this.nodes.find((n) => n.home === path.join(this.root, label));
    if (!node) throw new Error(`no node under ${label}`);
    return `http://127.0.0.1:${node.serverPort}`;
  }

  stop(): Promise<void> {
    return stopNodes(this.nodes.map((n) => n.pid));
  }

  private invoke(cmd: string, args: Args): Promise<unknown> | unknown {
    switch (cmd) {
      case "list_merod_nodes":
        return this.listNodes(this.home(args["homeDir"]));
      case "init_merod_node":
        return this.init(args);
      case "start_merod":
        return this.start(args);
      case "detect_running_merod_nodes":
        return this.nodes.map((n) => ({
          pid: n.pid,
          node_name: n.name,
          port: n.serverPort,
          swarm_port: n.swarmPort,
          home_dir: n.home,
          exe: this.merod,
          owned: true,
        }));
      case "check_merod_health":
        return health(String(args["nodeUrl"]));
      case "get_merod_binary_version":
        // `merod --version` prints "merod <version> (build ...)".
        return execFileSync(this.merod, ["--version"], { encoding: "utf8" }).split(" ")[1];
      default:
        throw new Error(`${cmd} is not available in the browser`);
    }
  }

  /** The only directory a node may live in; the default ~/.calimero is refused. */
  private home(dir: unknown): string {
    const home = path.resolve(String(dir ?? ""));
    if (!home.startsWith(this.root + path.sep)) throw new Error(`${String(dir)} is outside the test's data dir`);
    return home;
  }

  private listNodes(home: string): string[] {
    if (!existsSync(home)) return [];
    return readdirSync(home).filter((name) => existsSync(configPath({ home, name })));
  }

  private init(args: Args): string {
    const home = this.home(args["homeDir"]);
    const name = String(args["nodeName"]);
    execFileSync(this.merod, ["--home", home, "--node", name, "init", "--auth-mode", "embedded"], {
      stdio: "pipe",
      env: {
        ...nodeEnv(),
        MERO_AUTH_ADMIN_USER: String(args["adminUser"]),
        MERO_AUTH_ADMIN_PASSWORD: String(args["adminPassword"]),
      },
    });
    return `Node '${name}' initialized successfully`;
  }

  /** Listens where the desktop asked, and peers with the nodes this bridge started before it. */
  private start(args: Args): string {
    const home = this.home(args["dataDir"]);
    const name = String(args["nodeName"]);
    const running = this.nodes.find((n) => n.home === home && n.name === name);
    if (running) return `Merod already running with PID: ${running.pid}`;

    const serverPort = Number(args["serverPort"]);
    const swarmPort = Number(args["swarmPort"]);
    const file = configPath({ home, name });
    let toml = readFileSync(file, "utf8");
    toml = setTomlKey(toml, "server", "listen", [`/ip4/127.0.0.1/tcp/${serverPort}`, `/ip6/::1/tcp/${serverPort}`]);
    toml = setTomlKey(toml, "swarm", "listen", [
      `/ip4/0.0.0.0/tcp/${swarmPort}`,
      `/ip4/0.0.0.0/udp/${swarmPort}/quic-v1`,
    ]);
    const peers = this.nodes.map((n) => {
      const peerId = readTomlString(readFileSync(configPath(n), "utf8"), "identity", "peer_id");
      return swarmAddr(n.swarmPort, peerId ?? "");
    });
    writeFileSync(file, isolateNetwork(toml, peers, this.rendezvous));

    const node = { home, name, serverPort, swarmPort, log: path.join(this.root, `${path.basename(home)}.log`) };
    const pid = spawnMerod(this.merod, node);
    this.nodes.push({ ...node, pid });
    return `Merod started with PID: ${pid}`;
  }
}

async function health(nodeUrl: string) {
  try {
    const resp = await fetch(`${nodeUrl.replace(/\/$/, "")}/health`);
    return { status: resp.status, healthy: resp.ok, body: await resp.text() };
  } catch (e) {
    return { status: 0, healthy: false, body: `Request failed: ${String(e)}` };
  }
}
