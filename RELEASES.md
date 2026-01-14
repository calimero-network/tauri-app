# Release Process

This document describes the release process for Calimero Desktop, including automated builds, code signing, notarization, and distribution.

## Overview

Calimero Desktop uses a fully automated release pipeline:

1. **Tag-Based Releases**: Versions are controlled by git tags (e.g., `v0.0.3`)
2. **Automated Builds**: GitHub Actions builds the macOS bundles
3. **Code Signing & Notarization**: Apps can be signed and notarized when Apple secrets are configured
4. **Auto-Updates**: The installed app checks for and installs updates automatically via Tauri updater
5. **Download Page**: A static landing page shows the latest release

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│   Push a tag    │ ──▶ │  GitHub Actions  │ ──▶ │   GitHub Release    │
│    (vX.Y.Z)     │     │   release.yml    │     │ + bundles + manifest│
└─────────────────┘     └──────────────────┘     └──────────┬──────────┘
                                                           │
                        ┌──────────────────────────────────┼───────────────┐
                        │                                  │               │
                        ▼                                  ▼               ▼
                ┌───────────────┐                 ┌───────────────┐ ┌─────────────┐
                │ Download Page │                 │  Tauri App    │ │   latest    │
                │ (fetches API) │                 │  (auto-update)│ │   .json     │
                └───────────────┘                 └───────────────┘ └─────────────┘
```

## Creating a Release (Recommended: Tags)

```bash
# Make sure your local master is up to date
git checkout master
git pull origin master

# Create and push a release tag
git tag v0.0.3
git push origin v0.0.3
```

This triggers the GitHub Actions workflow in `.github/workflows/release.yml` which:

- Builds the Tauri app for macOS (universal)
- Produces:
  - `.dmg` (installer)
  - `.app.tar.gz` (Tauri auto-updater bundle)
  - `.app.tar.gz.sig` (signature)
  - `latest.json` (Tauri updater manifest)
- Creates a GitHub Release for `vX.Y.Z` and uploads the assets

### Manual Release (workflow_dispatch)

You can also trigger a release manually:

1. Go to **Actions → Release → Run workflow**
2. Provide `version` (e.g., `0.0.3`)

## Version Source of Truth

- **Release version**: the pushed tag `vX.Y.Z`
- **Build-time app version**: the workflow updates `apps/desktop/src-tauri/tauri.conf.json` to match the tag before building.
- **Local builds**: use whatever version is in `tauri.conf.json` unless you update it.

## Required Secrets

The following secrets must be configured in GitHub repository settings:

### Apple Code Signing

| Secret | Description |
|--------|-------------|
| `APPLE_CERTIFICATE` | Base64-encoded Developer ID Application certificate (.p12) |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the .p12 certificate |
| `APPLE_SIGNING_IDENTITY` | Certificate name (e.g., "Developer ID Application: Your Name (TEAMID)") |
| `APPLE_TEAM_ID` | Your Apple Developer Team ID |

### Apple Notarization

| Secret | Description |
|--------|-------------|
| `APPLE_ID` | Your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password from appleid.apple.com |

### Tauri Updater Signing

| Secret | Description |
|--------|-------------|
| `TAURI_PRIVATE_KEY` | Private key for signing update manifests |
| `TAURI_KEY_PASSWORD` | Password for the private key (if encrypted) |

## Generating Secrets

### Apple Developer Certificate

1. Open Keychain Access on macOS
2. Export your "Developer ID Application" certificate as .p12
3. Base64 encode it: `base64 -i certificate.p12 | pbcopy`
4. Add to GitHub secrets as `APPLE_CERTIFICATE`

### App-Specific Password

1. Go to https://appleid.apple.com
2. Sign in and go to Security → App-Specific Passwords
3. Generate a new password for "Calimero Desktop CI"
4. Add to GitHub secrets as `APPLE_APP_SPECIFIC_PASSWORD`

### Tauri Updater Keys

Generate a keypair for signing updates:

```bash
# Generate keypair (saves to ~/.tauri/keys)
pnpm tauri signer generate -w ~/.tauri/calimero-desktop.key

# The public key will be printed - add it to tauri.conf.json
# The private key file contents go to TAURI_PRIVATE_KEY secret
```

Update `apps/desktop/src-tauri/tauri.conf.json`:

```json
{
  "tauri": {
    "updater": {
      "pubkey": "YOUR_PUBLIC_KEY_HERE"
    }
  }
}
```

## Manual Release

See **Manual Release (workflow_dispatch)** above.

## Release Artifacts

Each release includes:

| Artifact | Description |
|----------|-------------|
| `Calimero Desktop_x.x.x_universal.dmg` | Universal macOS installer (Intel + Apple Silicon) |
| `Calimero*.app.tar.gz` | macOS updater bundle (required for Tauri auto-update) |
| `Calimero*.app.tar.gz.sig` | Signature for the updater bundle |
| `latest.json` | Update manifest for the Tauri updater |

## Auto-Update Flow

1. App checks `latest.json` on startup and every hour
2. If new version found, shows notification banner
3. User clicks "Update Now"
4. App downloads `.app.tar.gz`, verifies signature, installs
5. App relaunches to apply the update (may require manual restart in some environments)

## Download Page

The download page at `apps/download-site/`:

- Fetches latest release from GitHub API
- Shows version, release date, and download button
- Automatically updates when new releases are published
- Deployed to GitHub Pages on push to main

### Deployment

The download site deploys automatically via `.github/workflows/deploy-download-site.yml`:

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
- Ensure you pushed a tag matching `v*` (e.g., `v0.0.3`)
- Check Actions logs for the `Release` workflow run

### Update Issues

**"Update check failed"**
- Verify `tauri.conf.json` updater endpoints are correct
- Check GitHub release has `latest.json` attached

**"Signature verification failed"**
- Ensure `TAURI_PRIVATE_KEY` matches the pubkey in `tauri.conf.json`
- Regenerate keypair if compromised

## Security Considerations

1. **Never commit secrets** - All sensitive data in GitHub Secrets
2. **Rotate keys periodically** - Update signing keys annually
3. **Pin action versions** - Use SHA hashes for GitHub Actions
4. **Review before merge** - Require PR reviews for main branch
5. **Audit releases** - Check release artifacts match expected content

## Future Improvements

- [ ] Windows code signing and distribution
- [ ] Linux AppImage/deb/rpm packages
- [ ] Delta updates (smaller download sizes)
- [ ] Release channels (stable, beta, nightly)
- [ ] Crash reporting integration
