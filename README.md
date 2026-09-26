# Calimero Desktop Platforms

Monorepo for Calimero desktop applications built with Tauri.

## Download

**[Download Calimero Desktop](https://calimero.network/download)** - Available for macOS, Windows, and Linux

## Structure

```
.
├── apps/
│   └── desktop/          # Tauri desktop application
└── pnpm-workspace.yaml   # Workspace configuration
```

## Prerequisites

- Node.js >= 22.13
- pnpm >= 11 (pinned via `packageManager`; corepack installs it for you)
- Rust (for Tauri)

## Development

### Desktop App

```bash
# Install dependencies
pnpm install

# Start development server
pnpm dev:desktop

# Build for production
pnpm build:desktop

# Run Tauri commands
pnpm tauri:desktop [command]
```

### SDK Packages

`@calimero-network/mero-js` and `@calimero-network/mero-react` are installed from the npm registry and do not need to be built locally.

## Workspace Scripts

| Script       | Description                          |
| ------------ | ------------------------------------ |
| `pnpm dev`   | Start desktop app development        |
| `pnpm build` | Build the desktop app                |
| `pnpm clean` | Clean all build artifacts and node_modules |

## Auto-Updates

The desktop app automatically checks for updates on startup and periodically. When a new version is available, you'll see a notification with options to update immediately or later.

## Releases

Releases are **tag-based**. Merging a version bump to `master` releases it automatically (it dispatches the release workflow, which tags `vX.Y.Z`); pushing a `vX.Y.Z` tag by hand still works for anything else. The release workflow builds desktop bundles for macOS, Windows, and Linux in parallel and creates a GitHub Release.

See [RELEASES.md](./RELEASES.md) for detailed release process documentation.

## Documentation

- [Releases](./RELEASES.md) - Release process and CI/CD documentation
