#!/usr/bin/env bash
# 上传 TestFlight 之前的**真机冒烟**:把归档里的 .app 装到连着的 iPhone 上,启动,确认它活着。
#
#   npm run smoke:ios            (先跑 npm run dist:ios)
#
# ★★为什么装的是**归档里的 .app**,不另编一个:export 只是给同一批二进制换一个分发签名。
#  测归档里那份 = 测的就是要上传的那些字节;另编一个调试版,测的是另一份东西。
#  归档用的是开发签名 + 包含已登记设备的描述文件,所以能直接装到登记过的手机上。
#
# ★会**替换**手机上现有的 myFlowForge(TestFlight 装的那个也一样,同一个 bundle id)。
#  之后从 TestFlight 装新版会再换回来。换了证书后第一次启动可能要在手机上
#  「设置 → 通用 → VPN 与设备管理」点一次信任,手机也要解锁 —— 这两步只能人做。
set -euo pipefail
cd "$(dirname "$0")/.."
APP="mobile/ios/build/myFlowForge.xcarchive/Products/Applications/myFlowForge.app"
BUNDLE="com.flowforges.myflowforge"
WAIT="${SMOKE_SECONDS:-15}"
TMP="$(mktemp -d)"; trap 'rm -rf "${TMP}"' EXIT

[ -d "${APP}" ] || { echo "✗ 没有 ${APP} —— 先跑 npm run dist:ios"; exit 1; }

# ── 选设备:第一台已配对且在线的 iPhone(或用 IOS_DEVICE 指定 CoreDevice 标识符)
xcrun devicectl list devices --json-output "${TMP}/dev.json" >/dev/null
read -r DEV UDID NAME < <(python3 - "${TMP}/dev.json" "${IOS_DEVICE:-}" <<'PY'
import json,sys
want=sys.argv[2]
for d in json.load(open(sys.argv[1]))['result']['devices']:
    hp=d.get('hardwareProperties',{}); cp=d.get('connectionProperties',{})
    if hp.get('platform')!='iOS' or hp.get('deviceType')!='iPhone': continue
    if want and d['identifier']!=want: continue
    if cp.get('pairingState')!='paired' or cp.get('tunnelState')=='unavailable': continue
    print(d['identifier'], hp.get('udid',''), d.get('deviceProperties',{}).get('name','?').replace(' ','_')); break
PY
)
[ -n "${DEV:-}" ] || { echo "✗ 没有在线的 iPhone(插线 + 解锁,或 xcrun devicectl list devices 看 State)"; exit 1; }
echo "▸ 设备:${NAME} (${DEV})"

# ── 签名前提:开发证书 + 描述文件里登记了这台设备。否则装不上,早说早好。
AUTH="$(codesign -dvv "${APP}" 2>&1 | grep -m1 '^Authority=' || true)"
echo "▸ 签名:${AUTH#Authority=}"
security cms -D -i "${APP}/embedded.mobileprovision" > "${TMP}/profile.plist" 2>/dev/null
if ! /usr/libexec/PlistBuddy -c 'Print :ProvisionedDevices' "${TMP}/profile.plist" 2>/dev/null | grep -q "${UDID}"; then
  echo "✗ 这个包的描述文件里没有登记 ${NAME}(${UDID}),装不上。"
  exit 1
fi

VER="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "${APP}/Info.plist") ($(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "${APP}/Info.plist"))"
echo "▸ 安装 ${VER}"
xcrun devicectl device install app --device "${DEV}" "${APP}" >/dev/null

echo "▸ 启动,等 ${WAIT} 秒"
if ! xcrun devicectl device process launch --device "${DEV}" --terminate-existing "${BUNDLE}" > "${TMP}/launch.log" 2>&1; then
  cat "${TMP}/launch.log"
  echo "✗ 启动失败。若提示 profile not trusted:手机上「设置 → 通用 → VPN 与设备管理」信任开发者;若提示 locked:解锁手机。然后重跑。"
  exit 1
fi
sleep "${WAIT}"

xcrun devicectl device info processes --device "${DEV}" --json-output "${TMP}/ps.json" >/dev/null
PID="$(python3 - "${TMP}/ps.json" <<'PY'
import json,sys
for p in json.load(open(sys.argv[1]))['result'].get('runningProcesses',[]):
    if '/myFlowForge.app/' in p.get('executable',''): print(p['processIdentifier']); break
PY
)"
if [ -z "${PID}" ]; then
  echo "✗ 启动 ${WAIT} 秒后进程已经不在了 —— 崩了。崩溃日志:"
  echo "   xcrun devicectl device copy from --device ${DEV} --domain-type systemCrashLogs --source / --destination /tmp/crash"
  exit 1
fi
echo "✓ ${VER} 在 ${NAME} 上启动 ${WAIT} 秒后仍在运行(pid ${PID})"
