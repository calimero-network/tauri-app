import { spawn, type ChildProcess } from "node:child_process";

const DRIVER = "http://127.0.0.1:4444";

/** tauri-driver, which launches the app under WebKitWebDriver; `env` is what the app inherits. */
export async function startDriver(env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const proc = spawn("tauri-driver", [], { stdio: "inherit", env });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${DRIVER}/status`)).ok) return proc;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill();
  throw new Error("tauri-driver did not start on 4444");
}

/** The few W3C WebDriver commands the app test needs, over plain HTTP. */
export class Session {
  private constructor(private readonly id: string) {}

  static async start(application: string): Promise<Session> {
    const body = { capabilities: { alwaysMatch: { "tauri:options": { application } } } };
    const value = await call<{ sessionId: string }>("POST", "/session", body);
    return new Session(value.sessionId);
  }

  private cmd<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    return call<T>(method, `/session/${this.id}${path}`, body);
  }

  end = () => this.cmd("DELETE", "");
  url = () => this.cmd<string>("GET", "/url");
  navigate = (url: string) => this.cmd("POST", "/url", { url });
  handles = () => this.cmd<string[]>("GET", "/window/handles");
  handle = () => this.cmd<string>("GET", "/window");
  switchTo = (handle: string) => this.cmd("POST", "/window", { handle });
  run = <T>(script: string, args: unknown[] = []) => this.cmd<T>("POST", "/execute/sync", { script, args });
  text = () => this.run<string>("return document.body ? document.body.innerText : ''");

  async find(selector: { css: string } | { xpath: string }): Promise<string | undefined> {
    const using = "css" in selector ? "css selector" : "xpath";
    const value = "css" in selector ? selector.css : selector.xpath;
    const found = await this.cmd<Record<string, string>[]>("POST", "/elements", { using, value });
    return found[0] && Object.values(found[0])[0];
  }

  click = (element: string) => this.cmd("POST", `/element/${element}/click`, {});
  type = (element: string, text: string) => this.cmd("POST", `/element/${element}/value`, { text });
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const resp = await fetch(`${DRIVER}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await resp.json()) as { value: T & { error?: string; message?: string } };
  if (!resp.ok) throw new Error(`${method} ${path} -> ${resp.status}: ${json.value.error}: ${json.value.message}`);
  return json.value;
}

/** Polls `probe` until it answers, naming `what` when it does not within `ms`. */
export async function until<T>(what: string, probe: () => Promise<T | undefined | false>, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await probe();
      if (v !== undefined && v !== false) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what} did not happen within ${ms}ms${last ? `: ${String(last)}` : ""}`);
}
