/**
 * Platform detection for download page.
 */

import type { OS } from "./types";

export type Platform = OS | "unknown";

/**
 * Detect the user's operating system from browser APIs.
 * Returns "unknown" for mobile devices and unsupported platforms.
 */
export function detectPlatform(): Platform {
  const userAgent = navigator.userAgent.toLowerCase();
  const platform = navigator.platform.toLowerCase();

  // Check for iPhone/iPod
  if (userAgent.includes("iphone") || userAgent.includes("ipod")) {
    return "unknown";
  }

  // Check for iPad - iPadOS 13+ may report as MacIntel, so check touch capability
  if (
    userAgent.includes("ipad") ||
    (platform.includes("mac") && navigator.maxTouchPoints > 1)
  ) {
    return "unknown";
  }

  // Check for Android
  if (userAgent.includes("android")) {
    return "unknown";
  }

  // Check for macOS - Macintosh in user agent and no touch capability
  if (userAgent.includes("macintosh") && navigator.maxTouchPoints <= 1) {
    return "macos";
  }

  // Check for Windows
  if (userAgent.includes("win")) {
    return "windows";
  }

  // Check for Linux (but not Android which also contains "linux")
  if (userAgent.includes("linux")) {
    return "linux";
  }

  return "unknown";
}

/**
 * Get human-readable platform name.
 */
export function getPlatformLabel(platform: Platform): string {
  switch (platform) {
    case "macos":
      return "macOS";
    case "windows":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return "Unknown";
  }
}

/**
 * Check if a platform has available downloads.
 */
export function isPlatformSupported(platform: Platform): boolean {
  return platform === "macos" || platform === "windows" || platform === "linux";
}
