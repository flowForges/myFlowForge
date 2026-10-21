import { describe, it, expect } from 'vitest'
import { CouncilEngine, type EngineDeps, type PersistedCouncil } from './engine'
import { COUNCIL_RESULT_FENCE } from './prompts'
import type { SeatRunCallbacks, SeatRunResult } from './seatRunner'
import type { CouncilConfig, CouncilSeat, CouncilState } from '@shared/council'
import type { ChatEvent, ChatMessage } from '@shared/types'

const WS = '/tmp/ws-council'
const SID = 's1'
const CID = 'c1'
const T0 = new Date(2026, 9, 21, 9, 5).getTime()
const MIN = 60_000

const seat = (id: string, provider = 'codex'): CouncilSeat => ({ id, provider, model: `m-${id}`, label: `${provider} · ${id}` })
const cfg = (seatIds: string[], maxRounds = 5, maxMinutes = 30): CouncilConfig => ({
  topic: '怎么设计缓存',
  attachments: [],
  seats: seatIds.map(id => seat(id)),
  leader: seat('L', 'claude'),
  mode: { kind: 'consensus', maxRounds, maxMinutes },
})

const FINAL_TEXT = [
  '最终结论正文',
  COUNCIL_RESULT_FENCE,
  JSON.stringify({ conclusion: '用 LRU', candidates: [], disagreements: [] }),
  '```',
].join('\n')

type Kind = 'answer' | 'critique' | 'summary' | 'draft' | 'vote' | 'final'
type Call = { seat: string; prompt: string; n: number; kind: Kind }
// 'hang' = 一直不结束,只有 cancel() 能让它 settle
type Reply = { ok: true; text: string } | { ok: false } | 'hang'
type Script = (c: Call) => Reply | undefined

function kindOf(prompt: string): Kind {
  // ★投票提示词里也有「目前各方的共同点」草稿字样,先判投票
  if (prompt.includes('请判断你是否同意它可以作为共识')) return 'vote'
  if (prompt.includes('请整理一份「目前各方的共同点」草稿')) return 'draft'
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
    const fallback = call.kind === 'final' ? FINAL_TEXT : call.kind === 'vote' ? '同意,没问题' : `<<${s.id}#${call.n}>>`
    const reply: Reply = script(call) ?? { ok: true, text: fallback }
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

const seq = (calls: Call[]) => calls.map(c => `${c.seat}:${c.kind}`)
const uniqueIds = (ms: ChatMessage[]) => new Set(ms.map(m => m.id)).size === ms.length
function unclosedStreams(events: ChatEvent[]): string[] {
  const closed = new Set(events.flatMap(e => (e.type === 'done' ? [e.message.id] : e.type === 'error' ? [e.id] : [])))
  return events.flatMap(e => (e.type === 'assistant-start' && !closed.has(e.id) ? [e.id] : []))
}

describe('CouncilEngine consensus mode', () => {
  it('all agree after round 1 → summary, draft, parallel votes, then final after 1 round', async () => {
    const h = harness(cfg(['A', 'B']))
    await h.engine.start()
    expect(seq(h.calls)).toEqual(['A:answer', 'B:answer', 'L:summary', 'L:draft', 'A:vote', 'B:vote', 'L:final'])
    expect(h.engine.state).toMatchObject({ status: 'done', round: 1, totalRounds: null })
    const draft = h.appended.find(m => m.council?.stage === 'consensus-draft')!
    expect(draft).toMatchObject({ who: 'ai', text: '<<L#2>>', council: { id: CID, seat: 'L', round: 1 } })
    const votes = h.appended.filter(m => m.council?.stage === 'consensus-vote')
    expect(votes.map(m => m.council!.seat)).toEqual(['A', 'B'])
    // 投票拿到的是领导者的草稿
    for (const v of h.calls.filter(c => c.kind === 'vote')) expect(v.prompt).toContain('<<L#2>>')
    // 草稿只看本轮讨论者发言,不看总结
    const d = h.calls.find(c => c.kind === 'draft')!
    expect(d.prompt).toContain('<<A#1>>')
    expect(d.prompt).not.toContain('<<L#1>>')
    expect(h.calls.at(-1)!.prompt).not.toContain('未能达成共识的点')
    expect(h.files).toHaveLength(1)
    expect(uniqueIds(h.appended)).toBe(true)
  })

  it('one disagree then all agree → 2 rounds, and round-2 prompts contain the disagree reason', async () => {
    const h = harness(cfg(['A', 'B', 'C']), c =>
      (c.kind === 'vote' && c.seat === 'A' && c.n === 2 ? { ok: true, text: '不同意,没考虑并发写' } : undefined))
    await h.engine.start()
    expect(h.engine.state.status).toBe('done')
    expect(h.engine.state.round).toBe(2)
    const r2 = h.calls.filter(c => c.kind === 'critique')
    expect(r2.map(c => c.seat)).toEqual(['A', 'B', 'C'])
    for (const c of r2.slice(1)) expect(c.prompt).toContain('没考虑并发写')
    expect(seq(h.calls.slice(h.calls.indexOf(r2[2]) + 1))).toEqual(['L:summary', 'L:draft', 'A:vote', 'B:vote', 'C:vote', 'L:final'])
    expect(h.calls.at(-1)!.prompt).not.toContain('未能达成共识的点')
    expect(h.persisted.at(-1)!.transcript.items.some(u => u.stage === 'consensus-vote' && u.text === '不同意,没考虑并发写')).toBe(true)
    expect(uniqueIds(h.appended)).toBe(true)
  })

  it('never agreeing stops at maxRounds with unresolved reasons passed to the final', async () => {
    const h = harness(cfg(['A', 'B'], 3), c =>
      (c.kind === 'vote' && c.seat === 'B' ? { ok: true, text: `**不同意**:第 ${c.n} 次还是不行` } : undefined))
    await h.engine.start()
    expect(h.engine.state.status).toBe('done')
    expect(h.engine.state.round).toBe(3)
    expect(h.calls.filter(c => c.seat === 'L').map(c => c.kind)).toEqual([
      'summary', 'draft', 'summary', 'draft', 'summary', 'draft', 'final',
    ])
    const final = h.calls.at(-1)!.prompt
    expect(final).toContain('未能达成共识的点')
    // 只带最近一轮的不同意理由
    expect(final).toContain('- codex · B: 第 6 次还是不行')
    expect(final).not.toContain('- codex · B: 第 4 次')
    expect(final).not.toContain('codex · A:')
  })

  it('time cap via fake now stops early and the final receives unresolved reasons', async () => {
    let t = T0
    const h = harness(cfg(['A', 'B'], 5, 30), c => {
      if (c.kind === 'vote' && c.seat === 'A') {
        t = T0 + 31 * MIN
        return { ok: true, text: '不同意 缺少失效策略' }
      }
      return undefined
    }, { now: () => t })
    await h.engine.start()
    expect(h.engine.state.status).toBe('done')
    expect(h.engine.state.round).toBe(1)
    expect(h.calls.some(c => c.kind === 'critique')).toBe(false)
    expect(h.calls.at(-1)!.kind).toBe('final')
    expect(h.calls.at(-1)!.prompt).toContain('- codex · A: 缺少失效策略')
  })

  it('an unknown vote counts as not agreeing → another round', async () => {
    const h = harness(cfg(['A', 'B']), c =>
      (c.kind === 'vote' && c.seat === 'B' && c.n === 2 ? { ok: true, text: '基本可以吧' } : undefined))
    await h.engine.start()
    expect(h.engine.state.round).toBe(2)
    expect(h.calls.filter(c => c.kind === 'critique').map(c => c.seat)).toEqual(['A', 'B'])
    expect(h.calls.find(c => c.kind === 'critique' && c.seat === 'A')!.prompt).toContain('基本可以吧')
    expect(h.engine.state.status).toBe('done')
  })

  it('a failed vote counts as not agreeing and toward the seat drop rule', async () => {
    const h = harness(cfg(['A', 'B', 'C']), c =>
      (c.seat === 'C' && (c.kind === 'vote' || c.kind === 'critique') ? { ok: false } : undefined))
    await h.engine.start()
    // 第 1 轮 C 投票失败 → 不算同意;第 2 轮 C 发言再失败 → 连续 2 次,除名;之后 A、B 同意即出结果
    expect(h.engine.state.round).toBe(2)
    expect(h.persisted.at(-1)!.dropped).toEqual(['C'])
    const r2votes = h.calls.filter(c => c.kind === 'vote').slice(3)
    expect(r2votes.map(c => c.seat)).toEqual(['A', 'B'])
    expect(h.engine.state.status).toBe('done')
  })

  it('pause during the vote lets every vote finish, then resume continues', async () => {
    let h!: ReturnType<typeof harness>
    h = harness(cfg(['A', 'B']), c => {
      if (c.kind === 'vote' && c.seat === 'A' && c.n === 2) {
        h.engine.pause()
        return { ok: true, text: '不同意,再想想' }
      }
      return undefined
    })
    await h.engine.start()
    expect(h.engine.state.status).toBe('paused')
    expect(seq(h.calls).slice(-2)).toEqual(['A:vote', 'B:vote'])
    expect(h.appended.filter(m => m.council?.stage === 'consensus-vote')).toHaveLength(2)
    const before = h.calls.length
    await h.engine.resume()
    expect(seq(h.calls.slice(before))).toEqual(['A:critique', 'B:critique', 'L:summary', 'L:draft', 'A:vote', 'B:vote', 'L:final'])
    expect(h.engine.state.status).toBe('done')
    expect(uniqueIds(h.appended)).toBe(true)
  })

  it("stop('finalize') during the vote cancels the votes without failures and writes the final", async () => {
    let h!: ReturnType<typeof harness>
    h = harness(cfg(['A', 'B']), c => {
      if (c.kind === 'vote') {
        if (c.seat === 'B') setTimeout(() => h.engine.stop('finalize'), 2)
        return 'hang'
      }
      return undefined
    })
    await h.engine.start()
    expect(seq(h.calls).slice(-3)).toEqual(['A:vote', 'B:vote', 'L:final'])
    expect(h.engine.state.status).toBe('done')
    expect(h.appended.some(m => m.council?.stage === 'failed' || m.council?.stage === 'consensus-vote')).toBe(false)
    expect(h.persisted.at(-1)!.failures.A ?? 0).toBe(0)
    expect(unclosedStreams(h.events)).toEqual([])
    expect(h.events.filter(e => e.type === 'error').map(e => e.type === 'error' && e.error)).toEqual(['cancelled', 'cancelled'])
  })

  it('leader failing the draft twice pauses; resume retries the draft and finishes', async () => {
    let fail = true
    const h = harness(cfg(['A', 'B']), c => (c.kind === 'draft' && fail ? { ok: false } : undefined))
    await h.engine.start()
    expect(h.engine.state.status).toBe('paused')
    expect(h.calls.filter(c => c.kind === 'draft')).toHaveLength(2)
    expect(h.calls.some(c => c.kind === 'vote')).toBe(false)
    fail = false
    const before = h.calls.length
    await h.engine.resume()
    expect(seq(h.calls.slice(before))).toEqual(['L:draft', 'A:vote', 'B:vote', 'L:final'])
    expect(h.engine.state.status).toBe('done')
    expect(uniqueIds(h.appended)).toBe(true)
  })

  it('an interjection during the vote reaches the next round', async () => {
    let h!: ReturnType<typeof harness>
    h = harness(cfg(['A', 'B']), c => {
      if (c.kind === 'vote' && c.seat === 'A' && c.n === 2) {
        h.engine.interject('考虑多机')
        return { ok: true, text: '不同意' }
      }
      return undefined
    })
    await h.engine.start()
    expect(h.appended.find(m => m.council?.stage === 'interject')!.council!.round).toBe(2)
    for (const c of h.calls.filter(c => c.kind === 'critique')) expect(c.prompt).toContain('考虑多机')
    expect(h.calls.find(c => c.kind === 'summary' && c.prompt.includes('第 2 轮'))!.prompt).toContain('考虑多机')
  })
})
