import { useEffect, useMemo, useState } from 'react'
import type { KernelEvent, ModelRef } from '@mffai/protocol'
import { ModelPicker } from './ModelPicker'

const KEEP = 500
const ARGS_SHOWN = 60
type Decision = 'allow' | 'allow_session' | 'deny'

interface Payload {
  turnId?: string; step?: number; text?: unknown; input?: number; output?: number
  callId?: string; name?: string; argsPreview?: string; ok?: boolean
  approvalId?: string; summary?: string
  phase?: string; ref?: string; changed?: number; skipped?: unknown
}
const payloadOf = (e: KernelEvent) => (e.payload ?? {}) as Payload
const textOf = (e: KernelEvent) => String(payloadOf(e).text ?? '')
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

type Kind = 'user' | 'assistant' | 'tool' | 'approval' | 'snapshot'
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
  changed?: number
  failed?: boolean
}

interface Turn { sessionId?: string; terminal: boolean; failed: boolean; snapshotted: boolean; endRef: boolean; items: number[] }
interface RolledBack { skipped: string[] }

interface View { items: Item[]; turns: Map<string, Turn>; rolledBack: Map<string, RolledBack>; snapOrder: string[] }

const visible = (it: Item) => it.kind !== 'snapshot' && !(it.kind === 'approval' && it.resolved) &&
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
  const turn = (id: string, sessionId?: string): Turn => {
    let t = turns.get(id)
    if (!t) turns.set(id, (t = { sessionId, terminal: false, failed: false, snapshotted: false, endRef: false, items: [] }))
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
    switch (e.type) {
      case 'message.user':
        item(`u${e.seq}`, { kind: 'user', text: textOf(e), ...base })
        break
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
        const it = item(`c${p.callId}`, { kind: 'tool', text: `${String(p.name ?? '')} ${String(p.argsPreview ?? '').slice(0, ARGS_SHOWN)}`.trimEnd(), ...base })
        if (e.type === 'tool.ended') it.ok = p.ok === true
        break
      }
      case 'approval.requested':
        if (p.approvalId) item(`p${p.approvalId}`, { kind: 'approval', text: String(p.summary ?? ''), approvalId: p.approvalId, ...base })
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

/** 能回滚的轮:每个会话里拍过快照且未回滚的最新一轮,已结束且有结束快照(同 loop-default 的 rollbackRefs) */
function rollbackable(v: View, local: Map<string, RolledBack>): Set<string> {
  const latest = new Map<string, string>()
  for (const id of v.snapOrder) {
    const t = v.turns.get(id)!
    if (!v.rolledBack.has(id) && !local.has(id)) latest.set(t.sessionId ?? '', id)
  }
  return new Set([...latest.values()].filter(id => { const t = v.turns.get(id)!; return t.terminal && t.endRef && !!t.sessionId }))
}

export function DebugPanel() {
  const [events, setEvents] = useState<KernelEvent[]>([])
  const [text, setText] = useState('')
  const [cwd, setCwd] = useState('')
  const [auto, setAuto] = useState(false)
  const [failed, setFailed] = useState(false)
  const [model, setModel] = useState<ModelRef | undefined>()
  const [responding, setResponding] = useState<ReadonlySet<string>>(new Set())
  const [rolled, setRolled] = useState<Map<string, RolledBack>>(new Map())
  const [rolling, setRolling] = useState<ReadonlySet<string>>(new Set())
  const [rollFailed, setRollFailed] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    const api = window.forge.mffai
    let alive = true
    const off = api.onEvent(e => setEvents(es => [...es, e].slice(-KEEP)))
    void api.tail(50).then(r => {
      if (!alive) return
      // 订阅先于 tail 返回:按 seq 去重合并
      setEvents(es => {
        const seen = new Set(es.map(x => x.seq))
        return [...r.events.filter(x => !seen.has(x.seq)), ...es].sort((a, b) => a.seq - b.seq).slice(-KEEP)
      })
    }).catch(() => {})
    return () => { alive = false; off() }
  }, [])

  const view = useMemo(() => toView(events), [events])
  const canRollback = useMemo(() => rollbackable(view, rolled), [view, rolled])

  const send = () => {
    const t = text.trim()
    if (!t) return
    setText('')
    setFailed(false)
    const dir = cwd.trim()
    const opts = dir || auto ? { ...(dir && { cwd: dir }), approvalMode: auto ? 'auto' as const : 'ask' as const } : undefined
    const api = window.forge.mffai
    void (opts ? api.prompt(t, model, opts) : model ? api.prompt(t, model) : api.prompt(t))
      .catch((e) => { console.error('mffai prompt', e); setFailed(true) })
  }

  const respond = (approvalId: string, decision: Decision) => {
    setResponding(s => new Set(s).add(approvalId))
    void window.forge.mffai.approvalRespond(approvalId, decision)
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
      const busy = responding.has(it.approvalId!)
      return (
        <div key={it.key} className="mffai-line mffai-approval">
          <code>{it.text}</code>
          <div className="mffai-actions">
            <button className="set-btn" disabled={busy} onClick={() => respond(it.approvalId!, 'allow')}>允许</button>
            <button className="set-btn" disabled={busy} onClick={() => respond(it.approvalId!, 'allow_session')}>本会话允许</button>
            <button className="set-btn" disabled={busy} onClick={() => respond(it.approvalId!, 'deny')}>拒绝</button>
          </div>
          {fail}
        </div>
      )
    }
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
      </div>
      <div className="mffai-send">
        <ModelPicker value={model} onChange={setModel} />
        <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') send() }} />
        <button className="set-btn" onClick={send}>发送</button>
        {failed && <span className="mffai-fail">失败</span>}
      </div>
    </div>
  )
}
