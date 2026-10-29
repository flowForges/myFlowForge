import { useEffect, useMemo, useState } from 'react'
import type { KernelEvent } from '@mffai/protocol'

const SHOWN = new Set(['message.user', 'message.assistant', 'message.assistant.delta'])
const textOf = (e: KernelEvent) => String((e.payload as { text?: unknown } | null)?.text ?? '')

/** 每个 turn 有终稿用终稿,否则拼接 delta(流式中) */
function toLines(events: KernelEvent[]): { key: string; role: 'user' | 'assistant'; text: string }[] {
  const finals = new Set(events.filter(e => e.type === 'message.assistant').map(e => (e.payload as { turnId?: string })?.turnId))
  const out: { key: string; role: 'user' | 'assistant'; text: string }[] = []
  const live = new Map<string, number>()
  for (const e of events) {
    if (!SHOWN.has(e.type)) continue
    if (e.type === 'message.user') { out.push({ key: `u${e.seq}`, role: 'user', text: textOf(e) }); continue }
    const turnId = (e.payload as { turnId?: string })?.turnId ?? `s${e.seq}`
    if (e.type === 'message.assistant') { out.push({ key: `a${e.seq}`, role: 'assistant', text: textOf(e) }); continue }
    if (finals.has(turnId)) continue
    const at = live.get(turnId)
    if (at == null) { live.set(turnId, out.length); out.push({ key: `d${turnId}`, role: 'assistant', text: textOf(e) }) }
    else out[at] = { ...out[at], text: out[at].text + textOf(e) }
  }
  return out
}

export function DebugPanel() {
  const [events, setEvents] = useState<KernelEvent[]>([])
  const [text, setText] = useState('')

  useEffect(() => {
    const api = window.forge.mffai
    let alive = true
    const off = api.onEvent(e => setEvents(es => [...es, e]))
    void api.tail(50).then(r => {
      if (!alive) return
      // 订阅先于 tail 返回:按 seq 去重合并
      setEvents(es => {
        const seen = new Set(es.map(x => x.seq))
        return [...r.events.filter(x => !seen.has(x.seq)), ...es].sort((a, b) => a.seq - b.seq)
      })
    }).catch(() => {})
    return () => { alive = false; off() }
  }, [])

  const lines = useMemo(() => toLines(events), [events])
  const send = () => {
    const t = text.trim()
    if (!t) return
    setText('')
    void window.forge.mffai.prompt(t).catch(() => {})
  }

  return (
    <div className="mffai-debug">
      <div className="mffai-log">
        {lines.map(l => <div key={l.key} className={`mffai-line ${l.role}`}>{l.text}</div>)}
      </div>
      <div className="mffai-send">
        <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') send() }} />
        <button className="set-btn" onClick={send}>发送</button>
      </div>
    </div>
  )
}
