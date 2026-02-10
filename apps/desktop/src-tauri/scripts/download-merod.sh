#!/bin/bash

# Download merod binary at build time
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAURI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MEROD_DIR="$TAURI_DIR/merod"
MEROD_BINARY="$MEROD_DIR/merod"

# Detect architecture
ARCH=$(uname -m)
OS=$(uname -s | tr '[:upper:]' '[:lower:]')

echo "Detected architecture: $ARCH on $OS"

# Map architecture to GitHub release asset name
case "$ARCH" in
  arm64|aarch64)
    if [ "$OS" = "darwin" ]; then
      ASSET_NAME="merod_aarch64-apple-darwin.tar.gz"
    else
      echo "Unsupported OS for ARM64: $OS"
      exit 1
    fi
    ;;
  x86_64|amd64)
    if [ "$OS" = "darwin" ]; then
      ASSET_NAME="merod_x86_64-apple-darwin.tar.gz"
    elif [ "$OS" = "linux" ]; then
      ASSET_NAME="merod_x86_64-unknown-linux-gnu.tar.gz"
    else
      echo "Unsupported OS for x86_64: $OS"
      exit 1
    fi
    ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

VERSION="0.10.0-rc.40"
URL="https://github.com/calimero-network/core/releases/download/$VERSION/$ASSET_NAME"

echo "Downloading merod from: $URL"

# Create merod directory if it doesn't exist
mkdir -p "$MEROD_DIR"

# Check if binary already exists and is recent (less than 1 day old)
if [ -f "$MEROD_BINARY" ]; then
  FILE_AGE=$(find "$MEROD_BINARY" -mtime -1 2>/dev/null)
  if [ -n "$FILE_AGE" ]; then
    echo "Merod binary already exists and is recent, skipping download"
    exit 0
  fi
fi

# Download and extract
TEMP_TAR="$MEROD_DIR/temp.tar.gz"
curl -L -o "$TEMP_TAR" "$URL"

# Extract tar.gz
cd "$MEROD_DIR"
tar -xzf "$TEMP_TAR" merod
rm "$TEMP_TAR"

# Make executable
chmod +x "$MEROD_BINARY"

echo "Successfully downloaded merod to $MEROD_BINARY"
