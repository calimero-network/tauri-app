import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { createConnection } from "node:net";
import path from "node:path";

// Node directories the onboarding flow creates. Default node name is "default";
// "node1" is a common alternative used in dev.
const TEST_NODE_NAMES = ["default", "node1"];
const NODE_SERVER_PORT = 2528;

/** Whether anything is already serving the port the tests expect to be free. */
function portIsOccupied(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const settle = (occupied: boolean) => {
      socket.destroy();
      resolve(occupied);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

/**
 * Refuses to run while a node is serving localhost:2528, because a live node
 * lets the tests skip onboarding and login.
 *
 * This used to `pkill -f merod` and delete `~/.calimero/{default,node1}`
 * outright, which silently destroyed a developer's real node the first time they
 * ran the suite locally — the node home is shared with `merod`'s own default, so
 * there is no such thing as a "test-only" directory here. CI never has a node
 * running, so refusing costs nothing there and protects everyone else.
 */
export default async function globalSetup(): Promise<void> {
  if (!(await portIsOccupied(NODE_SERVER_PORT))) {
    return;
  }

  const homes = TEST_NODE_NAMES.map((name) =>
    path.join(homedir(), ".calimero", name),
  ).filter(existsSync);

  throw new Error(
    [
      `\n\x1b[33m⚠  A node is already serving localhost:${NODE_SERVER_PORT}.\x1b[0m`,
      "",
      "  These tests need onboarding and login to be reachable, which a running",
      "  node bypasses. Stop it and run them again:",
      "",
      "    pkill -f 'merod .*run'    # or quit Calimero Desktop",
      "",
      homes.length > 0
        ? `  Your node data is left untouched (${homes.join(", ")}).`
        : "  No node data found under ~/.calimero.",
      "",
    ].join("\n"),
  );
}
