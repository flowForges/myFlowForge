import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KernelEvent } from '../protocol/index'
import { Approvals } from './approvals'
import { sessionKey } from '../lib/tools/commandKey'

type Ev = Omit<KernelEvent, 'seq' | 'ts'>
let events: Ev[]
let approvals: Approvals
beforeEach(() => {
  vi.useFakeTimers()
  events = []
  approvals = new Approvals({ append: e => { events.push(e) }, timeoutMs: 50 })
})
afterEach(() => { vi.useRealTimers() })

const base = { sessionId: 's1', turnId: 't1', callId: 'c1', tool: 'shell' }
const ask = (summary: string, extra: { key?: string; signal?: AbortSignal; sessionId?: string; unsandboxed?: boolean } = {}) =>
  approvals.request({ ...base, summary, signal: new AbortController().signal, ...extra })
const requested = () => events.filter(e => e.type === 'approval.requested')
const resolved = () => events.filter(e => e.type === 'approval.resolved').map(e => e.payload as Record<string, unknown>)
const lastId = () => (requested().at(-1)!.payload as { approvalId: string }).approvalId

describe('Approvals', () => {
  it('allow: requested → respond allow → resolved by user; no timer left', async () => {
    const p = ask('npm test')
    expect(requested()).toHaveLength(1)
    const ev = requested()[0]
    expect(ev.sessionId).toBe('s1')
    expect(ev.payload).toEqual({ approvalId: expect.any(String), turnId: 't1', callId: 'c1', tool: 'shell', summary: 'npm test' })
    expect(vi.getTimerCount()).toBe(1)
    expect(approvals.respond(lastId(), 'allow')).toBe(true)
    await expect(p).resolves.toBe('allow')
    expect(resolved()).toEqual([expect.objectContaining({ approvalId: lastId(), decision: 'allow', by: 'user' })])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('key: shown when there is one, capped, redacted; no key when none', async () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz012345'
    const p = ask('x', { key: `run ${secret} ${'y'.repeat(5000)}` })
    const shown = (requested()[0].payload as { key: string }).key
    expect(shown.length).toBeLessThanOrEqual(200)
    expect(shown).not.toContain(secret)
    approvals.respond(lastId(), 'allow_session')
    await p
    // 判定用的是原值:同一个键下次不问
    await expect(ask('x', { key: `run ${secret} ${'y'.repeat(5000)}` })).resolves.toBe('allow')
    expect(requested()).toHaveLength(1)
  })

  it('via is written when the caller gives it, and only then', async () => {
    const a = ask('x')
    approvals.respond(lastId(), 'allow', 'telegram:42')
    await a
    expect(resolved()[0]).toMatchObject({ decision: 'allow', by: 'user', via: 'telegram:42' })
    const b = ask('y')
    approvals.respond(lastId(), 'deny')
    await b
    expect(Object.hasOwn(resolved()[1], 'via')).toBe(false)
    expect(Object.keys(resolved()[1]).sort()).toEqual(['approvalId', 'by', 'callId', 'decision', 'turnId'])
  })

  it('via is not written on what the user did not answer: timeout, cancel, session', async () => {
    const t = ask('x')
    vi.advanceTimersByTime(60)
    await t
    const c = new AbortController()
    const p = ask('y', { signal: c.signal })
    c.abort()
    await p
    expect(resolved().map(r => r.by)).toEqual(['timeout', 'cancel'])
    for (const r of resolved()) expect(Object.hasOwn(r, 'via')).toBe(false)
  })

  it('deny', async () => {
    const p = ask('rm -rf build')
    expect(approvals.respond(lastId(), 'deny')).toBe(true)
    await expect(p).resolves.toBe('deny')
    expect(resolved()).toEqual([expect.objectContaining({ decision: 'deny', by: 'user' })])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('respond on an unknown or finished id → false, no second resolved', async () => {
    expect(approvals.respond('nope', 'allow')).toBe(false)
    const p = ask('ls')
    const id = lastId()
    expect(approvals.respond(id, 'deny')).toBe(true)
    await p
    expect(approvals.respond(id, 'allow')).toBe(false)
    expect(resolved()).toHaveLength(1)
  })

  it('timeout → deny by timeout; respond afterwards is false', async () => {
    const p = ask('npm test')
    vi.advanceTimersByTime(49)
    expect(resolved()).toHaveLength(0)
    vi.advanceTimersByTime(1)
    await expect(p).resolves.toBe('deny')
    expect(resolved()).toEqual([expect.objectContaining({ decision: 'deny', by: 'timeout' })])
    expect(approvals.respond(lastId(), 'allow')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('abort while waiting → deny by cancel; the timer and listener are gone', async () => {
    const ac = new AbortController()
    const removeSpy = vi.spyOn(ac.signal, 'removeEventListener')
    const p = ask('npm test', { signal: ac.signal })
    ac.abort()
    await expect(p).resolves.toBe('deny')
    expect(resolved()).toEqual([expect.objectContaining({ decision: 'deny', by: 'cancel' })])
    expect(vi.getTimerCount()).toBe(0)
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(approvals.respond(lastId(), 'allow')).toBe(false)
  })

  it('a user answer removes the abort listener too', async () => {
    const ac = new AbortController()
    const removeSpy = vi.spyOn(ac.signal, 'removeEventListener')
    const p = ask('npm test', { signal: ac.signal })
    approvals.respond(lastId(), 'allow')
    await p
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function))
    ac.abort()
    expect(resolved()).toHaveLength(1)
  })

  it('an already-aborted signal → deny by cancel without asking', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(ask('npm test', { signal: ac.signal, key: 'npm test' })).resolves.toBe('deny')
    expect(requested()).toHaveLength(0)
    expect(resolved()).toEqual([expect.objectContaining({ decision: 'deny', by: 'cancel' })])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancelAll denies every pending request by cancel, and later requests too', async () => {
    const a = ask('npm test')
    const b = ask('npm publish', { sessionId: 's2' })
    approvals.cancelAll()
    await expect(a).resolves.toBe('deny')
    await expect(b).resolves.toBe('deny')
    expect(resolved().map(r => r.by)).toEqual(['cancel', 'cancel'])
    expect(vi.getTimerCount()).toBe(0)
    await expect(ask('ls')).resolves.toBe('deny')
    expect(requested()).toHaveLength(2)
  })

  it('allow_session for `npm test` auto-allows `npm test -- -t x`, still asks for `npm publish` and `npm test && rm -rf x`', async () => {
    const first = ask('npm test', { key: sessionKey('npm test') })
    approvals.respond(lastId(), 'allow_session')
    await expect(first).resolves.toBe('allow')
    expect(resolved().at(-1)).toMatchObject({ decision: 'allow', by: 'user' })

    events = []
    await expect(ask('npm test -- -t x', { key: sessionKey('npm test -- -t x') })).resolves.toBe('allow')
    expect(requested()).toHaveLength(0)
    expect(resolved()).toEqual([expect.objectContaining({ decision: 'allow', by: 'session' })])
    expect(vi.getTimerCount()).toBe(0)

    events = []
    const publish = ask('npm publish', { key: sessionKey('npm publish') })
    expect(requested()).toHaveLength(1)
    approvals.respond(lastId(), 'deny')
    await expect(publish).resolves.toBe('deny')

    events = []
    const chained = ask('npm test && rm -rf x', { key: sessionKey('npm test && rm -rf x') })
    expect(requested()).toHaveLength(1)
    approvals.respond(lastId(), 'deny')
    await expect(chained).resolves.toBe('deny')
  })

  it('M2: an allow_session key granted inside the sandbox asks again when the run would be unsandboxed', async () => {
    const key = sessionKey('npm test')
    const first = ask('npm test', { key }) // 授予时有沙箱
    approvals.respond(lastId(), 'allow_session')
    await first
    events = []
    await expect(ask('npm test', { key })).resolves.toBe('allow') // 仍有沙箱:自动放行
    expect(requested()).toHaveLength(0)
    const p = ask('npm test', { key, unsandboxed: true }) // 现在无沙箱:再问
    expect(requested()).toHaveLength(1)
    approvals.respond(lastId(), 'allow_session') // 在无沙箱下授予
    await p
    events = []
    await expect(ask('npm test', { key, unsandboxed: true })).resolves.toBe('allow')
    await expect(ask('npm test', { key })).resolves.toBe('allow')
    expect(requested()).toHaveLength(0)
  })

  it('M2: a key granted unsandboxed auto-allows at none and with a sandbox', async () => {
    const key = sessionKey('make')
    const first = ask('make', { key, unsandboxed: true })
    approvals.respond(lastId(), 'allow_session')
    await first
    events = []
    await expect(ask('make', { key, unsandboxed: true })).resolves.toBe('allow')
    await expect(ask('make', { key })).resolves.toBe('allow')
    expect(requested()).toHaveLength(0)
  })

  it('the allow-set is per session', async () => {
    const first = ask('npm test', { key: 'npm test' })
    approvals.respond(lastId(), 'allow_session')
    await first
    events = []
    const other = ask('npm test', { key: 'npm test', sessionId: 's2' })
    expect(requested()).toHaveLength(1)
    approvals.respond(lastId(), 'deny')
    await expect(other).resolves.toBe('deny')
  })

  it('allow_session without a key allows once and remembers nothing', async () => {
    const first = ask('npm test && echo ok')
    approvals.respond(lastId(), 'allow_session')
    await expect(first).resolves.toBe('allow')
    events = []
    const again = ask('npm test && echo ok')
    expect(requested()).toHaveLength(1)
    approvals.respond(lastId(), 'deny')
    await again
  })

  it('the event summary is the caller\'s string, verbatim', async () => {
    const summary = 'curl -H "Authorization: Bearer ***" https://x'
    const p = ask(summary)
    expect((requested()[0].payload as { summary: string }).summary).toBe(summary)
    approvals.respond(lastId(), 'deny')
    await p
  })

  it('unsandboxed: true goes into the payload; absent / false leaves no field', async () => {
    for (const [extra, want] of [[{ unsandboxed: true }, true], [{ unsandboxed: false }, undefined], [{}, undefined]] as const) {
      const p = ask('ls', extra)
      const payload = requested().at(-1)!.payload as Record<string, unknown>
      if (want) expect(payload.unsandboxed).toBe(true)
      else expect(payload).not.toHaveProperty('unsandboxed')
      approvals.respond(lastId(), 'deny')
      await p
    }
  })

  it('allow_session on `rm -rf build` does not auto-allow `rm -rf ~`', async () => {
    const first = ask('rm -rf build', { key: sessionKey('rm -rf build') })
    approvals.respond(lastId(), 'allow_session')
    await expect(first).resolves.toBe('allow')
    events = []
    const home = ask('rm -rf ~', { key: sessionKey('rm -rf ~') })
    expect(requested()).toHaveLength(1)
    approvals.respond(lastId(), 'deny')
    await expect(home).resolves.toBe('deny')
  })

  it.each([
    ['git status', 'git push --force'],
    ['npm test', 'npm exec rimraf ~'],
    ['npm install', 'npm install evil-pkg'],
    ['git stash', 'git stash clear'],
    ['git diff', 'git diff --output=/Users/x/.zshrc'],
  ])('allow_session on %j still asks for %j', async (allowed, other) => {
    const first = ask(allowed, { key: sessionKey(allowed) })
    approvals.respond(lastId(), 'allow_session')
    await expect(first).resolves.toBe('allow')
    events = []
    const p = ask(other, { key: sessionKey(other) })
    expect(requested()).toHaveLength(1)
    approvals.respond(lastId(), 'deny')
    await expect(p).resolves.toBe('deny')
  })

  it('a listener that answers inside the approval.requested notification is honoured', async () => {
    approvals = new Approvals({
      timeoutMs: 50,
      append: e => {
        events.push(e)
        if (e.type === 'approval.requested') approvals.respond((e.payload as { approvalId: string }).approvalId, 'allow')
      },
    })
    await expect(ask('npm test')).resolves.toBe('allow')
    expect(resolved()).toEqual([expect.objectContaining({ decision: 'allow', by: 'user' })])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('an abort inside the approval.requested notification is honoured', async () => {
    const ac = new AbortController()
    approvals = new Approvals({ timeoutMs: 50, append: e => { events.push(e); if (e.type === 'approval.requested') ac.abort() } })
    await expect(ask('npm test', { signal: ac.signal })).resolves.toBe('deny')
    expect(resolved()).toEqual([expect.objectContaining({ by: 'cancel' })])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a failing approval.requested write rejects and leaves nothing pending', async () => {
    approvals = new Approvals({ timeoutMs: 50, append: e => { if (e.type === 'approval.requested') throw new Error('SQLITE_FULL'); events.push(e) } })
    const ac = new AbortController()
    const removeSpy = vi.spyOn(ac.signal, 'removeEventListener')
    await expect(ask('npm test', { signal: ac.signal })).rejects.toThrow('SQLITE_FULL')
    expect(vi.getTimerCount()).toBe(0)
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(resolved()).toHaveLength(0)
  })

  describe('a failing approval.resolved write', () => {
    const errors: unknown[] = []
    beforeEach(() => {
      errors.length = 0
      approvals = new Approvals({
        timeoutMs: 50,
        log: { info() {}, warn() {}, error: (msg: string) => { errors.push(msg) } },
        append: e => { if (e.type === 'approval.resolved') throw new Error('SQLITE_FULL'); events.push(e) },
      })
    })

    it('cancelAll still settles every pending request and clears every timer', async () => {
      const ps = [ask('a'), ask('b'), ask('c', { sessionId: 's2' })]
      expect(() => approvals.cancelAll()).not.toThrow()
      await expect(Promise.all(ps)).resolves.toEqual(['deny', 'deny', 'deny'])
      expect(vi.getTimerCount()).toBe(0)
      expect(errors).toHaveLength(3)
    })

    it('timeout and abort do not throw out of the timer or listener', async () => {
      const t = ask('a')
      expect(() => vi.advanceTimersByTime(50)).not.toThrow()
      await expect(t).resolves.toBe('deny')
      const ac = new AbortController()
      const a = ask('b', { signal: ac.signal })
      expect(() => ac.abort()).not.toThrow()
      await expect(a).resolves.toBe('deny')
      expect(vi.getTimerCount()).toBe(0)
      expect(errors).toHaveLength(2)
    })

    it('respond still returns true and the decision stands', async () => {
      const p = ask('npm test', { key: 'npm test' })
      expect(approvals.respond(lastId(), 'allow_session')).toBe(true)
      await expect(p).resolves.toBe('allow')
    })
  })
})
