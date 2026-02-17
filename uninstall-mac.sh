#!/bin/bash
# Uninstall script for Calimero Desktop (Tauri app) on macOS
# Removes the installed app and all associated data/caches

set -e

APP_NAME="Calimero Desktop"
BUNDLE_ID="network.calimero.desktop"

echo "=== Uninstalling $APP_NAME ==="

# Kill the app if running
if pgrep -f "$APP_NAME" > /dev/null 2>&1; then
    echo "Stopping $APP_NAME..."
    pkill -f "$APP_NAME" || true
    sleep 1
fi

REMOVED=0

# Remove from /Applications
if [ -d "/Applications/${APP_NAME}.app" ]; then
    echo "Removing /Applications/${APP_NAME}.app"
    rm -rf "/Applications/${APP_NAME}.app"
    REMOVED=1
fi

# Remove from ~/Applications
if [ -d "$HOME/Applications/${APP_NAME}.app" ]; then
    echo "Removing ~/Applications/${APP_NAME}.app"
    rm -rf "$HOME/Applications/${APP_NAME}.app"
    REMOVED=1
fi

# Tauri app data & config directories
DIRS_TO_REMOVE=(
    "$HOME/Library/Application Support/${BUNDLE_ID}"
    "$HOME/Library/Application Support/${APP_NAME}"
    "$HOME/Library/Caches/${BUNDLE_ID}"
    "$HOME/Library/Caches/${APP_NAME}"
    "$HOME/Library/Preferences/${BUNDLE_ID}.plist"
    "$HOME/Library/Saved Application State/${BUNDLE_ID}.savedState"
    "$HOME/Library/WebKit/${BUNDLE_ID}"
    "$HOME/Library/Logs/${BUNDLE_ID}"
)

for dir in "${DIRS_TO_REMOVE[@]}"; do
    if [ -e "$dir" ]; then
        echo "Removing $dir"
        rm -rf "$dir"
        REMOVED=1
    fi
done

# Clean build artifacts in this repo
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIRS=(
    "$SCRIPT_DIR/apps/desktop/src-tauri/target"
    "$SCRIPT_DIR/apps/desktop/dist"
)

for dir in "${BUILD_DIRS[@]}"; do
    if [ -d "$dir" ]; then
        echo "Removing build artifacts: $dir"
        rm -rf "$dir"
        REMOVED=1
    fi
done

if [ "$REMOVED" -eq 0 ]; then
    echo "Nothing found to remove."
else
    echo ""
    echo "=== $APP_NAME has been uninstalled ==="
fi
