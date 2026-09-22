// ── 下载完之后「退出 → 安装 → 重启」,不再让系统弹「软件正在使用」 ─────────────────────────────
//
// 原来的做法是把 dmg / setup.exe 直接交给系统:mac 上用户把新版拖进「应用程序」时旧版还开着 → Finder 提示
// 正在使用;Windows 的 NSIS 发现 myFlowForge.exe 还在跑 → 弹「请先关闭」。两边的根因一样:安装发生在 app
// 还活着的时候。所以改成由 app 自己接手:先起一个脱离父进程的安装者,然后 app 退出,安装者等它退干净再装。
//
// - mac:一段 sh 脚本 —— 等 pid 消失 → 挂载 dmg → ditto 到目标旁边的临时名 → 两次 mv 换进去 → 打开新版。
//   任何一步失败都把旧版原样放回去并重新打开它,用户最坏也只是「没升级成」,不会「app 没了」。
// - Windows:`setup.exe /S --updated --force-run` —— electron-builder 的 NSIS 模板里:/S 静默、沿用注册表里
//   上次的 InstallLocation(multiUser.nsh)、--updated 让它先等旧进程退出(_CHECK_APP_RUNNING 里的 Sleep,
//   等不到才杀)、--force-run 装完把 app 拉起来(installSection.nsh)。和 electron-updater 用的是同一组参数。
//
// ★ 能不能走这条路必须在 app【还活着】的时候判断完(canApplyInPlace),判断不了就退回老的「打开安装器」,
//   否则 app 退了、安装者又起不来,用户手里就什么都没有了。

import { dirname, join, basename } from 'node:path'

export type ApplyPlan =
  | { kind: 'mac'; target: string }        // target = 要被替换的 .app 包的绝对路径
  | { kind: 'win' }
  | { kind: 'manual'; reason: string }     // 退回老流程:打开安装器 + 在访达/资源管理器里显示

export interface PlanEnv {
  platform: NodeJS.Platform
  isPackaged: boolean
  execPath: string                          // process.execPath
  assetName: string
  canWrite: (p: string) => boolean          // 目录/文件对当前用户可写
}

/** 从 process.execPath 反推 .app 包:`/X/myFlowForge.app/Contents/MacOS/myFlowForge` → `/X/myFlowForge.app`。 */
export function macBundleOf(execPath: string): string | null {
  const macos = dirname(execPath)
  const contents = dirname(macos)
  const bundle = dirname(contents)
  if (basename(macos) !== 'MacOS' || basename(contents) !== 'Contents' || !bundle.endsWith('.app')) return null
  return bundle
}

export function planApply(env: PlanEnv): ApplyPlan {
  if (!env.isPackaged) return { kind: 'manual', reason: '开发模式' }
  if (env.platform === 'darwin') {
    if (!/\.dmg$/i.test(env.assetName)) return { kind: 'manual', reason: '安装包不是 dmg' }
    const target = macBundleOf(env.execPath)
    if (!target) return { kind: 'manual', reason: '找不到 app 包位置' }
    // 从 dmg 里直接运行 / 被 Gatekeeper 随机化路径(App Translocation)时,真正的安装位置不是这里,换了也白换。
    if (target.startsWith('/Volumes/')) return { kind: 'manual', reason: 'app 正从磁盘映像里运行' }
    if (target.includes('/AppTranslocation/')) return { kind: 'manual', reason: 'app 处于系统隔离路径' }
    // 替换 = 在同一目录里 rename 两次,所以要的是【父目录】可写(目标本身也要能被挪走)。
    if (!env.canWrite(dirname(target)) || !env.canWrite(target)) return { kind: 'manual', reason: '安装位置没有写权限' }
    return { kind: 'mac', target }
  }
  if (env.platform === 'win32') {
    if (!/\.exe$/i.test(env.assetName)) return { kind: 'manual', reason: '安装包不是 exe' }
    return { kind: 'win' }
  }
  return { kind: 'manual', reason: '当前平台不支持自动安装' }
}

/** Windows 安装器的参数。单独导出,好让测试钉住这组参数(少一个 --updated 就会回到「请先关闭」弹窗)。 */
export const WIN_SILENT_ARGS = ['/S', '--updated', '--force-run'] as const

/** POSIX 单引号转义:整段包进 '…',内部的 ' 变成 '\''。 */
function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * mac 安装脚本。参数全部在生成时内联(转义过),脚本自己不读任何外部输入。
 * 日志写到 logPath,失败时用户/我们能看到是哪一步挂的。
 */
export function macApplyScript(a: { pid: number; dmg: string; target: string; logPath: string }): string {
  const { pid, dmg, target, logPath } = a
  const dir = dirname(target)
  const name = basename(target)
  return `#!/bin/sh
PID=${pid}
DMG=${q(dmg)}
TARGET=${q(target)}
STAGE=${q(join(dir, `.${name}.new`))}
OLD=${q(join(dir, `.${name}.old`))}
LOG=${q(logPath)}
exec >>"$LOG" 2>&1
echo "[$(date '+%F %T')] apply start pid=$PID"

# 1. 等旧 app 退干净(before-quit 要清子进程,给足 60 秒;超时也继续 —— 下面的 mv 对正在运行的包同样能成功,
#    只是那样旧进程会在被挪走的包里跑完,不影响结果)。
n=0
while kill -0 "$PID" 2>/dev/null && [ $n -lt 200 ]; do sleep 0.3; n=$((n+1)); done

MNT=$(mktemp -d /tmp/mff-update.XXXXXX)
restore() {
  echo "failed: $1"
  [ -d "$OLD" ] && [ ! -d "$TARGET" ] && mv "$OLD" "$TARGET"
  rm -rf "$STAGE"
  hdiutil detach "$MNT" -quiet -force 2>/dev/null
  open "$TARGET"
  exit 1
}

# 2. 挂载(不弹访达窗口)。
hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$MNT" "$DMG" || restore attach
SRC=$(ls -d "$MNT"/*.app 2>/dev/null | head -n 1)
[ -n "$SRC" ] || restore "no .app in dmg"

# 3. 先完整拷到目标旁边的临时名(同一卷 → 下面的 mv 是原子 rename),拷完才动旧版。
rm -rf "$STAGE" "$OLD"
ditto "$SRC" "$STAGE" || restore ditto
hdiutil detach "$MNT" -quiet || hdiutil detach "$MNT" -quiet -force

# 4. 换:旧的挪开 → 新的挪进来。第二步失败就把旧的挪回去。
mv "$TARGET" "$OLD" || restore "move old aside"
mv "$STAGE" "$TARGET" || restore "move new in"
rm -rf "$OLD"
# 我们自己下载的文件没有 quarantine 标记,这里只是保险。
xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null
rm -f "$DMG"
echo "[$(date '+%F %T')] apply ok"
open "$TARGET"
`
}
