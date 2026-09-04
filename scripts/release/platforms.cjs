/**
 * The one description of a release platform: where its bundles land, what they
 * are renamed to, and how the updater and the download site refer to them.
 */

const PRODUCT_NAME = "CalimeroDesktop";
const LINUX_BUNDLE_DIR = "apps/desktop/src-tauri/target/release/bundle";

// Order matters: it fixes the platform order in latest.json and the pre-sort
// order of release.json's downloads. Within a platform, so does artifact order.
const PLATFORM_CONFIG = {
  macos: {
    arch: "universal",
    searchPaths: [
      "apps/desktop/src-tauri/target/universal-apple-darwin/release/bundle",
      LINUX_BUNDLE_DIR,
    ],
    updaterTargets: ["darwin-universal", "darwin-x86_64", "darwin-aarch64"],
    artifacts: [
      {
        pattern: /\.dmg$/,
        suffix: "_macos_universal.dmg",
        type: "installer",
        format: "dmg",
        label: "macOS (Universal)",
        primary: true,
      },
      {
        pattern: /\.app\.tar\.gz$/,
        suffix: "_macos_universal.app.tar.gz",
        type: "updater",
      },
      {
        pattern: /\.app\.tar\.gz\.sig$/,
        suffix: "_macos_universal.app.tar.gz.sig",
        type: "signature",
      },
    ],
  },
  windows: {
    arch: "x64",
    searchPaths: [LINUX_BUNDLE_DIR],
    updaterTargets: ["windows-x86_64"],
    artifacts: [
      {
        pattern: /_x64-setup\.exe$/,
        suffix: "_windows_x64_setup.exe",
        type: "installer",
        format: "exe",
        label: "Windows (64-bit)",
        primary: true,
      },
      {
        pattern: /_x64\.msi$/,
        suffix: "_windows_x64.msi",
        type: "installer",
        format: "msi",
        label: "Windows MSI (64-bit)",
      },
      {
        pattern: /_x64-setup\.nsis\.zip$/,
        suffix: "_windows_x64.nsis.zip",
        type: "updater",
      },
      {
        pattern: /_x64-setup\.nsis\.zip\.sig$/,
        suffix: "_windows_x64.nsis.zip.sig",
        type: "signature",
      },
    ],
  },
  linux: {
    arch: "x64",
    searchPaths: [LINUX_BUNDLE_DIR],
    updaterTargets: ["linux-x86_64"],
    artifacts: [
      {
        pattern: /\.AppImage$/,
        suffix: "_linux_x64.AppImage",
        type: "installer",
        format: "appimage",
        label: "Linux (AppImage)",
        primary: true,
      },
      {
        pattern: /\.AppImage\.tar\.gz$/,
        suffix: "_linux_x64.AppImage.tar.gz",
        type: "updater",
      },
      {
        pattern: /\.AppImage\.tar\.gz\.sig$/,
        suffix: "_linux_x64.AppImage.tar.gz.sig",
        type: "signature",
      },
      {
        pattern: /\.deb$/,
        suffix: "_linux_x64.deb",
        type: "installer",
        format: "deb",
        label: "Linux (Debian/Ubuntu)",
      },
      {
        pattern: /\.rpm$/,
        suffix: "_linux_x64.rpm",
        type: "installer",
        format: "rpm",
        label: "Linux (Fedora/RHEL)",
      },
    ],
  },
  // Chromebook = ARM64 Linux (Crostini). Built on a native aarch64 runner, so
  // the bundle output lives in the same release/bundle path as x86_64 Linux.
  chromebook: {
    arch: "arm64",
    searchPaths: [LINUX_BUNDLE_DIR],
    updaterTargets: ["linux-aarch64"],
    artifacts: [
      {
        pattern: /\.deb$/,
        suffix: "_linux_arm64.deb",
        type: "installer",
        format: "deb",
        label: "Chromebook (Debian/ARM64)",
        primary: true,
      },
      {
        pattern: /\.AppImage$/,
        suffix: "_linux_arm64.AppImage",
        type: "installer",
        format: "appimage",
        label: "Chromebook (AppImage/ARM64)",
      },
      {
        pattern: /\.AppImage\.tar\.gz$/,
        suffix: "_linux_arm64.AppImage.tar.gz",
        type: "updater",
      },
      {
        pattern: /\.AppImage\.tar\.gz\.sig$/,
        suffix: "_linux_arm64.AppImage.tar.gz.sig",
        type: "signature",
      },
    ],
  },
};

module.exports = { PLATFORM_CONFIG, PRODUCT_NAME };
