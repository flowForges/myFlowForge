// 任务页(08 §9):executor.runs 的 运行中 / 排队 / 已结束 三组,外加 IM worktree 一组(channel.telegram.chats 的
// worktrees)。执行器行的 停止/合并/丢弃 复用 RunCard 的 useRunActions(sessionId, runId);IM worktree 没有会话
// 可带,走 channel.telegram.worktree.*,自己的一套同样形状的动作(同一套合并/丢弃确认模式)。
// 丢弃 IM worktree 时多算 在用的会话:后台的丢弃看不见里面开的 app 会话(07 followups Task 11 M4),
// 这里按 session.list 的 cwd 是否落在这棵 worktree 路径下(按 / 分界,不把 wt_10 当 wt_1 的孩子)数给用户看。
// 组标题的 N / 20 只在 已结束、IM worktree 两组上(委派 worktree 和 IM worktree 各自一个 20 个的上限,
// 满了就是在这页丢弃;运行中、排队不占 worktree 名额,只显示行数)。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { EventType, MergeRefusal, RunRow, SessionSummary, TelegramChats } from '@mffai/protocol'
import { fmtRelTime } from '@shared/relTime'
import { CopyButton } from '../../views/chat/blocks'
import { call, isUnsupported, retryable, toCallError } from '../rpc'
import { useMffaiEvent, useMffaiReset } from '../events'
import { route } from '../route'
import { label } from '../labels'
import { Chip } from '../ui/Chip'
import { CodeChip } from '../ui/CodeChip'
import { Confirm } from '../ui/Confirm'
import { ChangesBlock } from '../chat/ChangesBlock'
import { useRunActions } from '../chat/RunCard'

const K = '\u0000'
const ERR_BUSY = -32003
const REFRESH_MS = 300
/** harness/src/lib/git/worktree.ts MAX_WORKTREES:委派 worktree 和 IM worktree 各自一个根下的上限 */
const MAX_WORKTREES = 20

const RUN_TRIGGERS: readonly EventType[] = [
  'executor.run.queued', 'executor.run.started', 'executor.run.progress', 'executor.run.ended',
  'executor.worktree.merged', 'channel.worktree.merged',
]

const fmtMs = (ms: number) => (ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`)
const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`)

/** 会话的 cwd 必须落在 worktree 路径之下(自己或者 /子路径),不把一个更长的兄弟路径当孩子 */
const underPath = (cwd: string, root: string): boolean => cwd === root || cwd.startsWith(root.endsWith('/') ? root : `${root}/`)

function countSessionsUnder(sessions: ReadonlyMap<string, SessionSummary>, root: string): number {
  let n = 0
  for (const s of sessions.values()) if (s.cwd !== undefined && underPath(s.cwd, root)) n++
  return n
}

function refusalOf(e: unknown): MergeRefusal | undefined {
  const c = toCallError(e)
  const d = c.data as { reason?: unknown; paths?: unknown; restored?: unknown } | undefined
  if (c.code !== -32602 || typeof d?.reason !== 'string') return undefined
  return {
    reason: d.reason as MergeRefusal['reason'],
    ...(Array.isArray(d.paths) && { paths: d.paths.filter((p): p is string => typeof p === 'string') }),
    ...(typeof d.restored === 'boolean' && { restored: d.restored }),
  }
}

type Action = 'merge' | 'discard'

/** IM worktree 自己的 合并/丢弃:和 RunCard 的 useRunActions 同一个模式,但没有会话,参数是 worktreeId */
function useWorktreeActions(worktreeId: string) {
  const [busy, setBusy] = useState<Action | null>(null)
  const [failed, setFailed] = useState<{ action: Action; busy: boolean } | null>(null)
  const [refusal, setRefusal] = useState<MergeRefusal | null>(null)
  const [merged, setMerged] = useState<{ files: number } | null>(null)
  const [discarded, setDiscarded] = useState(false)
  const inflight = useRef(false)
  const retry = useRef(retryable()).current

  const run = async (action: Action, f: (commandId: string) => Promise<void>) => {
    if (inflight.current) return
    inflight.current = true
    setBusy(action)
    setFailed(null)
    if (action === 'merge') setRefusal(null)
    const key = action + K + worktreeId
    try {
      await f(retry.id(key))
      retry.done(key)
    } catch (e) {
      const r = action === 'merge' ? refusalOf(e) : undefined
      if (r) { retry.done(key); setRefusal(r) } else {
        const c = toCallError(e)
        console.error(`mffai telegram worktree ${action}`, c)
        setFailed({ action, busy: c.code === ERR_BUSY })
      }
    } finally {
      inflight.current = false
      setBusy(null)
    }
  }

  return {
    busy, failed, refusal, merged, discarded,
    merge: () => run('merge', async (commandId) => {
      const r = await call('channel.telegram.worktree.merge', { commandId, worktreeId })
      setMerged({ files: r.files })
    }),
    discard: () => run('discard', async (commandId) => {
      const r = await call('channel.telegram.worktree.discard', { commandId, worktreeId })
      if (!r.ok) throw new Error('discard refused')
      setDiscarded(true)
    }),
  }
}

interface Tasks {
  runs: RunRow[] | null
  runsUnsupported: boolean
  worktrees: TelegramChats['worktrees'] | null
  imUnsupported: boolean
  sessions: Map<string, SessionSummary>
  reload(): void
}

/** 三份数据一起拉,同一套触发器合并 300 ms 再拉;重置时马上拉(08 §7.1 同一个模式) */
function useTasks(): Tasks {
  const [runs, setRuns] = useState<RunRow[] | null>(null)
  const [runsUnsupported, setRunsUnsupported] = useState(false)
  const [worktrees, setWorktrees] = useState<TelegramChats['worktrees'] | null>(null)
  const [imUnsupported, setImUnsupported] = useState(false)
  const [sessions, setSessions] = useState<Map<string, SessionSummary>>(() => new Map())
  const gen = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const alive = useRef(true)

  const reload = useCallback(() => {
    const g = ++gen.current
    void call('executor.runs', { limit: 200 }).then(
      (r) => { if (alive.current && g === gen.current) { setRuns(r.runs); setRunsUnsupported(false) } },
      (e) => {
        if (!alive.current || g !== gen.current) return
        const unsupported = isUnsupported(e)
        if (!unsupported) console.error('mffai executor.runs', e)
        setRunsUnsupported(unsupported)
        setRuns([])
      },
    )
    void call('channel.telegram.chats').then(
      (r) => { if (alive.current && g === gen.current) { setWorktrees(r.worktrees); setImUnsupported(false) } },
      (e) => {
        if (!alive.current || g !== gen.current) return
        const unsupported = isUnsupported(e)
        if (!unsupported) console.error('mffai channel.telegram.chats', e)
        setImUnsupported(unsupported)
        setWorktrees([])
      },
    )
    void call('session.list').then(
      (r) => { if (alive.current && g === gen.current) setSessions(new Map(r.sessions.map((s) => [s.id, s]))) },
      () => {},
    )
  }, [])

  useEffect(() => {
    alive.current = true
    reload()
    return () => { alive.current = false; clearTimeout(timer.current) }
  }, [reload])

  useMffaiEvent({ types: RUN_TRIGGERS }, () => {
    if (timer.current !== undefined) return
    timer.current = setTimeout(() => { timer.current = undefined; reload() }, REFRESH_MS)
  })
  useMffaiReset(() => {
    clearTimeout(timer.current)
    timer.current = undefined
    reload()
  })

  return { runs, runsUnsupported, worktrees, imUnsupported, sessions, reload }
}

function phaseChip(row: RunRow) {
  if (row.phase === 'queued') return <Chip>排队</Chip>
  if (row.phase === 'running') return <Chip tone="ok">运行中</Chip>
  const st = row.status ?? ''
  return <Chip tone={st === 'ok' ? 'ok' : st === 'cancelled' ? 'muted' : 'bad'}>{label('runStatus', st)}</Chip>
}

function TaskRunRow({ row, session, onChanged }: { row: RunRow; session?: SessionSummary; onChanged: () => void }) {
  const a = useRunActions(row.sessionId, row.runId)
  const [confirm, setConfirm] = useState<Action | null>(null)

  const present = !a.discarded && !!row.worktree?.present
  const merged = a.merged ?? (row.worktree?.merged ? { files: row.changed ?? 0 } : null)
  const canStop = row.phase !== 'ended'
  const canMerge = row.phase === 'ended' && present && (row.changed ?? 0) > 0 && !merged
  const canDiscard = row.phase === 'ended' && present
  const ref = a.refusal
  const path = row.worktree?.path

  const act = async (what: Action) => {
    setConfirm(null)
    await (what === 'merge' ? a.merge() : a.discard())
    onChanged()
  }

  return (
    <div className="mffai-row mffai-taskrow" data-run={row.runId}>
      <span className="mffai-tool">{row.executor}</span>
      <button className="txt-btn" onClick={() => route.set({ page: 'chat', sessionId: row.sessionId, runId: row.runId })}>
        {session?.title ?? row.sessionId}
      </button>
      {phaseChip(row)}
      {row.ms !== undefined && <Chip>{fmtMs(row.ms)}</Chip>}
      {row.changed !== undefined && <Chip>{`${row.changed} 个文件`}</Chip>}
      {path && <code className="mffai-path">{path}</code>}
      {row.worktree?.bytes !== undefined && <Chip>{fmtBytes(row.worktree.bytes)}</Chip>}
      {merged && <Chip tone="ok">已合并</Chip>}
      {a.discarded && <Chip>已丢弃</Chip>}
      {canStop && <button className="set-btn" disabled={a.busy === 'stop'} onClick={() => void a.stop()}>停止</button>}
      {canMerge && <button className="set-btn" disabled={!!a.busy} onClick={() => setConfirm('merge')}>合并</button>}
      {canDiscard && <button className="set-btn" disabled={!!a.busy} onClick={() => setConfirm('discard')}>丢弃</button>}
      {a.failed?.busy && <Chip tone="warn">忙</Chip>}
      {a.failed && !a.failed.busy && <span className="mffai-fail">失败</span>}
      {ref && (
        <div className="mffai-row mffai-refusal">
          <CodeChip code={ref.reason} />
          {ref.restored === false && <Chip tone="bad">未还原</Chip>}
          {ref.paths?.map((p) => <code key={p} className="mffai-path">{p}</code>)}
        </div>
      )}
      {confirm === 'merge' && (
        <Confirm title={session?.cwd ? `合并到 ${session.cwd}` : '合并'} rows={[['worktree', path ?? '']]} confirmLabel="合并"
          onCancel={() => setConfirm(null)} onConfirm={() => void act('merge')} />
      )}
      {confirm === 'discard' && (
        <Confirm title="丢弃 worktree" rows={[['路径', path ?? '']]} confirmLabel="丢弃" danger
          onCancel={() => setConfirm(null)} onConfirm={() => void act('discard')} />
      )}
    </div>
  )
}

function ImWorktreeRow({ wt, sessions, onChanged }: { wt: TelegramChats['worktrees'][number]; sessions: Map<string, SessionSummary>; onChanged: () => void }) {
  const a = useWorktreeActions(wt.id)
  const [confirm, setConfirm] = useState<Action | null>(null)
  const [changes, setChanges] = useState(false)

  const merged = a.merged ?? (wt.merged ? { files: 0 } : null)
  const canMerge = !a.discarded && !merged
  const canDiscard = !a.discarded
  const underCount = countSessionsUnder(sessions, wt.path)

  const act = async (what: Action) => {
    setConfirm(null)
    await (what === 'merge' ? a.merge() : a.discard())
    onChanged()
  }

  return (
    <div className="mffai-row mffai-taskrow" data-worktree={wt.id}>
      {wt.project && <Chip>{wt.project}</Chip>}
      <code className="mffai-path">{wt.path}</code>
      <CopyButton className="mffai-copy" title={wt.path} text={() => wt.path} />
      <span className="mffai-sess-time">{fmtRelTime(wt.createdAt, Date.now())}</span>
      {wt.bytes !== undefined && <Chip>{fmtBytes(wt.bytes)}</Chip>}
      {wt.usedByChat && <CodeChip code={wt.usedByChat} />}
      {merged && <Chip tone="ok">已合并</Chip>}
      {a.discarded && <Chip>已丢弃</Chip>}
      <button className="txt-btn" aria-expanded={changes} onClick={() => setChanges(!changes)}>改动</button>
      {canMerge && <button className="set-btn" disabled={!!a.busy} onClick={() => setConfirm('merge')}>合并</button>}
      {canDiscard && <button className="set-btn" disabled={!!a.busy} onClick={() => setConfirm('discard')}>丢弃</button>}
      {a.failed?.busy && <Chip tone="warn">忙</Chip>}
      {a.failed && !a.failed.busy && <span className="mffai-fail">失败</span>}
      {a.refusal && (
        <div className="mffai-row mffai-refusal">
          <CodeChip code={a.refusal.reason} />
          {a.refusal.restored === false && <Chip tone="bad">未还原</Chip>}
          {a.refusal.paths?.map((p) => <code key={p} className="mffai-path">{p}</code>)}
        </div>
      )}
      {changes && (
        <ChangesBlock
          load={() => call('channel.telegram.worktree.changes', { worktreeId: wt.id })}
          diff={(p) => call('channel.telegram.worktree.diff', { worktreeId: wt.id, path: p })}
        />
      )}
      {confirm === 'merge' && (
        <Confirm title={wt.project ? `合并到 ${wt.project}` : '合并'} rows={[['worktree', wt.path]]} confirmLabel="合并"
          onCancel={() => setConfirm(null)} onConfirm={() => void act('merge')} />
      )}
      {confirm === 'discard' && (
        <Confirm title="丢弃 worktree" rows={[['路径', wt.path], ['在用的会话', String(underCount)]]} confirmLabel="丢弃" danger
          onCancel={() => setConfirm(null)} onConfirm={() => void act('discard')} />
      )}
    </div>
  )
}

const RUN_GROUPS: readonly { phase: RunRow['phase']; title: string }[] = [
  { phase: 'running', title: '运行中' },
  { phase: 'queued', title: '排队' },
  { phase: 'ended', title: '已结束' },
]

export default function TasksPage() {
  const { runs, runsUnsupported, worktrees, imUnsupported, sessions, reload } = useTasks()

  return (
    <div className="mffai-pane mffai-tasks">
      {runsUnsupported ? (
        <div className="mffai-group">
          <div className="mffai-grouphead"><span>任务</span></div>
          <Chip>不支持</Chip>
        </div>
      ) : runs !== null && RUN_GROUPS.map(({ phase, title }) => {
        const inGroup = runs.filter((r) => r.phase === phase)
        // 占用名额的不只是 已结束 的:运行中的运行一样占着一个 worktree,只是没地方丢弃。标在 已结束 上,数按全体算才不低估
        const retained = runs.filter((r) => r.worktree?.present).length
        return (
          <div key={phase} className="mffai-group">
            <div className="mffai-grouphead">
              <span>{title}</span>
              <span className="mffai-count">{phase === 'ended' ? `${retained} / ${MAX_WORKTREES}` : String(inGroup.length)}</span>
            </div>
            {inGroup.map((r) => <TaskRunRow key={r.runId} row={r} session={sessions.get(r.sessionId)} onChanged={reload} />)}
          </div>
        )
      })}
      <div className="mffai-group">
        <div className="mffai-grouphead">
          <span>IM worktree</span>
          {!imUnsupported && <span className="mffai-count">{`${worktrees?.length ?? 0} / ${MAX_WORKTREES}`}</span>}
        </div>
        {imUnsupported ? <Chip>不支持</Chip> : worktrees?.map((wt) => (
          <ImWorktreeRow key={wt.id} wt={wt} sessions={sessions} onChanged={reload} />
        ))}
      </div>
    </div>
  )
}
