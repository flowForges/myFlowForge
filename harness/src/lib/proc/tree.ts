// 进程树与杀进程阶梯(04 spec §9.3)。只发能证明是自己的:组靠启动时间 / 组员认,单个进程靠快照里的启动时间
import { descendants, resolveDeps, signalGroup, signalMembers, treeMembers, verify, type PgidEntry, type Member, type ProcDeps, type ProcRow, type Resolved } from './pgids'

export { descendants }

export interface LadderOpts extends Omit<ProcDeps, 'seed' | 'refreshMs' | 'listMembers'> {
  /**
   * 内核关闭:1.5 s + 1 s;否则 3 s + 2 s。函数每一拍都看:走到一半才变 true(刚取消就关内核)时,
   * 从那一刻起按短梯算,不会比原来的期限晚
   */
  fast?: boolean | (() => boolean)
  /** 组长的组还在吗 */
  alive: () => boolean
  /** 组长是我们还没回收的子进程:pid 不可能被复用,读不了进程表也能发组信号 */
  owned?: () => boolean
  /** 组长调用时已不在:组里得有其中一个才算自己的 */
  anchors?: Member[]
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export interface LadderResult {
  /** 组和快照里的进程都没了。false = 没杀掉(如一个信号都发不出去),调用方不能当作已结束 */
  gone: boolean
}

const POLL_MS = 25
/** SIGKILL 前还要读一次进程表:提前这么多,让信号落在预算之内 */
const SNAPSHOT_MS = 200
/** SIGKILL 之后,等内核和父进程收走 */
const CONFIRM_MS = 300

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
 * 每一步读一张进程表:认组、走后代、比启动时间都出自同一次读取,一步只花一次 ps。SIGINT 前也读:node 包装层一死,ppid 链就断了。
 * 认不出的组、对不上启动时间的 pid 都不发信号;认不出组又没有快照时直接结束。
 */
export async function killLadder(pid: number, o: LadderOpts): Promise<LadderResult> {
  const r = resolveDeps(process.platform, o)
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(res => setTimeout(res, ms)))
  const now = o.now ?? Date.now
  const boot = r.bootId()
  const entry: PgidEntry = {
    pgid: pid,
    // '' 永远对不上:同一个 pid 上又出现活的组长,就是被复用了
    start: '',
    ...(boot !== undefined && { boot }),
    members: o.anchors ?? [],
  }
  const known = new Map<number, string>()
  let first = true

  /** 读一张表、更新快照。返回这一步能用的表,以及这个组这一步算不算自己的 */
  const snapshot = (): { rows?: ProcRow[]; ours: boolean } => {
    const owned = o.owned?.() === true
    const isFirst = first
    first = false
    let rows: ProcRow[]
    try {
      rows = r.procTable()
    } catch (err) {
      r.log.warn('process table unavailable', { error: String(err) })
      return { ours: owned }
    }
    const byPid = new Map(rows.map(x => [x.pid, x]))
    // 没了或被复用的:不再等,也不能当根,否则会把别人的子进程算进来
    for (const [p, start] of known) if (byPid.get(p)?.start !== start) known.delete(p)
    const lead = byPid.get(pid)
    if (!o.anchors && !entry.start && lead && (owned || isFirst)) entry.start = lead.start
    const view: Resolved = { ...r, startTime: p => byPid.get(p)?.start, groupMembers: g => rows.filter(x => x.pgid === g).map(x => ({ pid: x.pid, start: x.start })) }
    const ours = owned || verify(entry, view) === 'ours'
    const roots = [...known.keys()]
    if (ours) {
      const group = rows.filter(x => x.pgid === pid && x.pid !== pid).map(x => ({ pid: x.pid, start: x.start }))
      if (group.length) entry.members = group
      for (const m of group) known.set(m.pid, m.start)
      roots.push(pid, ...group.map(m => m.pid))
    }
    for (const m of treeMembers(rows, roots)) known.set(m.pid, m.start)
    return { rows, ours }
  }
  const gone = () => !o.alive() && ![...known.keys()].some(p => pidExists(p, r))
  /** 等到都没了(true)或到点(false);期限可能中途提前 */
  const waitGone = async (until: () => number) => {
    while (now() < until()) {
      if (gone()) return true
      await sleep(Math.max(0, Math.min(POLL_MS, until() - now())))
    }
    return gone()
  }
  const send = (sig: NodeJS.Signals, members: boolean) => {
    const s = snapshot()
    if (s.ours) signalGroup(pid, sig, r)
    if (members && s.rows) signalMembers([...known].map(([p, start]) => ({ pid: p, start })), sig, r, s.rows)
    return s
  }

  const t0 = now()
  const isFast = () => (typeof o.fast === 'function' ? o.fast() : o.fast === true)
  let hurriedAt = isFast() ? t0 : undefined
  const deadline = (slowMs: number, fastMs: number) => () => {
    if (hurriedAt === undefined && isFast()) hurriedAt = now()
    return hurriedAt === undefined ? t0 + slowMs : Math.min(t0 + slowMs, hurriedAt + fastMs)
  }
  const s = send('SIGINT', false)
  if (!known.size && !s.ours) return { gone: !o.alive() }
  if (await waitGone(deadline(3000, 1500))) return { gone: true }
  send('SIGTERM', true)
  if (await waitGone(deadline(5000 - SNAPSHOT_MS, 2500 - SNAPSHOT_MS))) return { gone: true }
  send('SIGKILL', true)
  const confirmBy = now() + CONFIRM_MS
  if (await waitGone(() => confirmBy)) return { gone: true }
  snapshot() // 只为去掉已被复用的 pid:它们不算没杀掉
  return { gone: gone() }
}
