import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read the proxy script source once; tests replace the placeholder node URL.
const RAW_PROXY_SCRIPT = readFileSync(
  path.resolve(__dirname, "../../src-tauri/src/proxy_script.js"),
  "utf-8"
);

// The script runs in a webview, where ProgressEvent is a browser global. The
// vitest environment is `node`, which has Event but not ProgressEvent — so the
// XHR path would ReferenceError here for reasons that never occur in the app.
if (typeof (globalThis as any).ProgressEvent === "undefined") {
  (globalThis as any).ProgressEvent = class ProgressEvent extends Event {};
}

/**
 * Execute the proxy IIFE with a fake `window` object.
 * Using `new Function('window', src)` means all `window.*` accesses inside
 * the IIFE resolve to our mock; bare globals (URL, Headers, Response, …) are
 * still resolved from the Node 18+ global scope.
 */
function injectProxy(mockWindow: any, nodeUrl = "http://localhost:2428") {
  const src = RAW_PROXY_SCRIPT.replace("__CONFIGURED_NODE_URL__", nodeUrl);
  new Function("window", src)(mockWindow);
}

function makeMockWindow(pageProtocol = "https:") {
  // Minimal XMLHttpRequest stub. The script wraps open/send/setRequestHeader and
  // dispatches events on the instance, so those must exist for it to wrap them.
  function FakeXHR(this: any) {
    this.onload = null;
    this.onerror = null;
    this.onreadystatechange = null;
  }
  FakeXHR.prototype = {
    open() {},
    send() {},
    setRequestHeader() {},
    dispatchEvent() {},
    addEventListener() {},
  };
  return {
    __TAURI_FETCH_PROXY_INJECTED__: undefined as boolean | undefined,
    // The proxy only runs on HTTPS-hosted pages (mixed-content bypass);
    // default the mock to an HTTPS page so proxy-path tests exercise it.
    location: { protocol: pageProtocol },
    // Stored by the script as `originalFetch` — returned for non-proxied URLs.
    fetch: vi.fn().mockResolvedValue(new Response("original", { status: 200 })),
    XMLHttpRequest: FakeXHR,
  } as any;
}

describe("proxy_script SSE routing", () => {
  // Ensure each test gets a fresh injection (the script guards against
  // double-injection via __TAURI_FETCH_PROXY_INJECTED__).
  beforeEach(() => {});

  it("routes SSE fetch through Tauri IPC and returns a ReadableStream Response", async () => {
    const mockWindow = makeMockWindow();

    // Capture event.listen callbacks by event name so we can fire them later.
    const chunkCbs: Record<string, (e: { payload: string }) => void> = {};
    const endCbs: Record<string, () => void> = {};
    const invoked: Array<{ command: string; args: Record<string, unknown> }> =
      [];

    mockWindow.__TAURI__ = {
      event: {
        listen: vi.fn(async (eventName: string, cb: any) => {
          if (eventName.startsWith("sse-chunk-")) chunkCbs[eventName] = cb;
          if (eventName.startsWith("sse-end-")) endCbs[eventName] = cb;
          return vi.fn(); // unlisten no-op
        }),
      },
    };
    // __TAURI_INVOKE__ is also checked by getTauriInvoke()
    mockWindow.__TAURI_INVOKE__ = vi.fn(
      async (command: string, args: Record<string, unknown>) => {
        invoked.push({ command, args });
        // Never settles — simulates an ongoing Rust SSE stream.
        return new Promise<void>(() => {});
      }
    );

    injectProxy(mockWindow);

    // Kick off an SSE fetch; the interceptor must return before we read.
    const response = await mockWindow.fetch(
      "http://localhost:2428/admin-api/contexts/sse",
      { headers: { Accept: "text/event-stream" } }
    );

    // --- structural assertions -----------------------------------------------
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(invoked.some((c) => c.command === "proxy_sse_stream")).toBe(true);

    const chunkKey = Object.keys(chunkCbs)[0];
    const endKey = Object.keys(endCbs)[0];
    expect(chunkKey).toBeDefined();
    expect(endKey).toBeDefined();

    // The stream_id embedded in the event names must match.
    expect(chunkKey.replace("sse-chunk-", "")).toBe(
      endKey.replace("sse-end-", "")
    );

    // --- streaming assertions -------------------------------------------------
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();

    // Simulate Rust emitting two SSE chunks via window events.
    chunkCbs[chunkKey]({ payload: "data: hello\n\n" });
    chunkCbs[chunkKey]({ payload: "data: world\n\n" });

    const chunk1 = await reader.read();
    expect(chunk1.done).toBe(false);
    expect(decoder.decode(chunk1.value, { stream: true })).toBe(
      "data: hello\n\n"
    );

    const chunk2 = await reader.read();
    expect(chunk2.done).toBe(false);
    expect(decoder.decode(chunk2.value, { stream: true })).toBe(
      "data: world\n\n"
    );

    // Simulate stream end — ReadableStream should close.
    endCbs[endKey]();
    const final = await reader.read();
    expect(final.done).toBe(true);
  });

  it("does not invoke Tauri IPC for non-localhost requests", async () => {
    const mockWindow = makeMockWindow();
    mockWindow.__TAURI_INVOKE__ = vi.fn();
    mockWindow.__TAURI__ = {
      event: { listen: vi.fn(async () => vi.fn()) },
    };

    injectProxy(mockWindow);

    // External HTTPS URL — must not go through the proxy.
    await mockWindow.fetch("https://api.example.com/data", {});
    expect(mockWindow.__TAURI_INVOKE__).not.toHaveBeenCalled();
  });

  it("does not invoke Tauri IPC when the page itself is plain HTTP (e.g. the node's auth page)", async () => {
    // Pages served over http:// (like http://localhost:2528/auth/login after
    // a logout → browser-style login) have no mixed-content problem, and the
    // window's IPC scope may not cover their origin — native fetch must be
    // used instead of the proxy.
    const mockWindow = makeMockWindow("http:");
    mockWindow.__TAURI_INVOKE__ = vi.fn();
    mockWindow.__TAURI__ = {
      event: { listen: vi.fn(async () => vi.fn()) },
    };

    injectProxy(mockWindow);

    const response = await mockWindow.fetch(
      "http://localhost:2528/auth/providers",
      { headers: { Accept: "application/json" } }
    );
    expect(mockWindow.__TAURI_INVOKE__).not.toHaveBeenCalled();
    expect(await response.text()).toBe("original");
  });

  it("does not invoke Tauri IPC for non-SSE localhost requests", async () => {
    const mockWindow = makeMockWindow();
    const tauriInvoke = vi.fn().mockResolvedValue({
      status: 200,
      headers: {},
      body: "{}",
    });
    mockWindow.__TAURI_INVOKE__ = tauriInvoke;
    mockWindow.__TAURI__ = {
      event: { listen: vi.fn(async () => vi.fn()) },
    };

    injectProxy(mockWindow);

    // Plain JSON request to localhost — uses proxy_http_request, not proxy_sse_stream.
    await mockWindow
      .fetch("http://localhost:2428/admin-api/contexts", {
        headers: { Accept: "application/json" },
      })
      .catch(() => {}); // may throw; we only care about which command was called

    const sseCalls = tauriInvoke.mock.calls.filter(
      (call) => call[0] === "proxy_sse_stream"
    );
    expect(sseCalls.length).toBe(0);
  });
});

// ─── Brokered /auth/refresh (calimero-network/core#3083) ────────────────────
//
// Refresh tokens are single-use: whoever POSTs /auth/refresh consumes the token
// and gets a new one, and re-presenting a consumed one revokes the entire
// family. App windows therefore hold a sentinel, not a real refresh token —
// their /auth/refresh calls must be answered by the desktop, and must never
// reach the node.
describe("proxy_script /auth/refresh brokering", () => {
  const BROKERED_REFRESH_TOKEN = "calimero-desktop-brokered-refresh-token";

  function tauriWindow(invokeImpl: (cmd: string, args: any) => Promise<unknown>) {
    const mockWindow = makeMockWindow();
    mockWindow.__TAURI_INVOKE__ = vi.fn(invokeImpl);
    mockWindow.__TAURI__ = { event: { listen: vi.fn(async () => vi.fn()) } };
    // `originalFetch` is captured by the script at injection time; hold on to it
    // so a test can prove the sentinel never went out over the network.
    mockWindow.__originalFetch = mockWindow.fetch;
    return mockWindow;
  }

  it("routes an app's POST /auth/refresh to the desktop instead of the node", async () => {
    const mockWindow = tauriWindow(async (cmd) =>
      cmd === "broker_token_refresh" ? "fresh-access-token" : { status: 200, headers: {}, body: "{}" }
    );
    injectProxy(mockWindow);

    const response = await mockWindow.fetch("http://localhost:2428/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: "stale", refresh_token: BROKERED_REFRESH_TOKEN }),
    });

    const commands = mockWindow.__TAURI_INVOKE__.mock.calls.map((c: any[]) => c[0]);
    expect(commands).toContain("broker_token_refresh");
    // The sentinel must never be forwarded to the node.
    expect(commands).not.toContain("proxy_http_request");

    // Shaped like a real /auth/refresh reply so unmodified mero-js parses it.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        access_token: "fresh-access-token",
        refresh_token: BROKERED_REFRESH_TOKEN,
      },
    });
  });

  it("brokers /auth/refresh even when the node is not on localhost", async () => {
    const mockWindow = tauriWindow(async () => "fresh-access-token");
    injectProxy(mockWindow, "https://node.example.com");

    const response = await mockWindow.fetch("https://node.example.com/auth/refresh", {
      method: "POST",
      body: "{}",
    });

    expect(mockWindow.__TAURI_INVOKE__).toHaveBeenCalledWith("broker_token_refresh");
    expect(response.status).toBe(200);
    // A remote node is not "localhost", so without the explicit auth-refresh
    // route this would have gone straight out over the network with the sentinel.
    expect(mockWindow.__originalFetch).not.toHaveBeenCalled();
  });

  it("does not broker a GET to /auth/refresh, nor other auth routes", async () => {
    const mockWindow = tauriWindow(async () => ({ status: 200, headers: {}, body: "{}" }));
    injectProxy(mockWindow);

    await mockWindow.fetch("http://localhost:2428/auth/refresh", { method: "GET" }).catch(() => {});
    await mockWindow
      .fetch("http://localhost:2428/auth/login", { method: "POST", body: "{}" })
      .catch(() => {});

    const commands = mockWindow.__TAURI_INVOKE__.mock.calls.map((c: any[]) => c[0]);
    expect(commands).not.toContain("broker_token_refresh");
  });

  it("fails closed with a 401 rather than leaking the sentinel when IPC is unavailable", async () => {
    const mockWindow = makeMockWindow(); // no __TAURI_INVOKE__ at all
    const originalFetch = mockWindow.fetch;
    injectProxy(mockWindow);

    const response = await mockWindow.fetch("http://localhost:2428/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refresh_token: BROKERED_REFRESH_TOKEN }),
    });

    expect(response.status).toBe(401);
    // Must NOT fall back to the network: the app holds the sentinel, not a real
    // refresh token, so there is nothing useful to send and nothing to leak.
    expect(originalFetch).not.toHaveBeenCalled();
  });

  it("surfaces a desktop-side refresh failure as a 401", async () => {
    const mockWindow = tauriWindow(async (cmd) => {
      if (cmd === "broker_token_refresh") throw new Error("Desktop is not authenticated");
      return { status: 200, headers: {}, body: "{}" };
    });
    injectProxy(mockWindow);

    const response = await mockWindow.fetch("http://localhost:2428/auth/refresh", {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(401);
    expect(await response.text()).toContain("Desktop is not authenticated");
  });

  it("brokers an XHR POST to /auth/refresh too", async () => {
    const mockWindow = tauriWindow(async () => "fresh-access-token");
    injectProxy(mockWindow);

    const xhr = new mockWindow.XMLHttpRequest();
    xhr.open("POST", "http://localhost:2428/auth/refresh");
    const done = new Promise<void>((resolve) => { xhr.onload = () => resolve(); });
    xhr.send(JSON.stringify({ refresh_token: BROKERED_REFRESH_TOKEN }));
    await done;

    const commands = mockWindow.__TAURI_INVOKE__.mock.calls.map((c: any[]) => c[0]);
    expect(commands).toContain("broker_token_refresh");
    expect(commands).not.toContain("proxy_http_request");
    expect(xhr.status).toBe(200);
    expect(JSON.parse(xhr.responseText).data.access_token).toBe("fresh-access-token");
  });
});
