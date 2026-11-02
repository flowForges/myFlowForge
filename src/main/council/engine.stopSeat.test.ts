import { describe, it, expect } from 'vitest'
import { CouncilEngine, type EngineDeps, type PersistedCouncil } from './engine'
import { COUNCIL_RESULT_FENCE } from './prompts'
import type { SeatRunCallbacks, SeatRunResult } from './seatRunner'
import type { CouncilConfig, CouncilSeat, CouncilState } from '@shared/council'
import type { ChatMessage } from '@shared/types'

// 单个席位的「停止」:主路径是挂住不出字的席位(10 选 1 卡死整轮)。

const seat = (id: string, provider = 'codex'): CouncilSeat => ({ id, provider, model: `m-${id}`, label: `${provider} · ${id}` })
const LEADER = seat('L', 'claude')
const rounds = (ids: string[], n = 2): CouncilConfig => ({
  topic: '怎么设计缓存', attachments: [], seats: ids.map(i => seat(i)), leader: LEADER,
  mode: { kind: 'rounds', rounds: n }, pauseBetweenRounds: false,
})
const consensus = (ids: string[]): CouncilConfig => ({ ...rounds(ids), mode: { kind: 'consensus', maxRounds: 5, maxMinutes: 30 } })

const FINAL = ['结论', COUNCIL_RESULT_FENCE, JSON.stringify({ conclusion: '用 LRU', candidates: [], disagreements: [] }), '```'].join('\n')

type Kind = 'answer' | 'critique' | 'summary' | 'draft' | 'vote' | 'final'
type Call = { seat: string; prompt: string; n: number; kind: Kind }
// hang = 一直不结束,只有 cancel() 能让它 settle;partial = 挂住之前先吐出来的字
type Reply = { text: string } | { fail: true } | { hang: true; partial?: string; replace?: string; think?: string }
type Script = (c: Call) => Reply | undefined

function kindOf(p: string): Kind {
  if (p.includes('共识结果')) return 'final'
  if (p.includes('请做本轮总结')) return 'summary'
  if (p.includes('请整理一份')) return 'draft'
  if (p.includes('第一个词必须是')) return 'vote'
  if (p.includes('现在是第 1 轮')) return 'answer'
  return 'critique'
}

function harness(c: CouncilConfig, script: Script = () => undefined, over: Partial<EngineDeps> = {}, restored?: PersistedCouncil, seed: ChatMessage[] = []) {
  const calls: Call[] = []
  const appended: ChatMessage[] = [...seed]
  const states: CouncilState[] = []
  const persisted: PersistedCouncil[] = []
  const counts: Record<string, number> = {}
  const cancels: Record<string, number> = {}
  const pending: Record<string, () => void> = {}

  const runSeat: EngineDeps['runSeat'] = (_cid, s, prompt, _deps, cb: SeatRunCallbacks) => {
    counts[s.id] = (counts[s.id] ?? 0) + 1
    const call: Call = { seat: s.id, prompt, n: counts[s.id], kind: kindOf(prompt) }
    calls.push(call)
    const msgId = `inner-${s.id}-${call.n}`
    const reply: Reply = script(call) ?? { text: call.kind === 'final' ? FINAL : `<<${s.id}#${call.n}>>` }
    cb.onStart(msgId)
    let settle!: (r: SeatRunResult) => void
    const done = new Promise<SeatRunResult>(r => { settle = r })
    if ('hang' in reply) {
      if (reply.think) cb.onThink(msgId, reply.think)
      if (reply.partial) cb.onDelta(msgId, reply.partial)
      if (reply.replace) cb.onReplace(msgId, reply.replace)
      pending[s.id] = () => settle({ ok: true, msgId, text: reply.partial ?? '' })
    } else {
      setTimeout(() => {
        if ('fail' in reply) return settle({ ok: false, msgId, error: 'boom' })
        cb.onDelta(msgId, reply.text)
        settle({ ok: true, msgId, text: reply.text })
      }, 1)
    }
    return {
      done,
      cancel: () => { cancels[s.id] = (cancels[s.id] ?? 0) + 1; settle({ ok: false, msgId, error: 'cancelled' }) },
      resumed: false,
    }
  }

  const deps: EngineDeps = {
    runSeat,
    seatDeps: { providers: {}, env: {} },
    seatResumed: () => false,
    append: (_ws, _sid, m) => appended.push(m),
    readMessages: () => [...appended],
    emitChat: () => {},
    emitState: s => states.push(s),
    materialsText: async () => '',
    writeFile: () => {},
    persist: p => persisted.push(p),
    now: () => 1000,
    ...over,
  }
  const engine = new CouncilEngine('c1', '/tmp/ws', 's1', c, deps, restored)
  const stage = (id: string) => appended.find(m => m.id === id)?.council
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 400 && !ok(); i++) await new Promise(r => setTimeout(r, 1))
    expect(ok()).toBe(true)
  }
  return { engine, calls, appended, states, persisted, cancels, pending, stage, until, deps }
}

const seq = (h: { calls: Call[] }) => h.calls.map(c => `${c.seat}:${c.kind}`)
const speaking = (h: { engine: CouncilEngine }, id: string) => h.engine.state.speaking.includes(id)

describe('stopSeat: the stuck seat', () => {
  it('a seat hanging with no output is stopped: recorded as stopped, not an error; the round and the next one carry on', async () => {
    const h = harness(rounds(['A', 'B', 'C']), c => (c.seat === 'B' && c.kind === 'answer' ? { hang: true } : undefined))
    const run = h.engine.start()
    await h.until(() => speaking(h, 'B') && h.appended.filter(m => m.council?.stage === 'answer').length === 2)
    expect(h.engine.state.status).toBe('running')

    expect(h.engine.stopSeat('B')).toBe(true)
    await run

    expect(h.cancels).toEqual({ B: 1 })
    expect(h.stage('c1:1:B:answer')).toMatchObject({ stage: 'failed', stopped: true, seat: 'B', round: 1 })
    expect(h.engine.state.status).toBe('done')
    expect(h.engine.state.dropped).toEqual([])
    expect(h.persisted.at(-1)!.failures.B ?? 0).toBe(0)
    // ★只停这一轮:下一轮照常发言
    expect(seq(h)).toEqual(['A:answer', 'B:answer', 'C:answer', 'L:summary', 'A:critique', 'B:critique', 'C:critique', 'L:final'])
    // 总结里没有他
    const summary = h.calls.find(c => c.kind === 'summary')!.prompt
    expect(summary).toContain('<<A#1>>')
    expect(summary).not.toContain('codex · B')
  })

  it('the other seats keep running: stop neither ends the batch nor touches them', async () => {
    const h = harness(rounds(['A', 'B'], 1), () => ({ hang: true, partial: '半句' }))
    const run = h.engine.start()
    await h.until(() => speaking(h, 'A') && speaking(h, 'B'))

    h.engine.stopSeat('A')
    await h.until(() => !speaking(h, 'A'))
    expect(h.cancels).toEqual({ A: 1 })
    expect(speaking(h, 'B')).toBe(true)
    expect(h.calls.some(c => c.seat === 'L')).toBe(false)

    h.pending.B()
    await h.until(() => h.calls.some(c => c.seat === 'L'))
    h.pending.L()
    await run
    expect(h.engine.state.status).not.toBe('running')
  })

  it('partial output is kept and marked; everyone downstream can tell it is incomplete', async () => {
    const h = harness(rounds(['A', 'B', 'C']), c => (c.seat === 'A' && c.kind === 'answer' ? { hang: true, partial: '写到一半', think: '想了想' } : undefined))
    const run = h.engine.start()
    await h.until(() => speaking(h, 'A') && !speaking(h, 'B') && !speaking(h, 'C'))
    h.engine.stopSeat('A')
    await run

    const msg = h.appended.find(m => m.id === 'c1:1:A:answer')!
    expect(msg.text).toBe('写到一半')
    expect(msg.council).toMatchObject({ stage: 'answer', stopped: true })
    expect(msg.think?.steps).toEqual(['想了想'])
    const u = h.persisted.at(-1)!.transcript.items.find(i => i.seat === 'A' && i.round === 1)!
    expect(u).toMatchObject({ text: '写到一半', stopped: true })
    const summary = h.calls.find(c => c.kind === 'summary')!.prompt
    expect(summary).toContain('写到一半')
    expect(summary).toContain('被用户中止')
    // 完整发言不带这个标记
    expect(summary).not.toMatch(/codex · B[^】]*中止/)
    expect(h.persisted.at(-1)!.failures.A ?? 0).toBe(0)
  })

  it('a replaced stream keeps the replacement as the partial, whitespace-only counts as no output', async () => {
    const h = harness(rounds(['A', 'B', 'C'], 1), c => (
      c.seat === 'A' ? { hang: true, partial: '旧', replace: '新' } : c.seat === 'B' ? { hang: true, partial: ' \n ' } : undefined))
    const run = h.engine.start()
    await h.until(() => speaking(h, 'A') && speaking(h, 'B') && !speaking(h, 'C'))
    h.engine.stopSeat('A')
    h.engine.stopSeat('B')
    await run
    expect(h.appended.find(m => m.id === 'c1:1:A:answer')!.text).toBe('新')
    expect(h.stage('c1:1:B:answer')).toMatchObject({ stage: 'failed', stopped: true })
    expect(h.appended.find(m => m.id === 'c1:1:B:answer')!.text).toBe('')
  })

  it('stopping in a later round moves on to the next seat and does not rerun the stopped one on resume', async () => {
    const h = harness(rounds(['A', 'B', 'C'], 3), c => (c.seat === 'B' && c.kind === 'critique' && c.n === 2 ? { hang: true } : undefined))
    const run = h.engine.start()
    await h.until(() => h.calls.some(c => c.seat === 'B' && c.kind === 'critique'))
    await new Promise(r => setTimeout(r, 2))
    h.engine.stopSeat('B')
    await run
    expect(seq(h).slice(4, 9)).toEqual(['A:critique', 'B:critique', 'C:critique', 'L:summary', 'A:critique'])
    expect(h.engine.state.status).toBe('done')
    // 第 3 轮 B 还在(只要他这轮没被除名)
    expect(h.calls.filter(c => c.seat === 'B' && c.kind === 'critique')).toHaveLength(2)
  })

  it('stops never count towards retiring a seat, however many in a row', async () => {
    const h = harness(rounds(['A', 'B'], 3), c => (c.seat === 'A' && c.kind !== 'summary' ? { hang: true } : undefined))
    const run = h.engine.start()
    for (const n of [1, 2, 3]) {
      await h.until(() => speaking(h, 'A') && h.calls.filter(c => c.seat === 'A').length === n)
      await new Promise(r => setTimeout(r, 2))
      h.engine.stopSeat('A')
    }
    await run
    expect(h.engine.state.dropped).toEqual([])
    expect(h.calls.filter(c => c.seat === 'A')).toHaveLength(3)
    expect(h.calls.filter(c => c.seat === 'B' && c.kind === 'critique')).toHaveLength(2)
  })

  it('every seat stopped with nothing said: no summary of nothing; waits for the user, next round re-briefs them', async () => {
    const h = harness(rounds(['A', 'B'], 3), c => (c.kind === 'answer' ? { hang: true } : undefined), { seatResumed: () => true })
    const run = h.engine.start()
    await h.until(() => speaking(h, 'A') && speaking(h, 'B'))
    h.engine.stopSeat('A')
    h.engine.stopSeat('B')
    await run

    expect(h.calls.some(c => c.kind === 'summary')).toBe(false)
    expect(h.engine.state).toMatchObject({ status: 'paused', waitingForUser: true, round: 2 })
    const again = h.engine.resume()
    await h.until(() => h.calls.some(c => c.kind === 'critique'))
    // ★被停的那一轮提示词可能根本没送到:续上原生会话也得重带议题
    expect(h.calls.find(c => c.kind === 'critique')!.prompt).toContain('## 议题')
    await again
    expect(h.engine.state.status).toBe('done')
  })

  it('a stopped seat that already finished a turn is still treated as resumed', async () => {
    const h = harness(rounds(['A', 'B'], 3), c => (c.seat === 'A' && c.kind === 'critique' && c.n === 2 ? { hang: true } : undefined), { seatResumed: () => true })
    const run = h.engine.start()
    await h.until(() => speaking(h, 'A') && h.calls.filter(c => c.seat === 'A').length === 2)
    await new Promise(r => setTimeout(r, 2))
    h.engine.stopSeat('A')
    await run
    const third = h.calls.filter(c => c.seat === 'A')[2]
    expect(third.prompt).not.toContain('## 议题')
  })
})

describe('stopSeat: races and no-ops', () => {
  it('seat finishes on its own just as stop arrives: treated as finished, not stopped', async () => {
    const h = harness(rounds(['A', 'B'], 1), c => (c.seat === 'A' ? { hang: true, partial: '全部' } : undefined))
    const run = h.engine.start()
    await h.until(() => speaking(h, 'A') && !speaking(h, 'B'))
    // 同一拍:完成先到(done 已 resolve,speak 的 await 还没轮到),停止紧跟着来
    h.pending.A()
    h.engine.stopSeat('A')
    await run
    expect(h.appended.find(m => m.id === 'c1:1:A:answer')!.council).toMatchObject({ stage: 'answer' })
    expect(h.appended.find(m => m.id === 'c1:1:A:answer')!.council!.stopped).toBeUndefined()
    expect(h.persisted.at(-1)!.transcript.items.find(i => i.seat === 'A')!.stopped).toBeUndefined()
  })

  it('stop after the seat already finished is a no-op', async () => {
    const h = harness(rounds(['A', 'B'], 1), c => (c.seat === 'B' ? { hang: true } : undefined))
    const run = h.engine.start()
    await h.until(() => speaking(h, 'B') && !speaking(h, 'A'))
    expect(h.engine.stopSeat('A')).toBe(false)
    expect(h.cancels.A).toBeUndefined()
    h.engine.stopSeat('B')
    await run
    expect(h.appended.find(m => m.id === 'c1:1:A:answer')!.council!.stopped).toBeUndefined()
  })

  it('double stop kills once and writes one message', async () => {
    const h = harness(rounds(['A', 'B'], 1), c => (c.seat === 'A' ? { hang: true } : undefined))
    const run = h.engine.start()
    await h.until(() => speaking(h, 'A') && !speaking(h, 'B'))
    expect(h.engine.stopSeat('A')).toBe(true)
    expect(h.engine.stopSeat('A')).toBe(false)
    await run
    expect(h.engine.stopSeat('A')).toBe(false)
    expect(h.cancels.A).toBe(1)
    expect(h.appended.filter(m => m.id === 'c1:1:A:answer')).toHaveLength(1)
  })

  it('unknown seat: no-op', async () => {
    const h = harness(rounds(['A', 'B'], 1), c => (c.seat === 'A' ? { hang: true } : undefined))
    const run = h.engine.start()
    await h.until(() => speaking(h, 'A'))
    expect(h.engine.stopSeat('nobody')).toBe(false)
    expect(h.cancels).toEqual({})
    h.engine.stop('abort')
    await run
  })

  it('a pending pause still takes effect once the stopped batch ends', async () => {
    const h = harness(rounds(['A', 'B'], 2), c => (c.seat === 'A' && c.kind === 'answer' ? { hang: true } : undefined))
    const run = h.engine.start()
    await h.until(() => speaking(h, 'A') && !speaking(h, 'B'))
    h.engine.pause()
    expect(h.engine.state.status).toBe('running')
    expect(h.engine.stopSeat('A')).toBe(true)
    await run
    expect(h.engine.state.status).toBe('paused')
    expect(h.calls.some(c => c.kind === 'summary')).toBe(false)
    const again = h.engine.resume()
    await again
    expect(h.engine.state.status).toBe('done')
    expect(h.calls.filter(c => c.seat === 'A' && c.kind === 'answer')).toHaveLength(1)
  })

  it('while paused between rounds: nothing is running, no-op', async () => {
    const h = harness({ ...rounds(['A', 'B']), pauseBetweenRounds: true })
    await h.engine.start()
    expect(h.engine.state).toMatchObject({ status: 'paused', waitingForUser: true })
    expect(h.engine.stopSeat('A')).toBe(false)
    expect(h.engine.state.status).toBe('paused')
    expect(h.cancels).toEqual({})
  })

  it('after abort: already cancelled, no stopped message, stays aborted', async () => {
    const h = harness(rounds(['A', 'B'], 1), () => ({ hang: true, partial: '半句' }))
    const run = h.engine.start()
    await h.until(() => speaking(h, 'A') && speaking(h, 'B'))
    h.engine.stop('abort')
    expect(h.engine.stopSeat('A')).toBe(false)
    await run
    expect(h.engine.state.status).toBe('aborted')
    expect(h.cancels).toEqual({ A: 1, B: 1 })
    expect(h.appended.some(m => m.council?.stopped)).toBe(false)
  })

  it('while the whole council is finalizing: refused for the leader too (结束 aborts)', async () => {
    const h = harness(rounds(['A', 'B'], 1), c => (c.kind === 'final' ? { hang: true } : undefined))
    const run = h.engine.start()
    await h.until(() => h.engine.state.status === 'finalizing' && speaking(h, 'L'))
    expect(h.engine.stopSeat('L')).toBe(false)
    expect(h.engine.stopSeat('A')).toBe(false)
    expect(h.cancels).toEqual({})
    h.engine.stop('abort')
    await run
    expect(h.engine.state.status).toBe('aborted')
  })

  it('finalize requested mid-batch: the cancelled seats cannot be stopped any more', async () => {
    const h = harness(rounds(['A', 'B'], 2), c => (c.kind === 'answer' ? { hang: true, partial: '半句' } : undefined))
    const run = h.engine.start()
    await h.until(() => speaking(h, 'A') && speaking(h, 'B'))
    h.engine.stop('finalize')
    expect(h.engine.stopSeat('A')).toBe(false)
    await run
    expect(h.engine.state.status).toBe('done')
    expect(h.appended.some(m => m.council?.stopped)).toBe(false)
  })

  it('after done (including a follow-up in flight): no-op; a follow-up is not a round', async () => {
    const h = harness(rounds(['A', 'B'], 1), c => (c.kind === 'critique' ? { hang: true } : undefined))
    await h.engine.start()
    expect(h.engine.state.status).toBe('done')
    expect(h.engine.stopSeat('A')).toBe(false)
    const fu = h.engine.followup('再问一句', 'A')
    await h.until(() => speaking(h, 'A'))
    expect(h.engine.stopSeat('A')).toBe(false)
    expect(h.cancels).toEqual({})
    h.pending.A()
    await fu
  })

  it('suspended (app quitting) batch: stop is refused', async () => {
    const h = harness(rounds(['A', 'B'], 1), () => ({ hang: true }))
    const run = h.engine.start()
    await h.until(() => speaking(h, 'A') && speaking(h, 'B'))
    h.engine.suspend()
    expect(h.engine.stopSeat('A')).toBe(false)
    await run
    expect(h.appended.some(m => m.council?.stopped)).toBe(false)
  })
})

describe('stopSeat: the leader', () => {
  it('stopping the leader mid-summary does not retry: pauses like a leader failure, partial is not a summary, can swap leaders', async () => {
    const h = harness(rounds(['A', 'B']), c => (c.seat === 'L' && c.kind === 'summary' ? { hang: true, partial: '总结了一半' } : undefined))
    const run = h.engine.start()
    await h.until(() => speaking(h, 'L'))
    expect(h.engine.stopSeat('L')).toBe(true)
    await run

    expect(h.engine.state.status).toBe('paused')
    expect(h.engine.state.waitingForUser).toBeUndefined()
    expect(h.calls.filter(c => c.seat === 'L')).toHaveLength(1)
    const msg = h.appended.find(m => m.id === 'c1:1:L:summary')!
    expect(msg.text).toBe('总结了一半')
    expect(msg.council).toMatchObject({ stage: 'failed', stopped: true })
    expect(h.persisted.at(-1)!.transcript.items.some(u => u.stage === 'summary')).toBe(false)

    const other = seat('L2', 'gemini')
    await h.engine.resume(other)
    expect(h.calls.filter(c => c.seat === 'L2').map(c => c.kind)).toEqual(['summary', 'final'])
    expect(h.engine.state.status).toBe('done')
  })
})

describe('stopSeat: consensus votes', () => {
  const script = (stoppedText?: string, others = '同意 可以'): Script => c => {
    if (c.kind !== 'vote') return undefined
    if (c.seat === 'A') return { hang: true, partial: stoppedText }
    return { text: others }
  }
  const atVote = (h: ReturnType<typeof harness>) => h.until(() => speaking(h, 'A') && h.calls.filter(c => c.kind === 'vote').length === 3 && !speaking(h, 'B') && !speaking(h, 'C'))

  it('a stopped voter is absent: everyone else agreeing is agreement', async () => {
    const h = harness(consensus(['A', 'B', 'C']), script())
    const run = h.engine.start()
    await atVote(h)
    h.engine.stopSeat('A')
    await run
    expect(h.engine.state).toMatchObject({ status: 'paused', waitingForUser: true, round: 2 })
    expect(h.stage('c1:1:A:consensus-vote')).toMatchObject({ stage: 'failed', stopped: true })
    expect(h.engine.state.dropped).toEqual([])
    expect(h.persisted.at(-1)!.failures.A ?? 0).toBe(0)
  })

  it.each([['同意,但是'], ['不同意,因为']])('a half-written vote %s is kept in chat but neither counts nor becomes an objection', async (partial) => {
    const h = harness(consensus(['A', 'B', 'C']), script(partial))
    const run = h.engine.start()
    await atVote(h)
    h.engine.stopSeat('A')
    await run
    const msg = h.appended.find(m => m.id === 'c1:1:A:consensus-vote')!
    expect(msg.text).toBe(partial)
    expect(msg.council).toMatchObject({ stage: 'consensus-vote', stopped: true })
    expect(h.engine.state.waitingForUser).toBe(true)
    expect(h.persisted.at(-1)!.transcript.items.some(u => u.seat === 'A' && u.stage === 'consensus-vote')).toBe(false)

    // 被停的半张票不会变成「未能达成共识的点」
    h.engine.stop('finalize')
    await h.until(() => h.engine.state.status === 'done')
    const final = h.calls.find(c => c.kind === 'final')!.prompt
    expect(final).not.toContain('未能达成共识的点')
  })

  it('a dissenting vote that did finish still blocks agreement', async () => {
    const h = harness(consensus(['A', 'B', 'C']), script(undefined, '不同意 漏了'))
    const run = h.engine.start()
    await atVote(h)
    h.engine.stopSeat('A')
    await h.until(() => h.calls.some(c => c.kind === 'critique'))
    expect(h.engine.state.status).toBe('running')
    expect(h.engine.state.waitingForUser).toBeUndefined()
    h.engine.stop('abort')
    await run
  })

  it('every voter stopped is not agreement', async () => {
    const h = harness(consensus(['A', 'B']), c => (c.kind === 'vote' ? { hang: true } : undefined))
    const run = h.engine.start()
    await h.until(() => speaking(h, 'A') && speaking(h, 'B') && h.calls.some(c => c.kind === 'vote'))
    h.engine.stopSeat('A')
    h.engine.stopSeat('B')
    await h.until(() => h.calls.some(c => c.kind === 'critique'))
    expect(h.engine.state.waitingForUser).toBeUndefined()
    h.engine.stop('abort')
    await run
  })
})

describe('stopSeat: restart', () => {
  async function stoppedThenCrash(c: CouncilConfig, reach: (h: ReturnType<typeof harness>) => Promise<void>, script: Script, seatId: string) {
    const h = harness(c, script)
    const run = h.engine.start()
    await reach(h)
    h.engine.stopSeat(seatId)
    await h.until(() => !speaking(h, seatId))
    // 模拟崩溃:这一刻的落盘 + 已写进会话的消息;同批还有人在挂着,这批没记账
    const snap = JSON.parse(JSON.stringify(h.persisted.at(-1)!)) as PersistedCouncil
    const msgs = [...h.appended]
    h.engine.stop('abort')
    await run
    return { snap, msgs }
  }

  it('a batch interrupted after a stop: resuming does not rerun the stopped seat, keeps partial and its mark', async () => {
    const { snap, msgs } = await stoppedThenCrash(
      rounds(['A', 'B'], 1),
      h => h.until(() => speaking(h, 'A') && speaking(h, 'B')),
      c => (c.kind === 'answer' ? { hang: true, partial: `${c.seat}写到一半` } : undefined),
      'A',
    )
    expect(snap.state.status).toBe('running')
    const h2 = harness(rounds(['A', 'B'], 1), undefined, {}, snap, msgs)
    expect(h2.engine.state.status).toBe('paused')
    await h2.engine.resume()
    expect(h2.calls.map(c => `${c.seat}:${c.kind}`)).toEqual(['B:answer', 'L:final'])
    expect(h2.persisted.at(-1)!.transcript.items.find(u => u.seat === 'A')).toMatchObject({ text: 'A写到一半', stopped: true })
    expect(h2.persisted.at(-1)!.failures.A ?? 0).toBe(0)
    expect(h2.appended.filter(m => m.id === 'c1:1:A:answer')).toHaveLength(1)
    expect(h2.calls.at(-1)!.prompt).toContain('被用户中止')
  })

  it('a stopped vote survives a restart as an abstention, not as a vote', async () => {
    const { snap, msgs } = await stoppedThenCrash(
      consensus(['A', 'B', 'C']),
      h => h.until(() => h.calls.filter(c => c.kind === 'vote').length === 3 && speaking(h, 'A') && speaking(h, 'B')),
      c => (c.kind === 'vote' ? { hang: true, partial: c.seat === 'A' ? '不同意,因为' : '同意 行' } : undefined),
      'A',
    )
    const h2 = harness(consensus(['A', 'B', 'C']), c => (c.kind === 'vote' ? { text: '同意 行' } : undefined), {}, snap, msgs)
    await h2.engine.resume()
    expect(h2.calls.some(c => c.seat === 'A')).toBe(false)
    expect(h2.engine.state).toMatchObject({ status: 'paused', waitingForUser: true })
    expect(h2.persisted.at(-1)!.transcript.items.some(u => u.seat === 'A' && u.stage === 'consensus-vote')).toBe(false)
  })

  it('a no-output stop survives a restart and is still not a failure', async () => {
    const { snap, msgs } = await stoppedThenCrash(
      rounds(['A', 'B'], 1),
      h => h.until(() => speaking(h, 'A') && speaking(h, 'B')),
      c => (c.kind === 'answer' ? { hang: true } : undefined),
      'A',
    )
    const h2 = harness(rounds(['A', 'B'], 1), undefined, {}, snap, msgs)
    await h2.engine.resume()
    expect(h2.calls.some(c => c.seat === 'A')).toBe(false)
    expect(h2.persisted.at(-1)!.failures.A ?? 0).toBe(0)
  })

  it('a snapshot from before this feature still restores', async () => {
    const h = harness(rounds(['A', 'B'], 2), c => (c.kind === 'summary' ? { hang: true } : undefined))
    const run = h.engine.start()
    await h.until(() => speaking(h, 'L'))
    const snap = JSON.parse(JSON.stringify(h.persisted.at(-1)!)) as PersistedCouncil
    const msgs = [...h.appended]
    expect(JSON.stringify(snap)).not.toContain('stopped')
    h.engine.stop('abort')
    await run
    const h2 = harness(rounds(['A', 'B'], 2), undefined, {}, snap, msgs)
    await h2.engine.resume()
    expect(h2.engine.state.status).toBe('done')
  })
})
