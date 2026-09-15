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
  # ★★electron-builder **不接受完整的证书 CN**:传 "Developer ID Application: 张三 (TEAM)" 会得到
  #   `⨯ Please remove prefix "Developer ID Application:" …`,它要的是去掉前缀那半截。
  #   ★而这个错误**退出码是 0** —— 2026-09-15 实测:构建"成功"、产出一个**完全没签名**的包
  #   (`spctl` 说 `source=no usable signature`),而 afterSign 因为签名步骤压根没跑所以也没触发。
  #   所以这里自动剥前缀:环境变量里让你填 `security find-identity` 原样打印的那一串(完整 CN,
  #   signingPlan 靠前缀拦住"拿开发证书当分发证书"),到这里再转成 electron-builder 要的形式。
  EB_IDENTITY="${APPLE_SIGN_IDENTITY#Developer ID Application: }"
  SIGN_ARGS=(-c.mac.identity="${EB_IDENTITY}")
  echo "▸ 正式签名：${APPLE_SIGN_IDENTITY}"
  if [ -n "${FORGE_NOTARY_PROFILE:-}" ]; then
    # ★★开打之前先验一次凭据。2026-09-15 实测:钥匙串里那个条目**会消失**(原因未查明),
    #  而失败点在 afterSign —— 也就是编译 + 签名 + 打 zip 全做完之后。整整二十多分钟才换来一句
    #  `No Keychain password item found`。一个两秒钟能做的检查,不该放在二十分钟之后。
    echo "▸ 公证凭据：验证钥匙串条目 '${FORGE_NOTARY_PROFILE}'…"
    if ! probe="$(xcrun notarytool history --keychain-profile "${FORGE_NOTARY_PROFILE}" 2>&1)"; then
      echo "✗ 公证凭据不可用:"
      echo "${probe}" | sed 's/^/    /'
      echo ""
      echo "  重新存一次(密码只在你自己终端里输,不会进命令行和 history):"
      echo "    xcrun notarytool store-credentials \"${FORGE_NOTARY_PROFILE}\" \\"
      echo "      --apple-id \"<你的 Apple ID>\" --team-id \"<Team ID>\""
      exit 1
    fi
    echo "  ✓ 凭据可用（密码只在钥匙串里，这里只用到条目名）"
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

# ★★★出包之后必须自己验一遍,不能信 electron-builder 的退出码。
#  它在「identity 形式不对」时会打印 ⨯ 然后**以 0 退出**,于是整条流水线"绿着"产出一个裸包。
#  afterSign 那套验收在这种情况下根本不会触发(签名步骤没跑)——所以这道闸必须在构建之外。
if [ -n "${APPLE_SIGN_IDENTITY:-}" ]; then
  echo ""
  echo "▸ 验收:Gatekeeper 自己判(这才是「别人下载会不会被拦」的唯一证据)"
  for APP in release/mac/*.app release/mac-arm64/*.app; do
    [ -d "${APP}" ] || continue
    if ! out="$(spctl -a -vvv -t exec "${APP}" 2>&1)"; then
      echo "✗ ${APP} 没通过 Gatekeeper:"
      echo "${out}" | sed 's/^/    /'
      exit 1
    fi
    echo "  ✓ $(basename "$(dirname "${APP}")")/$(basename "${APP}"): $(echo "${out}" | tr '\n' ' ')"
  done
fi

echo ""
echo "▸ built dmgs:"
ls -1 release/*.dmg
# Sanity-check the arm64 app is actually arm64 (not x64 mislabelled).
APP="release/mac-arm64/myFlowForge.app/Contents/MacOS/myFlowForge"
if [ -f "${APP}" ]; then
  echo "▸ arm64 app arch: $(file "${APP}" | sed 's/.*: //')"
fi
