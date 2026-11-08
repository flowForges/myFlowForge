// 一个会话的事件 → 视图(08 §6.3、§8)。纯函数,按 seq 去重;历史(session.state / session.events)和实时推送走同一个函数。
// 调试页继续用它自己的 toView。
import type {
  ApprovalResolvedPayload, ContextRebuiltPayload, ExecutorIsolation, ExecutorRunEndedPayload, ExecutorRunProgressPayload,
  KernelEvent, TurnUsagePayload, WorkerResult,
} from '@mffai/protocol'
import type { ToolActivity } from '@shared/types'

export type StepTool = ToolActivity & { truncated?: boolean }

export interface Step { key: string; seq: number; ts: number; text: string; final: boolean; reasoning: string; tools: StepTool[] }

export interface ApprovalItem {
  approvalId: string; turnId: string; callId: string; tool: string; summary: string; seq: number
  key?: string; unsandboxed?: boolean
  resolved?: Pick<ApprovalResolvedPayload, 'decision' | 'by' | 'via'>
  /** 没有终态事件,但 session.state 的 open 里也没有它:后台已经不认了 */
  stale?: boolean
}

export interface RunItem {
  runId: string; turnId: string; seq: number
  phase: 'queued' | 'running' | 'ended'
  executor: string
  summary?: string; readOnly?: boolean; isolation?: ExecutorIsolation; position?: number
  cwd?: string; worktree?: string; untranslatedRules?: number
  progress: { seq: number; kind: ExecutorRunProgressPayload['kind']; text: string }[]
  ended?: ExecutorRunEndedPayload
  merged?: { files: number }
}

export interface TurnView {
  turnId: string; seq: number
  users: { text: string; followUp: boolean; external: boolean; seq: number; ts: number }[]
  steps: Step[]
  approvals: ApprovalItem[]
  runs: Map<string, RunItem>
  usage?: TurnUsagePayload
  snapshot?: { start?: string; end?: string; changed?: number; reason?: string }
  rolledBack?: { files: number; skipped: string[] }
  injected?: { items: string[]; truncated: boolean }
  plugins?: boolean
  rebuilt?: ContextRebuiltPayload[]
  netDenied: string[]
  /** 这一轮里自动放行被收回 */
  narrowed?: boolean
  terminal?: { type: 'turn.ended' | 'turn.failed'; reason?: string }
}

export interface SessionView {
  lastSeq: number; firstSeq: number; hasMore: boolean
  turns: TurnView[]
  open?: { turnId: string; parked: boolean }
  narrowed: boolean
}

export const emptyView = (): SessionView => ({ lastSeq: 0, firstSeq: 0, hasMore: false, turns: [], narrowed: false })

type P = Record<string, unknown>
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

const newTurn = (turnId: string, seq: number): TurnView => ({ turnId, seq, users: [], steps: [], approvals: [], runs: new Map(), netDenied: [] })

/** 换掉一轮(没有就新建在末尾)。f 拿到的是拷贝,只拷顶层;要改的数组、Map 由 f 自己换新的 */
function withTurn(v: SessionView, turnId: string, seq: number, f: (t: TurnView) => TurnView | undefined): SessionView {
  const i = v.turns.findIndex((t) => t.turnId === turnId)
  const cur = i >= 0 ? v.turns[i] : newTurn(turnId, seq)
  const next = f({ ...cur })
  if (!next) return v
  const turns = v.turns.slice()
  if (i >= 0) turns[i] = next
  else turns.push(next)
  return { ...v, turns }
}

/** 这一步(turnId + step;loop-direct 没有 step 就按 turnId) */
function withStep(t: TurnView, stepNo: number | undefined, seq: number, ts: number, f: (s: Step) => Step): TurnView {
  const key = `${t.turnId}:${stepNo ?? ''}`
  const i = t.steps.findIndex((s) => s.key === key)
  const cur = i >= 0 ? t.steps[i] : { key, seq, ts, text: '', final: false, reasoning: '', tools: [] }
  const steps = t.steps.slice()
  if (i >= 0) steps[i] = f(cur)
  else steps.push(f(cur))
  return { ...t, steps }
}

/** 工具调用挂在这一轮最近的一步上(message.assistant 先写,它的调用随后) */
function withTool(t: TurnView, seq: number, ts: number, callId: string, f: (x: StepTool | undefined) => StepTool): TurnView {
  const hostIdx = t.steps.findIndex((s) => s.tools.some((x) => x.id === callId))
  const host = hostIdx >= 0 ? t.steps[hostIdx] : t.steps.at(-1)
  const stepNo = host ? host.key.slice(t.turnId.length + 1) : ''
  return withStep(t, stepNo === '' ? undefined : Number(stepNo), seq, ts, (s) => {
    const j = s.tools.findIndex((x) => x.id === callId)
    const tools = s.tools.slice()
    if (j >= 0) tools[j] = f(tools[j])
    else tools.push(f(undefined))
    return { ...s, tools }
  })
}

function withRun(v: SessionView, turnId: string | undefined, runId: string, seq: number, f: (r: RunItem) => RunItem): SessionView {
  const owner = v.turns.find((t) => t.runs.has(runId))?.turnId ?? turnId
  if (!owner) return v
  return withTurn(v, owner, seq, (t) => {
    const cur = t.runs.get(runId) ?? { runId, turnId: owner, seq, phase: 'queued' as const, executor: '', progress: [] }
    const runs = new Map(t.runs)
    runs.set(runId, f(cur))
    return { ...t, runs }
  })
}

const lastTurnId = (v: SessionView): string | undefined => v.open?.turnId ?? v.turns.at(-1)?.turnId

/** 一条事件进视图。seq <= lastSeq 的、不认识的类型原样返回同一个对象 */
export function reduce(v: SessionView, e: KernelEvent): SessionView {
  if (typeof e?.seq !== 'number' || e.seq <= v.lastSeq) return v
  const next = apply(v, e)
  if (next === v && !KNOWN.has(e.type)) return v
  return { ...next, lastSeq: e.seq, firstSeq: v.firstSeq || e.seq }
}

const KNOWN: ReadonlySet<string> = new Set([
  'message.user', 'turn.started', 'message.assistant.delta', 'message.assistant', 'message.reasoning.delta', 'turn.usage',
  'tool.started', 'tool.ended', 'approval.requested', 'approval.resolved', 'turn.parked', 'turn.resumed', 'turn.ended', 'turn.failed',
  'turn.snapshot', 'turn.rolledBack', 'executor.run.queued', 'executor.run.started', 'executor.run.progress', 'executor.run.ended',
  'executor.worktree.merged', 'memory.injected', 'plugins.injected', 'context.rebuilt', 'sandbox.netDenied', 'session.approvalNarrowed',
])

function apply(v: SessionView, e: KernelEvent): SessionView {
  const p: P = e.payload && typeof e.payload === 'object' && !Array.isArray(e.payload) ? (e.payload as P) : {}
  const turnId = str(p.turnId)
  const seq = e.seq
  const opened = (id: string): SessionView['open'] => (v.open?.turnId === id ? v.open : { turnId: id, parked: false })

  switch (e.type) {
    case 'message.user': {
      if (!turnId) return v
      const w = withTurn(v, turnId, seq, (t) => ({
        ...t, users: [...t.users, { text: str(p.text) ?? '', followUp: p.followUp === true, external: p.external === true, seq, ts: e.ts }],
      }))
      return { ...w, open: opened(turnId) }
    }
    case 'turn.started':
      if (!turnId) return v
      return { ...withTurn(v, turnId, seq, (t) => t), open: opened(turnId) }
    case 'message.assistant.delta':
      if (!turnId) return v
      return withTurn(v, turnId, seq, (t) => withStep(t, num(p.step), seq, e.ts, (s) => (s.final ? s : { ...s, text: s.text + (str(p.text) ?? '') })))
    case 'message.assistant':
      if (!turnId) return v
      return withTurn(v, turnId, seq, (t) => withStep(t, num(p.step), seq, e.ts, (s) => ({ ...s, text: str(p.text) ?? '', final: true })))
    case 'message.reasoning.delta':
      if (!turnId) return v
      return withTurn(v, turnId, seq, (t) => withStep(t, num(p.step), seq, e.ts, (s) => ({ ...s, reasoning: s.reasoning + (str(p.text) ?? '') })))
    case 'turn.usage':
      if (!turnId) return v
      return withTurn(v, turnId, seq, (t) => {
        const u = t.usage
        const add = (a: number | undefined, b: unknown) => (num(b) === undefined ? a : (a ?? 0) + num(b)!)
        const cacheRead = add(u?.cacheRead, p.cacheRead)
        const cacheWrite = add(u?.cacheWrite, p.cacheWrite)
        return {
          ...t,
          usage: {
            turnId, input: (u?.input ?? 0) + (num(p.input) ?? 0), output: (u?.output ?? 0) + (num(p.output) ?? 0),
            ...(cacheRead !== undefined && { cacheRead }), ...(cacheWrite !== undefined && { cacheWrite }),
          },
        }
      })
    case 'tool.started':
    case 'tool.ended': {
      const callId = str(p.callId)
      if (!turnId || !callId) return v
      const title = `${str(p.name) ?? ''} ${str(p.argsPreview) ?? ''}`.trim()
      return withTurn(v, turnId, seq, (t) => withTool(t, seq, e.ts, callId, (x) => {
        const base: StepTool = x ?? { id: callId, title, name: str(p.name), status: 'run' }
        if (e.type === 'tool.started') return base
        const { truncated: _old, ...rest } = base
        return { ...rest, status: p.ok === true ? 'ok' : 'error', output: str(p.content) ?? '', ...(p.truncated === true && { truncated: true }) }
      }))
    }
    case 'approval.requested': {
      const approvalId = str(p.approvalId)
      if (!turnId || !approvalId) return v
      return withTurn(v, turnId, seq, (t) => {
        if (t.approvals.some((a) => a.approvalId === approvalId)) return undefined
        const a: ApprovalItem = {
          approvalId, turnId, callId: str(p.callId) ?? '', tool: str(p.tool) ?? '', summary: str(p.summary) ?? '', seq,
          ...(str(p.key) !== undefined && { key: str(p.key) }), ...(p.unsandboxed === true && { unsandboxed: true }),
        }
        return { ...t, approvals: [...t.approvals, a] }
      })
    }
    case 'approval.resolved': {
      const approvalId = str(p.approvalId)
      const owner = approvalId && v.turns.find((t) => t.approvals.some((a) => a.approvalId === approvalId))
      if (!owner) return v
      const decision = p.decision === 'allow' ? 'allow' : 'deny'
      const by = (['user', 'session', 'timeout', 'cancel'] as const).find((b) => b === p.by) ?? 'user'
      return withTurn(v, owner.turnId, seq, (t) => ({
        ...t,
        approvals: t.approvals.map((a) => (a.approvalId === approvalId
          ? { ...a, stale: false, resolved: { decision, by, ...(str(p.via) !== undefined && { via: str(p.via) }) } }
          : a)),
      }))
    }
    case 'turn.parked':
    case 'turn.resumed':
      if (!turnId) return v
      return { ...withTurn(v, turnId, seq, (t) => t), open: { turnId, parked: e.type === 'turn.parked' } }
    case 'turn.ended':
    case 'turn.failed': {
      if (!turnId) return v
      const w = withTurn(v, turnId, seq, (t) => ({
        ...t, terminal: { type: e.type as 'turn.ended' | 'turn.failed', ...(e.type === 'turn.failed' && str(p.reason) !== undefined && { reason: str(p.reason) }) },
      }))
      return v.open?.turnId === turnId ? { ...w, open: undefined } : w
    }
    case 'turn.snapshot':
      if (!turnId) return v
      return withTurn(v, turnId, seq, (t) => {
        const s = { ...t.snapshot }
        const ref = str(p.ref)
        if (ref && p.phase === 'start') s.start = ref
        if (ref && p.phase === 'end') s.end = ref
        if (p.phase === 'end' && num(p.changed) !== undefined) s.changed = num(p.changed)
        if (str(p.reason) !== undefined) s.reason = str(p.reason)
        return { ...t, snapshot: s }
      })
    case 'turn.rolledBack':
      if (!turnId) return v
      return withTurn(v, turnId, seq, (t) => ({ ...t, rolledBack: { files: num(p.files) ?? 0, skipped: strs(p.skipped) } }))
    case 'executor.run.queued':
    case 'executor.run.started':
    case 'executor.run.progress':
    case 'executor.run.ended': {
      const runId = str(p.runId)
      if (!runId) return v
      return withRun(v, turnId, runId, seq, (r) => {
        const x: RunItem = { ...r, executor: str(p.executor) ?? r.executor }
        if (e.type === 'executor.run.queued') {
          if (r.phase === 'queued') x.position = num(p.position)
          x.summary = str(p.summary)
          x.readOnly = p.readOnly === true
          x.isolation = p.isolation as ExecutorIsolation
        } else if (e.type === 'executor.run.started') {
          if (r.phase !== 'ended') x.phase = 'running'
          x.cwd = str(p.cwd)
          x.isolation = p.isolation as ExecutorIsolation
          if (str(p.worktree)) x.worktree = str(p.worktree)
          if (num(p.untranslatedRules)) x.untranslatedRules = num(p.untranslatedRules)
        } else if (e.type === 'executor.run.progress') {
          if (r.phase === 'queued') x.phase = 'running'
          x.progress = [...r.progress, { seq, kind: p.kind as RunItem['progress'][number]['kind'], text: str(p.text) ?? '' }]
        } else {
          x.phase = 'ended'
          x.ended = p as unknown as ExecutorRunEndedPayload
          if (str(p.worktree)) x.worktree = str(p.worktree)
        }
        return x
      })
    }
    case 'executor.worktree.merged': {
      const runId = str(p.runId)
      if (!runId || !v.turns.some((t) => t.runs.has(runId))) return v
      return withRun(v, undefined, runId, seq, (r) => ({ ...r, merged: { files: num(p.files) ?? 0 } }))
    }
    case 'memory.injected':
      if (!turnId) return v
      return withTurn(v, turnId, seq, (t) => {
        const items = [...(t.injected?.items ?? [])]
        for (const id of strs(p.items)) if (!items.includes(id)) items.push(id)
        return { ...t, injected: { items, truncated: (t.injected?.truncated ?? false) || p.truncated === true } }
      })
    case 'plugins.injected':
      if (!turnId) return v
      return withTurn(v, turnId, seq, (t) => ({ ...t, plugins: true }))
    case 'context.rebuilt':
      if (!turnId) return v
      return withTurn(v, turnId, seq, (t) => ({ ...t, rebuilt: [...(t.rebuilt ?? []), p as unknown as ContextRebuiltPayload] }))
    case 'sandbox.netDenied': {
      const id = lastTurnId(v)
      if (!id) return v
      return withTurn(v, id, seq, (t) => ({ ...t, netDenied: [...t.netDenied, `${str(p.host) ?? ''}:${num(p.port) ?? ''}`] }))
    }
    case 'session.approvalNarrowed': {
      const id = lastTurnId(v)
      const w = id ? withTurn(v, id, seq, (t) => ({ ...t, narrowed: true })) : v
      return { ...w, narrowed: true }
    }
    default:
      return v
  }
}

/** session.state → 视图。open 以后台为准:没有 open 的轮当作已结束;不在 approvalIds 里的未决审批是旧的 */
export function fromState(r: WorkerResult<'session.state'>): SessionView {
  const v = r.events.reduce(reduce, emptyView())
  const open = r.open ? { turnId: r.open.turnId, parked: r.open.parked } : undefined
  const live = new Set(r.open?.approvalIds ?? [])
  const turns = v.turns.map((t) => (t.approvals.some((a) => !a.resolved && !live.has(a.approvalId))
    ? { ...t, approvals: t.approvals.map((a) => (!a.resolved && !live.has(a.approvalId) ? { ...a, stale: true } : a)) }
    : t))
  return {
    ...v, turns, open, hasMore: r.hasMore, lastSeq: Math.max(v.lastSeq, r.lastSeq),
    firstSeq: r.events[0]?.seq ?? v.firstSeq,
  }
}

/** 轮结束了:有终态事件,或不是开着的那一轮(后台的 open 是权威) */
export const isEnded = (v: SessionView, t: TurnView): boolean => !!t.terminal || v.open?.turnId !== t.turnId

/**
 * 能回滚的轮(同 loop-default 的 rollbackRefs + 开着的轮时 busy,同调试面板的 rollbackable):
 * 跑过快照、没回滚过的轮里最新的一个,两张快照都在,而且会话里没有开着的轮
 */
export function rollbackable(v: SessionView): string | undefined {
  if (v.open) return undefined
  const latest = v.turns.filter((t) => t.snapshot && !t.rolledBack).at(-1)
  if (!latest?.snapshot?.start || !latest.snapshot.end || !isEnded(v, latest)) return undefined
  return latest.turnId
}
