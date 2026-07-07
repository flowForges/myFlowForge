#!/usr/bin/env bash
# Build BOTH macOS dmgs (Intel x64 + Apple-Silicon arm64) in one shot.
#
# Why this exists: electron-builder.yml pins `electronDist` to the locally-installed Electron
# (node_modules/electron/dist) to dodge a proxy-corrupted framework download. On an Intel machine
# that local dist is x64, so a plain `electron-builder --arm64` would wrap x64 Electron in an
# arm64-labelled dmg — a broken Apple-Silicon build. This script fetches the *matching-arch*
# Electron framework from the npmmirror mirror into a cache dir and points electronDist at it for
# the arm64 pass, so the arm64 app is genuinely native (verified below).
#
# Usage: npm run dist:mac-all   (or: bash scripts/build-mac-all.sh)
set -euo pipefail
cd "$(dirname "$0")/.."

VER="$(node -p "require('electron/package.json').version")"
MIRROR="https://npmmirror.com/mirrors/electron/${VER}"
CACHE="${HOME}/.cache/myflowforge-electron/${VER}"

fetch_dist() {   # $1 = arch (arm64|x64)
  local arch="$1" dir="${CACHE}/${arch}"
  if [ -x "${dir}/Electron.app/Contents/MacOS/Electron" ]; then echo "${dir}"; return; fi
  mkdir -p "${dir}"
  local zip="${CACHE}/electron-v${VER}-darwin-${arch}.zip"
  echo "↓ fetching Electron ${VER} darwin-${arch}…" >&2
  curl -fsSL --max-time 600 "${MIRROR}/electron-v${VER}-darwin-${arch}.zip" -o "${zip}"
  unzip -q -o "${zip}" -d "${dir}"
  echo "${dir}"
}

echo "▸ compiling renderer/main (electron-vite build)…"
npm run build

echo "▸ x64 dmg (local dist)…"
npx electron-builder --mac --x64

ARM_DIST="$(fetch_dist arm64)"
echo "▸ arm64 dmg (dist: ${ARM_DIST})…"
npx electron-builder --mac --arm64 -c.electronDist="${ARM_DIST}"

echo ""
echo "▸ built dmgs:"
ls -1 release/*.dmg
# Sanity-check the arm64 app is actually arm64 (not x64 mislabelled).
APP="release/mac-arm64/myFlowForge.app/Contents/MacOS/myFlowForge"
if [ -f "${APP}" ]; then
  echo "▸ arm64 app arch: $(file "${APP}" | sed 's/.*: //')"
fi
