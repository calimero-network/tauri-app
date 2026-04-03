#!/usr/bin/env bash
# Run a single Playwright test (or matching tests) in UI mode.
# Usage (from this directory):
#   ./single-test.sh "clicking Nodes navigates to nodes page"
#   ./single-test.sh "Sidebar navigation — developer mode"
# Grep is substring match against full test title (describe + test name).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ -z "${1:-}" ]]; then
  echo "Usage: $0 \"name or grep pattern for the test\""
  echo "Example: $0 \"clicking Nodes navigates to nodes page\""
  exit 1
fi

pnpm exec playwright test -g "$1" --ui
