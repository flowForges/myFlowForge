#!/usr/bin/env bash
# 并排测试包(mff-ai):装在正式版旁边,什么都不共用。只打**本机架构**一个 dmg,ad-hoc 签名,不公证。
#   · 产品名 / bundle id:myFlowForge Test / com.zghua.myflowforge.test
#     (Electron 的 userData、单实例锁、Safe Storage 都跟着 app 名走 —— 打进包里的 package.json 的 productName,
#      所以 extraMetadata 也要改;只改 -c.productName 只换 .app 的名字)
#   · MFF_SYS_DIR_NAME=.myFlowForge-test:app 数据目录、mff-ai 数据目录、自启动 id、钥匙串账号都从它派生
#   · MFF_TEST_BUILD=1:main 里不检查 / 不下载更新(src/main/config/buildFlavor.ts)
#   · 不登记任何 URL scheme(electron-builder.yml 本来就没有,这里也不加)
#   · 产物在 release-test/,不碰正式包的 release/
#
# Usage: npm run dist:mac-test
set -euo pipefail
cd "$(dirname "$0")/.."

# 测试包永远 ad-hoc:不读签名配置,也不让外面 export 的身份漏进来
unset APPLE_SIGN_IDENTITY FORGE_NOTARY_PROFILE

export MFF_TEST_BUILD=1
export MFF_SYS_DIR_NAME=.myFlowForge-test

case "$(uname -m)" in
  x86_64) ARCH=x64; FILE_ARCH=x86_64 ;;
  arm64) ARCH=arm64; FILE_ARCH=arm64 ;;
  *) echo "✗ 不认识的架构 $(uname -m)"; exit 1 ;;
esac

DIST="$(node scripts/electronDist.mjs darwin "${ARCH}")"

echo "▸ compiling (MFF_TEST_BUILD=1, MFF_SYS_DIR_NAME=${MFF_SYS_DIR_NAME})…"
npm run build

echo "▸ ${ARCH} dmg (dist: ${DIST})…"
npx electron-builder --mac "--${ARCH}" --publish never \
  -c.electronDist="${DIST}" \
  -c.productName="myFlowForge Test" \
  -c.extraMetadata.productName="myFlowForge Test" \
  -c.appId=com.zghua.myflowforge.test \
  -c.directories.output=release-test \
  -c.mac.artifactName='myFlowForge-Test-${version}-${arch}.${ext}' \
  -c.dmg.title='myFlowForge Test ${version}'

OUT=release-test/mac
[ "${ARCH}" = arm64 ] && OUT=release-test/mac-arm64
APP="${OUT}/myFlowForge Test.app"
BIN="${APP}/Contents/MacOS/myFlowForge Test"
[ -f "${BIN}" ] || { echo "✗ 找不到 ${BIN}"; exit 1; }
got="$(file "${BIN}" | sed 's/.*: //')"
case "${got}" in *"${FILE_ARCH}"*) echo "  ✓ arch: ${got}" ;; *) echo "✗ 架构不对:${got}"; exit 1 ;; esac
id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "${APP}/Contents/Info.plist")"
[ "${id}" = com.zghua.myflowforge.test ] || { echo "✗ bundle id 是 ${id}"; exit 1; }
if /usr/libexec/PlistBuddy -c 'Print :CFBundleURLTypes' "${APP}/Contents/Info.plist" >/dev/null 2>&1; then echo "✗ Info.plist 里有 CFBundleURLTypes"; exit 1; fi
# SYS_DIR 落在 main 的共享 chunk 里,不一定在 index.js —— 整个 out/main 找
grep -rq 'sysDirName(".myFlowForge-test")' "${APP}/Contents/Resources/app/out/main" || { echo "✗ main 里没有 .myFlowForge-test"; exit 1; }
grep -q '"productName": "myFlowForge Test"' "${APP}/Contents/Resources/app/package.json" || { echo "✗ 包里 package.json 的 productName 不是 myFlowForge Test(userData 会和正式包撞)"; exit 1; }
echo "  ✓ ${id},无 URL scheme,数据目录 ~/${MFF_SYS_DIR_NAME}"

echo ""
ls -1 release-test/*.dmg
