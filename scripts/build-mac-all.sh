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

# ── 正式签名 / 公证（可选）──────────────────────────────────────────────────────────
# 只认两个变量，**两个都不是密钥**（真正的密码在 macOS 钥匙串里，见 scripts/macSigning.cjs 顶部）:
#   APPLE_SIGN_IDENTITY   "Developer ID Application: 你的名字 (TEAMID)"
#   FORGE_NOTARY_PROFILE  `xcrun notarytool store-credentials` 存的那个**条目名**
# 两个都不设 → 走今天的老路（ad-hoc 签名，Gatekeeper 照样拦），行为完全不变。
#
# 嫌每次 export 麻烦可以放进 .signing.local.sh（已在 .gitignore 里）。
# ★那个文件里也只该有上面两个变量，**任何时候都别把 App 专用密码写进文件**。
if [ -f .signing.local.sh ]; then
  echo "▸ 读取 .signing.local.sh（未提交，仅本机）"
  # shellcheck disable=SC1091
  . ./.signing.local.sh
fi

SIGN_ARGS=()
if [ -n "${APPLE_SIGN_IDENTITY:-}" ]; then
  # 覆盖 electron-builder.yml 里的 `identity: null`（那是安全默认值，别去改它 —— 见那边的注释）。
  SIGN_ARGS=(-c.mac.identity="${APPLE_SIGN_IDENTITY}")
  echo "▸ 正式签名：${APPLE_SIGN_IDENTITY}"
  if [ -n "${FORGE_NOTARY_PROFILE:-}" ]; then
    echo "▸ 公证凭据：钥匙串条目 '${FORGE_NOTARY_PROFILE}'（密码不在这里，只在钥匙串里）"
  fi
else
  echo "▸ 未配 APPLE_SIGN_IDENTITY → ad-hoc 签名（Gatekeeper 会拦，只适合自己用）"
fi

VER="$(node -p "require('electron/package.json').version")"
MIRROR="https://npmmirror.com/mirrors/electron/${VER}"
CACHE="${HOME}/.cache/myflowforge-electron/${VER}"

fetch_dist() {   # $1 = arch (arm64|x64)
  # NOTE: separate `local` statements — `local a=$1 b=${CACHE}/$a` expands $a before it's assigned,
  # which trips `set -u` ("arch: unbound variable").
  local arch="$1"
  local dir="${CACHE}/${arch}"
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
npx electron-builder --mac --x64 "${SIGN_ARGS[@]+"${SIGN_ARGS[@]}"}"

ARM_DIST="$(fetch_dist arm64)"
echo "▸ arm64 dmg (dist: ${ARM_DIST})…"
npx electron-builder --mac --arm64 -c.electronDist="${ARM_DIST}" "${SIGN_ARGS[@]+"${SIGN_ARGS[@]}"}"

echo ""
echo "▸ built dmgs:"
ls -1 release/*.dmg
# Sanity-check the arm64 app is actually arm64 (not x64 mislabelled).
APP="release/mac-arm64/myFlowForge.app/Contents/MacOS/myFlowForge"
if [ -f "${APP}" ]; then
  echo "▸ arm64 app arch: $(file "${APP}" | sed 's/.*: //')"
fi
