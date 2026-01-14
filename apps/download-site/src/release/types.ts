/**
 * Types for release.json manifest consumed by the download site.
 */

export type OS = "macos" | "windows" | "linux";
export type Arch = "x64" | "arm64" | "universal";
export type Format = "dmg" | "exe" | "msi" | "appimage" | "deb" | "rpm";

export interface DownloadAsset {
  os: OS;
  arch: Arch;
  format: Format;
  label: string;
  url: string;
  filename: string;
  size: number;
  sizeFormatted: string;
  primary: boolean;
}

export interface ReleaseManifest {
  version: string;
  tag: string;
  publishedAt: string;
  releaseUrl: string;
  notesUrl: string;
  downloads: DownloadAsset[];
}

// For backward compatibility with GitHub API fallback
export interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface GitHubRelease {
  tag_name: string;
  name: string;
  published_at: string;
  html_url: string;
  body: string;
  assets: GitHubReleaseAsset[];
}

// Platform-specific download info for UI
export interface PlatformDownloads {
  primary: DownloadAsset | null;
  alternatives: DownloadAsset[];
}
