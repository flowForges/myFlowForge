// 进程树与杀进程阶梯(04 spec §9.3)。只发能证明是自己的:组靠启动时间 / 组员认,单个进程靠快照里的启动时间
import { descendants, resolveDeps, signalGroup, signalMembers, treeMembers, verify, type Member, type PgidEntry, type ProcDeps, type Resolved } from './pgids'

export { descendants }

export interface LadderOpts extends Omit<ProcDeps, 'seed' | 'refreshMs' | 'listMembers'> {
  /** 内核关闭:1.5 s + 1 s;否则 3 s + 2 s */
  fast?: boolean
  /** 组长的组还在吗 */
  alive: () => boolean
  /** 组长是我们还没回收的子进程:pid 不可能被复用,不必再查(ps 失败也杀得了) */
  owned?: () => boolean
  /** 组长调用时已不在:组里得有其中一个才算自己的。不给 → 现在就记 */
  anchors?: Member[]
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const POLL_MS = 25
/** SIGKILL 前还要拍一次快照:提前这么多,让信号落在预算之内 */
const SNAPSHOT_MS = 100

const pidExists = (pid: number, r: Resolved): boolean => {
  try {
    r.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * SIGINT 整组 → 宽限 → SIGTERM 整组与后代 → 宽限 → SIGKILL 整组与后代;组和后代都没了就提前结束。
 * SIGINT 打头:实测 SIGTERM 会留下 Codex 自成一组的命令,SIGINT 才能让它自己收尾(spec §2)。
 * 每次动手前都拍快照,SIGINT 前也拍:node 包装层一死,ppid 链就断了。
 * 认不出的组、对不上启动时间的 pid 都不发信号;认不出组又没有快照时直接结束。
 */
export async function killLadder(pid: number, o: LadderOpts): Promise<void> {
  const r = resolveDeps(process.platform, o)
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(res => setTimeout(res, ms)))
  const now = o.now ?? Date.now
  const members = () => {
    try {
      return r.groupMembers(pid).filter(m => m.pid !== pid)
    } catch {
      return []
    }
  }
  const leaderStart = () => {
    try {
      return r.startTime(pid)
    } catch {
      return undefined
    }
  }
  const boot = r.bootId()
  const entry: PgidEntry = {
    pgid: pid,
    // '' 永远对不上:同一个 pid 上又出现活的组长,就是被复用了
    start: (o.anchors ? undefined : leaderStart()) ?? '',
    ...(boot !== undefined && { boot }),
    members: o.anchors ?? members(),
  }
  const ours = () => o.owned?.() === true || verify(entry, r) === 'ours'
  const known = new Map<number, string>()

  const snapshot = () => {
    // 已知的 pid 先比启动时间:被复用的不能当根,否则会把别人的子进程算进来
    let current = new Map<number, string>()
    try {
      current = r.startTimes([...known.keys()])
    } catch {
      // 这次不从它们往下走
    }
    const roots = [...known].filter(([p, s]) => current.get(p) === s).map(([p]) => p)
    if (ours()) {
      const group = members()
      entry.members = group
      roots.push(pid)
      for (const m of group) {
        known.set(m.pid, m.start)
        roots.push(m.pid)
      }
    }
    for (const m of treeMembers(roots, r)) known.set(m.pid, m.start)
  }
  const list = (): Member[] => [...known].map(([p, start]) => ({ pid: p, start }))
  const send = (sig: NodeJS.Signals) => {
    if (ours()) signalGroup(pid, sig, r)
  }
  const gone = () => !o.alive() && ![...known.keys()].some(p => pidExists(p, r))
  /** 等到都没了(true)或到点(false) */
  const waitGone = async (until: number) => {
    while (now() < until) {
      if (gone()) return true
      await sleep(Math.min(POLL_MS, until - now()))
    }
    return gone()
  }

  const t0 = now()
  const [intMs, totalMs] = o.fast ? [1500, 2500] : [3000, 5000]
  snapshot()
  if (!known.size && !ours()) return
  send('SIGINT')
  if (await waitGone(t0 + intMs)) return
  snapshot()
  send('SIGTERM')
  signalMembers(list(), 'SIGTERM', r)
  if (await waitGone(t0 + totalMs - SNAPSHOT_MS)) return
  snapshot()
  send('SIGKILL')
  signalMembers(list(), 'SIGKILL', r)
}
