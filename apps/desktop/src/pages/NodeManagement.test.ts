import { describe, it, expect } from "vitest";
import { findRunningNode, resolveStartPorts } from "./NodeManagement";
import { homeDirsMatch, type RunningMerodNode } from "../utils/merod";

function node(overrides: Partial<RunningMerodNode>): RunningMerodNode {
  return { pid: 111, node_name: "default", port: 2528, swarm_port: 2428, home_dir: "/Users/dev/.calimero", ...overrides };
}

// Regression coverage: starting a second merod on a data dir another node already
// had open let two RocksDB writers destroy one store.
describe("homeDirsMatch", () => {
  it("matches identical paths", () => {
    expect(homeDirsMatch("/Users/dev/.calimero", "/Users/dev/.calimero")).toBe(true);
  });

  it("matches despite a trailing slash", () => {
    expect(homeDirsMatch("/Users/dev/.calimero/", "/Users/dev/.calimero")).toBe(true);
  });

  it("matches a ~ path against its resolved absolute form when the OS home dir is known", () => {
    expect(homeDirsMatch("~/.calimero", "/Users/dev/.calimero", "/Users/dev")).toBe(true);
  });

  it("does not match different directories", () => {
    expect(homeDirsMatch("/Users/dev/.calimero", "/tmp/e2e")).toBe(false);
  });

  it("does not match when either side is empty", () => {
    expect(homeDirsMatch("", "/Users/dev/.calimero")).toBe(false);
    expect(homeDirsMatch(undefined, undefined)).toBe(false);
  });
});

describe("findRunningNode", () => {
  it("finds a node already running for this exact home+node pair", () => {
    const running = [node({ pid: 555, node_name: "default", home_dir: "/Users/dev/.calimero" })];
    const found = findRunningNode(running, "/Users/dev/.calimero", "default");
    expect(found?.pid).toBe(555);
  });

  it("treats the same node name under a DIFFERENT home dir as unrelated", () => {
    // A developer running `merod --home /tmp/e2e --node default run` must not
    // be confused with this app's own "default" node in a different home dir.
    const running = [node({ pid: 999, node_name: "default", home_dir: "/tmp/e2e" })];
    const found = findRunningNode(running, "/Users/dev/.calimero", "default");
    expect(found).toBeUndefined();
  });

  it("resolves to the right PID when two different homes both have a node called 'default'", () => {
    const running = [
      node({ pid: 111, node_name: "default", home_dir: "/tmp/e2e" }),
      node({ pid: 222, node_name: "default", home_dir: "/Users/dev/.calimero" }),
    ];
    expect(findRunningNode(running, "/Users/dev/.calimero", "default")?.pid).toBe(222);
    expect(findRunningNode(running, "/tmp/e2e", "default")?.pid).toBe(111);
  });

  it("matches robustly across spelling differences (trailing slash, ~ vs absolute)", () => {
    const running = [node({ pid: 333, node_name: "default", home_dir: "/Users/dev/.calimero/" })];
    expect(findRunningNode(running, "~/.calimero", "default", "/Users/dev")?.pid).toBe(333);
  });
});

describe("resolveStartPorts", () => {
  it("refuses to start or bump when the target home+node is already running, and surfaces its PID", () => {
    const running = [node({ pid: 777, node_name: "default", home_dir: "/Users/dev/.calimero", port: 2528, swarm_port: 2428 })];
    const result = resolveStartPorts(running, "/Users/dev/.calimero", "default", 2528, 2428);
    expect(result.alreadyRunning?.pid).toBe(777);
    // Ports must be left untouched — no route-around-the-conflict bump.
    expect(result.serverPort).toBe(2528);
    expect(result.swarmPort).toBe(2428);
  });

  it("still refuses when the running node's home dir is spelled differently", () => {
    const running = [node({ pid: 888, node_name: "default", home_dir: "~/.calimero", port: 2528, swarm_port: 2428 })];
    const result = resolveStartPorts(running, "/Users/dev/.calimero/", "default", 2528, 2428, "/Users/dev");
    expect(result.alreadyRunning?.pid).toBe(888);
  });

  it("bumps ports when starting a genuinely different node (different home) whose port is taken", () => {
    const running = [node({ pid: 111, node_name: "default", home_dir: "/tmp/other-home", port: 2528, swarm_port: 2428 })];
    const result = resolveStartPorts(running, "/Users/dev/.calimero", "second-node", 2528, 2428);
    expect(result.alreadyRunning).toBeUndefined();
    expect(result.serverPort).toBe(2529);
    expect(result.swarmPort).toBe(2429);
  });

  it("bumps ports when starting a genuinely different node (different name, same home) whose port is taken", () => {
    const running = [node({ pid: 111, node_name: "default", home_dir: "/Users/dev/.calimero", port: 2528, swarm_port: 2428 })];
    const result = resolveStartPorts(running, "/Users/dev/.calimero", "second-node", 2528, 2428);
    expect(result.alreadyRunning).toBeUndefined();
    expect(result.serverPort).toBe(2529);
    expect(result.swarmPort).toBe(2429);
  });

  it("leaves the requested ports alone when nothing conflicts", () => {
    const running: RunningMerodNode[] = [];
    const result = resolveStartPorts(running, "/Users/dev/.calimero", "default", 2528, 2428);
    expect(result.alreadyRunning).toBeUndefined();
    expect(result.serverPort).toBe(2528);
    expect(result.swarmPort).toBe(2428);
  });
});
