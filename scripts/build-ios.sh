#!/usr/bin/env bash
# 打 iOS 分发包(TestFlight 用的 ipa)。**不上传** —— 上传是 scripts/upload-ios.sh,发版要人点头。
#
#   npm run dist:ios
#
# 每一步都有闸,任何一道没过就停,不会产出一个「全绿但装上就崩」的 ipa:
#   1. prebuild(native:check)—— 重新生成 ios/,config plugin 在这里把依赖一致性闸写进 Podfile
#   2. pod install —— 闸:RN 核心预编译、依赖却退回源码 ⇒ 失败(见 mobile/plugins/withPrebuiltRNGuard.js)。
#      那个判断取决于**当时联网查 Maven 的结果**,所以失败后自动重跑,最多 3 次
#   3. archive
#   4. 闸:回读归档里的 .app,每个 @rpath 引用都得在包里(scripts/verify-ios-app.sh)
#   5. export ipa
#   6. 闸:苹果校验(VALIDATE_ONLY,不上传)
#
# ★★第 4 步是 2026-09-21 build 4 事故的正面回答:那个包过了构建、归档、导出、苹果校验、上传,
#  装上一启动就被 dyld 终止。前面那些没有一个会真的把 app 加载起来,所以一个都没拦住。
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
IOS="${ROOT}/mobile/ios"
ARCHIVE="${IOS}/build/myFlowForge.xcarchive"
EXPORT="${IOS}/build/export"

echo "▸ 1/6 prebuild + 原生自检"
npm run --prefix mobile native:check

grep -q "withPrebuiltRNGuard.js" "${IOS}/Podfile" \
  || { echo "✗ Podfile 里没有一致性闸 —— withPrebuiltRNGuard 插件没生效?"; exit 1; }

echo "▸ 2/6 pod install(带一致性闸,失败自动重试)"
ok=0
for attempt in 1 2 3; do
  # 第一次不刷 specs(快);后面两次带 --repo-update,顺带排除「specs 太旧」这类原因
  flags=(); [ "${attempt}" -gt 1 ] && flags=(--repo-update)
  if (cd "${IOS}" && pod install "${flags[@]+"${flags[@]}"}"); then ok=1; break; fi
  echo "  ⚠️  第 ${attempt} 次 pod install 没过,重试…"
done
[ "${ok}" = 1 ] || { echo "✗ pod install 连续 3 次没过"; exit 1; }

# ★★自动签名走 App Store Connect API 密钥(和 upload-ios.sh 同一把),不靠 Xcode 里登没登账号。
#  2026-10-07 打开 iOS 推送时栽的:这台 Mac 的 Xcode 没登账号 → 只能用现成的通配描述文件「*」,
#  而通配描述文件**不可能**带推送能力 —— 报「doesn't include the Push Notifications capability」。
#  给了 API 密钥,Xcode 会自己给 App ID 开推送、生成带推送的描述文件。没有密钥文件时照旧(不加参数)。
AUTH=()
if [ -f "$HOME/.appstoreconnect/asc.env" ]; then
  set -a; . "$HOME/.appstoreconnect/asc.env"; set +a
  KEYF="$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID:-}.p8"
  [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ] && [ -f "$KEYF" ] && \
    AUTH=(-authenticationKeyPath "$KEYF" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
fi

echo "▸ 3/6 archive"
rm -rf "${ARCHIVE}" "${EXPORT}"
# ★不再 `| tail -5`:真正的报错(签名、描述文件)在几千行里,只留最后 5 行等于只看见一句「ARCHIVE FAILED」。
#  全量进日志,失败时把 error: 行挑出来。
ALOG="${IOS}/build/archive.log"; mkdir -p "${IOS}/build"
if ! xcodebuild -workspace "${IOS}/myFlowForge.xcworkspace" -scheme myFlowForge -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "${ARCHIVE}" -allowProvisioningUpdates "${AUTH[@]+"${AUTH[@]}"}" archive \
  > "${ALOG}" 2>&1; then
  grep -E "error:" "${ALOG}" | grep -v DTDK | head -10
  echo "✗ archive 失败,完整日志:${ALOG}"; exit 1
fi
tail -2 "${ALOG}"

echo "▸ 4/6 链接闸:包里的每个 @rpath 引用都得找得到"
bash "${ROOT}/scripts/verify-ios-app.sh" "${ARCHIVE}/Products/Applications/myFlowForge.app"

echo "▸ 5/6 export ipa"
xcodebuild -exportArchive -archivePath "${ARCHIVE}" -exportOptionsPlist "${ROOT}/scripts/ios/ExportOptions.plist" \
  -exportPath "${EXPORT}" | tail -3   # 手动签名,见 ExportOptions.plist
[ -f "${EXPORT}/myFlowForge.ipa" ] || { echo "✗ 没导出 ipa"; exit 1; }

echo "▸ 6/6 苹果校验(不上传)"
VALIDATE_ONLY=1 bash "${ROOT}/scripts/upload-ios.sh" "${EXPORT}/myFlowForge.ipa"

BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "${ARCHIVE}/Products/Applications/myFlowForge.app/Info.plist")"
VER="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "${ARCHIVE}/Products/Applications/myFlowForge.app/Info.plist")"
echo ""
echo "✓ ${VER} (${BUILD}) → ${EXPORT}/myFlowForge.ipa"
echo "  上传前先真机跑一次:  npm run smoke:ios"
echo "  上传:               scripts/upload-ios.sh"
