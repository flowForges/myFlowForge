#!/usr/bin/env bash
# 验一个打好的 iOS .app:**它和它带的每个框架引用到的动态库,包里都真的有。**
#
# ★★为什么需要:2026-09-21 TestFlight 1.2.1(build 4)一启动就被 dyld 终止 ——
#  React.framework 链接着 @rpath/ReactNativeDependencies.framework,包里没有这个框架。
#  构建、归档、导出、苹果校验、上传**全都是绿的**,因为它们没有一个会真的把 app 加载起来。
#  这个脚本做的就是 dyld 启动时第一件事:把 @rpath 引用逐个找一遍。找不到 = 这个包装上就崩。
#
# 只查 @rpath / @executable_path / @loader_path 这三种「包里自带」的引用;/usr/lib、/System 那些是系统的。
#
# 用法:scripts/verify-ios-app.sh path/to/myFlowForge.app
set -euo pipefail

APP="${1:?用法: $0 path/to/App.app}"
[ -d "${APP}" ] || { echo "✗ 不是目录: ${APP}"; exit 1; }
APP="$(cd "${APP}" && pwd)"
FW="${APP}/Frameworks"

# 要检查的 Mach-O:主程序 + 每个框架的主二进制 + Frameworks 下的散装 dylib。
BINS=()
MAIN="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "${APP}/Info.plist")"
BINS+=("${APP}/${MAIN}")
if [ -d "${FW}" ]; then
  for f in "${FW}"/*.framework; do
    [ -d "$f" ] || continue
    name="$(basename "$f" .framework)"
    [ -f "$f/$name" ] && BINS+=("$f/$name")
  done
  for d in "${FW}"/*.dylib; do [ -f "$d" ] && BINS+=("$d"); done
fi

missing=0
checked=0
for bin in "${BINS[@]}"; do
  dir="$(dirname "${bin}")"
  # otool -L 第一行是文件名本身,跳过;每行开头是引用路径
  while read -r ref; do
    case "${ref}" in
      @rpath/*)          target="${FW}/${ref#@rpath/}" ;;
      @executable_path/*) target="${APP}/${ref#@executable_path/}" ;;
      @loader_path/*)    target="${dir}/${ref#@loader_path/}" ;;
      *) continue ;;
    esac
    checked=$((checked + 1))
    if [ ! -e "${target}" ]; then
      echo "  ✗ $(basename "${bin}") 需要 ${ref} —— 包里没有"
      missing=$((missing + 1))
    fi
  done < <(otool -L "${bin}" | tail -n +2 | awk '{print $1}')
done

if [ "${missing}" -gt 0 ]; then
  echo "✗ ${missing} 个动态库引用在包里找不到 —— 这个 app 装上就会在启动时被 dyld 终止。不能发。"
  exit 1
fi
echo "✓ ${#BINS[@]} 个二进制、${checked} 个包内引用全部找得到"
