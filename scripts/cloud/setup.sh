#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
echo '[cloud setup] 1/4 runtime and checkout'
node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<13))throw Error("Node >=22.13 required; use .nvmrc")'
# Environment setup installs tools only; the preview command owns Redis on port 6380.
if ! command -v redis-server >/dev/null || ! command -v make >/dev/null || ! command -v g++ >/dev/null || ! command -v python3 >/dev/null; then
  elevate=()
  if [ "$(id -u)" != 0 ]; then elevate=(sudo -n); fi
  "${elevate[@]}" apt-get update
  "${elevate[@]}" apt-get install -y --no-install-recommends redis-server build-essential python3
fi
echo '[cloud setup] 2/4 locked JavaScript dependencies'
npm ci --no-audit --no-fund
echo '[cloud setup] 3/4 project Playwright Chromium (not platform browser use)'
node node_modules/@playwright/test/cli.js install --with-deps chromium
echo '[cloud setup] 4/4 native tools'
node scripts/cloud/preflight.mjs
# No build, full suite, Provider request or user data is part of installation.
