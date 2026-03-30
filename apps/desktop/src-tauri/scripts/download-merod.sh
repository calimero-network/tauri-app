#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

node "$DESKTOP_DIR/scripts/prepare-merod.mjs"
