// 每轮的开始 / 结束快照与回滚(spec §11):git 部分在 lib/git/snapshot,这里管引用命名、事件与"哪一轮能回滚"
import type { Logger } from '../../kernel/log'
import { RpcError } from '../../kernel/rpcError'
import { changes, pruneRefs, restore, takeSnapshot, type Git, type SnapshotResult } from '../../lib/git/snapshot'
import type { FileChange, KernelEvent } from '../../protocol/index'

const ERR_INVALID_PARAMS = -32602
const ERR_INTERNAL = -32603
export const KEEP_TURNS = 50
export const SLOW_MS = 5_000

export interface SnapshotDeps {
  git: Git
  /** 临时索引与空钩子目录的父目录 */
  tmpDir: string
  log: Logger
  append(e: Omit<KernelEvent, 'seq' | 'ts'>): unknown
  /** 超过这么久记日志;默认 5 s */
  slowMs?: number
}

export interface SnapshotTarget { sessionId: string; cwd: string }

type Phase = 'start' | 'end' | 'pre-rollback'
export const refBase = (sessionId: string) => `refs/mffai/snapshots/${sessionId}`
export const snapshotRef = (sessionId: string, turnId: string, phase: Phase) => `${refBase(sessionId)}/${turnId}-${phase}`

async function timed<T>(deps: SnapshotDeps, what: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now()
  try {
    return await fn()
  } finally {
    const ms = Date.now() - t0
    if (ms > (deps.slowMs ?? SLOW_MS)) deps.log.warn('snapshot slow', { what, ms })
  }
}

const take = (deps: SnapshotDeps, t: SnapshotTarget, turnId: string, phase: Phase): Promise<SnapshotResult> =>
  timed(deps, phase, () => takeSnapshot(t.cwd, snapshotRef(t.sessionId, turnId, phase), deps.git, { tmpDir: deps.tmpDir }))

/** 开始快照 → `turn.snapshot {phase:'start'}`;拍到了就按会话清理旧引用。返回引用(拍不了 → undefined) */
export async function startSnapshot(deps: SnapshotDeps, t: SnapshotTarget, turnId: string): Promise<string | undefined> {
  const r = await take(deps, t, turnId, 'start')
  if (r.reason === 'error') deps.log.warn('start snapshot failed', { turnId })
  deps.append({ type: 'turn.snapshot', sessionId: t.sessionId, payload: { turnId, phase: 'start', ...(r.ref && { ref: r.ref }), ...(r.reason && { reason: r.reason }) } })
  if (r.ref) {
    await timed(deps, 'prune', () => pruneRefs(t.cwd, refBase(t.sessionId), KEEP_TURNS, deps.git, { tmpDir: deps.tmpDir })).catch(err =>
      deps.log.warn('snapshot prune failed', { error: err instanceof Error ? err.message : String(err) }),
    )
  }
  return r.ref
}

/** 结束快照 → `turn.snapshot {phase:'end', changed}`(changed 只在两张都拍到时有) */
export async function endSnapshot(deps: SnapshotDeps, t: SnapshotTarget, turnId: string, startRef: string | undefined): Promise<void> {
  const r = await take(deps, t, turnId, 'end')
  if (r.reason === 'error') deps.log.warn('end snapshot failed', { turnId })
  let changed: number | undefined
  if (startRef && r.ref) {
    changed = await timed(deps, 'changes', () => changes(t.cwd, startRef, r.ref!, deps.git, { tmpDir: deps.tmpDir })).then(
      f => f.length,
      err => {
        deps.log.warn('snapshot diff failed', { error: err instanceof Error ? err.message : String(err) })
        return undefined
      },
    )
  }
  deps.append({
    type: 'turn.snapshot', sessionId: t.sessionId,
    payload: { turnId, phase: 'end', ...(r.ref && { ref: r.ref }), ...(changed !== undefined && { changed }), ...(r.reason && { reason: r.reason }) },
  })
}

interface TurnState { snapshotted: boolean; start?: string; end?: string }
interface Scan { order: string[]; turns: Map<string, TurnState>; rolledBack: Set<string>; open: Set<string> }

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined)

/** 从会话事件里读出各轮(按 message.user 顺序)、快照引用、已回滚的轮与没有终态的轮 */
function scan(sessionId: string, events: KernelEvent[]): Scan {
  const s: Scan = { order: [], turns: new Map(), rolledBack: new Set(), open: new Set() }
  for (const e of events) {
    const p = obj(e.payload)
    const id = p?.turnId
    if (typeof id !== 'string') continue
    if (e.type === 'message.user' && !s.turns.has(id)) {
      s.turns.set(id, { snapshotted: false })
      s.order.push(id)
      s.open.add(id)
    } else if (e.type === 'turn.ended' || e.type === 'turn.failed') s.open.delete(id)
    else if (e.type === 'turn.rolledBack') s.rolledBack.add(id)
    else if (e.type === 'turn.snapshot') {
      const t = s.turns.get(id)
      if (!t) continue
      t.snapshotted = true
      // 只认按命名规则写下的引用(不信任载荷里任意的 ref)
      if (p!.phase === 'start' && p!.ref === snapshotRef(sessionId, id, 'start')) t.start = p!.ref
      if (p!.phase === 'end' && p!.ref === snapshotRef(sessionId, id, 'end')) t.end = p!.ref
    }
  }
  return s
}

/** 会话里有没有写了 message.user 却还没有终态的轮 */
export const hasOpenTurn = (sessionId: string, events: KernelEvent[]) => scan(sessionId, events).open.size > 0

/**
 * 能回滚的轮:跑过快照(有 turn.snapshot)且未回滚的轮里最新的一个,且两张快照都在。
 * 没跑快照的轮(tools_unavailable、loop-echo 接的)不挡;拍失败(too_large 等)的轮会挡住更早的轮,因为它的改动无从得知
 */
export function rollbackRefs(sessionId: string, events: KernelEvent[], turnId: string): { start: string; end: string } | undefined {
  const s = scan(sessionId, events)
  const latest = s.order.filter(id => s.turns.get(id)!.snapshotted && !s.rolledBack.has(id)).at(-1)
  if (latest !== turnId) return undefined
  const t = s.turns.get(turnId)!
  return t.start && t.end ? { start: t.start, end: t.end } : undefined
}

/** `turn.changes`:两张快照都在才有 */
export async function turnChanges(deps: SnapshotDeps, t: SnapshotTarget, events: KernelEvent[], turnId: string): Promise<FileChange[]> {
  const ts = scan(t.sessionId, events).turns.get(turnId)
  if (!ts?.start || !ts.end) throw new RpcError(ERR_INVALID_PARAMS, 'snapshots missing')
  try {
    return await changes(t.cwd, ts.start, ts.end, deps.git, { tmpDir: deps.tmpDir })
  } catch {
    throw new RpcError(ERR_INVALID_PARAMS, 'snapshots missing')
  }
}

/**
 * 回滚一轮(调用方已检查会话没有进行中的轮):pre-rollback 快照 → changes(start, end) → restore → `turn.rolledBack`。
 * pre-rollback 拍不了就不回滚(用户在这之后的改动没有兜底);写回有失败的不记 turn.rolledBack,可再试
 */
export async function rollbackTurn(deps: SnapshotDeps, t: SnapshotTarget, events: KernelEvent[], turnId: string): Promise<number> {
  const refs = rollbackRefs(t.sessionId, events, turnId)
  if (!refs) throw new RpcError(ERR_INVALID_PARAMS, 'not rollbackable')
  const pre = await take(deps, t, turnId, 'pre-rollback')
  if (!pre.ref) throw new RpcError(ERR_INTERNAL, `pre-rollback snapshot failed: ${pre.reason ?? 'error'}`)
  let files: FileChange[]
  try {
    files = await timed(deps, 'changes', () => changes(t.cwd, refs.start, refs.end, deps.git, { tmpDir: deps.tmpDir }))
  } catch {
    throw new RpcError(ERR_INVALID_PARAMS, 'not rollbackable')
  }
  try {
    await timed(deps, 'restore', () => restore(t.cwd, refs.start, files, deps.git, { tmpDir: deps.tmpDir }))
  } catch (err) {
    throw new RpcError(ERR_INTERNAL, err instanceof Error ? err.message : String(err))
  }
  deps.append({ type: 'turn.rolledBack', sessionId: t.sessionId, payload: { turnId, files: files.length } })
  return files.length
}
