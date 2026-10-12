#!/usr/bin/env bash
# Optional, offline Mandarin fixture generator. No app setup or Provider calls.
set -euo pipefail
cd "$(dirname "$0")/../.."
tools_dir="$(dirname "$PWD")/.cloud-tools"
tts_root="$tools_dir/asr-tts"
if [ -x "$tts_root/usr/bin/espeak-ng" ] && LD_LIBRARY_PATH="$tts_root/usr/lib/x86_64-linux-gnu" "$tts_root/usr/bin/espeak-ng" --path="$tts_root/usr/lib/x86_64-linux-gnu" --version 2>/dev/null; then
  exit 0
fi
if [ "$(uname -m)" != x86_64 ] || ! ( . /etc/os-release; [ "$ID" = debian ] && [ "$VERSION_ID" = 13 ] ); then
  echo 'ASR fixture tools require the supported Debian 13 x86_64 Cloud image.' >&2
  exit 1
fi
mkdir -p "$tools_dir/tmp" "$tts_root"
work_dir=$(mktemp -d "$tools_dir/tmp/asr-tts-install.XXXXXX")
trap 'rm -rf "$work_dir"' EXIT
mkdir -p "$work_dir/parts" "$work_dir/lists/partial" "$work_dir/cache/archives/partial" "$work_dir/packages"
cat > "$work_dir/apt.conf" <<EOF
Dir::Etc::parts "$work_dir/parts";
Dir::Etc::main "-";
Dir::Etc::sourcelist "$work_dir/source.list";
Dir::Etc::sourceparts "$work_dir/parts";
Dir::State::lists "$work_dir/lists";
Dir::Cache "$work_dir/cache";
EOF
printf '%s\n' 'deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://deb.debian.org/debian trixie main' > "$work_dir/source.list"
export APT_CONFIG="$work_dir/apt.conf"
apt-get update
(cd "$work_dir/packages"
  apt-get download espeak-ng espeak-ng-data libespeak-ng1 libpcaudio0 libsonic0
  for package in *.deb; do dpkg-deb -x "$package" "$tts_root"; done)
LD_LIBRARY_PATH="$tts_root/usr/lib/x86_64-linux-gnu" "$tts_root/usr/bin/espeak-ng" --path="$tts_root/usr/lib/x86_64-linux-gnu" --voices=cmn
