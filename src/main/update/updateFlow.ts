// ── 下载完之后怎么装:没有会话在跑就直接退出安装;有就先问用户 ─────────────────────────────────
//
// 三种走法,由渲染层的 update:apply 选:
//   'now'   —— 再查一次;空闲就装,还有在跑的就把清单发回去(不装)。下载刚完成时自动走这条。
//   'wait'  —— 每 2 秒查一次,一空闲就装。等待期间清单有变化就推给界面。
//   'force' —— 不管有没有在跑,直接装(before-quit 会把 agent 进程树、终端都清掉)。
//   'cancel'—— 停止等待。已下载的包留着,之后还能再点「安装并重启」。
//
// ★「有没有在跑」必须在【真要退出的那一刻】查,不能用下载开始时的结论 —— 下载要一两分钟,中间完全可能开了新会话。

import type { UpdateInfo, UpdateBusyItem, InstallProgress } from '@shared/types'
import { planApply, macApplyScript, WIN_SILENT_ARGS, type PlanEnv } from './applyUpdate'

export type ApplyMode = 'now' | 'wait' | 'force' | 'cancel'

export interface UpdateFlowDeps {
  listBusy: () => UpdateBusyItem[]
  planEnv: (assetName: string) => PlanEnv
  pid: number
  tmpDir: string
  join: (a: string, b: string) => string
  writeScript: (path: string, content: string) => Promise<void>
  /** 起一个脱离本进程的子进程(detached + unref),app 退出后它还活着。 */
  spawnDetached: (cmd: string, args: readonly string[]) => void
  quit: () => void
  openPath: (p: string) => Promise<string>
  reveal: (p: string) => void
  emitReady: (busy: UpdateBusyItem[], waiting: boolean) => void
  emitProgress: (p: InstallProgress) => void
  emitDone: () => void
  emitError: (message: string) => void
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (h: unknown) => void
  /** 交给安装者之后,留一点时间让「正在安装」这条进度真的画到屏幕上再退。 */
  setTimeout: (fn: () => void, ms: number) => void
}

export function createUpdateFlow(d: UpdateFlowDeps) {
  let downloaded: { path: string; info: UpdateInfo } | null = null
  let waitHandle: unknown = null
  let applying = false

  const stopWaiting = () => { if (waitHandle !== null) { d.clearInterval(waitHandle); waitHandle = null } }

  async function install(): Promise<void> {
    if (!downloaded || applying) return
    applying = true
    stopWaiting()
    const { path, info } = downloaded
    const plan = planApply(d.planEnv(info.assetName))
    try {
      if (plan.kind === 'manual') {
        // 老流程:把安装器交给系统 + 在访达/资源管理器里定位。用户自己装(这条路上仍可能看到「正在使用」)。
        await d.openPath(path)
        d.reveal(path)
        d.emitProgress({ stage: '正在打开安装器…', pct: 100, log: `无法自动安装:${plan.reason}` })
        d.emitDone()
        applying = false
        return
      }
      if (plan.kind === 'mac') {
        const script = d.join(d.tmpDir, 'myflowforge-apply-update.sh')
        await d.writeScript(script, macApplyScript({ pid: d.pid, dmg: path, target: plan.target, logPath: d.join(d.tmpDir, 'myflowforge-apply-update.log') }))
        d.spawnDetached('/bin/sh', [script])
      } else {
        d.spawnDetached(path, WIN_SILENT_ARGS)
      }
      d.emitProgress({ stage: '正在安装,app 会自动重新打开…', pct: 100, log: '退出并安装' })
      d.setTimeout(() => d.quit(), 400)
    } catch (e) {
      applying = false
      d.emitError(`自动安装失败:${e instanceof Error ? e.message : String(e)}`)
    }
  }

  function apply(mode: ApplyMode): void {
    if (!downloaded || applying) return
    if (mode === 'cancel') { stopWaiting(); d.emitReady(d.listBusy(), false); return }
    if (mode === 'force') { void install(); return }
    const busy = d.listBusy()
    if (busy.length === 0) { void install(); return }
    d.emitReady(busy, mode === 'wait')
    if (mode === 'wait' && waitHandle === null) {
      waitHandle = d.setInterval(() => {
        const now = d.listBusy()
        if (now.length === 0) void install()
        else d.emitReady(now, true)
      }, 2000)
    }
  }

  return {
    /** 下载完成:记下安装包,马上按「空闲就装」走一次。 */
    downloaded(path: string, info: UpdateInfo): void {
      downloaded = { path, info }
      applying = false
      apply('now')
    },
    apply,
    /** 已经下好、在等用户决定(界面重开时用来恢复「安装并重启」按钮)。 */
    pending(): boolean { return downloaded !== null && !applying },
  }
}
