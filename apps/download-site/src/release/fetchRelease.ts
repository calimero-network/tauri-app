/**
 * Fetch release information from release.json or GitHub API fallback.
 */

import type {
  ReleaseManifest,
  GitHubRelease,
  DownloadAsset,
  OS,
  PlatformDownloads,
} from "./types";

const GITHUB_REPO = "calimero-network/tauri-app";
const RELEASE_JSON_URL = `https://github.com/${GITHUB_REPO}/releases/latest/download/release.json`;
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

/**
 * Format bytes to human-readable string.
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

/**
 * Format ISO date to human-readable string.
 */
export function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Infer OS and format from filename for GitHub API fallback.
 */
function inferAssetMetadata(
  filename: string
): { os: OS; format: string } | null {
  const lower = filename.toLowerCase();

  if (lower.endsWith(".dmg")) {
    return { os: "macos", format: "dmg" };
  }
  if (lower.endsWith("_setup.exe") || lower.endsWith("-setup.exe")) {
    return { os: "windows", format: "exe" };
  }
  if (lower.endsWith(".msi")) {
    return { os: "windows", format: "msi" };
  }
  if (lower.endsWith(".appimage")) {
    return { os: "linux", format: "appimage" };
  }
  if (lower.endsWith(".deb")) {
    return { os: "linux", format: "deb" };
  }
  if (lower.endsWith(".rpm")) {
    return { os: "linux", format: "rpm" };
  }

  return null;
}

/**
 * Primary fetch: get release.json from GitHub releases.
 */
async function fetchReleaseJson(): Promise<ReleaseManifest | null> {
  try {
    const response = await fetch(RELEASE_JSON_URL);
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Fallback: parse GitHub API release into our manifest format.
 */
async function fetchFromGitHubApi(): Promise<ReleaseManifest | null> {
  try {
    const response = await fetch(GITHUB_API_URL, {
      headers: {
        Accept: "application/vnd.github.v3+json",
      },
    });

    if (!response.ok) {
      return null;
    }

    const release: GitHubRelease = await response.json();
    const downloads: DownloadAsset[] = [];

    for (const asset of release.assets) {
      const meta = inferAssetMetadata(asset.name);
      if (!meta) continue;

      // Skip updater and signature files
      if (
        asset.name.includes(".tar.gz") ||
        asset.name.includes(".sig") ||
        asset.name.includes(".zip")
      ) {
        continue;
      }

      downloads.push({
        os: meta.os,
        arch: meta.os === "macos" ? "universal" : "x64",
        format: meta.format as DownloadAsset["format"],
        label: getFormatLabel(meta.os, meta.format),
        url: asset.browser_download_url,
        filename: asset.name,
        size: asset.size,
        sizeFormatted: formatBytes(asset.size),
        primary: isPrimaryFormat(meta.os, meta.format),
      });
    }

    return {
      version: release.tag_name.replace(/^v/, ""),
      tag: release.tag_name,
      publishedAt: release.published_at,
      releaseUrl: release.html_url,
      notesUrl: release.html_url,
      downloads,
    };
  } catch {
    return null;
  }
}

function getFormatLabel(os: OS, format: string): string {
  if (os === "macos") return "macOS (Universal)";
  if (os === "windows" && format === "exe") return "Windows (64-bit)";
  if (os === "windows" && format === "msi") return "Windows MSI (64-bit)";
  if (os === "linux" && format === "appimage") return "Linux (AppImage)";
  if (os === "linux" && format === "deb") return "Linux (Debian/Ubuntu)";
  if (os === "linux" && format === "rpm") return "Linux (Fedora/RHEL)";
  return format.toUpperCase();
}

function isPrimaryFormat(os: OS, format: string): boolean {
  if (os === "macos" && format === "dmg") return true;
  if (os === "windows" && format === "exe") return true;
  if (os === "linux" && format === "appimage") return true;
  return false;
}

/**
 * Fetch release manifest with fallback strategy.
 */
export async function fetchRelease(): Promise<ReleaseManifest | null> {
  // Try release.json first
  const manifest = await fetchReleaseJson();
  if (manifest && manifest.downloads.length > 0) {
    return manifest;
  }

  // Fall back to GitHub API
  return fetchFromGitHubApi();
}

/**
 * Get downloads for a specific platform.
 */
export function getDownloadsForPlatform(
  manifest: ReleaseManifest,
  os: OS
): PlatformDownloads {
  const platformDownloads = manifest.downloads.filter((d) => d.os === os);
  const primary = platformDownloads.find((d) => d.primary) || null;
  const alternatives = platformDownloads.filter((d) => !d.primary);

  return { primary, alternatives };
}

/**
 * Get all available platforms from manifest.
 */
export function getAvailablePlatforms(manifest: ReleaseManifest): OS[] {
  const platforms = new Set<OS>();
  for (const download of manifest.downloads) {
    platforms.add(download.os);
  }
  return Array.from(platforms);
}

/**
 * Get the GitHub repo URL.
 */
export function getGitHubRepoUrl(): string {
  return `https://github.com/${GITHUB_REPO}`;
}
