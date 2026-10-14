import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import * as tar from "tar";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const scriptsDir = import.meta.dirname;
const VERSION = "9.9.9-test";
// Every platform prepare-merod can run on, so the test is not tied to the host's.
const ASSETS = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "aarch64-unknown-linux-gnu",
  "x86_64-unknown-linux-gnu",
  "aarch64-pc-windows-msvc",
  "x86_64-pc-windows-msvc",
].map((triple) => `merod_${triple}.tar.gz`);

let server;
let apiUrl;
let archive;
let archiveSha;
let requests;
let tree;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pinsFor = (hash) => Object.fromEntries(ASSETS.map((name) => [name, hash]));

beforeAll(async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "merod-pins-fixture-"));
  await fs.writeFile(path.join(work, "merod"), "fake merod binary");
  await fs.writeFile(path.join(work, "merod.exe"), "fake merod binary");
  await tar.c({ gzip: true, cwd: work, file: path.join(work, "a.tgz") }, [
    "merod",
    "merod.exe",
  ]);
  archive = await fs.readFile(path.join(work, "a.tgz"));
  archiveSha = sha256(archive);
  await fs.rm(work, { recursive: true, force: true });

  server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === `/repos/calimero-network/core/releases/tags/${VERSION}`) {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          tag_name: VERSION,
          assets: [
            ...ASSETS.map((name) => ({
              name,
              browser_download_url: `${apiUrl}/dl/${name}`,
            })),
            { name: "SHA256SUMS", browser_download_url: `${apiUrl}/dl/SHA256SUMS` },
          ],
        }),
      );
    } else if (req.url.startsWith("/dl/")) {
      res.end(archive);
    } else {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

// A copy of the scripts in a scratch checkout, so they read and write its
// merod-config.json and src-tauri/merod rather than the real ones.
async function scratchCheckout(config) {
  tree = await fs.mkdtemp(path.join(os.tmpdir(), "merod-pins-"));
  const desktop = path.join(tree, "apps", "desktop");
  await fs.mkdir(path.join(desktop, "scripts"), { recursive: true });
  for (const file of await fs.readdir(scriptsDir)) {
    if (file.endsWith(".mjs") && !file.endsWith(".test.mjs")) {
      await fs.copyFile(
        path.join(scriptsDir, file),
        path.join(desktop, "scripts", file),
      );
    }
  }
  await fs.symlink(
    path.join(scriptsDir, "..", "node_modules"),
    path.join(desktop, "node_modules"),
  );
  await fs.writeFile(
    path.join(tree, "merod-config.json"),
    `${JSON.stringify(config, null, 4)}\n`,
  );
}

async function runScript(name) {
  try {
    const { stdout } = await run(
      process.execPath,
      [path.join(tree, "apps", "desktop", "scripts", name)],
      { env: { ...process.env, GITHUB_API_URL: apiUrl, GITHUB_TOKEN: "" } },
    );
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.code, out: `${e.stdout}${e.stderr}` };
  }
}

const merodBinary = () =>
  fs
    .readdir(path.join(tree, "apps", "desktop", "src-tauri", "merod"))
    .catch(() => []);
const readConfigText = () =>
  fs.readFile(path.join(tree, "merod-config.json"), "utf8");

beforeEach(() => {
  requests = [];
});

describe("prepare-merod", () => {
  it("installs the binary when the download matches its pin", async () => {
    await scratchCheckout({ version: VERSION, sha256: pinsFor(archiveSha) });
    const { code, out } = await runScript("prepare-merod.mjs");
    expect(out).toContain("[merod] ready");
    expect(code).toBe(0);
    expect(await merodBinary()).toHaveLength(1);
  });

  it("fails and installs nothing when the download does not match its pin", async () => {
    await scratchCheckout({ version: VERSION, sha256: pinsFor(sha256("other")) });
    const { code, out } = await runScript("prepare-merod.mjs");
    expect(out).toContain("does not match the pinned sha256");
    expect(code).toBe(1);
    expect(await merodBinary()).toEqual([]);
  });

  it("fails when the chosen asset has no pin", async () => {
    await scratchCheckout({ version: VERSION });
    const { code, out } = await runScript("prepare-merod.mjs");
    expect(out).toContain("no pinned sha256");
    expect(code).toBe(1);
    expect(await merodBinary()).toEqual([]);
  });

  it("does not fall back to the latest release when no version is pinned", async () => {
    await scratchCheckout({ sha256: pinsFor(archiveSha) });
    const { code, out } = await runScript("prepare-merod.mjs");
    expect(out).toContain("no version");
    expect(code).toBe(1);
    expect(requests).toEqual([]);
  });
});

describe("update-merod-pins", () => {
  it("pins the hash of every merod archive, keeping the version first", async () => {
    await scratchCheckout({ name: "merod binary", version: VERSION });
    const { code } = await runScript("update-merod-pins.mjs");
    expect(code).toBe(0);
    const text = await readConfigText();
    expect(JSON.parse(text)).toEqual({
      name: "merod binary",
      version: VERSION,
      sha256: pinsFor(archiveSha),
    });
    expect(text.match(/"version"/g)).toHaveLength(1);
  });

  it("replaces a stale pin and is a no-op on a second run", async () => {
    await scratchCheckout({ version: VERSION, sha256: pinsFor(sha256("stale")) });
    await runScript("update-merod-pins.mjs");
    const first = await readConfigText();
    expect(JSON.parse(first).sha256).toEqual(pinsFor(archiveSha));
    await runScript("update-merod-pins.mjs");
    expect(await readConfigText()).toBe(first);
  });

  it("fails and leaves the config alone when the release does not exist", async () => {
    await scratchCheckout({ version: "no-such-release" });
    const before = await readConfigText();
    const { code, out } = await runScript("update-merod-pins.mjs");
    expect(out).toContain("404");
    expect(code).toBe(1);
    expect(await readConfigText()).toBe(before);
  });
});
