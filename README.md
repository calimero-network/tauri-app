# Calimero Desktop Platforms

Monorepo for Calimero desktop applications built with Tauri.

## Structure

```
.
├── apps/
│   └── desktop/          # Tauri desktop application
├── packages/
│   └── mero-js/          # Mero-js SDK package (workspace)
└── pnpm-workspace.yaml  # Workspace configuration
```

## Prerequisites

- Node.js >= 18.0.0
- pnpm >= 8.0.0
- Rust (for Tauri)

## Development

### Desktop App

```bash
# Start development server (builds mero-js first)
pnpm dev:desktop

# Build for production (builds mero-js first)
pnpm build:desktop

# Run Tauri commands
pnpm tauri:desktop [command]
```

### Mero-js Package

```bash
# Build mero-js package
pnpm build:mero-js
```

## Workspace Scripts

- `pnpm dev` - Build mero-js and start desktop app development
- `pnpm build` - Build mero-js and desktop app
- `pnpm build:mero-js` - Build mero-js package only
- `pnpm clean` - Clean all build artifacts and node_modules
