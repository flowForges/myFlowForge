import { describe, it, expect, beforeEach } from 'vitest'
import { CouncilEngine, type EngineDeps, type PersistedCouncil } from './engine'
import { COUNCIL_RESULT_FENCE } from './prompts'
import type { SeatRunCallbacks, SeatRunResult } from './seatRunner'
import type { CouncilConfig, CouncilSeat, CouncilState } from '@shared/council'
import type { ChatEvent, ChatMessage } from '@shared/types'
import { clearAppLog, getAppLog } from '../log/appLog'

const WS = '/tmp/ws-council'
const SID = 's1'
const CID = 'c1'
const T0 = new Date(2026, 9, 21, 9, 5).getTime()

const seat = (id: string, provider = 'codex'): CouncilSeat => ({ id, provider, model: `m-${id}`, label: `${provider} · ${id}` })
const cfg = (seatIds: string[], rounds = 2): CouncilConfig => ({
  topic: '怎么设计缓存',
  attachments: [],
  seats: seatIds.map(id => seat(id)),
  leader: seat('L', 'claude'),
  mode: { kind: 'rounds', rounds },
  pauseBetweenRounds: false,
})

const FINAL_TEXT = [
  '最终结论正文',
  COUNCIL_RESULT_FENCE,
  JSON.stringify({
    conclusion: '用 LRU',
    candidates: [
      { name: 'A', points: 'pa', pros: '', cons: '', supporters: [], dissenters: [] },
      { name: 'B', points: 'pb', pros: '', cons: '', supporters: [], dissenters: [] },
    ],
    disagreements: [],
  }),
  '```',
].join('\n')

type Kind = 'answer' | 'critique' | 'summary' | 'final' | 'followup'
type Call = { seat: string; prompt: string; n: number; kind: Kind }
// 'hang' = 一直不结束,只有 cancel() 能让它 settle
type Reply = { ok: true; text: string } | { ok: false } | 'hang'
type Script = (c: Call) => Reply | undefined

function kindOf(prompt: string): Kind {
  if (prompt.includes('用户有一个追问')) return 'followup'
  if (prompt.includes('共识结果')) return 'final'
  if (prompt.includes('请做本轮总结')) return 'summary'
  if (prompt.includes('现在是第 1 轮')) return 'answer'
  return 'critique'
}

function harness(c: CouncilConfig, script: Script = () => undefined, over: Partial<EngineDeps> = {}) {
  const calls: Call[] = []
  const appended: ChatMessage[] = []
  const events: ChatEvent[] = []
  const states: CouncilState[] = []
  const persisted: PersistedCouncil[] = []
  const files: { path: string; text: string }[] = []
  const counts: Record<string, number> = {}

  const runSeat: EngineDeps['runSeat'] = (_cid, s, prompt, _deps, cb: SeatRunCallbacks) => {
    counts[s.id] = (counts[s.id] ?? 0) + 1
    const call: Call = { seat: s.id, prompt, n: counts[s.id], kind: kindOf(prompt) }
    calls.push(call)
    const msgId = `inner-${s.id}-${call.n}`
    const reply: Reply = script(call) ?? { ok: true, text: call.kind === 'final' ? FINAL_TEXT : `<<${s.id}#${call.n}>>` }
    cb.onStart(msgId)
    let settle!: (r: SeatRunResult) => void
    const done = new Promise<SeatRunResult>(r => { settle = r })
    if (reply !== 'hang') {
      setTimeout(() => {
        if (!reply.ok) return settle({ ok: false, msgId, error: 'boom' })
        cb.onDelta(msgId, reply.text)
        settle({ ok: true, msgId, text: reply.text })
      }, 1)
    }
    return { done, cancel: () => settle({ ok: false, msgId, error: 'cancelled' }), resumed: false }
  }

  const deps: EngineDeps = {
    runSeat,
    seatDeps: { providers: {}, env: {} },
    seatResumed: () => false,
    append: (_ws, _sid, m) => appended.push(m),
    readMessages: () => [...appended],
    emitChat: e => { events.push(e) },
    emitState: s => states.push(s),
    materialsText: async () => '',
    writeFile: (path, text) => files.push({ path, text }),
    persist: p => persisted.push(p),
    now: () => T0,
    ...over,
  }
  const engine = new CouncilEngine(CID, WS, SID, c, deps)
  return { engine, calls, appended, events, states, persisted, files }
}

const tick = () => new Promise(r => setTimeout(r, 5))
const uniqueIds = (ms: ChatMessage[]) => new Set(ms.map(m => m.id)).size === ms.length
/** 每个 assistant-start 都有 done 或 error 收尾(否则全局流式状态永远不清)。 */
function unclosedStreams(events: ChatEvent[]): string[] {
  const closed = new Set(events.flatMap(e => (e.type === 'done' ? [e.message.id] : e.type === 'error' ? [e.id] : [])))
  return events.flatMap(e => (e.type === 'assistant-start' && !closed.has(e.id) ? [e.id] : []))
}

describe('CouncilEngine controls', () => {
  beforeEach(() => clearAppLog())

  it('pause during round 2 lets the current seat finish, stops before the next; resume continues', async () => {
    let h!: ReturnType<typeof harness>
    h = harness(cfg(['A', 'B', 'C']), c => {
      if (c.seat === 'A' && c.kind === 'critique') h.engine.pause()
      return undefined
    })
    await h.engine.start()
    expect(h.engine.state.status).toBe('paused')
    expect(h.calls.at(-1)).toMatchObject({ seat: 'A', kind: 'critique' })
    expect(h.appended.some(m => m.council?.seat === 'A' && m.council.stage === 'critique')).toBe(true)
    expect(h.engine.state.speaking).toEqual([])
    expect(h.persisted.at(-1)!.state.status).toBe('paused')

    const before = h.calls.length
    await h.engine.resume()
    const rest = h.calls.slice(before).map(c => `${c.seat}:${c.kind}`)
    expect(rest).toEqual(['B:critique', 'C:critique', 'L:final'])
    expect(h.calls[before].prompt).toContain('<<A#2>>')
    expect(h.engine.state.status).toBe('done')
    expect(uniqueIds(h.appended)).toBe(true)
  })

  it('resume(newLeader) after a leader-failure pause uses the new leader for the pending summary and the final', async () => {
    const h = harness(cfg(['A', 'B']), c => (c.seat === 'L' ? { ok: false } : undefined))
    await h.engine.start()
    expect(h.engine.state.status).toBe('paused')
    const before = h.calls.length
    const M = seat('M', 'gemini')
    await h.engine.resume(M)
    expect(h.calls.slice(before).map(c => `${c.seat}:${c.kind}`)).toEqual(['M:summary', 'A:critique', 'B:critique', 'M:final'])
    expect(h.calls.filter(c => c.seat === 'L')).toHaveLength(2)
    expect(h.engine.state.config.leader.id).toBe('M')
    expect(h.engine.state.status).toBe('done')
    expect(uniqueIds(h.appended)).toBe(true)
  })

  it('resume with the same leader after a leader failure does not reuse message ids', async () => {
    let fail = true
    const h = harness(cfg(['A', 'B']), c => (c.seat === 'L' && fail ? { ok: false } : undefined))
    await h.engine.start()
    expect(h.engine.state.status).toBe('paused')
    fail = false
    await h.engine.resume()
    expect(h.engine.state.status).toBe('done')
    expect(uniqueIds(h.appended)).toBe(true)
  })

  it('interjection during seat A reaches seat B but not A; it is a user interject message in the transcript', async () => {
    let h!: ReturnType<typeof harness>
    h = harness(cfg(['A', 'B']), c => {
      if (c.seat === 'A' && c.kind === 'critique') h.engine.interject('别忘了并发', 'iPhone')
      return undefined
    })
    await h.engine.start()
    const a = h.calls.find(c => c.seat === 'A' && c.kind === 'critique')!
    const b = h.calls.find(c => c.seat === 'B' && c.kind === 'critique')!
    expect(a.prompt).not.toContain('别忘了并发')
    expect(b.prompt).toContain('别忘了并发')
    const msg = h.appended.find(m => m.council?.stage === 'interject')!
    expect(msg).toMatchObject({ who: 'user', text: '别忘了并发', via: 'iPhone', council: { id: CID, round: 2 } })
    expect(h.events.some(e => e.type === 'user' && e.message.id === msg.id)).toBe(true)
    expect(h.persisted.at(-1)!.transcript.items.some(u => u.stage === 'interject' && u.text === '别忘了并发')).toBe(true)
    expect(uniqueIds(h.appended)).toBe(true)
  })

  it('a pause requested before a leader failure does not re-pause after resume', async () => {
    let h!: ReturnType<typeof harness>
    h = harness(cfg(['A', 'B']), c => {
      if (c.seat === 'L' && c.n === 1) h.engine.pause()
      return c.seat === 'L' && c.n <= 2 ? { ok: false } : undefined
    })
    await h.engine.start()
    expect(h.engine.state.status).toBe('paused')
    await h.engine.resume()
    expect(h.engine.state.status).toBe('done')
  })

  it('interjection during the round-1 summary reaches round-2 seats and the round-2 summary', async () => {
    let h!: ReturnType<typeof harness>
    h = harness(cfg(['A', 'B'], 3), c => {
      if (c.seat === 'L' && c.n === 1) h.engine.interject('考虑多机')
      return undefined
    })
    await h.engine.start()
    expect(h.calls.find(c => c.seat === 'L' && c.n === 1)!.prompt).not.toContain('考虑多机')
    const r2 = h.calls.filter(c => c.kind === 'critique' && c.prompt.includes('现在是第 2 轮'))
    expect(r2.map(c => c.seat)).toEqual(['A', 'B'])
    for (const c of r2) expect(c.prompt).toContain('考虑多机')
    const sum2 = h.calls.find(c => c.seat === 'L' && c.kind === 'summary' && c.n === 2)!
    expect(sum2.prompt).toContain('考虑多机')
    expect(h.appended.find(m => m.council?.stage === 'interject')!.council!.round).toBe(2)
  })

  it('interjection during the round-1 summary reaches the final when round 2 is the last', async () => {
    let h!: ReturnType<typeof harness>
    h = harness(cfg(['A', 'B'], 2), c => {
      if (c.seat === 'L' && c.n === 1) h.engine.interject('考虑多机')
      return undefined
    })
    await h.engine.start()
    expect(h.calls.find(c => c.kind === 'final')!.prompt).toContain('考虑多机')
  })

  it('resume(newLeader) while the pause is still pending swaps the leader', async () => {
    let h!: ReturnType<typeof harness>
    h = harness(cfg(['A', 'B', 'C']), c => {
      if (c.seat === 'A' && c.kind === 'critique') {
        h.engine.pause()
        void h.engine.resume(seat('M', 'gemini'))
      }
      return undefined
    })
    await h.engine.start()
    expect(h.engine.state.status).toBe('done')
    expect(h.calls.at(-1)).toMatchObject({ seat: 'M', kind: 'final' })
    expect(h.engine.state.config.leader.id).toBe('M')
  })

  it('a state listener resuming synchronously on pause does not stall the council', async () => {
    let resumed = false
    let h!: ReturnType<typeof harness>
    h = harness(cfg(['A', 'B', 'C']), c => {
      if (c.seat === 'A' && c.kind === 'critique') h.engine.pause()
      return undefined
    }, {
      emitState: s => {
        if (s.status === 'paused' && !resumed) { resumed = true; void h.engine.resume() }
      },
    })
    await h.engine.start()
    for (let i = 0; i < 10 && h.engine.state.status !== 'done'; i++) await tick()
    expect(resumed).toBe(true)
    expect(h.engine.state.status).toBe('done')
  })

  it("stop('finalize') mid-round cancels the running seat, then the leader writes the final", async () => {
    let h!: ReturnType<typeof harness>
    h = harness(cfg(['A', 'B', 'C']), c => {
      if (c.seat === 'B' && c.kind === 'critique') {
        setTimeout(() => h.engine.stop('finalize'), 2)
        return 'hang'
      }
      return undefined
    })
    await h.engine.start()
    expect(h.calls.map(c => `${c.seat}:${c.kind}`).slice(-2)).toEqual(['B:critique', 'L:final'])
    expect(h.calls.some(c => c.seat === 'C' && c.kind === 'critique')).toBe(false)
    expect(h.appended.some(m => m.council?.stage === 'failed')).toBe(false)
    expect(h.persisted.at(-1)!.failures.B ?? 0).toBe(0)
    expect(h.engine.state.status).toBe('done')
    expect(h.files).toHaveLength(1)
    expect(unclosedStreams(h.events)).toEqual([])
    const err = h.events.find(e => e.type === 'error')
    expect(err).toMatchObject({ type: 'error', error: 'cancelled', workspacePath: WS, sessionId: SID })
    expect(h.appended.some(m => err?.type === 'error' && m.id === err.id)).toBe(false)
    // 最后一轮发言里有 A 的第 2 轮内容
    expect(h.calls.at(-1)!.prompt).toContain('<<A#2>>')
  })

  it("stop('abort') mid-round cancels with no final and status aborted", async () => {
    let h!: ReturnType<typeof harness>
    h = harness(cfg(['A', 'B', 'C']), c => {
      if (c.seat === 'B' && c.kind === 'critique') {
        setTimeout(() => h.engine.stop('abort'), 2)
        return 'hang'
      }
      return undefined
    })
    await h.engine.start()
    expect(h.engine.state.status).toBe('aborted')
    expect(h.calls.some(c => c.kind === 'final')).toBe(false)
    expect(h.calls.at(-1)).toMatchObject({ seat: 'B', kind: 'critique' })
    expect(h.appended.some(m => m.council?.stage === 'failed' || m.council?.stage === 'final')).toBe(false)
    expect(h.files).toHaveLength(0)
    expect(h.persisted.at(-1)!.state.status).toBe('aborted')
    expect(h.engine.state.speaking).toEqual([])
    expect(unclosedStreams(h.events)).toEqual([])
  })

  it("stop('abort') during round 1 cancels every running seat", async () => {
    let h!: ReturnType<typeof harness>
    h = harness(cfg(['A', 'B']), c => {
      if (c.kind === 'answer') {
        if (c.seat === 'B') setTimeout(() => h.engine.stop('abort'), 2)
        return 'hang'
      }
      return undefined
    })
    await h.engine.start()
    expect(h.engine.state.status).toBe('aborted')
    expect(h.calls.map(c => c.seat)).toEqual(['A', 'B'])
    expect(unclosedStreams(h.events)).toEqual([])
  })

  it("a second stop('abort') while finalizing ends as aborted, not paused", async () => {
    let h!: ReturnType<typeof harness>
    h = harness(cfg(['A', 'B'], 1), c => {
      if (c.kind === 'final') {
        setTimeout(() => h.engine.stop('abort'), 2)
        return 'hang'
      }
      return undefined
    })
    await h.engine.start()
    expect(h.engine.state.status).toBe('aborted')
    expect(h.files).toHaveLength(0)
    expect(unclosedStreams(h.events)).toEqual([])
  })

  it("stop('finalize') while paused runs the final; stop('abort') while paused aborts", async () => {
    let h!: ReturnType<typeof harness>
    h = harness(cfg(['A', 'B', 'C']), c => {
      if (c.seat === 'A' && c.kind === 'critique') h.engine.pause()
      return undefined
    })
    await h.engine.start()
    expect(h.engine.state.status).toBe('paused')
    h.engine.stop('finalize')
    for (let i = 0; i < 10 && h.engine.state.status !== 'done'; i++) await tick()
    expect(h.engine.state.status).toBe('done')
    expect(h.calls.at(-1)!.kind).toBe('final')

    const h2 = harness(cfg(['A', 'B']), c => (c.seat === 'L' ? { ok: false } : undefined))
    await h2.engine.start()
    h2.engine.stop('abort')
    expect(h2.engine.state.status).toBe('aborted')
  })

  it("followup('x','all') after done asks each seat once, not the leader, leaves councilResult, appends 追问", async () => {
    const h = harness(cfg(['A', 'B']))
    await h.engine.start()
    const finalBefore = structuredClone(h.appended.find(m => m.council?.stage === 'final')!)
    const before = h.calls.length
    await h.engine.followup('x 怎么办', 'all')
    const fu = h.calls.slice(before)
    expect(fu.map(c => `${c.seat}:${c.kind}`)).toEqual(['A:followup', 'B:followup'])
    for (const c of fu) expect(c.prompt).toContain('x 怎么办')
    // B 依次回答,能看到 A 的追问回答
    expect(fu[1].prompt).toContain('<<A#3>>')
    const msgs = h.appended.filter(m => m.council?.stage === 'followup')
    expect(msgs.map(m => m.who)).toEqual(['user', 'ai', 'ai'])
    expect(msgs[0].text).toBe('x 怎么办')
    expect(h.appended.filter(m => m.councilResult)).toHaveLength(1)
    expect(h.appended.find(m => m.council?.stage === 'final')).toEqual(finalBefore)
    expect(h.engine.state.status).toBe('done')
    const file = h.files.at(-1)!
    expect(file.path).toBe(h.engine.state.resultFile)
    expect(file.text).toContain('## 追问')
    expect(file.text).toContain('x 怎么办')
    expect(file.text).toContain('<<B#3>>')
    expect(file.text).toContain('用 LRU')
    expect(uniqueIds(h.appended)).toBe(true)

    // 第二次追问:id 不撞,单个席位只问它
    const n = h.calls.length
    await h.engine.followup('y', 'B')
    expect(h.calls.slice(n).map(c => c.seat)).toEqual(['B'])
    expect(uniqueIds(h.appended)).toBe(true)
  })

  it('followup before done is rejected without calling any seat', async () => {
    const h = harness(cfg(['A', 'B']), c => (c.seat === 'L' ? { ok: false } : undefined))
    await h.engine.start()
    const before = h.calls.length
    await expect(h.engine.followup('x', 'all')).rejects.toThrow()
    expect(h.calls.length).toBe(before)
    expect(h.appended.some(m => m.council?.stage === 'followup')).toBe(false)
  })

  it("choose('B') records the choice and rewrites the file, also after a follow-up", async () => {
    const h = harness(cfg(['A', 'B']))
    await h.engine.start()
    await h.engine.followup('x', 'A')
    h.engine.choose('B')
    expect(h.engine.state.chosen).toBe('B')
    expect(h.states.at(-1)!.chosen).toBe('B')
    expect(h.persisted.at(-1)!.state.chosen).toBe('B')
    const file = h.files.at(-1)!
    expect(file.path).toBe(h.engine.state.resultFile)
    expect(file.text).toContain('用户选定:B')
    expect(file.text).toContain('## 追问')
  })

  it('choose persists the choice even if rewriting the file fails', async () => {
    let fail = false
    const h = harness(cfg(['A', 'B']), undefined, { writeFile: () => { if (fail) throw new Error('EACCES') } })
    await h.engine.start()
    fail = true
    expect(() => h.engine.choose('B')).not.toThrow()
    expect(h.persisted.at(-1)!.state.chosen).toBe('B')
    expect(getAppLog().some(e => e.level === 'error' && (e.detail ?? '').includes('EACCES'))).toBe(true)
  })

  it('an unexpected error is logged before pausing', async () => {
    const h = harness(cfg(['A', 'B']), undefined, { materialsText: async () => { throw new Error('git failed') } })
    await h.engine.start()
    expect(h.engine.state.status).toBe('paused')
    expect(getAppLog().some(e => e.level === 'error' && e.scope === 'council' && (e.detail ?? e.msg).includes('git failed'))).toBe(true)
  })
})
