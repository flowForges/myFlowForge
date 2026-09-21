#!/usr/bin/env bash
# Build BOTH macOS dmgs (Intel x64 + Apple-Silicon arm64) in one shot.
#
# Why this exists: each arch's dmg must be built from THAT arch's Electron. Both passes get their
# Electron from scripts/electronDist.mjs (npmmirror + verified against the official SHASUMS256.txt)
# and pass it as -c.electronDist — electron-builder.yml deliberately pins nothing. The arch of each
# resulting app is then checked from the binary itself (`file`), and a mismatch fails the build.
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
  # ★★2026-09-16:公证优先走 App Store Connect API 密钥(钥匙串那个条目消失过两次,
  #  原因始终没查明 —— 见 scripts/macSigning.cjs)。密钥在 ~/.appstoreconnect/,仓库里没有。
  ASC_ENV="$HOME/.appstoreconnect/asc.env"
  if [ -f "$ASC_ENV" ]; then
    # shellcheck disable=SC1090
    . "$ASC_ENV"
    ASC_KEY="$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8"
    echo "▸ 公证凭据：App Store Connect API 密钥 ${ASC_KEY_ID}"
    # 预检照旧 —— 两秒钟的事,不该等二十分钟的构建跑完才发现凭据不可用。
    if ! probe="$(xcrun notarytool history --key "$ASC_KEY" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" 2>&1)"; then
      echo "✗ API 密钥不可用:"
      echo "${probe}" | sed 's/^/    /'
      exit 1
    fi
    echo "  ✓ 凭据可用"
  elif [ -n "${FORGE_NOTARY_PROFILE:-}" ]; then
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

# ★★两个架构都取**对应架构**的 Electron,并按官方校验和验过(scripts/electronDist.mjs)。
#  以前 x64 这一轮用的是 electron-builder.yml 里钉死的 node_modules/electron/dist(本机那份),
#  那一行现在删了 —— 它正是「Intel 上打 arm64 包、构建全绿、里面是 x86_64」的根源。
#  (失败时 electronDist.mjs 以非零退出,`set -e` 会让这里当场停下。)
X64_DIST="$(node scripts/electronDist.mjs darwin x64)"
ARM_DIST="$(node scripts/electronDist.mjs darwin arm64)"

echo "▸ compiling renderer/main (electron-vite build)…"
npm run build

echo "▸ x64 dmg (dist: ${X64_DIST})…"
npx electron-builder --mac --x64 -c.electronDist="${X64_DIST}" "${SIGN_ARGS[@]+"${SIGN_ARGS[@]}"}"

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
echo "▸ 验收:架构只认二进制本身(文件名说明不了任何事)"
# ★以前这里只**打印** arm64 的架构,不判断 —— 打印出 x86_64 也照样绿着结束。现在两个都判,不对就失败。
check_arch() {   # $1 = 目录名(mac|mac-arm64)  $2 = file 输出里应出现的架构
  local bin="release/$1/myFlowForge.app/Contents/MacOS/myFlowForge"
  [ -f "${bin}" ] || { echo "✗ 找不到 ${bin}"; exit 1; }
  local got
  got="$(file "${bin}" | sed 's/.*: //')"
  case "${got}" in
    *"$2"*) echo "  ✓ $1: ${got}" ;;
    *) echo "✗ $1 的架构不对:${got}(应含 $2)"; exit 1 ;;
  esac
}
check_arch mac x86_64
check_arch mac-arm64 arm64

echo ""
echo "▸ built dmgs:"
ls -1 release/*.dmg
