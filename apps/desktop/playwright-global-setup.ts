import { execSync, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const meroDist = path.join(repoRoot, "packages/mero-react/dist/index.mjs");

// Node directories created by the onboarding flow that need to be wiped before tests.
// Default node name is "default"; "node1" is a common alternative used in dev.
const TEST_NODE_NAMES = ["default", "node1"];

function killMerod(): void {
  // pkill exits with 1 when no matching process is found — that is fine.
  const result = spawnSync("pkill", ["-f", "merod"], { stdio: "ignore" });
  if (result.status === 0) {
    console.log("    killed running merod process");
  } else {
    console.log("    no merod process running");
  }
}

function cleanNodeData(): void {
  const calimeroDir = path.join(homedir(), ".calimero");
  const deleted: string[] = [];

  for (const name of TEST_NODE_NAMES) {
    const dir = path.join(calimeroDir, name);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      deleted.push(`~/.calimero/${name}`);
    }
  }

  if (deleted.length > 0) {
    console.log(`    deleted node data: ${deleted.join(", ")}`);
  } else {
    console.log("    no node data to clean up");
  }
}

/**
 * Vite resolves @calimero-network/mero-react from dist/. Build once if missing (local dev / fresh clone).
 *
 * Also kills any running merod process and wipes test node data directories so a
 * live node on localhost:2528 cannot bypass the onboarding/login flow in tests.
 */
export default async function globalSetup(): Promise<void> {
  // ── Build mero-react if dist is missing ────────────────────────────────────
  if (!existsSync(meroDist)) {
    execSync("pnpm build:mero-react", { cwd: repoRoot, stdio: "inherit" });
  }

  // ── Pre-test cleanup ────────────────────────────────────────────────────────
  console.log("\n\x1b[33m⚠  E2E pre-run cleanup\x1b[0m");
  console.log(
    `  Killing merod and deleting node data in ~/.calimero/{${TEST_NODE_NAMES.join(",")}}`,
  );
  console.log(
    "  (Prevents a running node from bypassing onboarding/login in tests)\n",
  );

  killMerod();
  cleanNodeData();

  console.log("\n  \x1b[32m✓\x1b[0m cleanup done — starting tests\n");
}
