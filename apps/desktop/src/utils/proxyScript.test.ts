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

function makeMockWindow() {
  // Provide a minimal XMLHttpRequest stub so the script's XHR-wrapping code
  // doesn't throw on init (we don't exercise XHR in these tests).
  function FakeXHR() {}
  FakeXHR.prototype = {};
  return {
    __TAURI_FETCH_PROXY_INJECTED__: undefined as boolean | undefined,
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
      ([cmd]: [string]) => cmd === "proxy_sse_stream"
    );
    expect(sseCalls.length).toBe(0);
  });
});
