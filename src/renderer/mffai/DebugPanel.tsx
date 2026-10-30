import { useEffect, useMemo, useState } from 'react'
import type { KernelEvent, ModelRef } from '@mffai/protocol'
import { ModelPicker } from './ModelPicker'

const KEEP = 500
const SHOWN = new Set(['message.user', 'message.assistant', 'message.assistant.delta'])
const textOf = (e: KernelEvent) => String((e.payload as { text?: unknown } | null)?.text ?? '')

interface Line { key: string; role: 'user' | 'assistant'; text: string; turnId?: string }
const payloadOf = (e: KernelEvent) => (e.payload ?? {}) as { turnId?: string; input?: number; output?: number }

/** 每个 turn 有终稿用终稿,否则拼接 delta(流式中) */
function toLines(events: KernelEvent[]): Line[] {
  const finals = new Set(events.filter(e => e.type === 'message.assistant').map(e => payloadOf(e).turnId))
  const out: Line[] = []
  const live = new Map<string, number>()
  for (const e of events) {
    if (!SHOWN.has(e.type)) continue
    if (e.type === 'message.user') { out.push({ key: `u${e.seq}`, role: 'user', text: textOf(e) }); continue }
    const turnId = payloadOf(e).turnId ?? `s${e.seq}`
    if (e.type === 'message.assistant') { out.push({ key: `a${e.seq}`, role: 'assistant', text: textOf(e), turnId }); continue }
    if (finals.has(turnId)) continue
    const at = live.get(turnId)
    if (at == null) { live.set(turnId, out.length); out.push({ key: `d${turnId}`, role: 'assistant', text: textOf(e), turnId }) }
    else out[at] = { ...out[at], text: out[at].text + textOf(e) }
  }
  return out
}

/** 每个 turn 的推理文本与 token 用量 */
function turnExtras(events: KernelEvent[]) {
  const reasoning = new Map<string, string>()
  const usage = new Map<string, string>()
  for (const e of events) {
    const turnId = payloadOf(e).turnId
    if (!turnId) continue
    if (e.type === 'message.reasoning.delta') reasoning.set(turnId, (reasoning.get(turnId) ?? '') + textOf(e))
    else if (e.type === 'turn.usage') usage.set(turnId, `${payloadOf(e).input ?? 0} / ${payloadOf(e).output ?? 0}`)
  }
  return { reasoning, usage }
}

export function DebugPanel() {
  const [events, setEvents] = useState<KernelEvent[]>([])
  const [text, setText] = useState('')
  const [failed, setFailed] = useState(false)
  const [model, setModel] = useState<ModelRef | undefined>()

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

  const lines = useMemo(() => toLines(events), [events])
  const extras = useMemo(() => turnExtras(events), [events])
  const send = () => {
    const t = text.trim()
    if (!t) return
    setText('')
    setFailed(false)
    void (model ? window.forge.mffai.prompt(t, model) : window.forge.mffai.prompt(t)).catch((e) => { console.error('mffai prompt', e); setFailed(true) })
  }

  return (
    <div className="mffai-debug">
      <div className="mffai-log">
        {lines.map(l => {
          const think = l.turnId ? extras.reasoning.get(l.turnId) : undefined
          const used = l.turnId ? extras.usage.get(l.turnId) : undefined
          return (
            <div key={l.key} className={`mffai-line ${l.role}`}>
              {think && <details><summary>推理</summary>{think}</details>}
              {l.text}
              {used && <div className="mffai-usage">{used}</div>}
            </div>
          )
        })}
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
