// 任务页(08 §9):executor.runs 的 运行中 / 排队 / 已结束 三组,外加 IM worktree 一组(channel.telegram.chats 的
// worktrees)。执行器行的 停止/合并/丢弃 和 RunCard 共用 ../actions 的 useRunActions(sessionId, runId);IM worktree
// 没有会话可带,走 channel.telegram.worktree.*(同一个 ../actions 里的 useWorktreeActions)。
// 丢弃 IM worktree 时多算 在用的会话:后台的丢弃看不见里面开的 app 会话(07 followups Task 11 M4),
// 这里按 session.list 的 cwd 是否落在这棵 worktree 路径下(按 / 分界,不把 wt_10 当 wt_1 的孩子)数给用户看。
// 组标题的 N / 20 只在 已结束、IM worktree 两组上(委派 worktree 和 IM worktree 各自一个 20 个的上限,
// 满了就是在这页丢弃;运行中、排队不占 worktree 名额,只显示行数)。
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import type { EventType, RunRow, SessionSummary, TelegramChats } from '@mffai/protocol'
import { fmtRelTime } from '@shared/relTime'
import { CopyButton } from '../../views/chat/blocks'
import { call, isUnsupported, toCallError } from '../rpc'
import { useMffaiEvent, useMffaiReset } from '../events'
import { route } from '../route'
import { label } from '../labels'
import { Chip } from '../ui/Chip'
import { CodeChip } from '../ui/CodeChip'
import { Confirm } from '../ui/Confirm'
import { ChangesBlock } from '../chat/ChangesBlock'
import { useRunActions, useWorktreeActions } from '../actions'
import { Icon } from '../shell/icons'
import { HeaderExtra } from '../shell/headerSlot'
import { execTint } from '../ui/tint'

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

type Action = 'merge' | 'discard'

interface Tasks {
  runs: RunRow[] | null
  runsUnsupported: boolean
  worktrees: TelegramChats['worktrees'] | null
  imUnsupported: boolean
  sessions: Map<string, SessionSummary>
  /** 项目名 → 真实检出路径(channel.telegram.config.get);IM worktree 合并要给用户看写进哪里,不能只报项目名 */
  projectPaths: Map<string, string>
  reload(): void
}

/** 三份数据一起拉,同一套触发器合并 300 ms 再拉;重置时马上拉(08 §7.1 同一个模式) */
function useTasks(): Tasks {
  const [runs, setRuns] = useState<RunRow[] | null>(null)
  const [runsUnsupported, setRunsUnsupported] = useState(false)
  const [worktrees, setWorktrees] = useState<TelegramChats['worktrees'] | null>(null)
  const [imUnsupported, setImUnsupported] = useState(false)
  const [sessions, setSessions] = useState<Map<string, SessionSummary>>(() => new Map())
  const [projectPaths, setProjectPaths] = useState<Map<string, string>>(() => new Map())
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
    void call('channel.telegram.config.get').then(
      (r) => { if (alive.current && g === gen.current) setProjectPaths(new Map(r.projects.map((p) => [p.name, p.path]))) },
      (e) => { if (alive.current && g === gen.current && !isUnsupported(e)) console.error('mffai channel.telegram.config.get', e) },
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

  return { runs, runsUnsupported, worktrees, imUnsupported, sessions, projectPaths, reload }
}

function phaseChip(row: RunRow) {
  if (row.phase === 'queued') return <Chip tone="line">排队</Chip>
  if (row.phase === 'running') return <Chip tone="run" dot>运行中</Chip>
  const st = row.status ?? ''
  return <Chip tone={st === 'ok' ? 'ok' : st === 'cancelled' ? 'muted' : 'bad'}>{label('runStatus', st)}</Chip>
}

const COLS = 7

function Refusal({ reason, restored, paths }: { reason: string; restored?: boolean; paths?: string[] }) {
  return (
    <tr className="mffai-tsub"><td colSpan={COLS}>
      <div className="mffai-row mffai-refusal">
        <CodeChip code={reason} tone="bad" />
        {restored === false && <Chip tone="bad">未还原</Chip>}
        {paths?.map((p) => <code key={p} className="mffai-path">{p}</code>)}
      </div>
    </td></tr>
  )
}

function TaskRunRow({ row, session, onChanged }: { row: RunRow; session?: SessionSummary; onChanged: () => void }) {
  const a = useRunActions(row.sessionId, row.runId)
  const [confirm, setConfirm] = useState<Action | null>(null)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)

  const present = !a.discarded && !!row.worktree?.present
  const merged = a.merged ?? (row.worktree?.merged ? { files: row.changed ?? 0 } : null)
  const canStop = row.phase !== 'ended'
  const canMerge = row.phase === 'ended' && present && (row.changed ?? 0) > 0 && !merged
  const canDiscard = row.phase === 'ended' && present
  const ref = a.refusal
  const path = row.worktree?.path
  const ask = (what: Action) => (e: MouseEvent<HTMLButtonElement>) => { setAnchor(e.currentTarget); setConfirm(what) }

  const act = async (what: Action) => {
    setConfirm(null)
    await (what === 'merge' ? a.merge() : a.discard())
    onChanged()
  }

  return (
    <tbody className="mffai-trow" data-run={row.runId}>
      <tr>
        <td>
          <div className="mffai-tname">
            <span className={`mffai-rlogo ${execTint(row.executor)}`}><Icon name="term" size={12} /></span>
            <span className="mffai-tool">{row.executor}</span>
          </div>
        </td>
        <td>
          <button className="txt-btn mffai-tlink" onClick={() => route.set({ page: 'chat', sessionId: row.sessionId, runId: row.runId })}>
            <Icon name="chat" size={12} />{session?.title ?? row.sessionId}
          </button>
        </td>
        <td>
          <div className="mffai-tstate">
            {phaseChip(row)}
            {row.phase === 'ended' && row.reason && <CodeChip code={row.reason} tone={row.status === 'ok' || row.status === 'cancelled' ? undefined : 'bad'} />}
            {merged && <Chip tone="ok">已合并</Chip>}
            {a.discarded && <Chip>已丢弃</Chip>}
          </div>
        </td>
        <td className="mffai-mono">{row.ms !== undefined ? fmtMs(row.ms) : '—'}</td>
        <td className="mffai-mono">{row.changed !== undefined ? `${row.changed} 个文件` : '—'}</td>
        <td className="mffai-mono" title={path}>{row.worktree?.bytes !== undefined ? fmtBytes(row.worktree.bytes) : '—'}</td>
        <td>
          <div className="mffai-tact">
            {canStop && <button className="set-btn" disabled={a.busy === 'stop'} onClick={() => void a.stop()}><Icon name="pause" size={12} />停止</button>}
            {canMerge && <button className="set-btn mffai-primary" disabled={!!a.busy} onClick={ask('merge')}><Icon name="merge" size={12} />合并</button>}
            {canDiscard && <button className="set-btn mffai-danger" disabled={!!a.busy} onClick={ask('discard')}>丢弃</button>}
            {a.failed?.busy && <Chip tone="warn">忙</Chip>}
            {a.failed && !a.failed.busy && <span className="mffai-fail">失败</span>}
            {confirm === 'merge' && (
              <Confirm title={session?.cwd ? `合并到 ${session.cwd}` : '合并'} rows={[['worktree', path ?? ''], ['文件', String(row.changed ?? 0)]]} confirmLabel="合并" anchor={anchor}
                onCancel={() => setConfirm(null)} onConfirm={() => void act('merge')} />
            )}
            {confirm === 'discard' && (
              <Confirm title="丢弃 worktree" rows={[['路径', path ?? '']]} confirmLabel="丢弃" danger anchor={anchor}
                onCancel={() => setConfirm(null)} onConfirm={() => void act('discard')} />
            )}
          </div>
        </td>
      </tr>
      {ref && <Refusal reason={ref.reason} restored={ref.restored} paths={ref.paths} />}
    </tbody>
  )
}

function ImWorktreeRow({ wt, sessions, projectPaths, onChanged }: {
  wt: TelegramChats['worktrees'][number]
  sessions: Map<string, SessionSummary>
  /** 项目名 → 真实检出路径;没查到就不给合并(宁可不给,也不拿项目名糊弄用户写进哪里) */
  projectPaths: Map<string, string>
  onChanged: () => void
}) {
  const a = useWorktreeActions(wt.id)
  const [confirm, setConfirm] = useState<Action | null>(null)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [changes, setChanges] = useState(false)

  const checkout = wt.project ? projectPaths.get(wt.project) : undefined
  const merged = a.merged ?? (wt.merged ? { files: 0 } : null)
  const canMerge = !a.discarded && !merged && !!checkout
  const canDiscard = !a.discarded
  const underCount = countSessionsUnder(sessions, wt.path)
  const ask = (what: Action) => (e: MouseEvent<HTMLButtonElement>) => { setAnchor(e.currentTarget); setConfirm(what) }

  const act = async (what: Action) => {
    setConfirm(null)
    await (what === 'merge' ? a.merge() : a.discard())
    onChanged()
  }

  return (
    <tbody className="mffai-trow" data-worktree={wt.id}>
      <tr>
        <td>
          <div className="mffai-tname">
            <span className="mffai-rlogo im"><Icon name="send" size={12} /></span>
            <div className="mffai-tstack">
              {wt.project && <span className="mffai-tool">{wt.project}</span>}
              <span className="mffai-tpathrow">
                <code className="mffai-path">{wt.path}</code>
                <CopyButton className="mffai-copy" title={wt.path} text={() => wt.path} />
              </span>
            </div>
          </div>
        </td>
        <td>{wt.usedByChat && <CodeChip code={wt.usedByChat} />}</td>
        <td className="mffai-mono mffai-sess-time">{fmtRelTime(wt.createdAt, Date.now())}</td>
        <td>
          <div className="mffai-tstate">
            {merged && <Chip tone="ok">已合并</Chip>}
            {a.discarded && <Chip>已丢弃</Chip>}
          </div>
        </td>
        <td className="mffai-mono">{wt.bytes !== undefined ? fmtBytes(wt.bytes) : '—'}</td>
        <td>
          <div className="mffai-tact">
            <button className="set-btn" aria-expanded={changes} onClick={() => setChanges(!changes)}>改动</button>
            {canMerge && <button className="set-btn mffai-primary" disabled={!!a.busy} onClick={ask('merge')}><Icon name="merge" size={12} />合并</button>}
            {canDiscard && <button className="set-btn mffai-danger" disabled={!!a.busy} onClick={ask('discard')}>丢弃</button>}
            {a.failed?.busy && <Chip tone="warn">忙</Chip>}
            {a.failed && !a.failed.busy && <span className="mffai-fail">失败</span>}
            {confirm === 'merge' && checkout && (
              <Confirm title={`合并到 ${checkout}`} rows={[['项目', wt.project], ['worktree', wt.path]]} confirmLabel="合并" anchor={anchor}
                onCancel={() => setConfirm(null)} onConfirm={() => void act('merge')} />
            )}
            {confirm === 'discard' && (
              <Confirm title="丢弃 worktree" rows={[['路径', wt.path], ['在用的会话', String(underCount)]]} confirmLabel="丢弃" danger anchor={anchor}
                onCancel={() => setConfirm(null)} onConfirm={() => void act('discard')} />
            )}
          </div>
        </td>
      </tr>
      {a.refusal && <Refusal reason={a.refusal.reason} restored={a.refusal.restored} paths={a.refusal.paths} />}
      {changes && (
        <tr className="mffai-tsub"><td colSpan={COLS}>
          <ChangesBlock
            load={() => call('channel.telegram.worktree.changes', { worktreeId: wt.id })}
            diff={(p) => call('channel.telegram.worktree.diff', { worktreeId: wt.id, path: p })}
          />
        </td></tr>
      )}
    </tbody>
  )
}

/** 一张卡片:标题 + 数量 + 右侧的块,下面是表(没有行就没有表) */
function TCard({ kind, title, count, chip, children }: { kind: string; title: string; count?: number; chip?: ReactNode; children?: ReactNode }) {
  return (
    <section className="mffai-tgroup" data-tcard={kind}>
      <div className="mffai-sech">
        <span className="mffai-tcard-title">{title}</span>
        {count !== undefined && <span className="mffai-count">{count}</span>}
        <span className="mffai-spring" />
        {chip}
      </div>
      {children}
    </section>
  )
}

const slots = (n: number) => <Chip tone="line">worktree <b>{`${n} / ${MAX_WORKTREES}`}</b></Chip>

function Table({ cols, children }: { cols: readonly string[]; children: ReactNode }) {
  return (
    <div className="mffai-tbox">
      <table className="mffai-tbl mffai-ttbl">
        <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}<th /></tr></thead>
        {children}
      </table>
    </div>
  )
}

const RUN_COLS = ['任务', '会话', '状态', '耗时', '改动', 'worktree'] as const
const IM_COLS = ['项目', '在用', '创建', '状态', 'worktree'] as const

export default function TasksPage() {
  const { runs, runsUnsupported, worktrees, imUnsupported, sessions, projectPaths, reload } = useTasks()
  const row = (r: RunRow) => <TaskRunRow key={r.runId} row={r} session={sessions.get(r.sessionId)} onChanged={reload} />
  // 运行中先、排队后;都在一张 进行中 的卡里
  const live = runs ? [...runs.filter((r) => r.phase === 'running'), ...runs.filter((r) => r.phase === 'queued')] : []
  const ended = runs ? runs.filter((r) => r.phase === 'ended') : []
  // 占用名额的不只是 已结束 的:运行中的运行一样占着一个 worktree,只是没地方丢弃。标在 已结束 上,数按全体算才不低估
  const retained = runs ? runs.filter((r) => r.worktree?.present).length : 0

  return (
    <div className="mffai-pane mffai-tasks">
      {runs !== null && !runsUnsupported && (
        <HeaderExtra>
          <Chip tone="run" dot>{`${runs.filter((r) => r.phase === 'running').length} 运行中`}</Chip>
          <Chip tone="line">{`${runs.filter((r) => r.phase === 'queued').length} 排队`}</Chip>
        </HeaderExtra>
      )}
      {runsUnsupported ? (
        <TCard kind="live" title="任务"><Chip>不支持</Chip></TCard>
      ) : runs !== null && (
        <>
          <TCard kind="live" title="进行中" count={live.length}>
            {live.length > 0 && <Table cols={RUN_COLS}>{live.map(row)}</Table>}
          </TCard>
          <TCard kind="ended" title="已结束" count={ended.length} chip={slots(retained)}>
            {ended.length > 0 && <Table cols={RUN_COLS}>{ended.map(row)}</Table>}
          </TCard>
        </>
      )}
      <TCard kind="im" title="IM worktree" count={imUnsupported ? undefined : worktrees?.length ?? 0} chip={imUnsupported ? undefined : slots(worktrees?.length ?? 0)}>
        {imUnsupported ? <Chip>不支持</Chip> : worktrees && worktrees.length > 0 && (
          <Table cols={IM_COLS}>
            {worktrees.map((wt) => <ImWorktreeRow key={wt.id} wt={wt} sessions={sessions} projectPaths={projectPaths} onChanged={reload} />)}
          </Table>
        )}
      </TCard>
    </div>
  )
}
