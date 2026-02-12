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

# Fetch latest release tag from GitHub (includes pre-releases)
VERSION=$(curl -sL "https://api.github.com/repos/calimero-network/core/releases?per_page=1" | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -z "$VERSION" ]; then
  echo "Failed to fetch latest release version from GitHub"
  exit 1
fi

URL="https://github.com/calimero-network/core/releases/download/$VERSION/$ASSET_NAME"

echo "Downloading merod $VERSION from: $URL"

# Create merod directory if it doesn't exist
mkdir -p "$MEROD_DIR"

# Remove old binary so we always get the configured VERSION
rm -f "$MEROD_BINARY"

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
