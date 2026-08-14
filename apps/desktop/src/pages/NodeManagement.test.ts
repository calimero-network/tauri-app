import { describe, it, expect } from "vitest";
import { resolveStartPorts } from "./NodeManagement";
import type { RunningMerodNode } from "../utils/merod";

function node(overrides: Partial<RunningMerodNode>): RunningMerodNode {
  return { pid: 111, node_name: "default", port: 2528, swarm_port: 2428, home_dir: "/Users/dev/.calimero", ...overrides };
}

// Regression coverage: starting a second merod on a data dir another node already
// had open let two RocksDB writers destroy one store.
describe("resolveStartPorts", () => {
  it("refuses to start or bump when the target home+node is already running, and surfaces its PID", () => {
    const running = [node({ pid: 777, node_name: "default", home_dir: "/Users/dev/.calimero", port: 2528, swarm_port: 2428 })];
    const result = resolveStartPorts(running, "/Users/dev/.calimero", "default", 2528, 2428);
    expect(result.alreadyRunning?.pid).toBe(777);
    // Ports must be left untouched - no route-around-the-conflict bump.
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

  it("bumps past a running node that reports no ports at all", () => {
    // Defaults stand in for the ports, so an argv the scan could not parse still
    // counts as holding 2528/2428 rather than reading as free.
    const running = [node({ pid: 111, node_name: "default", home_dir: "/tmp/other-home", port: undefined as unknown as number, swarm_port: undefined })];
    const result = resolveStartPorts(running, "/Users/dev/.calimero", "second-node", 2528, 2428);
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
