# Calimero Desktop Platforms

Monorepo for Calimero desktop applications built with Tauri.

## Download

**[Download Calimero Desktop for macOS](https://github.com/calimero-network/tauri-app/releases/latest)**

## Structure

```
.
├── apps/
│   ├── desktop/          # Tauri desktop application
│   └── download-site/    # Download landing page
├── packages/
│   ├── mero-js/          # Mero-js SDK package (workspace)
│   └── mero-react/       # React bindings and components
└── pnpm-workspace.yaml   # Workspace configuration
```

## Prerequisites

- Node.js >= 18.0.0
- pnpm >= 8.0.0
- Rust (for Tauri)

## Development

### Desktop App

```bash
# Install dependencies
pnpm install

# Build SDK packages first
pnpm build:mero-js
pnpm build:mero-react

# Start development server
pnpm dev:desktop

# Start with DevTools forced ON
pnpm dev:desktop:devtools

# Start with DevTools forced OFF
pnpm dev:desktop:no-devtools

# Build for production (builds mero-js first)
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

```bash
# Build mero-js package
pnpm build:mero-js

# Build mero-react package
pnpm build:mero-react
```

## Workspace Scripts

| Script                  | Description                                      |
| ----------------------- | ------------------------------------------------ |
| `pnpm dev`              | Build packages and start desktop app development |
| `pnpm build`            | Build all packages and desktop app               |
| `pnpm build:mero-js`    | Build mero-js SDK package                        |
| `pnpm build:mero-react` | Build mero-react package                         |
| `pnpm clean`            | Clean all build artifacts and node_modules       |

## Auto-Updates

The desktop app automatically checks for updates on startup and periodically. When a new version is available, you'll see a notification with options to update immediately or later.

## Releases

Releases are automated using semantic versioning based on commit messages:

- `feat:` commits trigger minor version bumps
- `fix:` commits trigger patch version bumps
- `BREAKING CHANGE:` triggers major version bumps

See [RELEASES.md](./RELEASES.md) for detailed release process documentation.

## Documentation

- [Releases](./RELEASES.md) - Release process and CI/CD documentation
