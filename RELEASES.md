# Release Process

This document describes the release process for Calimero Desktop, including automated builds, code signing, notarization, and multi-platform distribution.

## Overview

Calimero Desktop uses a fully automated, multi-platform release pipeline:

1. **Tag-Based Releases**: Versions are controlled by git tags (e.g., `v1.0.0`)
2. **Multi-Platform Builds**: GitHub Actions builds for macOS, Windows, and Linux in parallel
3. **Code Signing**: macOS apps are signed/notarized; Windows can use Authenticode
4. **Stable Asset Naming**: All artifacts use deterministic names (`CalimeroDesktop_{version}_{platform}_{arch}.{ext}`)
5. **Auto-Updates**: Installed apps check for and install updates automatically via Tauri updater
6. **Download Page**: A landing page with platform tabs shows the latest release

## Architecture

```
┌─────────────────┐     ┌──────────────────────────────────────────┐
│   Push tag      │     │            GitHub Actions                │
│   (vX.Y.Z)      │ ──▶ │  ┌─────────┐ ┌─────────┐ ┌─────────┐   │
└─────────────────┘     │  │ macOS   │ │ Windows │ │ Linux   │   │
                        │  │ build   │ │ build   │ │ build   │   │
                        │  └────┬────┘ └────┬────┘ └────┬────┘   │
                        │       └───────────┼───────────┘        │
                        │                   ▼                    │
                        │         ┌─────────────────┐            │
                        │         │ Publish Release │            │
                        │         │ (all platforms) │            │
                        │         └────────┬────────┘            │
                        └──────────────────┼─────────────────────┘
                                           │
              ┌────────────────────────────┼────────────────────────────┐
              │                            │                            │
              ▼                            ▼                            ▼
    ┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
    │  GitHub Release │         │   latest.json   │         │  release.json   │
    │  (installers)   │         │ (Tauri updater) │         │ (download site) │
    └─────────────────┘         └─────────────────┘         └─────────────────┘
```

## Creating a Release

### Using Git Tags (Recommended)

```bash
# Ensure local master is up to date
git checkout master
git pull origin master

# Create and push a release tag
git tag v1.0.0
git push origin v1.0.0
```

This triggers `.github/workflows/release.yml` which:

1. Builds Tauri app for macOS (universal), Windows (x64), and Linux (x64)
2. Collects and normalizes artifacts to stable names
3. Generates `latest.json` (Tauri updater) and `release.json` (download site)
4. Creates GitHub Release and uploads all assets

### Manual Release (workflow_dispatch)

1. Go to **Actions → Release → Run workflow**
2. Enter `version` (e.g., `1.0.0`)
3. Click **Run workflow**

## Artifact Naming Convention

All artifacts follow a deterministic naming pattern:

| Platform | Installer | Updater Bundle |
|----------|-----------|----------------|
| macOS | `CalimeroDesktop_{version}_macos_universal.dmg` | `CalimeroDesktop_{version}_macos_universal.app.tar.gz` |
| Windows | `CalimeroDesktop_{version}_windows_x64_setup.exe` | `CalimeroDesktop_{version}_windows_x64.nsis.zip` |
| Linux | `CalimeroDesktop_{version}_linux_x64.AppImage` | `CalimeroDesktop_{version}_linux_x64.AppImage.tar.gz` |

Additional Linux packages: `.deb`, `.rpm`

## Required Secrets

### Shared (All Platforms)

| Secret | Description |
|--------|-------------|
| `TAURI_PRIVATE_KEY` | Private key for signing update manifests |
| `TAURI_KEY_PASSWORD` | Password for the private key (optional, if encrypted) |
| `TAURI_PUBLIC_KEY` | Public key injected into builds at CI time |

### macOS Code Signing

| Secret | Description |
|--------|-------------|
| `APPLE_CERTIFICATE` | Base64-encoded Developer ID Application certificate (.p12) |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the .p12 certificate |
| `APPLE_SIGNING_IDENTITY` | Certificate name (e.g., "Developer ID Application: Your Name (TEAMID)") |
| `APPLE_TEAM_ID` | Your Apple Developer Team ID |

### macOS Notarization

| Secret | Description |
|--------|-------------|
| `APPLE_ID` | Your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password from appleid.apple.com |

### Windows Code Signing (Optional)

| Secret | Description |
|--------|-------------|
| `WINDOWS_CERTIFICATE` | Base64-encoded code signing certificate (.pfx) |
| `WINDOWS_CERTIFICATE_PASSWORD` | Password for the .pfx certificate |

## Generating Secrets

### Tauri Updater Keys

```bash
# Generate keypair
pnpm tauri signer generate -w ~/.tauri/calimero-desktop.key

# Output shows the public key - add it to TAURI_PUBLIC_KEY secret
# Private key file contents go to TAURI_PRIVATE_KEY secret
```

The public key is injected into `tauri.conf.json` at build time from the `TAURI_PUBLIC_KEY` secret, so you don't need to commit it to the repository.

### Key Rotation Procedure

Because older app installs only trust the currently-embedded pubkey, key rotation must be staged:

1. **Transition Release**: Publish `vX.Y.Z` signed with the **old** private key, but built with the **new** pubkey embedded (update `TAURI_PUBLIC_KEY` secret first)
2. **Post-Rotation Release**: Publish `vX.Y.(Z+1)` signed with the **new** private key (update `TAURI_PRIVATE_KEY` secret)

This allows older versions to update to the transition release using the old key, then accept future updates using the new key.

### Apple Developer Certificate

1. Open Keychain Access on macOS
2. Export your "Developer ID Application" certificate as .p12
3. Base64 encode it: `base64 -i certificate.p12 | pbcopy`
4. Add to GitHub secrets as `APPLE_CERTIFICATE`

### App-Specific Password

1. Go to https://appleid.apple.com
2. Sign in → Security → App-Specific Passwords
3. Generate a new password for "Calimero Desktop CI"
4. Add to GitHub secrets as `APPLE_APP_SPECIFIC_PASSWORD`

## Release Artifacts

Each release includes:

| Artifact | Description |
|----------|-------------|
| `CalimeroDesktop_*.dmg` | macOS installer (Universal) |
| `CalimeroDesktop_*.exe` | Windows installer (NSIS) |
| `CalimeroDesktop_*.AppImage` | Linux portable app |
| `CalimeroDesktop_*.deb` | Linux Debian/Ubuntu package |
| `CalimeroDesktop_*.rpm` | Linux Fedora/RHEL package |
| `*.app.tar.gz` / `*.nsis.zip` / `*.AppImage.tar.gz` | Updater bundles |
| `*.sig` | Signatures for updater bundles |
| `latest.json` | Tauri updater manifest |
| `release.json` | Download site metadata |

## Release Verification Checklist

After publishing a release, verify:

### 1. GitHub Release Page

- [ ] Release exists at `https://github.com/calimero-network/tauri-app/releases/tag/vX.Y.Z`
- [ ] All expected platform installers are attached
- [ ] `latest.json` and `release.json` are attached
- [ ] Release notes are populated

### 2. Manifest Validation

Run the validation script:

```bash
# Download artifacts locally first
gh release download vX.Y.Z -D release-assets/

# Run validation
node scripts/release/validate-release.js --assets release-assets/ --check-urls
```

Checks:
- [ ] `latest.json` has valid structure and all platform entries
- [ ] `release.json` has valid structure and download entries
- [ ] All download URLs return HTTP 200
- [ ] Signatures exist for updater bundles

### 3. Download Site

- [ ] Visit https://calimero-network.github.io/tauri-app/
- [ ] Platform tabs show available platforms
- [ ] Download buttons work for each platform
- [ ] Version and date are correct

### 4. Auto-Update (Per Platform)

**macOS:**
- [ ] Install previous version
- [ ] App detects new version on startup
- [ ] Update downloads and installs successfully
- [ ] App restarts with new version

**Windows:**
- [ ] Install previous version
- [ ] App detects new version
- [ ] Update completes successfully

**Linux:**
- [ ] Install previous version (AppImage)
- [ ] App detects new version
- [ ] Update completes successfully

### 5. Fresh Install (Per Platform)

- [ ] Download installer from release/download page
- [ ] Install completes without errors
- [ ] App launches and shows correct version
- [ ] Basic functionality works (connect to node, view contexts)

## Auto-Update Flow

1. App checks `latest.json` on startup and every hour
2. If new version found, shows notification banner
3. User clicks "Update Now"
4. App downloads updater bundle, verifies signature, installs
5. App relaunches to apply the update

## Download Page

The download page at `apps/download-site/`:

- Fetches `release.json` from latest release (falls back to GitHub API)
- Shows platform tabs with auto-detection
- Displays primary and alternative download formats
- Updates automatically when new releases are published

### Deployment

Deploys automatically via `.github/workflows/deploy-download-site.yml`:

- Triggers on push to main (if download-site changed)
- Triggers on new release published
- Deploys to GitHub Pages

## Troubleshooting

### Build Failures

**"Certificate not found"**
- Verify `APPLE_CERTIFICATE` is correctly base64 encoded
- Check certificate hasn't expired

**"Notarization failed"**
- Verify `APPLE_ID` and `APPLE_APP_SPECIFIC_PASSWORD` are correct
- Check Apple Developer account is in good standing

**"No release created"**
- Ensure you pushed a tag matching `v*` (e.g., `v1.0.0`)
- Check Actions logs for the `Release` workflow run

**"Windows build failed"**
- Check Rust target is installed for Windows
- Verify NSIS dependencies are available

**"Linux build failed"**
- Check WebKit2GTK dependencies are installed
- Verify AppImage tools are available

### Update Issues

**"Update check failed"**
- Verify `tauri.conf.json` updater endpoints are correct
- Check GitHub release has `latest.json` attached

**"Signature verification failed"**
- Ensure `TAURI_PRIVATE_KEY` matches the pubkey embedded in the app
- If keys were rotated, follow the key rotation procedure above

**"Download failed"**
- Check artifact URLs in `latest.json` are correct
- Verify GitHub release assets are publicly accessible

## Security Considerations

1. **Never commit secrets** - All sensitive data in GitHub Secrets
2. **Rotate keys periodically** - Update signing keys annually
3. **Pin action versions** - Use SHA hashes for GitHub Actions
4. **Review before merge** - Require PR reviews for main branch
5. **Audit releases** - Run validation script after each release
6. **Key rotation** - Use staged releases when rotating updater keys

## Workflow Files

| Workflow | Purpose |
|----------|---------|
| `.github/workflows/release.yml` | Main release orchestration (tag-triggered) |
| `.github/workflows/build-macos.yml` | Reusable macOS build |
| `.github/workflows/build-windows.yml` | Reusable Windows build |
| `.github/workflows/build-linux.yml` | Reusable Linux build |
| `.github/workflows/build-macos-dmg.yml` | PR validation (macOS only) |
| `.github/workflows/deploy-download-site.yml` | Download page deployment |

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/release/collect-assets.js` | Normalize artifact names |
| `scripts/release/generate-latest-json.js` | Generate Tauri updater manifest |
| `scripts/release/generate-release-json.js` | Generate download site metadata |
| `scripts/release/validate-release.js` | Validate release artifacts and URLs |
