// Shared by prepare-merod.mjs and update-merod-pins.mjs: the pinned core
// release named in merod-config.json and the helpers to fetch and hash it.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const CORE_REPO = "calimero-network/core";
// GitHub Actions sets this; the scripts' tests point it at a local server.
const API_URL = process.env.GITHUB_API_URL || "https://api.github.com";

export const configPath = path.resolve(
  import.meta.dirname,
  "../../../merod-config.json",
);

function githubHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "calimero-desktop-merod-prep",
  };

  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  return headers;
}

async function readErrorBody(response) {
  try {
    const text = await response.text();
    const trimmed = text.trim();
    if (!trimmed) {
      return "";
    }
    return trimmed.length > 800 ? `${trimmed.slice(0, 800)}…` : trimmed;
  } catch {
    return "";
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: githubHeaders() });
  if (!response.ok) {
    const body = await readErrorBody(response);
    const detail = body ? ` — ${body}` : "";
    throw new Error(
      `GitHub API request failed (${response.status}) for ${url}${detail}`,
    );
  }

  return response.json();
}

export async function readConfig() {
  if (!existsSync(configPath)) {
    throw new Error(`${configPath} is missing`);
  }

  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  if (!config.version) {
    throw new Error("merod-config.json has no version to bundle");
  }
  return config;
}

export function fetchRelease(version) {
  return fetchJson(
    `${API_URL}/repos/${CORE_REPO}/releases/tags/${encodeURIComponent(version)}`,
  );
}

export function isMerodAsset(name) {
  return name.toLowerCase().startsWith("merod");
}

export async function downloadToFile(url, destination) {
  const response = await fetch(url, { headers: githubHeaders() });
  if (!response.ok || !response.body) {
    const body = await readErrorBody(response);
    const detail = body ? ` — ${body}` : "";
    throw new Error(`Failed to download ${url} (${response.status})${detail}`);
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

export async function sha256File(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}
