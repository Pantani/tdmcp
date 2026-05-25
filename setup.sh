#!/usr/bin/env bash
# One-command setup: installs deps, builds, and prints how to connect your AI
# client + switch the TouchDesigner bridge on. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "✖ Node.js is not installed. Get Node 20+ from https://nodejs.org and re-run ./setup.sh"
  exit 1
fi

exec npm run setup
