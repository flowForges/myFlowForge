import { describe, it, expect } from 'vitest'
import { CouncilEngine, type EngineDeps, type PersistedCouncil } from './engine'
import { COUNCIL_RESULT_FENCE } from './prompts'
import type { SeatRunCallbacks, SeatRunResult } from './seatRunner'
import type { CouncilConfig, CouncilMode, CouncilSeat, CouncilState } from '@shared/council'
import type { ChatEvent, ChatMessage } from '@shared/types'

// 「每轮结束后等我」(pauseBetweenRounds)+ 流式事件都带共商标记。

const WS = '/tmp/ws-council'
const SID = 's1'
const CID = 'c1'
const T0 = new Date(2026, 9, 21, 9, 5).getTime()

const seat = (id: string, provider = 'codex'): CouncilSeat => ({ id, provider, model: `m-${id}`, label: `${provider} · ${id}` })
const cfg = (seatIds: string[], mode: CouncilMode = { kind: 'rounds', rounds: 3 }, over: Partial<CouncilConfig> = {}): CouncilConfig => ({
  topic: '怎么设计缓存',
  attachments: [],
  seats: seatIds.map(id => seat(id)),
  leader: seat('L', 'claude'),
  mode,
  ...over,
})

const FINAL_TEXT = [
  '最终结论正文',
  COUNCIL_RESULT_FENCE,
  JSON.stringify({ conclusion: '用 LRU', candidates: [], disagreements: [] }),
  '```',
].join('\n')

type Kind = 'answer' | 'critique' | 'summary' | 'draft' | 'vote' | 'final'
type Call = { seat: string; prompt: string; n: number; kind: Kind }
type Reply = { ok: true; text: string } | { ok: false }
type Script = (c: Call) => Reply | undefined

function kindOf(prompt: string): Kind {
  if (prompt.includes('请判断你是否同意它可以作为共识')) return 'vote'
  if (prompt.includes('请整理一份「目前各方的共同点」草稿')) return 'draft'
  if (prompt.includes('共识结果')) return 'final'
  if (prompt.includes('请做本轮总结')) return 'summary'
  if (prompt.includes('现在是第 1 轮')) return 'answer'
  return 'critique'
}

function harness(c: CouncilConfig, script: Script = () => undefined, over: Partial<EngineDeps> = {}, restored?: PersistedCouncil) {
  const calls: Call[] = []
  const appended: ChatMessage[] = over.readMessages ? [...over.readMessages(WS, SID)] : []
  const events: ChatEvent[] = []
  const states: CouncilState[] = []
  const persisted: PersistedCouncil[] = []
  const counts: Record<string, number> = {}

  const runSeat: EngineDeps['runSeat'] = (_cid, s, prompt, _deps, cb: SeatRunCallbacks) => {
    counts[s.id] = (counts[s.id] ?? 0) + 1
    const call: Call = { seat: s.id, prompt, n: counts[s.id], kind: kindOf(prompt) }
    calls.push(call)
    const msgId = `inner-${s.id}-${call.n}`
    const fallback = call.kind === 'final' ? FINAL_TEXT : call.kind === 'vote' ? '同意,没问题' : `<<${s.id}#${call.n}>>`
    const reply: Reply = script(call) ?? { ok: true, text: fallback }
    cb.onStart(msgId)
    const done = (async (): Promise<SeatRunResult> => {
      await new Promise(r => setTimeout(r, 1))
      if (!reply.ok) return { ok: false, msgId, error: 'boom' }
      cb.onThink(msgId, `${s.id} 在想`)
      cb.onDelta(msgId, 'x')
      cb.onReplace(msgId, reply.text)
      return { ok: true, msgId, text: reply.text }
    })()
    return { done, cancel() {}, resumed: false }
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
    writeFile: () => {},
    persist: p => persisted.push(p),
    now: () => T0,
    ...over,
  }
  const engine = new CouncilEngine(CID, WS, SID, c, deps, restored)
  return { engine, calls, appended, events, states, persisted }
}

const seq = (calls: Call[]) => calls.map(c => `${c.seat}:${c.kind}`)

describe('CouncilEngine round break (pauseBetweenRounds)', () => {
  it('defaults on: waits after the round-1 and round-2 summaries, not after round 3', async () => {
    const h = harness(cfg(['A', 'B']))
    await h.engine.start()
    expect(seq(h.calls)).toEqual(['A:answer', 'B:answer', 'L:summary'])
    expect(h.engine.state).toMatchObject({ status: 'paused', waitingForUser: true, round: 2 })
    expect(h.persisted.at(-1)!.state.waitingForUser).toBe(true)

    await h.engine.resume()
    expect(seq(h.calls.slice(3))).toEqual(['A:critique', 'B:critique', 'L:summary'])
    expect(h.engine.state).toMatchObject({ status: 'paused', waitingForUser: true, round: 3 })

    await h.engine.resume()
    expect(seq(h.calls.slice(6))).toEqual(['A:critique', 'B:critique', 'L:final'])
    expect(h.engine.state.status).toBe('done')
    expect(h.engine.state.waitingForUser).toBeFalsy()
  })

  it('resume clears the flag as soon as the next round starts', async () => {
    const h = harness(cfg(['A', 'B']))
    await h.engine.start()
    const resumed = h.engine.resume()
    expect(h.engine.state).toMatchObject({ status: 'running' })
    expect(h.engine.state.waitingForUser).toBeFalsy()
    await resumed
  })

  it('an interjection during the break is accepted, tagged for the next round, and reaches round-2 seats and the round-2 summary', async () => {
    const h = harness(cfg(['A', 'B']))
    await h.engine.start()
    h.engine.interject('考虑多机')
    const inter = h.appended.find(m => m.council?.stage === 'interject')
    expect(inter).toMatchObject({ who: 'user', text: '考虑多机', council: { round: 2 } })
    expect(h.engine.state).toMatchObject({ status: 'paused', waitingForUser: true })
    await h.engine.resume()
    const r2 = h.calls.filter(c => c.kind === 'critique')
    expect(r2.map(c => c.seat)).toEqual(['A', 'B'])
    for (const c of r2) expect(c.prompt).toContain('考虑多机')
    expect(h.calls.filter(c => c.kind === 'summary')[1].prompt).toContain('考虑多机')
  })

  it('an interjection during the last break reaches the final', async () => {
    const h = harness(cfg(['A', 'B'], { kind: 'rounds', rounds: 2 }))
    await h.engine.start()
    h.engine.interject('考虑多机')
    await h.engine.resume()
    expect(h.engine.state.status).toBe('done')
    expect(h.calls.at(-1)!.kind).toBe('final')
    expect(h.calls.at(-1)!.prompt).toContain('考虑多机')
  })

  it('pauseBetweenRounds:false runs straight through', async () => {
    const h = harness(cfg(['A', 'B'], { kind: 'rounds', rounds: 3 }, { pauseBetweenRounds: false }))
    await h.engine.start()
    expect(h.engine.state.status).toBe('done')
    expect(h.states.some(s => s.waitingForUser)).toBe(false)
  })

  it("stop('finalize') during the break writes the final and clears the flag", async () => {
    const h = harness(cfg(['A', 'B']))
    await h.engine.start()
    h.engine.stop('finalize')
    for (let i = 0; i < 20 && h.engine.state.status !== 'done'; i++) await new Promise(r => setTimeout(r, 5))
    expect(h.engine.state.status).toBe('done')
    expect(h.engine.state.waitingForUser).toBeFalsy()
    expect(h.calls.at(-1)!.kind).toBe('final')
  })

  it("stop('abort') during the break clears the flag", async () => {
    const h = harness(cfg(['A', 'B']))
    await h.engine.start()
    h.engine.stop('abort')
    expect(h.engine.state.status).toBe('aborted')
    expect(h.engine.state.waitingForUser).toBeFalsy()
  })

  it('a user pause or a leader-failure pause is not a round break; interject stays rejected there', async () => {
    let h!: ReturnType<typeof harness>
    h = harness(cfg(['A', 'B', 'C']), c => {
      if (c.seat === 'A' && c.kind === 'answer') h.engine.pause()
      return undefined
    })
    await h.engine.start()
    expect(h.engine.state.status).toBe('paused')
    expect(h.engine.state.waitingForUser).toBeFalsy()
    h.engine.interject('暂停中插话')
    expect(h.appended.some(m => m.council?.stage === 'interject')).toBe(false)

    const f = harness(cfg(['A', 'B']), c => (c.seat === 'L' ? { ok: false } : undefined))
    await f.engine.start()
    expect(f.engine.state.status).toBe('paused')
    expect(f.engine.state.waitingForUser).toBeFalsy()
  })

  it('a pause requested during the summary is absorbed by the break; resume goes on with the next round', async () => {
    let h!: ReturnType<typeof harness>
    h = harness(cfg(['A', 'B']), c => {
      if (c.seat === 'L' && c.n === 1) h.engine.pause()
      return undefined
    })
    await h.engine.start()
    expect(h.engine.state).toMatchObject({ status: 'paused', waitingForUser: true, round: 2 })
    await h.engine.resume()
    expect(seq(h.calls.slice(3))).toEqual(['A:critique', 'B:critique', 'L:summary'])
  })

  it('consensus mode waits after a disagreeing vote, not after an agreeing one', async () => {
    const h = harness(cfg(['A', 'B'], { kind: 'consensus', maxRounds: 5, maxMinutes: 30 }), c =>
      (c.kind === 'vote' && c.seat === 'A' && c.n === 2 ? { ok: true, text: '不同意,没考虑并发写' } : undefined))
    await h.engine.start()
    expect(seq(h.calls)).toEqual(['A:answer', 'B:answer', 'L:summary', 'L:draft', 'A:vote', 'B:vote'])
    expect(h.engine.state).toMatchObject({ status: 'paused', waitingForUser: true, round: 2 })
    h.engine.interject('先别管并发')
    await h.engine.resume()
    expect(h.engine.state.status).toBe('done')
    const r2 = h.calls.filter(c => c.kind === 'critique')
    for (const c of r2) expect(c.prompt).toContain('先别管并发')
  })

  it('consensus mode does not wait when the round cap ends the discussion', async () => {
    const h = harness(cfg(['A', 'B'], { kind: 'consensus', maxRounds: 1, maxMinutes: 30 }), c =>
      (c.kind === 'vote' && c.seat === 'A' ? { ok: true, text: '不同意' } : undefined))
    await h.engine.start()
    expect(h.engine.state.status).toBe('done')
  })

  it('the flag survives persist + restore; the restored engine accepts the interjection and resumes', async () => {
    const h = harness(cfg(['A', 'B']))
    await h.engine.start()
    const snap = h.persisted.at(-1)!
    expect(snap.state.waitingForUser).toBe(true)
    const appended = [...h.appended]
    const r = harness(cfg(['A', 'B']), undefined, { readMessages: () => appended }, JSON.parse(JSON.stringify(snap)))
    expect(r.engine.state).toMatchObject({ status: 'paused', waitingForUser: true, round: 2 })
    r.engine.interject('重启后补充')
    expect(r.appended.at(-1)).toMatchObject({ text: '重启后补充', council: { stage: 'interject', round: 2 } })
    await r.engine.resume()
    expect(seq(r.calls)).toEqual(['A:critique', 'B:critique', 'L:summary'])
    for (const c of r.calls) expect(c.prompt).toContain('重启后补充')
  })
})

describe('CouncilEngine streaming events', () => {
  it('every streaming event carries the same council tag as its assistant-start', async () => {
    const h = harness(cfg(['A', 'B'], { kind: 'rounds', rounds: 2 }, { pauseBetweenRounds: false }))
    await h.engine.start()
    const starts = new Map(h.events.flatMap(e => (e.type === 'assistant-start' ? [[e.id, e.council] as const] : [])))
    const streaming = h.events.filter(e => e.type === 'assistant-delta' || e.type === 'think-delta' || e.type === 'assistant-replace')
    expect(new Set(streaming.map(e => e.type))).toEqual(new Set(['assistant-delta', 'think-delta', 'assistant-replace']))
    for (const e of streaming) {
      const tag = 'id' in e ? starts.get(e.id) : undefined
      expect(tag).toBeDefined()
      expect((e as { council?: unknown }).council).toEqual(tag)
    }
  })

  it('thinking is persisted on seat and leader messages', async () => {
    const h = harness(cfg(['A', 'B'], { kind: 'rounds', rounds: 2 }, { pauseBetweenRounds: false }))
    await h.engine.start()
    const ai = h.appended.filter(m => m.who === 'ai')
    expect(ai.map(m => m.council!.stage)).toEqual(['answer', 'answer', 'summary', 'critique', 'critique', 'final'])
    for (const m of ai) expect(m.think?.steps).toEqual([`${m.council!.seat} 在想`])
  })
})
