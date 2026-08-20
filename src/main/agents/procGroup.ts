import { execa, type Options, type ResultPromise } from 'execa'
import { execFileSync } from 'node:child_process'

// ── 停止一个 agent = 杀掉它的【整棵进程树】,不是只杀 CLI 自己 ────────────────────────────────
//
// 每个 provider 原本都是 `execa(bin, args)` + `child.kill('SIGTERM')`。POSIX 下子进程继承的是
// Electron 主进程的进程组,所以我们没法杀组(会把 app 自己一起杀了),只能杀单个 pid —— 于是 CLI 派生的
// shell 命令活了下来。实测(2026-08-20,真 codex):正卡在 `/bin/zsh -lc 'sleep 120'` 时 SIGTERM 掉 codex,
// 那条 sleep 的 PPID 变成 1 继续跑。换成 `npm run build` 或任何改文件的命令,它就会跟下一轮并发踩同一个
// 工作区,而我们连它是什么都不知道(CLI 只报命令行,不报子进程 pid)。
//
// 修法:POSIX 下用 detached 让每个 CLI 自成进程组,停止时 kill(-pid) 杀整组;Windows 不支持负 pid,
// 改用 `taskkill /T` 走进程树(所以那边不需要 detached)。
//
// ★ detached 的代价必须一起付:execa 的 `cleanup`(父进程退出时杀子进程)在 detached 下是直接 return 的
//   (见 execa/lib/terminate/cleanup.js:`if (!cleanup || detached) return`)。不自己补,就等于把「停止漏
//   孤儿」换成了「退出 app 漏孤儿」,更糟。所以这里维护一张活进程表,由 index.ts 的 before-quit 扫掉。

const WIN = process.platform === 'win32'

/** killTree/track 能接的最小形状 —— execa 的 ResultPromise 和 node 原生 ChildProcess 都满足
 *  (codexAppServer 走的是后者,而且它的 spawn 是可注入的,测试里塞的假 child 也照样能过)。 */
export interface KillableChild {
  pid?: number
  kill(signal?: NodeJS.Signals): unknown
  once?(event: string, listener: () => void): unknown
}

/** 还活着的 agent 子进程(进程自己退出时摘除)。仅用于 app 退出时的兜底清理。 */
const live = new Set<KillableChild>()
/** 确实建过独立进程组的子进程。★ 这是 kill(-pid) 的安全闸门:对一个没有独立进程组的子进程用负 pid,
 *  杀的就是 app 自己所在的组 —— 所以不在这张表里的,一律只许单杀。 */
const ownGroup = new WeakSet<KillableChild>()

/** 原生 spawn 的调用方(codexAppServer)拿这个去拼选项,好跟 spawnAgent 保持同一套进程组语义。 */
export function agentSpawnOptions(): { detached?: boolean } {
  return WIN ? {} : { detached: true }
}

/** 把一个自己 spawn 出来的 agent 子进程登记进来(退出兜底 + 允许杀组)。
 *  `ownGroup` 传 false 表示它没有独立进程组(例如测试注入的假 child),killTree 就只会单杀它。 */
export function trackAgentChild<T extends KillableChild>(child: T, opts: { ownGroup?: boolean } = {}): T {
  if (opts.ownGroup ?? !WIN) ownGroup.add(child)
  live.add(child)
  const drop = () => { live.delete(child) }
  child.once?.('close', drop)
  child.once?.('error', drop)
  return child
}

/** 起一个 agent CLI。除了 execa 的常规选项,POSIX 下额外给它一个独立进程组,好让 killTree 杀干净。 */
export function spawnAgent(bin: string, args: readonly string[], opts: Options = {}): ResultPromise {
  return trackAgentChild(execa(bin, args, { ...opts, ...agentSpawnOptions() }) as ResultPromise)
}

// 按 ppid 递归收集 root 的全部后代。
//
// ★ 为什么光杀进程组不够:真 codex 取证(2026-08-20)显示,它给自己派生的每条 shell 命令【另建了进程组】
//   (setsid,做沙箱/超时隔离)—— `sleep 400` 的 pgid 等于它自己的 pid,根本不在我们 detached 出来的组里,
//   kill(-pid) 一个都打不到。但它当时仍在我们的【进程树】里(ppid 指向 codex),所以按 ppid 走才抓得住。
//
// ★ 必须在【动手杀之前】拍快照:父进程一死,后代立刻被 init 收养(ppid→1),ppid 链当场断掉,再查就查不到了。
//
// 同步实现:cancel() 是同步的,而且停止是低频操作,一次 ps 的几十毫秒可以接受。ps 不可用就退回只杀进程组。
function descendants(root: number): number[] {
  const out: number[] = []
  try {
    const raw = execFileSync('ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8', timeout: 3000 })
    const kids = new Map<number, number[]>()
    for (const line of raw.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)/.exec(line)
      if (!m) continue
      const pid = Number(m[1])
      const ppid = Number(m[2])
      if (pid <= 1) continue
      const arr = kids.get(ppid)
      if (arr) arr.push(pid); else kids.set(ppid, [pid])
    }
    const seen = new Set<number>([root])
    const stack = [root]
    while (stack.length) {
      for (const c of kids.get(stack.pop()!) ?? []) {
        if (seen.has(c)) continue          // ps 快照理论上无环,这里只是防御性地不重复入栈
        seen.add(c); out.push(c); stack.push(c)
      }
    }
  } catch { /* ps 不在/超时 → 退回只杀进程组 */ }
  return out
}

/** 杀掉这个 agent 及它派生的一切(shell 命令、编译器、子 CLI……)。 */
export function killTree(child: KillableChild, signal: NodeJS.Signals = 'SIGTERM'): void {
  const single = () => { try { child.kill(signal) } catch { /* 已经没了 */ } }
  const pid = child.pid
  if (!pid) { single(); return }
  if (WIN) {
    // /T = 连同子进程树,/F = 强制。best-effort:taskkill 不在或进程已退出都不该让停止流程炸掉。
    try { void execa('taskkill', ['/pid', String(pid), '/T', '/F'], { reject: false }) } catch { /* ignore */ }
    single()
    return
  }
  // 先拍快照,再动手 —— 顺序不能反(见 descendants 的注释)。
  const tree = descendants(pid)
  // ★ 只有确实建过独立进程组的才允许负 pid;否则退回单杀(见 ownGroup 的注释)。
  if (ownGroup.has(child)) {
    try { process.kill(-pid, signal) }
    catch { single() }   // 组已经空了 / 进程已退出 → ESRCH,退回单杀
  } else single()
  // 另建了进程组、因而躲过上面那一刀的后代,按进程树补掉。
  for (const p of tree) { try { process.kill(p, signal) } catch { /* 已经跟着组一起死了 */ } }
}

/** app 退出时的兜底:detached 关掉了 execa 自带的 cleanup,这里替它把还活着的 agent 树全杀掉。 */
export function killAllAgentTrees(signal: NodeJS.Signals = 'SIGTERM'): void {
  for (const child of [...live]) { killTree(child, signal); live.delete(child) }
}

/** 测试用:当前还被跟踪的 agent 子进程数。 */
export function liveAgentCount(): number { return live.size }
