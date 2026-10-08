#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
repo_dir=$PWD
tools_dir="$(dirname "$repo_dir")/.cloud-tools"

echo '[cloud setup] 1/5 supported runtime and clean checkout'
node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<13))throw Error("Node >=22.13.0 required")'
node --input-type=module -e 'import {assertCleanConfig} from "./scripts/cloud/environment.mjs";assertCleanConfig(process.cwd())'
# The retained Redis packages and Chromium baseline target this Cloud image.
if [ "$(uname -m)" != x86_64 ] || ! ( . /etc/os-release; [ "$ID" = debian ] && [ "$VERSION_ID" = 13 ] ); then
  echo 'Cloud setup requires the verified Debian 13 x86_64 image; do not reuse its binaries on another OS.' >&2
  exit 1
fi
mkdir -p "$tools_dir/bin" "$tools_dir/tmp"
packages=()
command -v make >/dev/null && command -v g++ >/dev/null || packages+=(build-essential)
test -x /usr/bin/chromium || packages+=(chromium)
python_command=$(command -v python3 || true)
if [ -z "$python_command" ] || ! "$python_command" -c 'import venv,ensurepip' 2>/dev/null; then
  packages+=(python3 python3-venv)
  python_command=/usr/bin/python3
fi
if [ ${#packages[@]} -gt 0 ]; then
  elevate=()
  if [ "$(id -u)" != 0 ]; then
    if ! command -v sudo >/dev/null || ! sudo -n true; then
      echo "Base image is missing system prerequisites: ${packages[*]}; system package installation permission is required." >&2
      exit 1
    fi
    elevate=(sudo -n)
  fi
  "${elevate[@]}" apt-get update
  "${elevate[@]}" apt-get install -y --no-install-recommends "${packages[@]}"
fi
"$python_command" -c 'import venv,ensurepip'

echo '[cloud setup] 2/5 verified Redis tools'
# User-space installation uses official signed Debian metadata and HTTPS.
# Never use Ubuntu/another distribution's older libc with these packages.
if [ ! -x "$tools_dir/redis/usr/bin/redis-server" ] || [ ! -x "$tools_dir/redis/usr/bin/redis-cli" ]; then
  apt_root="$tools_dir/apt"
  mkdir -p "$apt_root/lists/partial" "$apt_root/cache/archives/partial" "$tools_dir/redis-packages"
  source_file=$(mktemp "$apt_root/redis-source.XXXXXX")
  package_dir=$(mktemp -d "$tools_dir/redis-packages/install.XXXXXX")
  printf '%s\n' 'deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://deb.debian.org/debian trixie main' > "$source_file"
  apt_args=(-o "Dir::Etc::sourcelist=$source_file" -o Dir::Etc::sourceparts=- -o "Dir::State::lists=$apt_root/lists" -o "Dir::Cache=$apt_root/cache")
  apt-get "${apt_args[@]}" update
  (cd "$package_dir"
    apt-get "${apt_args[@]}" download redis-server redis-tools liblzf1 libjemalloc2
    for package in *.deb; do dpkg-deb -x "$package" "$tools_dir/redis"; done)
  rm "$source_file"
fi
for binary in redis-server redis-cli; do
  wrapper_tmp=$(mktemp "$tools_dir/tmp/redis-wrapper.XXXXXX")
  legacy_tmp=$(mktemp "$tools_dir/tmp/redis-legacy.XXXXXX")
  # Derive the retained library directory from the wrapper's own location.
  printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'redis_root="$(cd "$(dirname "$0")/../redis" && pwd)"' 'export LD_LIBRARY_PATH="$redis_root/usr/lib/x86_64-linux-gnu"' "exec \"\$redis_root/usr/bin/$binary\" \"\$@\" " > "$wrapper_tmp"
  printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' "export LD_LIBRARY_PATH=$tools_dir/redis/usr/lib/x86_64-linux-gnu" "exec $tools_dir/redis/usr/bin/$binary \"\$@\"" > "$legacy_tmp"
  if [ -e "$tools_dir/bin/$binary" ] && ! cmp -s "$wrapper_tmp" "$tools_dir/bin/$binary" && ! cmp -s "$legacy_tmp" "$tools_dir/bin/$binary"; then
    rm "$wrapper_tmp" "$legacy_tmp"
    echo "Refusing to overwrite unknown $binary wrapper" >&2
    exit 1
  fi
  cp "$wrapper_tmp" "$tools_dir/bin/$binary"
  chmod +x "$tools_dir/bin/$binary"
  rm "$wrapper_tmp" "$legacy_tmp"
done

echo '[cloud setup] 3/5 locked JavaScript dependencies'
npm ci --no-audit --no-fund --cache "$(dirname "$repo_dir")/.npm"

echo '[cloud setup] 4/5 project Python requirements'
if [ ! -x .venv/bin/python ]; then "$python_command" -m venv .venv; fi
.venv/bin/python -m pip install --cache-dir "$(dirname "$repo_dir")/.pip-cache" -r requirements.txt

echo '[cloud setup] 5/5 native tools and retained system browser'
# cloudEnvironment owns tool discovery, including Python and Redis, for every
# runtime command. No task-local activation file or Playwright download.
node scripts/cloud/preflight.mjs
node --input-type=module <<'JS'
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)('playwright');
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});
try {console.log('[cloud setup] Chromium '+browser.version());} finally {await browser.close();}
JS
# No .env creation, application data, service startup, build or Provider calls.
