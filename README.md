# Calimero Desktop Platforms

Monorepo for Calimero desktop applications built with Tauri.

## Download

**[Download Calimero Desktop](https://calimero-network.github.io/tauri-app/)** - Available for macOS, Windows, and Linux

## Structure

```
.
├── apps/
│   ├── desktop/          # Tauri desktop application
│   └── download-site/    # Download landing page
├── packages/
│   └── mero-react/       # React bindings and components
└── pnpm-workspace.yaml   # Workspace configuration
```

**Note:** `mero-js` SDK package has been moved to the repository root as an independent package.

## Prerequisites

- Node.js >= 18.0.0
- pnpm >= 8.0.0
- Rust (for Tauri)

## Development

### Desktop App

```bash
# Install dependencies
pnpm install

# Start development server
pnpm dev:desktop

# Start with DevTools forced ON
pnpm dev:desktop:devtools

# Start with DevTools forced OFF
pnpm dev:desktop:no-devtools

# Build for production
pnpm build:desktop

# Run Tauri commands
pnpm tauri:desktop [command]
```

#### DevTools Control

DevTools can be controlled via environment variables:

- **Default** (`pnpm dev:desktop`): DevTools opens automatically in debug builds
- **Force ON** (`pnpm dev:desktop:devtools`): DevTools always opens
- **Force OFF** (`pnpm dev:desktop:no-devtools`): DevTools never opens

**Important:** Release builds (`.dmg`, `.exe`, etc.) **never** have DevTools enabled, regardless of environment variables. This is enforced at compile time for security.

### Download Site

```bash
# Start download site dev server
cd apps/download-site
pnpm dev

# Build for production
pnpm build
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

Releases are **tag-based**. Pushing a `vX.Y.Z` tag triggers the release workflow, which builds desktop bundles for macOS, Windows, and Linux in parallel and creates a GitHub Release.

See [RELEASES.md](./RELEASES.md) for detailed release process documentation.

## Documentation

- [Releases](./RELEASES.md) - Release process and CI/CD documentation
