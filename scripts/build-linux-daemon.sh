#!/usr/bin/env bash
# 打 Linux 用的**无界面 daemon** 包。
#
# ★这不是一个 Electron 应用 —— Linux 上没有窗口,只有一个 daemon 进程,手机/别的电脑连上去用。
#  所以它不走 electron-builder,就是把编译产物 + 依赖清单打个 tar。
#
# ★★里面**不带 node_modules**。node-pty 是原生模块,必须在**目标机器上**编译 ——
#  把 mac 上编好的 .node 打进去,到 Linux 上一加载就炸,而且那是运行时才炸的(终端打不开),
#  装的时候一切正常。这正是「装得上、终端是坏的」那类假绿,所以宁可让用户在那边跑一次
#  `npm install`(README 里写着),也不把一个注定坏掉的二进制塞进去。
#
# 用法:npm run dist:linux     产物在 release/
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(node -p "require('./package.json').version")"
OUT="release/myFlowForge-daemon-${VERSION}-linux.tar.gz"

[ -d out/main ] || { echo "✗ 没有 out/main —— 先跑 npm run build"; exit 1; }
[ -f out/main/daemon.js ] || { echo "✗ out/main/daemon.js 不在"; exit 1; }

mkdir -p release
# ★`--no-xattrs` / `COPYFILE_DISABLE`:macOS 的 tar 默认会塞一堆 `._` 元数据文件进去,
#  在 Linux 上解出来就是一地垃圾文件。
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$OUT" \
  out package.json package-lock.json scripts/postinstall.mjs

echo "✓ ${OUT}  $(du -h "$OUT" | cut -f1)"
# ★验一眼内容。只看文件在不在不够 —— daemon.js 是整个包的入口,它不在的话这个包毫无意义。
tar tzf "$OUT" | grep -q '^out/main/daemon.js$' || { echo "✗ 包里没有 daemon.js"; exit 1; }
echo "  ✓ 含 out/main/daemon.js"
