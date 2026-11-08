import { useEffect, useMemo, useState } from 'react'
import type { KernelEvent, ModelRef, SandboxStatus } from '@mffai/protocol'
import { ModelPicker } from './ModelPicker'
import { applyRedaction } from './debug/redact'

const KEEP = 500
const ARGS_SHOWN = 60
type Decision = 'allow' | 'allow_session' | 'deny'

interface Payload {
  turnId?: string; step?: number; text?: unknown; input?: number; output?: number
  callId?: string; name?: string; argsPreview?: string; ok?: boolean
  approvalId?: string; summary?: string
  phase?: string; ref?: string; changed?: unknown; skipped?: unknown
  unsandboxed?: unknown; key?: unknown; host?: unknown; port?: unknown
  runId?: unknown; executor?: unknown; status?: unknown
}
const payloadOf = (e: KernelEvent) => (e.payload ?? {}) as Payload
const textOf = (e: KernelEvent) => String(payloadOf(e).text ?? '')
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

const RUN_STATUS = new Map<unknown, string>([
  ['ok', '完成'], ['failed', '失败'], ['cancelled', '已取消'], ['timeout', '超时'], ['stalled', '卡住'], ['interrupted', '中断'],
])
/** 改动文件数。线上把长列表截断,截掉的数量在 filesTruncated */
function fileCount(changed: unknown): number {
  const c = changed as { files?: unknown; filesTruncated?: unknown } | null | undefined
  if (!Array.isArray(c?.files)) return 0
  return c.files.length + (typeof c.filesTruncated === 'number' ? c.filesTruncated : 0)
}
const runLabel = (p: Payload, label: string) => `${typeof p.executor === 'string' ? p.executor : ''} ${label}`.trim()

/** 这些事件说明轮开过。不含运行结束、通知、快照:它们可能晚于终态,而终态可能已滑出窗口 */
const OPENS_TURN: ReadonlySet<string> = new Set([
  'message.user', 'turn.started', 'turn.parked', 'turn.resumed',
  'message.assistant.delta', 'message.assistant', 'message.reasoning.delta',
  'tool.started', 'approval.requested',
  'executor.run.queued', 'executor.run.started', 'executor.run.progress',
])

/**
 * 留最近 KEEP 条,超出时先丢最旧的进度:一个运行能写 2000 条进度,
 * 否则几分钟就把用户行和 turn.parked 挤出窗口,而挂起的轮可能开 30 分钟
 */
function trimEvents(events: KernelEvent[]): KernelEvent[] {
  let over = events.length - KEEP
  if (over <= 0) return events
  const out: KernelEvent[] = []
  for (const e of events) {
    if (over > 0 && e.type === 'executor.run.progress') over--
    else out.push(e)
  }
  return out.slice(-KEEP)
}

type Kind = 'user' | 'assistant' | 'tool' | 'approval' | 'snapshot' | 'net' | 'run'
interface Item {
  key: string
  kind: Kind
  text: string
  turnId?: string
  sessionId?: string
  /** assistant:已有终稿,之后的 delta 不再拼 */
  final?: boolean
  reasoning?: string
  usage?: string
  /** tool:undefined = 进行中 */
  ok?: boolean
  approvalId?: string
  resolved?: boolean
  unsandboxed?: boolean
  /** 审批能不能本会话放行:内核给了 key 才能 */
  sessionKey?: boolean
  changed?: number
  failed?: boolean
}

interface Turn { sessionId?: string; started: boolean; terminal: boolean; failed: boolean; parked: boolean; snapshotted: boolean; startRef: boolean; endRef: boolean; items: number[] }
interface RolledBack { skipped: string[] }

interface View { items: Item[]; turns: Map<string, Turn>; rolledBack: Map<string, RolledBack>; snapOrder: string[] }

const LEVEL: Record<SandboxStatus['level'], string> = { full: '完整', partial: '部分', none: '未隔离' }

const visible = (it: Item) => it.kind !== 'snapshot' && !((it.kind === 'approval' || it.kind === 'run') && it.resolved) &&
  !(it.kind === 'assistant' && !it.text && !it.reasoning && !it.usage)

/**
 * 事件 → 行。助手文本按 turnId + step 分行(无 step 的 loop-direct 按 turnId);有终稿用终稿,否则拼 delta。
 * 工具调用、审批请求、结束快照各占一行,位置取首次出现处
 */
function toView(events: KernelEvent[]): View {
  const items: Item[] = []
  const at = new Map<string, number>()
  const turns = new Map<string, Turn>()
  const rolledBack = new Map<string, RolledBack>()
  const snapOrder: string[] = []
  const userLines = new Map<string, number>()
  const turn = (id: string, sessionId?: string): Turn => {
    let t = turns.get(id)
    if (!t) turns.set(id, (t = { sessionId, started: false, terminal: false, failed: false, parked: false, snapshotted: false, startRef: false, endRef: false, items: [] }))
    t.sessionId ??= sessionId
    return t
  }
  const item = (key: string, init: Omit<Item, 'key'>): Item => {
    const i = at.get(key)
    if (i != null) return items[i]
    const it: Item = { key, ...init }
    at.set(key, items.length)
    if (it.turnId) turn(it.turnId, it.sessionId).items.push(items.length)
    items.push(it)
    return it
  }

  for (const e of events) {
    const p = payloadOf(e)
    const turnId = p.turnId
    const base = { turnId, sessionId: e.sessionId }
    const akey = turnId ? `a${turnId}:${p.step ?? ''}` : `s${e.seq}`
    const runKey = typeof p.runId === 'string' && p.runId
    if (turnId && OPENS_TURN.has(e.type)) turn(turnId, e.sessionId).started = true
    switch (e.type) {
      case 'message.user': {
        // turnId 键:日志重置后 seq 会重复。挂起时收下的后续消息同一 turnId,靠序号分行
        const n = turnId ? userLines.get(turnId) ?? 0 : 0
        if (turnId) {
          userLines.set(turnId, n + 1)
          turn(turnId, e.sessionId).parked = false
        }
        item(turnId ? (n ? `u${turnId}:${n}` : `u${turnId}`) : `u#${e.seq}`, { kind: 'user', text: textOf(e), ...base })
        break
      }
      case 'turn.parked':
      case 'turn.resumed':
        if (turnId) turn(turnId, e.sessionId).parked = e.type === 'turn.parked'
        break
      case 'executor.run.queued':
        if (runKey) item(`r${runKey}`, { kind: 'run', text: runLabel(p, '排队中'), ...base })
        break
      case 'executor.run.started':
        if (runKey) item(`r${runKey}`, { kind: 'run', text: '', ...base }).text = runLabel(p, '运行中')
        break
      case 'executor.run.progress':
        if (runKey && textOf(e)) item(`g${runKey}:${e.seq}`, { kind: 'run', text: textOf(e), ...base })
        break
      case 'executor.run.ended': {
        if (!runKey) break
        // "运行中"那行到此为止,结果放在进度之后
        const i = at.get(`r${runKey}`)
        if (i != null) items[i].resolved = true
        const n = fileCount(p.changed)
        const label = RUN_STATUS.get(p.status) ?? String(p.status ?? '')
        item(`e${runKey}`, { kind: 'run', text: runLabel(p, n ? `${label} ${n} 个文件` : label), ...base })
        break
      }
      case 'message.assistant.delta': {
        const it = item(akey, { kind: 'assistant', text: '', ...base })
        if (!it.final) it.text += textOf(e)
        break
      }
      case 'message.assistant': {
        const it = item(akey, { kind: 'assistant', text: '', ...base })
        it.text = textOf(e)
        it.final = true
        break
      }
      case 'message.reasoning.delta': {
        const it = item(akey, { kind: 'assistant', text: '', ...base })
        it.reasoning = (it.reasoning ?? '') + textOf(e)
        break
      }
      case 'turn.usage':
        if (turnId) item(akey, { kind: 'assistant', text: '', ...base }).usage = `${p.input ?? 0} / ${p.output ?? 0}`
        break
      case 'tool.started':
      case 'tool.ended': {
        if (!p.callId) break
        // callId 来自模型,可能在各轮重复(call_1_0、functions.read:0)
        const it = item(`c${e.sessionId ?? ''}:${turnId ?? ''}:${p.callId}`, { kind: 'tool', text: `${String(p.name ?? '')} ${String(p.argsPreview ?? '').slice(0, ARGS_SHOWN)}`.trimEnd(), ...base })
        if (e.type === 'tool.ended') it.ok = p.ok === true
        break
      }
      case 'approval.requested':
        if (p.approvalId) {
          item(`p${p.approvalId}`, { kind: 'approval', text: String(p.summary ?? ''), approvalId: p.approvalId, ...base, ...(p.unsandboxed === true && { unsandboxed: true }), ...(typeof p.key === 'string' && { sessionKey: true }) })
        }
        break
      case 'sandbox.netDenied':
        item(`n#${e.seq}`, { kind: 'net', text: `已拦截 ${String(p.host ?? '')}:${String(p.port ?? '')}`, ...base })
        break
      case 'approval.resolved': {
        const i = p.approvalId ? at.get(`p${p.approvalId}`) : undefined
        if (i != null) items[i].resolved = true
        break
      }
      case 'turn.snapshot': {
        if (!turnId) break
        const t = turn(turnId, e.sessionId)
        if (!t.snapshotted) snapOrder.push(turnId)
        t.snapshotted = true
        if (p.phase === 'start' && p.ref) t.startRef = true
        if (p.phase === 'end' && p.ref) {
          t.endRef = true
          item(`k${turnId}`, { kind: 'snapshot', text: '', ...base, ...(typeof p.changed === 'number' && { changed: p.changed }) })
        }
        break
      }
      case 'turn.rolledBack':
        if (turnId) rolledBack.set(turnId, { skipped: strings(p.skipped) })
        break
      case 'turn.ended':
      case 'turn.failed':
        if (turnId) {
          const t = turn(turnId, e.sessionId)
          t.terminal = true
          t.failed ||= e.type === 'turn.failed'
          t.parked = false
        }
        break
    }
  }
  // 失败的轮:标在它最后一条可见的行上
  for (const t of turns.values()) {
    if (!t.failed) continue
    const last = t.items.filter(i => visible(items[i])).at(-1)
    if (last != null) items[last].failed = true
  }
  return { items, turns, rolledBack, snapOrder }
}

/**
 * 能回滚的轮(同 loop-default 的 rollbackRefs + ERR_BUSY):每个会话里拍过快照且未回滚的最新一轮,
 * 两张快照都在,且该会话没有进行中的轮
 */
function rollbackable(v: View, local: Map<string, RolledBack>): Set<string> {
  const latest = new Map<string, string>()
  for (const id of v.snapOrder) {
    const t = v.turns.get(id)!
    if (!v.rolledBack.has(id) && !local.has(id)) latest.set(t.sessionId ?? '', id)
  }
  const busy = new Set([...v.turns.values()].filter(t => t.started && !t.terminal).map(t => t.sessionId))
  return new Set([...latest.values()].filter(id => {
    const t = v.turns.get(id)!
    return !!t.sessionId && t.terminal && t.startRef && t.endRef && !busy.has(t.sessionId)
  }))
}

/**
 * 进行中的轮:消息和停止都发给它所在的会话。优先本面板最后发出的那一轮的会话;
 * 那个会话没有开着的轮(或者没发过:重开面板、app 重启,后台的轮还开着)就取日志里最新的进行中的轮
 */
function currentTurn(v: View, sent: string | undefined): (Turn & { sessionId: string }) | undefined {
  const open = [...v.turns.values()].filter((t): t is Turn & { sessionId: string } => t.started && !t.terminal && !!t.sessionId)
  const sentSession = sent ? v.turns.get(sent)?.sessionId : undefined
  const session = open.some(t => t.sessionId === sentSession) ? sentSession : open.at(-1)?.sessionId
  return open.filter(t => t.sessionId === session).at(-1)
}

export function DebugPanel() {
  const [events, setEvents] = useState<KernelEvent[]>([])
  const [text, setText] = useState('')
  const [cwd, setCwd] = useState('')
  const [auto, setAuto] = useState(false)
  const [failed, setFailed] = useState(false)
  const [model, setModel] = useState<ModelRef | undefined>()
  const [responding, setResponding] = useState<ReadonlySet<string>>(new Set())
  // 应答回 ok:false(已结束 / 内核重启后不认)的审批:本地当作已结束
  const [settled, setSettled] = useState<ReadonlySet<string>>(new Set())
  const [rolled, setRolled] = useState<Map<string, RolledBack>>(new Map())
  const [rolling, setRolling] = useState<ReadonlySet<string>>(new Set())
  const [rollFailed, setRollFailed] = useState<ReadonlySet<string>>(new Set())
  const [sandbox, setSandbox] = useState<SandboxStatus | undefined>()
  const [sentTurn, setSentTurn] = useState<string | undefined>()
  const [stopping, setStopping] = useState(false)

  useEffect(() => {
    const api = window.forge.mffai
    let alive = true
    // 全局沙箱状态(不含单个会话的代理失败);旧后台没有该字段
    const refresh = () => void api.state().then(s => { if (alive) setSandbox(s.sandbox) }).catch(() => {})
    refresh()
    const off = api.onEvent(e => {
      // events.redacted:缓存里删掉的文字不留在屏幕上(08 §14)
      setEvents(es => trimEvents([...(e.type === 'events.redacted' ? applyRedaction(es, e) : es), e]))
      if (e.type === 'kernel.started' || e.type === 'permissions.updated') refresh()
    })
    void api.tail(KEEP).then(r => {
      if (!alive) return
      // 订阅先于 tail 返回:按 seq 去重合并
      setEvents(es => {
        const seen = new Set(es.map(x => x.seq))
        return trimEvents([...r.events.filter(x => !seen.has(x.seq)), ...es].sort((a, b) => a.seq - b.seq))
      })
    }).catch(() => {})
    return () => { alive = false; off() }
  }, [])

  const view = useMemo(() => toView(events), [events])
  const canRollback = useMemo(() => rollbackable(view, rolled), [view, rolled])
  const current = useMemo(() => currentTurn(view, sentTurn), [view, sentTurn])

  const send = () => {
    const t = text.trim()
    if (!t) return
    setText('')
    setFailed(false)
    const dir = cwd.trim()
    // 有开着的轮:消息归它,工作目录、模型、自动放行这几个控件只管下一次新开的轮
    const opts = current ? { sessionId: current.sessionId }
      : dir || auto ? { ...(dir && { cwd: dir }), approvalMode: auto ? 'auto' as const : 'ask' as const } : undefined
    const ref = current ? undefined : model
    const api = window.forge.mffai
    // 没发出去(ERR_BUSY 等):打的字放回去;这期间又打了字就接在后面
    const restore = () => {
      setText(cur => (cur ? `${text} ${cur}` : text))
      setFailed(true)
    }
    void (opts ? api.prompt(t, ref, opts) : ref ? api.prompt(t, ref) : api.prompt(t))
      .then(r => { if (r.accepted) setSentTurn(r.turnId); else restore() })
      .catch((e) => { console.error('mffai prompt', e); restore() })
  }

  const stop = (sessionId: string) => {
    setStopping(true)
    setFailed(false)
    void window.forge.mffai.cancel(sessionId)
      .catch((e) => { console.error('mffai cancel', e); setFailed(true) })
      .finally(() => setStopping(false))
  }

  const respond = (approvalId: string, decision: Decision) => {
    setResponding(s => new Set(s).add(approvalId))
    void window.forge.mffai.approvalRespond(approvalId, decision)
      .then(r => { if (!r.ok) setSettled(s => new Set(s).add(approvalId)) })
      .catch((e) => console.error('mffai approval', e))
      .finally(() => setResponding(s => { const n = new Set(s); n.delete(approvalId); return n }))
  }

  const rollback = (sessionId: string, turnId: string) => {
    setRolling(s => new Set(s).add(turnId))
    setRollFailed(s => { const n = new Set(s); n.delete(turnId); return n })
    void window.forge.mffai.rollback(sessionId, turnId)
      .then(r => setRolled(m => new Map(m).set(turnId, { skipped: r.skipped ?? [] })))
      .catch((e) => { console.error('mffai rollback', e); setRollFailed(s => new Set(s).add(turnId)) })
      .finally(() => setRolling(s => { const n = new Set(s); n.delete(turnId); return n }))
  }

  const snapshotLine = (it: Item) => {
    const turnId = it.turnId!
    const done = view.rolledBack.get(turnId) ?? rolled.get(turnId)
    return (
      <div key={it.key} className="mffai-line mffai-snap">
        {it.changed != null && <span>{it.changed} 个文件</span>}
        {done ? <span>已回滚</span>
          : canRollback.has(turnId) && <button className="set-btn" disabled={rolling.has(turnId)} onClick={() => rollback(it.sessionId!, turnId)}>回滚本轮</button>}
        {done && done.skipped.length > 0 && <span className="mffai-skipped">{done.skipped.map(p => <code key={p}>{p}</code>)}</span>}
        {!done && rollFailed.has(turnId) && <span className="mffai-fail">失败</span>}
      </div>
    )
  }

  const line = (it: Item) => {
    if (it.kind === 'snapshot') return snapshotLine(it)
    if (!visible(it)) return null
    const fail = it.failed && <span className="mffai-fail"> 失败</span>
    if (it.kind === 'tool') {
      return (
        <div key={it.key} className="mffai-line mffai-tool">
          <span>{it.text}</span>
          {it.ok != null && <span className={it.ok ? 'mffai-ok' : 'mffai-fail'}> {it.ok ? '✓' : '✗'}</span>}
          {fail}
        </div>
      )
    }
    if (it.kind === 'approval') {
      if (settled.has(it.approvalId!)) return null
      const busy = responding.has(it.approvalId!)
      return (
        <div key={it.key} className="mffai-line mffai-approval">
          <code>{it.text}</code>
          {it.unsandboxed && <span className="mffai-badge mffai-unsandboxed">未隔离</span>}
          <div className="mffai-actions">
            <button className="set-btn" disabled={busy} onClick={() => respond(it.approvalId!, 'allow')}>允许</button>
            {it.sessionKey && <button className="set-btn" disabled={busy} onClick={() => respond(it.approvalId!, 'allow_session')}>本会话允许</button>}
            <button className="set-btn" disabled={busy} onClick={() => respond(it.approvalId!, 'deny')}>拒绝</button>
          </div>
          {fail}
        </div>
      )
    }
    if (it.kind === 'net') return <div key={it.key} className="mffai-line mffai-net">{it.text}</div>
    if (it.kind === 'run') return <div key={it.key} className="mffai-line mffai-run">{it.text}{fail}</div>
    return (
      <div key={it.key} className={`mffai-line ${it.kind}`}>
        {it.reasoning && <details><summary>推理</summary>{it.reasoning}</details>}
        {it.text}
        {fail}
        {it.usage && <div className="mffai-usage">{it.usage}</div>}
      </div>
    )
  }

  return (
    <div className="mffai-debug">
      <div className="mffai-log">{view.items.map(line)}</div>
      <div className="mffai-opts">
        <input aria-label="工作目录" placeholder="工作目录" value={cwd} onChange={e => setCwd(e.target.value)} />
        <label><input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} />命令自动放行</label>
        {auto && sandbox?.autoDegraded && <span className="mffai-badge mffai-degraded">需审批</span>}
        {sandbox && (
          <span className={`mffai-badge mffai-sandbox ${sandbox.level}`} title={sandbox.missing.length ? sandbox.missing.join(' ') : undefined}>
            {LEVEL[sandbox.level]}
          </span>
        )}
      </div>
      <div className="mffai-send">
        <ModelPicker value={model} onChange={setModel} />
        <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') send() }} />
        <button className="set-btn" onClick={send}>发送</button>
        {current && <button className="set-btn" disabled={stopping} onClick={() => stop(current.sessionId)}>停止</button>}
        {current?.parked && <span className="mffai-badge mffai-parked">挂起</span>}
        {failed && <span className="mffai-fail">失败</span>}
      </div>
    </div>
  )
}
