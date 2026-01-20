# Testing Embedded Merod Node

This guide explains how to test the embedded merod node functionality in the Calimero Desktop app.

## Prerequisites

1. **Rust installed** (required for Tauri)
   ```bash
   # Check if Rust is installed
   rustc --version
   
   # If not installed, install from https://rustup.rs/
   ```

2. **Node.js >= 18.0.0 and pnpm >= 8.0.0**
   ```bash
   node --version
   pnpm --version
   ```

3. **Dependencies installed**
   ```bash
   pnpm install
   ```

## Quick Start

### 1. Build SDK Packages (First Time)

```bash
# Build the required SDK packages
pnpm build:mero-js
pnpm build:mero-react
```

### 2. Start the Development App

```bash
# Start with DevTools (recommended for testing)
pnpm dev:desktop:devtools

# Or without DevTools
pnpm dev:desktop
```

The app will open in a window. You should see the main interface.

## Testing Scenarios

### Scenario 1: Download Merod Binary

**Steps:**
1. Open the app
2. Click **⚙️ Settings** button
3. Check the **"Use Embedded Node"** checkbox
4. Click **"Download Merod"** button
5. Wait for download to complete (you'll see a success message)

**Expected Behavior:**
- Download button shows "Loading..." while downloading
- Success alert: "Successfully downloaded and extracted merod to [path]"
- Merod binary is extracted to app data directory

**Verify:**
- Check the console/logs for download progress
- Binary should be at: `~/Library/Application Support/network.calimero.desktop/merod/merod` (macOS)

### Scenario 2: Start Embedded Node

**Steps:**
1. After downloading (or if already downloaded)
2. In Settings, ensure **"Use Embedded Node"** is checked
3. Set port (default: 2528) or leave as default
4. Optionally set a custom data directory
5. Click **"Start Node"** button
6. Wait a few seconds for node to start

**Expected Behavior:**
- Start button shows "Starting..." while starting
- Success alert: "Merod started successfully"
- Status indicator turns green and shows "Running"
- Node URL automatically updates to `http://localhost:[port]`

**Verify:**
- Status indicator shows green dot and "Running"
- Check node health: Open browser to `http://localhost:2528/health` (or your configured port)
- Check console logs for "Merod started with PID: [number]"

### Scenario 3: Stop Embedded Node

**Steps:**
1. With node running (green status)
2. Click **"Stop Node"** button

**Expected Behavior:**
- Stop button shows "Stopping..." while stopping
- Success alert: "Merod stopped successfully"
- Status indicator turns red and shows "Stopped"

**Verify:**
- Status indicator shows red dot and "Stopped"
- Health check should fail: `curl http://localhost:2528/health` (should timeout or error)

### Scenario 4: Auto-Start on App Launch

**Steps:**
1. Enable **"Use Embedded Node"** in Settings
2. Save settings
3. Close the app completely
4. Restart the app

**Expected Behavior:**
- App checks if merod is running
- If not running, automatically starts merod
- Node URL is set to embedded node URL
- App connects to embedded node automatically

**Verify:**
- Check console logs for "🔧 Using embedded node"
- Check logs for "📥 Starting embedded merod node..."
- Status should show "Running" after a few seconds
- Main app should connect successfully

### Scenario 5: Switch Between Embedded and Remote Node

**Steps:**
1. Start with embedded node running
2. Go to Settings
3. Uncheck **"Use Embedded Node"**
4. Enter a remote node URL (e.g., `http://localhost:2528` or remote server)
5. Save settings
6. Restart app

**Expected Behavior:**
- Embedded node can be stopped manually (or left running)
- App connects to remote node URL
- Node URL field becomes editable again

**Verify:**
- App connects to the remote node URL
- Health checks work against remote node

### Scenario 6: Port Configuration

**Steps:**
1. Enable embedded node
2. Change port to a different value (e.g., 8080)
3. Save settings
4. Start node

**Expected Behavior:**
- Node starts on the new port
- Node URL updates to `http://localhost:8080`
- Health check works on new port: `http://localhost:8080/health`

**Verify:**
- Check `http://localhost:8080/health` in browser
- Node URL in settings shows the new port

### Scenario 7: Custom Data Directory

**Steps:**
1. Enable embedded node
2. Enter a custom data directory path (e.g., `/tmp/merod-test`)
3. Save settings
4. Start node

**Expected Behavior:**
- Node uses the custom data directory
- Data is stored at the specified location

**Verify:**
- Check that directory exists and contains merod data files
- Restart node - data should persist

## Debugging Tips

### Check Rust Logs

The Rust backend logs to console. To see more detailed logs:

```bash
# Set log level
export RUST_LOG=debug

# Run app
pnpm dev:desktop:devtools
```

### Check Browser Console

Open DevTools (F12 or Cmd+Option+I) to see:
- Frontend logs
- API call errors
- Tauri command invocations

### Common Issues

1. **"Merod binary not found"**
   - Solution: Click "Download Merod" first

2. **"Merod is already running"**
   - Solution: Stop the existing instance first, or restart the app

3. **Port already in use**
   - Solution: Change port in settings, or stop other merod instance

4. **Download fails**
   - Check internet connection
   - Verify GitHub release URL is accessible
   - Check architecture matches (currently hardcoded to aarch64-apple-darwin)

5. **Node won't start**
   - Check Rust logs for detailed error
   - Verify data directory permissions
   - Check if port is available

### Manual Testing via Browser Console

You can test Tauri commands directly in the browser console:

```javascript
// Check merod status
const { invoke } = await import('@tauri-apps/api/tauri');
await invoke('get_merod_status');

// Start merod
await invoke('start_merod', { port: 2528 });

// Stop merod
await invoke('stop_merod');

// Check health
await invoke('check_merod_health', { nodeUrl: 'http://localhost:2528' });
```

## Testing Checklist

- [ ] Download merod binary successfully
- [ ] Start embedded node
- [ ] Stop embedded node
- [ ] Status indicator updates correctly
- [ ] Auto-start on app launch works
- [ ] Port configuration works
- [ ] Custom data directory works
- [ ] Switch between embedded and remote node works
- [ ] Node health check works
- [ ] App connects to embedded node successfully
- [ ] Settings persist after restart

## Architecture Note

Currently, the download URL is hardcoded to `aarch64-apple-darwin` (Apple Silicon Macs). To test on other architectures:

1. Update the URL in `apps/desktop/src-tauri/src/main.rs` in the `download_merod` function
2. Or add architecture detection logic

## Next Steps

After testing, you may want to:
- Add architecture detection for automatic binary selection
- Add more configuration options (network settings, etc.)
- Add better error handling and user feedback
- Add progress indicators for download/start operations
