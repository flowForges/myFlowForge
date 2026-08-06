#!/usr/bin/env bash
# 修复「删掉 ~/.myFlowForge 后，工作区内所有项目 git 失效」。
#
# 病因：每个项目目录是 ~/.myFlowForge/repos/<id>.git 的 git worktree —— 它的 .git 是一个【文件】，
# 内容形如 `gitdir: ~/.myFlowForge/repos/<id>.git/worktrees/<name>`。真正的仓库（对象库/refs/HEAD）
# 在工作区【之外】。删掉 ~/.myFlowForge，这个指针就悬空了：文件都在，git 没了
# （fatal: not a git repository: …）。重装 app 不会重建它。
#
# 本脚本就地把每个坏掉的项目恢复成一个正常的独立 git 仓库：
#   git init → 加回 origin → fetch → reset --mixed origin/<base>
# 【只动索引和 HEAD，不碰工作区文件】，所以你未提交的改动会原样保留，并正确显示为「已修改」。
#
# 用法：
#   bash repair-worktrees.sh <工作区目录>          # 先看会做什么（dry-run）
#   bash repair-worktrees.sh <工作区目录> --apply  # 真正执行
set -uo pipefail

WS="${1:-}"
APPLY="${2:-}"
if [ -z "$WS" ] || [ ! -d "$WS" ]; then
  echo "用法: bash $0 <工作区目录> [--apply]" >&2
  exit 2
fi
WS="$(cd "$WS" && pwd)"
CFG="$WS/.forge/workspace.json"

echo "工作区: $WS"
[ "$APPLY" = "--apply" ] || echo "（dry-run —— 加 --apply 才会真正修改）"
echo

# 仓库地址存在工作区自己的 .forge/workspace.json 里，没跟着 ~/.myFlowForge 一起被删。
if [ ! -f "$CFG" ]; then
  echo "✗ 找不到 $CFG —— 没有它就拿不到各项目的仓库地址，无法自动恢复。" >&2
  exit 1
fi

# 从 workspace.json 取出 name/repoUrl/branch（python3 是 macOS 自带的）。
# 注意：这里不用 bash 的 mapfile —— macOS 自带的是 bash 3.2，没有那个内建命令。
ROWS_FILE="$(mktemp)"
trap 'rm -f "$ROWS_FILE"' EXIT
python3 - "$CFG" > "$ROWS_FILE" <<'PY'
import json,sys
cfg=json.load(open(sys.argv[1]))
for p in cfg.get('projects') or []:
    name=p.get('name') or p.get('repoId') or ''
    url=p.get('repoUrl') or ''
    br=p.get('branch') or p.get('baseBranch') or ''
    if name and url:
        print("%s\t%s\t%s" % (name,url,br))
PY

if [ ! -s "$ROWS_FILE" ]; then
  echo "✗ workspace.json 里没读到带仓库地址的项目。" >&2
  exit 1
fi

fixed=0; skipped=0; failed=0
while IFS="$(printf '\t')" read -r NAME URL BRANCH; do
  [ -n "$NAME" ] || continue
  DIR="$WS/$NAME"
  [ -n "$BRANCH" ] || BRANCH=main

  if [ ! -d "$DIR" ]; then
    echo "· ${NAME} —— 目录不存在，跳过"; skipped=$((skipped+1)); continue
  fi
  # 已经健康就别碰
  if git -C "$DIR" rev-parse --git-dir >/dev/null 2>&1; then
    echo "✓ ${NAME} —— git 正常，跳过"; skipped=$((skipped+1)); continue
  fi

  # 变量一律用 ${} 包起来：全角括号「）」是多字节字符，紧跟在 $BRANCH 后面时
  # bash 3.2（macOS 自带版本）会把它的字节当成变量名的一部分 → unbound variable。
  echo "✗ ${NAME} —— git 已失效，将就地恢复（origin: ${URL}，基线分支: ${BRANCH}）"
  if [ "$APPLY" != "--apply" ]; then continue; fi

  # 当前分支名：从悬空的 .git 文件推不出来，用 forge/<name> 这个 Forge 的命名约定兜底。
  BR_LOCAL="forge/$NAME"
  (
    set -e
    cd "$DIR"
    rm -f .git                                   # 只删那个悬空指针文件，不动任何代码
    git init -q -b "$BR_LOCAL" .
    git remote add origin "$URL"
    git fetch -q origin
    # --mixed：重置索引与 HEAD，工作区文件一律不动 → 未提交的改动保留为「已修改」
    git reset -q --mixed "origin/$BRANCH" 2>/dev/null || git reset -q --mixed FETCH_HEAD
    # 上游必须在 reset 之后设 —— 之前分支还没有提交，set-upstream 会失败
    git branch -q --set-upstream-to="origin/$BRANCH" "$BR_LOCAL" 2>/dev/null || true
  )
  if [ $? -eq 0 ]; then
    echo "   → 已恢复：$(git -C "$DIR" status --short -b | head -1)"
    fixed=$((fixed+1))
  else
    echo "   → 恢复失败（网络？仓库地址？）" >&2
    failed=$((failed+1))
  fi
# 从文件重定向而不是管道 —— 管道会让 while 跑在子 shell 里，计数器加完就丢了。
done < "$ROWS_FILE"

echo
echo "完成：修复 $fixed · 跳过 $skipped · 失败 $failed"
[ "$APPLY" = "--apply" ] || echo "这是 dry-run。确认无误后加 --apply 再跑一次。"
