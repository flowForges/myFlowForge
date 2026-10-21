import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { CouncilEngine, type EngineDeps, type PersistedCouncil } from './engine'
import { councilFileName } from './result'
import { COUNCIL_RESULT_FENCE } from './prompts'
import type { SeatRunCallbacks, SeatRunResult } from './seatRunner'
import type { CouncilConfig, CouncilSeat, CouncilState } from '@shared/council'
import type { ChatEvent, ChatMessage } from '@shared/types'

const WS = '/tmp/ws-council'
const SID = 's1'
const CID = 'c1'
const T0 = new Date(2026, 9, 21, 9, 5).getTime()

const seat = (id: string, provider = 'codex'): CouncilSeat => ({ id, provider, model: `m-${id}`, label: `${provider} · ${id}` })
const cfg = (seatIds: string[], rounds = 2): CouncilConfig => ({
  topic: '怎么设计缓存',
  attachments: [{ name: 'a.png', path: '/tmp/a.png', size: 3 }],
  seats: seatIds.map(id => seat(id)),
  leader: seat('L', 'claude'),
  mode: { kind: 'rounds', rounds },
})

const FINAL_TEXT = [
  '最终结论正文',
  COUNCIL_RESULT_FENCE,
  JSON.stringify({ conclusion: '用 LRU', candidates: [], disagreements: [] }),
  '```',
].join('\n')

type Call = { seat: string; prompt: string; n: number; kind: 'answer' | 'critique' | 'summary' | 'final' }
type Reply = { ok: true; text: string } | { ok: false }
type Script = (c: Call) => Reply | undefined

function kindOf(prompt: string): Call['kind'] {
  if (prompt.includes('共识结果')) return 'final'
  if (prompt.includes('请做本轮总结')) return 'summary'
  if (prompt.includes('现在是第 1 轮')) return 'answer'
  return 'critique'
}

function harness(c: CouncilConfig, script: Script = () => undefined, over: Partial<EngineDeps> = {}) {
  const calls: Call[] = []
  const log: string[] = []
  const appended: ChatMessage[] = []
  const events: ChatEvent[] = []
  const states: CouncilState[] = []
  const persisted: PersistedCouncil[] = []
  const files: { path: string; text: string }[] = []
  const counts: Record<string, number> = {}
  let late: (() => void)[] = []

  const runSeat: EngineDeps['runSeat'] = (_cid, s, prompt, _deps, cb: SeatRunCallbacks) => {
    counts[s.id] = (counts[s.id] ?? 0) + 1
    const call: Call = { seat: s.id, prompt, n: counts[s.id], kind: kindOf(prompt) }
    calls.push(call)
    log.push(`start:${s.id}`)
    const msgId = `inner-${s.id}-${call.n}`
    const reply: Reply = script(call) ?? { ok: true, text: call.kind === 'final' ? FINAL_TEXT : `<<${s.id}#${call.n}>>` }
    cb.onStart(msgId)
    const done = (async (): Promise<SeatRunResult> => {
      await new Promise(r => setTimeout(r, 1))
      if (!reply.ok) {
        // ★模拟 runSeat 在 settle 之后还漏出来的回调
        late.push(() => cb.onDelta(msgId, 'LATE'))
        log.push(`end:${s.id}`)
        return { ok: false, msgId, error: 'boom' }
      }
      cb.onThink(msgId, 'thinking')
      cb.onDelta(msgId, reply.text)
      log.push(`end:${s.id}`)
      return { ok: true, msgId, text: reply.text }
    })()
    return { done, cancel() {}, resumed: false }
  }

  const deps: EngineDeps = {
    runSeat,
    seatDeps: { providers: {}, env: {} },
    seatResumed: () => false,
    append: (_ws, _sid, m) => appended.push(m),
    emitChat: e => { events.push(e) },
    emitState: s => states.push(s),
    materialsText: async () => '',
    writeFile: (path, text) => files.push({ path, text }),
    persist: p => persisted.push(p),
    now: () => T0,
    ...over,
  }
  const engine = new CouncilEngine(CID, WS, SID, c, deps)
  return {
    engine, calls, log, appended, events, states, persisted, files,
    flushLate: () => { const l = late; late = []; l.forEach(f => f()) },
  }
}

describe('CouncilEngine rounds mode', () => {
  it('appends the topic as a user message with attachments', async () => {
    const h = harness(cfg(['A', 'B']))
    await h.engine.start()
    const topic = h.appended[0]
    expect(topic).toMatchObject({ who: 'user', text: '怎么设计缓存', council: { id: CID, stage: 'topic' } })
    expect(topic.files).toHaveLength(1)
  })

  it('round 1 starts all seats before any finishes, and prompts are independent', async () => {
    const h = harness(cfg(['A', 'B', 'C']))
    await h.engine.start()
    expect(h.log.slice(0, 3)).toEqual(['start:A', 'start:B', 'start:C'])
    const r1 = h.calls.filter(c => c.kind === 'answer')
    expect(r1.map(c => c.seat)).toEqual(['A', 'B', 'C'])
    for (const c of r1) expect(c.prompt).not.toMatch(/<<[ABC]#/)
  })

  it('round 2 runs seats sequentially in config order and later seats see earlier round-2 text', async () => {
    const h = harness(cfg(['A', 'B', 'C']))
    await h.engine.start()
    const r2 = h.calls.filter(c => c.kind === 'critique')
    expect(r2.map(c => c.seat)).toEqual(['A', 'B', 'C'])
    // 每个 round-2 席位都在前一个结束后才开始
    const idx = (s: string) => h.log.indexOf(s, h.log.indexOf('start:L'))
    expect(idx('end:A')).toBeLessThan(h.log.lastIndexOf('start:B'))
    expect(idx('end:B')).toBeLessThan(h.log.lastIndexOf('start:C'))
    expect(r2[1].prompt).toContain('<<A#2>>')
    expect(r2[2].prompt).toContain('<<A#2>>')
    expect(r2[2].prompt).toContain('<<B#2>>')
    // 第 2 轮提示词带上一轮领导者总结
    expect(r2[0].prompt).toContain('<<L#1>>')
  })

  it('leader summarises every round but the last, then writes the final; final carries councilResult; markdown is written', async () => {
    const h = harness(cfg(['A', 'B'], 3))
    await h.engine.start()
    const leader = h.calls.filter(c => c.seat === 'L').map(c => c.kind)
    expect(leader).toEqual(['summary', 'summary', 'final'])
    const final = h.appended.find(m => m.council?.stage === 'final')!
    expect(final.who).toBe('ai')
    expect(final.council).toMatchObject({ id: CID, seat: 'L' })
    expect(final.councilResult?.conclusion).toBe('用 LRU')
    expect(final.text).toBe('最终结论正文')
    const path = join(WS, '.forge', 'council', councilFileName(T0, '怎么设计缓存'))
    expect(h.files).toHaveLength(1)
    expect(h.files[0].path).toBe(path)
    expect(h.files[0].text).toContain('用 LRU')
    expect(h.engine.state.status).toBe('done')
    expect(h.engine.state.resultFile).toBe(path)
  })

  it('seat utterances are emitted start→delta→done with council tag, provider, and label as model', async () => {
    const h = harness(cfg(['A', 'B'], 1))
    await h.engine.start()
    const doneA = h.appended.find(m => m.council?.seat === 'A' && m.council.stage === 'answer')!
    expect(doneA).toMatchObject({ who: 'ai', provider: 'codex', model: 'codex · A', text: '<<A#1>>', council: { id: CID, round: 1 } })
    const forId = h.events.filter(e => 'id' in e && e.id === doneA.id || (e.type === 'done' && e.message.id === doneA.id))
    expect(forId.map(e => e.type)).toEqual(['assistant-start', 'think-delta', 'assistant-delta', 'done'])
    const ids = h.appended.map(m => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('with a single round the leader goes from answers straight to final', async () => {
    const h = harness(cfg(['A', 'B'], 1))
    await h.engine.start()
    expect(h.calls.filter(c => c.seat === 'L').map(c => c.kind)).toEqual(['final'])
    expect(h.engine.state.status).toBe('done')
  })

  it('materialsText rejecting pauses the council instead of leaving it running', async () => {
    const h = harness(cfg(['A', 'B']), undefined, { materialsText: async () => { throw new Error('git failed') } })
    await expect(h.engine.start()).resolves.toBeUndefined()
    expect(h.engine.state.status).toBe('paused')
    expect(h.persisted.at(-1)!.state.status).toBe('paused')
    expect(h.states.at(-1)!.status).toBe('paused')
    expect(h.calls).toHaveLength(0)
  })

  it('writeFile throwing during final pauses the council', async () => {
    const h = harness(cfg(['A', 'B']), undefined, { writeFile: () => { throw new Error('EACCES') } })
    await expect(h.engine.start()).resolves.toBeUndefined()
    expect(h.engine.state.status).toBe('paused')
    expect(h.engine.state.resultFile).toBeUndefined()
    expect(h.persisted.at(-1)!.state.status).toBe('paused')
    expect(h.states.at(-1)!.speaking).toEqual([])
  })

  it('round completes when one seat errors', async () => {
    const h = harness(cfg(['A', 'B', 'C']), c => (c.seat === 'B' && c.n === 1 ? { ok: false } : undefined))
    await h.engine.start()
    const failed = h.appended.filter(m => m.council?.stage === 'failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({ text: '', council: { id: CID, seat: 'B', round: 1 } })
    expect(h.appended.some(m => m.council?.seat === 'A' && m.council.stage === 'answer')).toBe(true)
    expect(h.calls.filter(c => c.kind === 'critique').map(c => c.seat)).toEqual(['A', 'B', 'C'])
    expect(h.appended.some(m => m.council?.stage === 'final')).toBe(true)
  })

  it('ignores late callbacks from a seat that already failed', async () => {
    const h = harness(cfg(['A', 'B', 'C'], 1), c => (c.seat === 'B' ? { ok: false } : undefined))
    await h.engine.start()
    const before = h.events.length
    h.flushLate()
    expect(h.events.length).toBe(before)
    expect(h.events.some(e => e.type === 'assistant-delta' && e.text === 'LATE')).toBe(false)
  })

  it('a seat failing twice in a row is not called in round 3', async () => {
    const h = harness(cfg(['A', 'B', 'C'], 3), c => (c.seat === 'B' && c.n <= 2 ? { ok: false } : undefined))
    await h.engine.start()
    const r3 = h.calls.filter(c => c.kind === 'critique' && c.prompt.includes('现在是第 3 轮'))
    expect(r3.map(c => c.seat)).toEqual(['A', 'C'])
    expect(h.persisted.at(-1)!.dropped).toEqual(['B'])
  })

  it('with only one seat left the leader goes straight to final', async () => {
    const h = harness(cfg(['A', 'B'], 4), c => (c.seat === 'B' && c.n <= 2 ? { ok: false } : undefined))
    await h.engine.start()
    const lastSeatIdx = h.calls.map(c => c.seat).lastIndexOf('B')
    expect(h.calls.slice(lastSeatIdx + 1).map(c => `${c.seat}:${c.kind}`)).toEqual(['L:final'])
    expect(h.calls.some(c => c.prompt.includes('现在是第 3 轮'))).toBe(false)
    expect(h.engine.state.status).toBe('done')
  })

  it('leader failing twice pauses the council with no final', async () => {
    const h = harness(cfg(['A', 'B']), c => (c.seat === 'L' ? { ok: false } : undefined))
    await h.engine.start()
    expect(h.calls.filter(c => c.seat === 'L')).toHaveLength(2)
    expect(h.engine.state.status).toBe('paused')
    expect(h.calls.some(c => c.kind === 'critique' || c.kind === 'final')).toBe(false)
    expect(h.appended.some(m => m.council?.stage === 'final')).toBe(false)
    expect(h.files).toHaveLength(0)
    expect(h.persisted.at(-1)!.state.status).toBe('paused')
  })

  it('leader failing once is retried and the council continues', async () => {
    const h = harness(cfg(['A', 'B'], 1), c => (c.seat === 'L' && c.n === 1 ? { ok: false } : undefined))
    await h.engine.start()
    expect(h.engine.state.status).toBe('done')
    const ids = h.appended.map(m => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('tags every message and event with the council / session', async () => {
    const h = harness(cfg(['A', 'B']), c => (c.seat === 'A' && c.n === 2 ? { ok: false } : undefined))
    await h.engine.start()
    for (const m of h.appended) expect(m.council?.id).toBe(CID)
    expect(h.events.length).toBeGreaterThan(0)
    for (const e of h.events) expect({ ws: e.workspacePath, sid: e.sessionId }).toEqual({ ws: WS, sid: SID })
  })

  it('tracks speaking seats and emits/persists state on every change', async () => {
    const h = harness(cfg(['A', 'B']))
    await h.engine.start()
    expect(h.states.some(s => s.speaking.length === 2 && s.round === 1)).toBe(true)
    expect(h.states.some(s => s.speaking.length === 1 && s.speaking[0] === 'L')).toBe(true)
    expect(h.states.at(-1)!.speaking).toEqual([])
    expect(h.persisted.length).toBe(h.states.length)
    expect(h.persisted.at(-1)!.transcript.items.length).toBeGreaterThan(0)
  })
})
