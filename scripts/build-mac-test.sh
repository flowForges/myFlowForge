#!/usr/bin/env bash
# 并排测试包:装在正式版旁边,什么都不共用(数据目录、bundle id、TCC 记录、Keychain 条目都分开)。
#   · 默认只打**本机架构**一个 dmg,ad-hoc 签名,不公证(只适合本机)
#   · MFF_TEST_ARCHS="x64 arm64":两个架构都打
#   · MFF_TEST_SIGN=1:走正式包的 Developer ID 签名 + 公证(拿到别的电脑上装,Gatekeeper 不拦)
#   · MFF_TEST_VERSION=1.3.0-beta:包里的版本号(不改仓库的 package.json)
#   · 产品名 / bundle id:myFlowForge Test / com.zghua.myflowforge.test
#     (Electron 的 userData、单实例锁、Safe Storage 都跟着 app 名走 —— 打进包里的 package.json 的 productName,
#      所以 extraMetadata 也要改;只改 -c.productName 只换 .app 的名字)
#   · MFF_SYS_DIR_NAME=.myFlowForge-test:app 数据目录从它派生
#   · MFF_TEST_BUILD=1:main 里不检查 / 不下载更新(src/main/config/buildFlavor.ts)
#   · 不登记任何 URL scheme(electron-builder.yml 本来就没有,这里也不加)
#   · forge-cu(电脑操作 helper)照常编译并随包验收;bundle id 不同 → 屏幕录制 / 辅助功能要在这个包上单独授权一次
#   · 产物在 release-test/,不碰正式包的 release/
#
# Usage: npm run dist:mac-test
set -euo pipefail
cd "$(dirname "$0")/.."

# 没要签名就永远 ad-hoc:不读签名配置,也不让外面 export 的身份漏进来
SIGN_ARGS=()
if [ "${MFF_TEST_SIGN:-}" = 1 ]; then
  [ -f .signing.local.sh ] && . ./.signing.local.sh
  [ -n "${APPLE_SIGN_IDENTITY:-}" ] || { echo "✗ MFF_TEST_SIGN=1 但没有 APPLE_SIGN_IDENTITY"; exit 1; }
  SIGN_ARGS=(-c.mac.identity="${APPLE_SIGN_IDENTITY#Developer ID Application: }")
  echo "▸ 签名 + 公证:${APPLE_SIGN_IDENTITY}"
else
  unset APPLE_SIGN_IDENTITY FORGE_NOTARY_PROFILE
fi
VERSION_ARGS=()
if [ -n "${MFF_TEST_VERSION:-}" ]; then
  [[ "${MFF_TEST_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || { echo "✗ MFF_TEST_VERSION 不是 semver:${MFF_TEST_VERSION}"; exit 1; }
  VERSION_ARGS=(-c.extraMetadata.version="${MFF_TEST_VERSION}")
fi

export MFF_TEST_BUILD=1
export MFF_SYS_DIR_NAME=.myFlowForge-test

case "$(uname -m)" in
  x86_64) HOST=x64 ;;
  arm64) HOST=arm64 ;;
  *) echo "✗ 不认识的架构 $(uname -m)"; exit 1 ;;
esac
ARCHS="${MFF_TEST_ARCHS:-${HOST}}"

echo "▸ compiling (MFF_TEST_BUILD=1, MFF_SYS_DIR_NAME=${MFF_SYS_DIR_NAME})…"
npm run build

# computer-use helper (universal Swift binary → build/native/darwin/forge-cu → Resources/native/forge-cu).
# --require: no swiftc must fail here, not ship a test package without its helper.
echo "▸ forge-cu helper (swiftc x86_64 + arm64 → lipo)…"
node scripts/build-cu-helper.mjs --require

for ARCH in ${ARCHS}; do
  case "${ARCH}" in
    x64) FILE_ARCH=x86_64; OUT=release-test/mac ;;
    arm64) FILE_ARCH=arm64; OUT=release-test/mac-arm64 ;;
    *) echo "✗ 不认识的架构 ${ARCH}"; exit 1 ;;
  esac
  DIST="$(node scripts/electronDist.mjs darwin "${ARCH}")"
  echo "▸ ${ARCH} dmg (dist: ${DIST})…"
  npx electron-builder --mac "--${ARCH}" --publish never \
    -c.electronDist="${DIST}" \
    -c.productName="myFlowForge Test" \
    -c.extraMetadata.productName="myFlowForge Test" \
    -c.appId=com.zghua.myflowforge.test \
    -c.directories.output=release-test \
    -c.mac.artifactName='myFlowForge-Test-${version}-${arch}.${ext}' \
    -c.dmg.title='myFlowForge Test ${version}' \
    "${VERSION_ARGS[@]+"${VERSION_ARGS[@]}"}" "${SIGN_ARGS[@]+"${SIGN_ARGS[@]}"}"

  APP="${OUT}/myFlowForge Test.app"
  BIN="${APP}/Contents/MacOS/myFlowForge Test"
  [ -f "${BIN}" ] || { echo "✗ 找不到 ${BIN}"; exit 1; }
  got="$(file "${BIN}" | sed 's/.*: //')"
  case "${got}" in *"${FILE_ARCH}"*) echo "  ✓ arch: ${got}" ;; *) echo "✗ 架构不对:${got}"; exit 1 ;; esac
  id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "${APP}/Contents/Info.plist")"
  [ "${id}" = com.zghua.myflowforge.test ] || { echo "✗ bundle id 是 ${id}"; exit 1; }
  if /usr/libexec/PlistBuddy -c 'Print :CFBundleURLTypes' "${APP}/Contents/Info.plist" >/dev/null 2>&1; then echo "✗ Info.plist 里有 CFBundleURLTypes"; exit 1; fi
  # SYS_DIR 落在 main 的共享 chunk 里,不一定在 index.js —— 整个 out/main 找
  grep -rqF '.myFlowForge-test' "${APP}/Contents/Resources/app/out/main" || { echo "✗ main 里没有 .myFlowForge-test"; exit 1; }
  grep -q '"productName": "myFlowForge Test"' "${APP}/Contents/Resources/app/package.json" || { echo "✗ 包里 package.json 的 productName 不是 myFlowForge Test(userData 会和正式包撞)"; exit 1; }
  # forge-cu: present, carries the built arch, no entitlements (V13)
  CU="${APP}/Contents/Resources/native/forge-cu"
  [ -f "${CU}" ] || { echo "✗ 找不到 ${CU}"; exit 1; }
  cu_archs="$(lipo -archs "${APP}/Contents/Resources/native/forge-cu")"
  case " ${cu_archs} " in *" ${FILE_ARCH} "*) echo "  ✓ forge-cu archs: ${cu_archs}" ;; *) echo "✗ forge-cu 架构不对:${cu_archs}(应含 ${FILE_ARCH})"; exit 1 ;; esac
  node scripts/cuHelperCheck.cjs "${APP}"
  # V14 / M-8:mac.extraResources 是和顶层列表合并,不是替换 —— 宠物包、app 图标、示例插件都还在
  RES="${APP}/Contents/Resources"
  [ -n "$(ls -A "${RES}/app-icons" 2>/dev/null)" ] || { echo "✗ 包里没有 ${RES}/app-icons"; exit 1; }
  [ -n "$(ls -A "${RES}/example-plugins" 2>/dev/null)" ] || { echo "✗ 包里没有 ${RES}/example-plugins"; exit 1; }
  if [ -d assets/pet-packs ]; then
    [ -f "${RES}/builtin-pet-packs/white-catgirl/manifest.json" ] || { echo "✗ 包里没有内置宠物包 manifest"; exit 1; }
    echo "  ✓ Resources: builtin-pet-packs、app-icons、example-plugins 都在 forge-cu 旁边"
  else
    echo "  ▸ 这棵树里没有 assets/pet-packs:跳过内置宠物包检查(app-icons、example-plugins 已验)"
  fi
  if [ -n "${MFF_TEST_VERSION:-}" ]; then
    grep -q "\"version\": \"${MFF_TEST_VERSION}\"" "${APP}/Contents/Resources/app/package.json" || { echo "✗ 包里的版本不是 ${MFF_TEST_VERSION}"; exit 1; }
  fi
  if [ "${MFF_TEST_SIGN:-}" = 1 ]; then
    # electron-builder 签名失败也可能退出 0:Gatekeeper 自己判才算数
    out="$(spctl -a -vvv -t exec "${APP}" 2>&1)" || { echo "✗ ${APP} 没通过 Gatekeeper:"; echo "${out}" | sed 's/^/    /'; exit 1; }
    echo "  ✓ Gatekeeper: $(echo "${out}" | tr '\n' ' ')"
  fi
  echo "  ✓ ${ARCH}: ${id},无 URL scheme,数据目录 ~/${MFF_SYS_DIR_NAME}"
done

echo ""
ls -1 release-test/*.dmg
