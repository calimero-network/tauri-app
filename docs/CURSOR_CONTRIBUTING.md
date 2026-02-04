# Cursor Contributor Guide for Calimero Desktop

This guide helps contributors get the best experience using Cursor when working on the Calimero Tauri Desktop App.

## Repository Structure

```
.
├── apps/
│   ├── desktop/          # Main Tauri desktop application
│   │   ├── src/          # React TypeScript frontend
│   │   ├── src-tauri/    # Rust Tauri backend
│   │   └── package.json
│   └── download-site/    # Download landing page (separate app)
├── packages/
│   ├── mero-js/          # Pure JavaScript SDK for Calimero
│   └── mero-react/       # React bindings and components
├── scripts/              # Release and build scripts
└── bounties.json         # Available contributor bounties
```

**Key Entry Points:**
- `apps/desktop/src/main.tsx` - React app entry
- `apps/desktop/src/App.tsx` - Main app component
- `apps/desktop/src-tauri/src/main.rs` - Tauri Rust backend
- `packages/mero-js/src/index.ts` - SDK exports
- `packages/mero-react/src/index.ts` - React bindings exports

## Opening the Repo in Cursor

### 1. Clone and Open

```bash
git clone https://github.com/calimero-network/tauri-app.git
cd tauri-app
cursor .
```

### 2. Ensure Toolchain is Available

**Node.js and pnpm:**
```bash
# Check versions
node --version   # Should be >= 18.0.0
pnpm --version   # Should be >= 8.0.0

# Install pnpm if needed
npm install -g pnpm
```

**Rust Toolchain:**
```bash
# Install rustup if not present
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Ensure components are available
rustup component add rustfmt
rustup component add clippy

# Check Rust version
rustc --version
cargo --version
```

**Install Dependencies:**
```bash
pnpm install
```

## Cursor Best Practices

### Using .cursorrules

If you create `.cursorrules` in the repo root, Cursor will use it for context. Recommended rules for this repo:

```
# Calimero Tauri App Conventions

## TypeScript/React
- Use functional components with hooks
- Prefer named exports over default exports for utilities
- Use React Context for global state (ThemeContext, ToastContext)
- Handle errors with proper try-catch and user-friendly messages

## Rust/Tauri
- All Tauri commands return Result<T, String>
- Use #[tauri::command] for IPC functions
- Validate all user input before processing
- Use info!, warn!, error! for logging

## Error Handling
- Frontend: Wrap async operations in try-catch
- Backend: Return descriptive error messages
- Never swallow errors silently
```

### Composer vs Agent

- **Composer (Ctrl+K)**: Use for quick edits, refactoring single files, or asking questions about code
- **Agent (Ctrl+Shift+I)**: Use for multi-file changes, implementing new features, or working on bounties

For bounties, Agent mode is typically better as most bounties span multiple files.

### When to Use Terminal vs In-Editor

- **In-Editor**: Code changes, refactoring, adding tests
- **Terminal**: Running commands, building, testing

Common terminal commands:
```bash
# Development
pnpm dev                    # Start desktop app in dev mode
pnpm build:mero-js         # Build mero-js package
pnpm build:mero-react      # Build mero-react package

# Testing
cargo test                  # Run Rust tests (in src-tauri)
pnpm test                   # Run JS tests (when available)

# Formatting and Linting
cargo fmt                   # Format Rust code
cargo clippy                # Lint Rust code
pnpm lint                   # Lint TypeScript (when configured)
```

## Repo-Specific Workflow

### Building and Running

```bash
# Full build (builds packages first, then desktop app)
pnpm build

# Development with hot reload
pnpm dev:desktop

# Build packages separately (needed before desktop dev)
pnpm build:mero-js
pnpm build:mero-react
```

### Running Tests

```bash
# Rust unit tests
cd apps/desktop/src-tauri
cargo test

# mero-js tests
cd packages/mero-js
pnpm test

# E2E tests (requires running node)
cd packages/mero-js
pnpm test:e2e
```

### Formatting Before Commit

**Always run before committing:**

```bash
# Format Rust code
cd apps/desktop/src-tauri
cargo fmt

# Check Rust lints
cargo clippy -- -D warnings

# TypeScript (manual check until ESLint is configured)
# Review for consistent patterns and remove console.logs
```

### Key Configuration Files

- `apps/desktop/src-tauri/tauri.conf.json` - Tauri app configuration
- `apps/desktop/src-tauri/Cargo.toml` - Rust dependencies
- `apps/desktop/package.json` - Frontend dependencies and scripts
- `packages/mero-js/tsconfig.json` - TypeScript configuration

### Environment Variables

```bash
# Development
TAURI_OPEN_DEVTOOLS=true   # Force devtools open in debug builds
RUST_LOG=debug             # Enable debug logging for Rust

# These are only effective in debug builds - release builds ignore them
```

## Working on Bounties

### 1. Pick a Bounty

Review `bounties.json` in the repo root. Each bounty includes:
- `title`: Brief description
- `description`: Details and what to fix
- `pathHint`: Where to start looking
- `estimatedMinutes`: Expected time
- `category`: Type of work
- `severity`: Priority level

### 2. Understand the Issue

Use Cursor's code navigation:
- Ctrl+Click on functions to jump to definitions
- Search (Ctrl+Shift+F) for related code
- Read the `pathHint` file first
- Trace data flow from entry points

### 3. Make Minimal Changes

- Focus on the specific issue described
- Avoid scope creep into unrelated refactoring
- Keep commits atomic and focused

### 4. Test Your Changes

```bash
# For Rust changes
cd apps/desktop/src-tauri
cargo test
cargo clippy

# For frontend changes
pnpm build:mero-js
pnpm build:mero-react
pnpm build:desktop  # or pnpm dev:desktop to test

# Manual testing
pnpm dev:desktop
# Test the specific feature you changed
```

### 5. Format and Commit

```bash
# Format code
cd apps/desktop/src-tauri && cargo fmt
cd ../..

# Stage and commit with conventional format
git add -A
git commit -m "fix: prevent command injection in create_desktop_shortcut"
# or "feat:", "docs:", "refactor:", "test:", "chore:"

git push origin your-branch-name
```

## Conventional Commits

Use conventional commit format for all commits and PR titles:

```
feat: add new feature
fix: fix a bug
docs: documentation changes
refactor: code restructuring without behavior change
test: adding or updating tests
chore: build scripts, configs, etc.
security: security-related changes
```

Examples:
```
fix: validate node names to prevent path traversal
feat: implement secure token storage using system keychain
docs: add API documentation for mero-js
test: add integration tests for proxy_http_request
security: remove unsafe-inline from CSP policy
```

## Common Patterns in This Codebase

### Tauri IPC Commands

```rust
// Define in main.rs
#[tauri::command]
async fn my_command(param: String) -> Result<MyResponse, String> {
    // Validate input
    if param.is_empty() {
        return Err("Parameter cannot be empty".to_string());
    }
    // Do work
    Ok(MyResponse { ... })
}

// Register in main()
.invoke_handler(tauri::generate_handler![my_command, ...])
```

```typescript
// Call from frontend
import { invoke } from '@tauri-apps/api/tauri';

const result = await invoke<MyResponse>('my_command', { param: 'value' });
```

### React Component Pattern

```tsx
// Functional component with hooks
export default function MyComponent({ onAction }: Props) {
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  const handleClick = async () => {
    setLoading(true);
    try {
      await someAsyncOperation();
      toast.success('Success!');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed');
    } finally {
      setLoading(false);
    }
  };

  return <button onClick={handleClick} disabled={loading}>...</button>;
}
```

### API Client Usage

```typescript
import { apiClient } from '@calimero-network/mero-react';

// Call admin API
const response = await apiClient.node.listApplications();
if (response.error) {
  // Handle error - check for 401
  if (response.error.code === '401') {
    // Redirect to login
  }
  console.error(response.error.message);
  return;
}
// Use response.data
```

## Getting Help

- Check existing issues and PRs on GitHub
- Review the code comments and JSDoc
- Use Cursor's AI to explain unfamiliar patterns
- Look at similar implementations in the codebase

## Security Considerations

When working on this codebase, especially security bounties:

1. **Never trust user input** - validate all parameters
2. **Avoid shell execution** - prefer native APIs when possible
3. **Sanitize paths** - prevent path traversal attacks
4. **Protect tokens** - don't log or expose authentication data
5. **Follow least privilege** - request only needed permissions
