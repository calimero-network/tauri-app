import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const meroDist = path.join(repoRoot, "packages/mero-react/dist/index.mjs");

/**
 * Vite resolves @calimero-network/mero-react from dist/. Build once if missing (local dev / fresh clone).
 */
export default async function globalSetup(): Promise<void> {
  if (!existsSync(meroDist)) {
    execSync("pnpm build:mero-react", { cwd: repoRoot, stdio: "inherit" });
  }
}
