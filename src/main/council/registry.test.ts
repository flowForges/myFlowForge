import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CouncilEngine, type EngineDeps, type PersistedCouncil } from './engine'
import { CouncilRegistry } from './registry'
import { loadCouncils, saveCouncil } from './store'
import { COUNCIL_RESULT_FENCE } from './prompts'
import type { SeatRunCallbacks, SeatRunResult } from './seatRunner'
import type { CouncilConfig, CouncilSeat, CouncilState } from '@shared/council'
import { appendMessage, readMessages } from '../chat/chatStore'
import { logError } from '../log/appLog'

vi.mock('../log/appLog', async (orig) => ({ ...(await orig<typeof import('../log/appLog')>()), logError: vi.fn() }))

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
const FINAL_TEXT = ['最终结论', COUNCIL_RESULT_FENCE, JSON.stringify({ conclusion: 'x', candidates: [], disagreements: [] }), '```'].join('\n')

type Kind = 'answer' | 'critique' | 'summary' | 'final'
type Call = { seat: string; prompt: string; kind: Kind; n: number }
// 'hang' = 只有 cancel() 能让它结束(模拟崩溃时卡在半路的发言)
type Reply = { ok: true; text: string } | { ok: false } | 'hang'

function kindOf(prompt: string): Kind {
  if (prompt.includes('共识结果')) return 'final'
  if (prompt.includes('请做本轮总结')) return 'summary'
  if (prompt.includes('现在是第 1 轮')) return 'answer'
  return 'critique'
}

/**
 * 真实落盘(store + chatStore 写临时工作区),假的 runSeat。「崩溃」= 丢下旧注册表(卡住的发言永不结束),
 * 再 new 一个注册表 restore。
 */
function world(ws: string) {
  const calls: Call[] = []
  const cancelled: string[] = []
  const states: CouncilState[] = []
  const counts: Record<string, number> = {}
  let script: (c: Call) => Reply | undefined = () => undefined

  const runSeat: EngineDeps['runSeat'] = (_cid, s, prompt, _deps, cb: SeatRunCallbacks) => {
    const kind = kindOf(prompt)
    const key = `${s.id}:${kind}`
    counts[key] = (counts[key] ?? 0) + 1
    const call: Call = { seat: s.id, prompt, kind, n: counts[key] }
    calls.push(call)
    const reply = script(call) ?? { ok: true, text: kind === 'final' ? FINAL_TEXT : `${s.id}-${kind}-${call.n}` }
    const msgId = `inner-${key}-${call.n}`
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
    return { done, cancel: () => { cancelled.push(s.id); settle({ ok: false, msgId, error: 'cancelled' }) }, resumed: false }
  }

  const deps: EngineDeps = {
    runSeat,
    seatDeps: { providers: {}, env: {} },
    seatResumed: () => false,
    append: appendMessage,
    readMessages,
    emitChat: () => {},
    emitState: s => { states.push(s) },
    materialsText: async () => 'MATERIALS-TEXT',
    writeFile: () => {},
    persist: p => saveCouncil(p.state.workspacePath, p),
    now: () => T0,
  }
  const make = (id: string, w: string, sid: string, c: CouncilConfig, restored?: PersistedCouncil) =>
    new CouncilEngine(id, w, sid, c, { ...deps }, restored)

  return {
    calls, cancelled, states, make,
    setScript: (f: (c: Call) => Reply | undefined) => { script = f },
    registry: () => new CouncilRegistry(make),
    stored: (id: string) => loadCouncils(ws).find(p => p.state.id === id)!,
    messageIds: (sid: string) => readMessages(ws, sid).map(m => m.id),
  }
}

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms))
const unique = (ids: string[]) => new Set(ids).size === ids.length
const untilStatus = (get: () => CouncilState | undefined, status: string) =>
  vi.waitFor(() => expect(get()?.status).toBe(status), { timeout: 2000, interval: 2 })

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'council-reg-')) })
afterEach(() => rmSync(ws, { recursive: true, force: true }))

describe('CouncilRegistry', () => {
  it('start twice for the same session while running → busy; different sessions → both allowed', async () => {
    const w = world(ws)
    w.setScript(() => 'hang')
    const reg = w.registry()
    const a = reg.start(ws, 's1', cfg(['A', 'B']))
    expect(() => reg.start(ws, 's1', cfg(['A', 'B']))).toThrow('busy')
    const b = reg.start(ws, 's2', cfg(['A', 'B']))
    expect(a).not.toBe(b)
    expect(reg.get(a)!.state.status).toBe('running')
    expect(reg.get(b)!.state.status).toBe('running')
    reg.shutdown()
  })

  it('events carry council and session ids', async () => {
    const w = world(ws)
    const reg = w.registry()
    const id = reg.start(ws, 's1', cfg(['A', 'B'], 1))
    await untilStatus(() => reg.get(id)?.state, 'done')
    const mine = w.states.filter(s => s.id === id)
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.every(s => s.workspacePath === ws && s.sessionId === 's1')).toBe(true)
    expect(reg.listForSession(ws, 's1').map(s => s.id)).toEqual([id])
    expect(reg.listForSession(ws, 's2')).toEqual([])
    // 结束后同一会话可以再开
    expect(() => reg.start(ws, 's1', cfg(['A', 'B'], 1))).not.toThrow()
  })

  it('restore turns running into paused (persisted), does not auto-resume, keeps done councils usable', async () => {
    const w = world(ws)
    const reg1 = w.registry()
    const done = reg1.start(ws, 's2', cfg(['A', 'B'], 1))
    await untilStatus(() => reg1.get(done)?.state, 'done')
    w.setScript(() => 'hang')
    const live = reg1.start(ws, 's1', cfg(['A', 'B']))
    await tick()
    expect(w.stored(live).state.status).toBe('running')

    // 崩溃:丢下 reg1
    const reg2 = w.registry()
    // 还没 restore 时列表也不能把它显示成运行中
    expect(reg2.listForSession(ws, 's1').map(s => [s.id, s.status])).toEqual([[live, 'paused']])
    reg2.restore(ws)
    expect(reg2.get(live)!.state).toMatchObject({ status: 'paused', speaking: [], round: 1 })
    expect(w.stored(live).state.status).toBe('paused')
    const before = w.calls.length
    await tick()
    expect(w.calls.length).toBe(before)
    expect(reg2.get(done)!.state.status).toBe('done')
    reg2.get(done)!.choose('A')
    expect(w.stored(done).state.chosen).toBe('A')
    // 暂停中的共商不占用会话
    expect(() => reg2.start(ws, 's1', cfg(['A', 'B']))).not.toThrow()
    // 重复 restore 不重建已经在内存里的引擎
    const eng = reg2.get(live)
    reg2.restore(ws)
    expect(reg2.get(live)).toBe(eng)
  })

  it('resume after crash mid round 1 does not duplicate messages', async () => {
    const w = world(ws)
    let crashed = false
    w.setScript(c => (!crashed && c.seat === 'B' ? 'hang' : undefined))
    const reg1 = w.registry()
    const id = reg1.start(ws, 's1', cfg(['A', 'B'], 2))
    await vi.waitFor(() => expect(w.messageIds('s1')).toContain(`${id}:1:A:answer`), { timeout: 2000, interval: 2 })
    // A 的作答已经写进会话,但第 1 轮没结束 → 还没进 transcript
    expect(w.stored(id).transcript.items).toEqual([])

    crashed = true
    const reg2 = w.registry()
    reg2.restore(ws)
    const eng = reg2.get(id)!
    void eng.resume()
    await untilStatus(() => eng.state, 'done')

    const ids = w.messageIds('s1')
    expect(unique(ids)).toBe(true)
    expect(ids.filter(x => x === `${id}:topic`)).toHaveLength(1)
    expect(w.calls.filter(c => c.seat === 'A' && c.kind === 'answer')).toHaveLength(1)
    expect(w.calls.filter(c => c.seat === 'B' && c.kind === 'answer')).toHaveLength(2)
    // 崩溃前 A 的作答照样进了本轮总结
    const summary = w.calls.find(c => c.kind === 'summary')!
    expect(summary.prompt).toContain('A-answer-1')
    expect(summary.prompt).toContain('B-answer-2')
    const answers = w.stored(id).transcript.items.filter(u => u.stage === 'answer')
    expect(answers.map(u => [u.seat, u.text])).toEqual([['A', 'A-answer-1'], ['B', 'B-answer-2']])
  })

  it('crash while summarising with a next-round interjection: restore keeps the persisted round', async () => {
    const w = world(ws)
    let crashed = false
    let reg1!: CouncilRegistry
    let id = ''
    w.setScript(c => {
      if (!crashed && c.kind === 'summary') {
        reg1.get(id)!.interject('插一句')
        return 'hang'
      }
      return undefined
    })
    reg1 = w.registry()
    id = reg1.start(ws, 's1', cfg(['A', 'B'], 2))
    await vi.waitFor(() => expect(w.stored(id).transcript.items.some(u => u.stage === 'interject')).toBe(true), { timeout: 2000, interval: 2 })
    const snap = w.stored(id)
    expect(snap.state.round).toBe(1)
    expect(snap.transcript.items.find(u => u.stage === 'interject')!.round).toBe(2)

    crashed = true
    const reg2 = w.registry()
    reg2.restore(ws)
    const eng = reg2.get(id)!
    expect(eng.state.round).toBe(1)
    void eng.resume()
    await untilStatus(() => eng.state, 'done')

    const summaries = w.calls.filter(c => c.kind === 'summary')
    expect(summaries).toHaveLength(2)
    expect(summaries[1].prompt).toContain('第 1 轮')
    for (const s of ['A', 'B']) {
      expect(w.calls.find(c => c.seat === s && c.kind === 'critique')!.prompt).toContain('插一句')
    }
    expect(unique(w.messageIds('s1'))).toBe(true)
    expect(w.messageIds('s1')).toContain(`${id}:1:L:summary:r1`)
  })

  it('resume after restore continues at the persisted round and seats see only unseen items', async () => {
    const w = world(ws)
    let reg1!: CouncilRegistry
    let id = ''
    let restarted = false
    w.setScript(c => {
      if (restarted || c.kind !== 'critique' || c.n !== 1) return undefined
      // 第 2 轮:A 发言时用户插话(A 这次看不到);B 发言时点暂停
      if (c.seat === 'A') reg1.get(id)!.interject('X-INTERJECT')
      if (c.seat === 'B') reg1.get(id)!.pause()
      return undefined
    })
    reg1 = w.registry()
    id = reg1.start(ws, 's1', cfg(['A', 'B', 'C'], 3))
    await untilStatus(() => reg1.get(id)?.state, 'paused')
    expect(w.stored(id)).toMatchObject({ state: { round: 2 }, phase: 'critique', spokenThisRound: ['A', 'B'] })

    restarted = true
    const reg2 = w.registry()
    reg2.restore(ws)
    const eng = reg2.get(id)!
    expect(eng.state).toMatchObject({ status: 'paused', round: 2 })
    const before = w.calls.length
    void eng.resume()
    await untilStatus(() => eng.state, 'done')

    const after = w.calls.slice(before)
    expect(after[0]).toMatchObject({ seat: 'C', kind: 'critique', n: 1 })
    expect(after[0].prompt).toContain('X-INTERJECT')
    expect(after[0].prompt).toContain('A-critique-1')
    expect(after[0].prompt).toContain('B-critique-1')
    // 材料在恢复后重新取了一遍(席位不能续原生会话 → 重带材料)
    expect(after[0].prompt).toContain('MATERIALS-TEXT')
    expect(after.filter(c => c.kind === 'critique' && c.n === 1).map(c => c.seat)).toEqual(['C'])

    const round3 = (s: string) => w.calls.find(c => c.seat === s && c.kind === 'critique' && c.n === 2)!.prompt
    expect(round3('A')).toContain('X-INTERJECT')
    expect(round3('B')).not.toContain('X-INTERJECT')
    expect(round3('C')).not.toContain('X-INTERJECT')
    expect(unique(w.messageIds('s1'))).toBe(true)
  })

  it('leader message ids after restart do not clash with ids written before it', async () => {
    const w = world(ws)
    let leaderOk = false
    w.setScript(c => (c.kind === 'summary' && !leaderOk ? { ok: false } : undefined))
    const reg1 = w.registry()
    const id = reg1.start(ws, 's1', cfg(['A', 'B'], 2))
    await untilStatus(() => reg1.get(id)?.state, 'paused')
    void reg1.get(id)!.resume()
    await vi.waitFor(() => expect(w.calls.filter(c => c.kind === 'summary')).toHaveLength(4), { timeout: 2000, interval: 2 })
    await untilStatus(() => reg1.get(id)?.state, 'paused')
    expect(w.messageIds('s1')).toContain(`${id}:1:L:summary:r1:retry`)

    leaderOk = true
    const reg2 = w.registry()
    reg2.restore(ws)
    const eng = reg2.get(id)!
    void eng.resume()
    await untilStatus(() => eng.state, 'done')
    expect(unique(w.messageIds('s1'))).toBe(true)
    expect(w.messageIds('s1')).toContain(`${id}:1:L:summary:r2`)
  })

  it('suspend then resume in the same process does not duplicate messages', async () => {
    const w = world(ws)
    let quitting = true
    w.setScript(c => (quitting && c.seat === 'B' ? 'hang' : undefined))
    const reg = w.registry()
    const id = reg.start(ws, 's1', cfg(['A', 'B'], 2))
    await vi.waitFor(() => expect(w.messageIds('s1')).toContain(`${id}:1:A:answer`), { timeout: 2000, interval: 2 })
    reg.shutdown()
    await tick()
    quitting = false
    const eng = reg.get(id)!
    void eng.resume()
    await untilStatus(() => eng.state, 'done')
    expect(unique(w.messageIds('s1'))).toBe(true)
    expect(w.calls.filter(c => c.kind === 'answer').map(c => c.seat)).toEqual(['A', 'B', 'B'])
  })

  it('shutdown cancels running seats and persists paused', async () => {
    const w = world(ws)
    let quitting = true
    // A 已经答完(写进了会话),B 还在说
    w.setScript(c => (quitting && c.seat === 'B' ? 'hang' : undefined))
    const reg1 = w.registry()
    const id = reg1.start(ws, 's1', cfg(['A', 'B'], 2))
    await vi.waitFor(() => expect(w.messageIds('s1')).toContain(`${id}:1:A:answer`), { timeout: 2000, interval: 2 })

    reg1.shutdown()
    expect(w.cancelled).toEqual(['B'])
    expect(reg1.get(id)!.state).toMatchObject({ status: 'paused', speaking: [] })
    expect(w.stored(id)).toMatchObject({ state: { status: 'paused' }, phase: 'answer' })
    // 被取消的第 1 轮不能把进度推到总结
    await tick()
    expect(w.stored(id)).toMatchObject({ state: { status: 'paused' }, phase: 'answer', transcript: { items: [] } })
    expect(reg1.get(id)!.snapshot()).toMatchObject({ state: { status: 'paused' }, phase: 'answer' })
    expect(w.calls).toHaveLength(2)

    quitting = false
    const reg2 = w.registry()
    reg2.restore(ws)
    const eng = reg2.get(id)!
    void eng.resume()
    await untilStatus(() => eng.state, 'done')
    expect(unique(w.messageIds('s1'))).toBe(true)
    expect(w.calls.filter(c => c.kind === 'answer').map(c => c.seat)).toEqual(['A', 'B', 'B'])
    const answers = w.stored(id).transcript.items.filter(u => u.stage === 'answer')
    expect(answers.map(u => u.seat)).toEqual(['A', 'B'])
  })
  it('restore: one council that fails to load is logged and skipped, the others still come back', async () => {
    const w = world(ws)
    const reg1 = w.registry()
    w.setScript(() => 'hang')
    const a = reg1.start(ws, 's1', cfg(['A', 'B']))
    const b = reg1.start(ws, 's2', cfg(['A', 'B']))
    await tick()
    reg1.shutdown()

    const reg2 = new CouncilRegistry((id, ww, sid, c, p) => {
      if (id === a) throw new Error('malformed')
      return w.make(id, ww, sid, c, p)
    })
    expect(() => reg2.restore(ws)).not.toThrow()
    expect(vi.mocked(logError)).toHaveBeenCalledWith('council', expect.stringContaining(a), expect.anything())
    expect(reg2.get(a)).toBeUndefined()
    expect(reg2.get(b)!.state.status).toBe('paused')
  })

  it('hasLive: running / finalizing in the session count, paused and other sessions do not', async () => {
    const w = world(ws)
    w.setScript(() => 'hang')
    const reg = w.registry()
    const id = reg.start(ws, 's1', cfg(['A', 'B']))
    expect(reg.hasLive(ws, 's1')).toBe(true)
    expect(reg.hasLive(ws, 's1', id)).toBe(false)
    expect(reg.hasLive(ws, 's2')).toBe(false)
    reg.shutdown()
    expect(reg.hasLive(ws, 's1')).toBe(false)
  })
})
