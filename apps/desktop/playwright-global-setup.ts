import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { createConnection } from "node:net";
import path from "node:path";

// Node names the onboarding flow creates under ~/.calimero, which is also merod's
// own default home: nothing here is a "test-only" directory to clean up.
const TEST_NODE_NAMES = ["default", "node1"];
const NODE_SERVER_PORT = 2528;
/** A local port either answers at once or is not listening. */
const PORT_PROBE_TIMEOUT_MS = 1000;

/** Whether anything is already serving the port the tests expect to be free. */
function portIsOccupied(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const settle = (occupied: boolean) => {
      socket.destroy();
      resolve(occupied);
    };
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

/** Refuses to run while a node serves the node port: a live node lets the tests skip
 *  onboarding and login. Never stops it or touches its data - that is the user's node. */
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
