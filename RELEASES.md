# Release Process

This document describes the release process for Calimero Desktop, including automated builds, code signing, notarization, and distribution.

## Overview

Calimero Desktop uses a fully automated release pipeline:

1. **Semantic Versioning**: Versions are determined automatically from commit messages using [Conventional Commits](https://www.conventionalcommits.org/)
2. **Automated Builds**: GitHub Actions builds signed macOS DMGs
3. **Code Signing & Notarization**: Apps are signed with Apple Developer ID and notarized
4. **Auto-Updates**: The installed app checks for and installs updates automatically
5. **Download Page**: A static landing page always shows the latest release

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  Commit to main │ ──▶ │  GitHub Actions  │ ──▶ │   GitHub Release    │
│  (conventional) │     │  semantic-release│     │   + DMG + manifest  │
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

## Commit Message Convention

We use [Conventional Commits](https://www.conventionalcommits.org/) to determine version bumps:

| Commit Type | Version Bump | Example |
|-------------|--------------|---------|
| `feat:` | Minor (0.x.0) | `feat: add context export feature` |
| `fix:` | Patch (0.0.x) | `fix: resolve login timeout issue` |
| `perf:` | Patch | `perf: optimize context loading` |
| `refactor:` | Patch | `refactor: simplify auth flow` |
| `BREAKING CHANGE:` | Major (x.0.0) | `feat!: redesign API` |

### Examples

```bash
# Feature (minor bump: 1.0.0 → 1.1.0)
git commit -m "feat: add application marketplace"

# Bug fix (patch bump: 1.1.0 → 1.1.1)
git commit -m "fix: resolve node connection timeout"

# Breaking change (major bump: 1.1.1 → 2.0.0)
git commit -m "feat!: redesign authentication system

BREAKING CHANGE: The auth token format has changed."

# No release (docs, chore without deps scope)
git commit -m "docs: update README"
git commit -m "chore: update linting rules"
```

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

To trigger a release manually:

1. Go to Actions → Release workflow
2. Click "Run workflow"
3. Optionally enable "dry run" to preview without releasing

## Release Artifacts

Each release includes:

| Artifact | Description |
|----------|-------------|
| `Calimero Desktop_x.x.x_universal.dmg` | Universal macOS installer (Intel + Apple Silicon) |
| `latest.json` | Update manifest for Tauri updater |
| `CHANGELOG.md` | Auto-generated changelog |

## Auto-Update Flow

1. App checks `latest.json` on startup and every hour
2. If new version found, shows notification banner
3. User clicks "Update Now"
4. App downloads new DMG, verifies signature
5. App restarts with new version

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
- Ensure commits follow conventional commit format
- Check that commits include releasable types (feat, fix, perf)

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
