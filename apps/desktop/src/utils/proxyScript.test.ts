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
  const win: any = {
    __TAURI_FETCH_PROXY_INJECTED__: undefined as boolean | undefined,
    // The proxy only runs on HTTPS-hosted pages (mixed-content bypass);
    // default the mock to an HTTPS page so proxy-path tests exercise it.
    location: { protocol: pageProtocol },
    // Stored by the script as `originalFetch` — returned for non-proxied URLs.
    fetch: vi.fn().mockResolvedValue(new Response("original", { status: 200 })),
    XMLHttpRequest: FakeXHR,
  };
  // Tauri v2 exposes IPC via window.__TAURI_INTERNALS__ (getTauriInvoke reads
  // .invoke there). Tests still assign the invoke stub to win.__TAURI_INVOKE__
  // for readability/assertions, so delegate to it dynamically. transformCallback
  // backs the low-level event-listen fallback.
  win.__TAURI_INTERNALS__ = {
    transformCallback: (cb: any) => cb,
    // Only expose invoke when a test has wired up __TAURI_INVOKE__; otherwise
    // getTauriInvoke() must see no IPC (so "fails closed" tests still fail closed).
    get invoke() {
      return win.__TAURI_INVOKE__
        ? (...args: any[]) => win.__TAURI_INVOKE__(...args)
        : undefined;
    },
  };
  return win as any;
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
      body: JSON.stringify({ refresh_token: BROKERED_REFRESH_TOKEN }),
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
      body: JSON.stringify({ refresh_token: BROKERED_REFRESH_TOKEN }),
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

// ─── Binary-safe bodies (image upload/download through the proxy) ────────────
//
// The Tauri proxy carries HTTP bodies over IPC. Before this fix everything went
// as a UTF-8 string: downloads ran response.text() (mojibake) and XHR uploads
// ran String(arrayBuffer) → "[object ArrayBuffer]". Binary now travels as
// base64 (body_base64) in both directions; text bodies stay plain strings.
describe("proxy_script binary bodies", () => {
  function tauriInvokeWindow(impl: (cmd: string, args: any) => Promise<unknown>) {
    const mockWindow = makeMockWindow();
    mockWindow.__TAURI_INVOKE__ = vi.fn(impl);
    mockWindow.__TAURI__ = { event: { listen: vi.fn(async () => vi.fn()) } };
    return mockWindow;
  }

  it("downloads a binary response byte-exact (base64 → bytes)", async () => {
    // Bytes that are NOT valid UTF-8 — the exact case response.text() corrupted.
    const raw = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xfe]);
    const b64 = Buffer.from(raw).toString("base64");
    const mockWindow = tauriInvokeWindow(async (cmd) =>
      cmd === "proxy_http_request"
        ? { status: 200, headers: { "content-type": "image/png" }, body_base64: b64 }
        : { status: 200, headers: {}, body: "{}" }
    );
    injectProxy(mockWindow);

    const res = await mockWindow.fetch("http://localhost:2428/admin-api/blobs/abc?context_id=x");
    const got = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(got)).toEqual(Array.from(raw));
  });

  it("uploads a binary fetch body as base64, not mangled text", async () => {
    const raw = new Uint8Array([0, 1, 2, 250, 200, 5, 127, 255]);
    const calls: Array<{ cmd: string; args: any }> = [];
    const mockWindow = tauriInvokeWindow(async (cmd, args) => {
      calls.push({ cmd, args });
      return { status: 200, headers: { "content-type": "application/json" }, body: "{}" };
    });
    injectProxy(mockWindow);

    await mockWindow.fetch("http://localhost:2428/admin-api/blobs", {
      method: "PUT",
      body: raw,
      headers: { "Content-Type": "application/octet-stream" },
    });

    const call = calls.find((c) => c.cmd === "proxy_http_request")!;
    expect(call).toBeTruthy();
    expect(call.args.request.body).toBeNull();
    expect(call.args.request.body_base64).toBe(Buffer.from(raw).toString("base64"));
  });

  it("uploads a binary XHR body (ArrayBuffer) as base64 — the axios PUT path", async () => {
    const raw = new Uint8Array([9, 8, 7, 255, 0, 128, 64]);
    const calls: Array<{ cmd: string; args: any }> = [];
    const mockWindow = tauriInvokeWindow(async (cmd, args) => {
      calls.push({ cmd, args });
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: { blob_id: "b1", size: raw.length } }),
      };
    });
    injectProxy(mockWindow);

    const xhr = new mockWindow.XMLHttpRequest();
    xhr.open("PUT", "http://localhost:2428/admin-api/blobs");
    const done = new Promise<void>((resolve) => { xhr.onload = () => resolve(); });
    xhr.send(raw.buffer); // ArrayBuffer, exactly what axios sends for a File.arrayBuffer()
    await done;

    const call = calls.find((c) => c.cmd === "proxy_http_request")!;
    expect(call).toBeTruthy();
    expect(call.args.request.body).toBeNull();
    expect(call.args.request.body_base64).toBe(Buffer.from(raw).toString("base64"));
    expect(JSON.parse(xhr.responseText).data.blob_id).toBe("b1");
  });

  it("keeps a JSON string body as text (no base64)", async () => {
    const payload = JSON.stringify({ a: 1, b: "two" });
    const calls: Array<{ cmd: string; args: any }> = [];
    const mockWindow = tauriInvokeWindow(async (cmd, args) => {
      calls.push({ cmd, args });
      return { status: 200, headers: { "content-type": "application/json" }, body: "{}" };
    });
    injectProxy(mockWindow);

    await mockWindow.fetch("http://localhost:2428/admin-api/contexts", {
      method: "POST",
      body: payload,
      headers: { "Content-Type": "application/json" },
    });

    const call = calls.find((c) => c.cmd === "proxy_http_request")!;
    expect(call.args.request.body).toBe(payload);
    expect(call.args.request.body_base64).toBeNull();
  });
});

describe("refresh brokering", () => {
  it("brokers a refresh that presents the sentinel", async () => {
    const win = makeMockWindow();
    injectProxy(win, "http://localhost:2528");
    win.__TAURI_INVOKE__ = vi.fn().mockResolvedValue("fresh-access-token");

    const res = await win.fetch("http://localhost:2528/auth/refresh", {
      method: "POST",
      body: JSON.stringify({
        access_token: "a",
        refresh_token: "calimero-desktop-brokered-refresh-token",
      }),
    });

    expect(win.__TAURI_INVOKE__).toHaveBeenCalledWith("broker_token_refresh");
    expect((await res.json()).data.access_token).toBe("fresh-access-token");
  });

  it("lets a window holding a real refresh token rotate it itself", async () => {
    const win = makeMockWindow();
    injectProxy(win, "http://localhost:2529");
    win.__TAURI_INVOKE__ = vi.fn().mockResolvedValue("should-not-be-used");

    await win.fetch("http://localhost:2529/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ access_token: "a", refresh_token: "a-real-token" }),
    });

    expect(win.__TAURI_INVOKE__).not.toHaveBeenCalledWith("broker_token_refresh");
  });

  it("brokers a refresh made via a Request object, even against a remote node", async () => {
    // A bare fetch(url, init) form always has the body on init - only a
    // fetch(new Request(...)) call needs the body read off the Request itself.
    const win = makeMockWindow();
    const originalFetch = win.fetch;
    injectProxy(win, "https://node.example.com");
    win.__TAURI_INVOKE__ = vi.fn().mockResolvedValue("fresh-access-token");

    const request = new Request("https://node.example.com/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refresh_token: "calimero-desktop-brokered-refresh-token" }),
    });
    const res = await win.fetch(request);

    expect(win.__TAURI_INVOKE__).toHaveBeenCalledWith("broker_token_refresh");
    // A remote node bypasses the localhost mixed-content proxy path entirely,
    // so this is the only thing standing between the sentinel and the network.
    expect(originalFetch).not.toHaveBeenCalled();
    expect((await res.json()).data.access_token).toBe("fresh-access-token");
  });
});
