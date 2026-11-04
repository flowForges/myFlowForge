import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { done, fakeClock, fakeModels, memoryKernel, say, type FakeAccount, type FakeModelsOpts, type FakeModels, type MemoryRig } from '../../../test/memoryRig'
import { nullLogger } from '../../kernel/log'
import { MemoryConfigSchema, type MemoryConfig } from '../../lib/memory/types'
import type { ModelError, ModelEvent } from '../../lib/models/types'
import { MemoryHealthSchema, type MemoryHealth } from '../../protocol/rpc'
import { Background, dateKey, pickBackground, type BackgroundRun } from './background'
import { createMemoryDefault, type MemoryDefaultPlugin } from './index'
import { openStore, type Store } from './store'

const cfg = (over: Partial<MemoryConfig> = {}): MemoryConfig => ({ ...MemoryConfigSchema.parse({}), ...over })
const models = (...accounts: FakeAccount[]) => fakeModels({ accounts }).service
const priced = (id: string, input: number, extra: object = {}) => ({ id, cost: { input, output: input * 4 }, ...extra })
const ref = (accountId: string, modelId: string) => ({ accountId, modelId })

describe('pickBackground', () => {
  const session = ref('a', 'big')
  const rows: [string, FakeAccount[], Partial<MemoryConfig>, ReturnType<typeof ref> | undefined, ReturnType<typeof pickBackground>][] = [
    ['the cheapest by cost', [{ id: 'a', models: [priced('big', 15), priced('cheap', 0.25), priced('mid', 3)] }], {}, session, { ref: ref('a', 'cheap') }],
    ['a free model is still priced', [{ id: 'a', models: [priced('big', 15), priced('free', 0)] }], {}, session, { ref: ref('a', 'free') }],
    ['priced beats unpriced', [{ id: 'a', models: [{ id: 'gpt-mini' }, priced('big', 15)] }], {}, session, { ref: ref('a', 'big') }],
    ['deprecated skipped', [{ id: 'a', models: [priced('big', 15), priced('old', 0.1, { deprecated: true })] }], {}, session, { ref: ref('a', 'big') }],
    ['context under 16k skipped', [{ id: 'a', models: [priced('big', 15), priced('tiny', 0.1, { context: 15_999 })] }], {}, session, { ref: ref('a', 'big') }],
    ['context of exactly 16k kept', [{ id: 'a', models: [priced('big', 15), priced('tiny', 0.1, { context: 16_000 })] }], {}, session, { ref: ref('a', 'tiny') }],
    ['no prices: the id regex', [{ id: 'a', models: [{ id: 'big' }, { id: 'vendor-flash-2' }] }], {}, session, { ref: ref('a', 'vendor-flash-2') }],
    ['no prices: deprecated regex match skipped', [{ id: 'a', models: [{ id: 'big' }, { id: 'x-haiku', deprecated: true }] }], {}, session, { ref: ref('a', 'big') }],
    ['no prices: gemini does not count as mini', [{ id: 'a', models: [{ id: 'gemini-pro' }, { id: 'big' }] }], {}, session, { ref: ref('a', 'big') }],
    ['neither: the session model', [{ id: 'a', models: [{ id: 'other' }, { id: 'big' }] }], {}, session, { ref: ref('a', 'big') }],
    ['session model unknown to the catalog is still that model', [{ id: 'a', models: [{ id: 'other' }] }], {}, session, { ref: ref('a', 'big') }],
    ['session model too small and nothing else', [{ id: 'a', models: [{ id: 'big', context: 8000 }] }], {}, session, { none: 'no_model' }],
    ['session model deprecated and nothing else', [{ id: 'a', models: [{ id: 'big', deprecated: true }] }], {}, session, { none: 'no_model' }],
    ['coding-tools-only session', [{ id: 'a', restriction: 'coding-tools-only', models: [priced('big', 15)] }], {}, session, { none: 'restricted' }],
    ['unknown + subscription', [{ id: 'a', restriction: 'unknown', billing: 'subscription', models: [priced('big', 15)] }], {}, session, { none: 'unknown_subscription' }],
    ['unknown + metered', [{ id: 'a', restriction: 'unknown', billing: 'metered', models: [priced('big', 15)] }], {}, session, { ref: ref('a', 'big') }],
    ['never another account', [{ id: 'a', restriction: 'coding-tools-only', models: [priced('big', 15)] }, { id: 'b', models: [priced('cheap', 0.1)] }], {}, session, { none: 'restricted' }],
    ['cheaper model on another account is ignored', [{ id: 'a', models: [priced('big', 15)] }, { id: 'b', models: [priced('cheap', 0.1)] }], {}, session, { ref: ref('a', 'big') }],
    ['session account gone', [{ id: 'b', models: [priced('cheap', 0.1)] }], {}, session, { none: 'no_model' }],
    ['no session: the default account', [{ id: 'a', models: [priced('big', 15), priced('cheap', 1)] }, { id: 'b', models: [priced('c', 0.1)] }], {}, undefined, { ref: ref('a', 'cheap') }],
    ['no account at all', [], {}, undefined, { none: 'no_model' }],
    ['explicit model is used as given', [{ id: 'a', models: [priced('big', 15)] }, { id: 'b', models: [priced('pick', 9), priced('cheap', 0.1)] }], { backgroundModel: ref('b', 'pick') }, session, { ref: ref('b', 'pick') }],
    ['explicit on coding-tools-only', [{ id: 'a', models: [priced('big', 15)] }, { id: 'b', restriction: 'coding-tools-only', models: [priced('pick', 9)] }], { backgroundModel: ref('b', 'pick') }, session, { none: 'restricted' }],
    ['explicit on a removed account', [{ id: 'a', models: [priced('big', 15)] }], { backgroundModel: ref('gone', 'pick') }, session, { none: 'no_model' }],
  ]
  it.each(rows)('%s', (_name, accounts, over, sessionRef, want) => {
    expect(pickBackground(models(...accounts), cfg(over), sessionRef)).toEqual(want)
  })
})

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

const REQ = { system: 'sys', prompt: 'p', maxOutput: 100 }
const A = ref('acc', 'm')
const noon = new Date(2026, 10, 4, 12).getTime()

const gate = () => {
  let open!: () => void
  const opened = new Promise<void>(r => (open = r))
  return { opened, open }
}
const failing = async function* (kind: ModelError['kind']): AsyncIterable<ModelEvent> {
  yield { type: 'done', reason: 'error', error: { kind, message: 'nope', retryable: false } }
}
const usage = (input: number, output: number) => say('ok', { input, output })

interface Rig {
  bg: Background
  fake: FakeModels
  store: Store
  clock: ReturnType<typeof fakeClock>
  /** 一个任务调一次 text,等结果 */
  one(r?: typeof A): Promise<Awaited<ReturnType<BackgroundRun['text']>>>
  reopen(): Background
}

function rig(o: Partial<FakeModelsOpts> & { config?: Partial<MemoryConfig>; timeoutMs?: number; noModels?: boolean } = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'mffai-bg-'))
  const clock = fakeClock(noon)
  const store = openStore(join(dir, 'memory.sqlite'), { log: nullLogger, now: clock.now })
  const fake = fakeModels({ accounts: [{ id: 'acc', models: [{ id: 'm' }] }], ...o })
  const make = () => {
    const made = new Background({
      models: () => (o.noModels ? undefined : fake.service),
      config: () => cfg(o.config),
      store,
      now: clock.now,
      log: nullLogger,
      ...(o.timeoutMs !== undefined && { timeoutMs: o.timeoutMs }),
    })
    cleanups.push(() => made.close())
    return made
  }
  const h: Rig = {
    bg: make(),
    fake,
    store,
    clock,
    one(r = A) {
      return new Promise((resolve, reject) => {
        const queued = h.bg.enqueue(async run => resolve(await run.text(r, REQ)))
        if (!queued) reject(new Error('dropped'))
      })
    },
    reopen: () => (h.bg = make()),
  }
  // 后进先出:先关 Background,再关库、删目录
  cleanups.unshift(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return h
}

describe('the request', () => {
  it('is non-interactive, has no tools, no reasoning, and a live signal', async () => {
    const h = rig({ script: () => say('hello', { input: 3, output: 4 }) })
    expect(await h.one()).toEqual({ ok: true, text: 'hello', tokens: 7, model: 'm', usd: (3 * 10 + 4 * 10) / 1e6 })
    const [call] = h.fake.calls
    expect(call.ref).toEqual(A)
    expect(call.req.interactive).toBe(false)
    expect(call.req).not.toHaveProperty('tools')
    expect(call.req).not.toHaveProperty('toolChoice')
    expect(call.req.reasoning).toBe('off')
    expect(call.req.maxOutput).toBe(100)
    expect(call.req.system).toBe('sys')
    expect(call.req.messages).toEqual([{ role: 'user', parts: [{ type: 'text', text: 'p' }] }])
    expect(call.req.signal.aborted).toBe(false)
  })

  it('a fake interactive-only adapter proves it: the refusal is reported and the account is out', async () => {
    const h = rig({ script: (_n, req) => (req.interactive ? say('ok') : failing('restricted')) })
    expect(await h.one()).toEqual({ ok: false, reason: 'restricted' })
    expect(await h.one()).toEqual({ ok: false, reason: 'account_out' })
    expect(h.fake.calls).toHaveLength(1)
  })
})

describe('fences before the call', () => {
  const noCall: [string, Parameters<typeof rig>[0], string][] = [
    ['coding-tools-only', { accounts: [{ id: 'acc', restriction: 'coding-tools-only', models: [{ id: 'm' }] }] }, 'restricted'],
    ['coding-tools-only, even when configured', { accounts: [{ id: 'acc', restriction: 'coding-tools-only', models: [{ id: 'm' }] }], config: { backgroundModel: A } }, 'restricted'],
    ['unknown subscription', { accounts: [{ id: 'acc', restriction: 'unknown', billing: 'subscription', models: [{ id: 'm' }] }] }, 'restricted'],
    ['missing account', { accounts: [{ id: 'other', models: [{ id: 'm' }] }] }, 'account_out'],
    ['account needs login', { accounts: [{ id: 'acc', state: 'needs_login', models: [{ id: 'm' }] }] }, 'account_out'],
    ['account quota exhausted', { accounts: [{ id: 'acc', state: 'quota_exhausted', models: [{ id: 'm' }] }] }, 'account_out'],
    ['no models service', { noModels: true }, 'error'],
    ['token budget zero', { config: { tokensPerDay: 0 } }, 'budget'],
    ['usd budget zero on metered', { config: { usdPerDay: 0 } }, 'budget'],
    ['quota at 75%', { quota: () => ({ windows: [{ label: 'w', usedPercent: 75 }] }) }, 'quota_low'],
    ['one window of several at 90%', { quota: () => ({ windows: [{ label: 'a', usedPercent: 1 }, { label: 'b', usedPercent: 90 }] }) }, 'quota_low'],
    ['quota percent is not a number', { quota: () => ({ windows: [{ label: 'a', usedPercent: Number.NaN }] }) }, 'quota_low'],
    ['quota read throws', { quota: () => { throw new Error('probe down') } }, 'quota_low'],
  ]
  it.each(noCall)('%s: no call', async (_name, opts, reason) => {
    const h = rig(opts)
    expect(await h.one()).toEqual({ ok: false, reason })
    expect(h.fake.calls).toHaveLength(0)
  })

  it('a quota read that never answers is no call either, and frees the slot', async () => {
    const h = rig({ quota: () => new Promise(() => {}), timeoutMs: 40 })
    expect(await h.one()).toEqual({ ok: false, reason: 'timeout' })
    expect(h.fake.calls).toHaveLength(0)
  })

  it('usd does not stop a subscription account, and it records no dollars', async () => {
    const h = rig({ accounts: [{ id: 'acc', billing: 'subscription', models: [{ id: 'm' }] }], quota: () => ({ windows: [] }), config: { usdPerDay: 0 } })
    const r = await h.one()
    expect(r).toMatchObject({ ok: true, usd: 0 })
    expect((await h.bg.status()).budget.usd).toBe(0)
  })

  it('an explicit model on an unknown subscription is the user\'s call', async () => {
    const h = rig({ accounts: [{ id: 'acc', restriction: 'unknown', billing: 'subscription', models: [{ id: 'm' }] }], config: { backgroundModel: A } })
    expect((await h.one()).ok).toBe(true)
  })

  it('quota under 75% allows the call', async () => {
    const h = rig({ quota: () => ({ windows: [{ label: 'w', usedPercent: 74.9 }] }) })
    expect((await h.one()).ok).toBe(true)
  })
})

describe('budget', () => {
  const priced40 = [{ id: 'acc', models: [{ id: 'm', cost: { input: 10, output: 40 } }] }]
  const until = async (h: Rig, cap = 200) => {
    for (let i = 0; i < cap; i++) {
      const r = await h.one()
      if (!r.ok) return { calls: h.fake.calls.length, reason: r.reason }
    }
    throw new Error('never stopped')
  }

  it('stops at the token line until the injected clock passes local midnight', async () => {
    const h = rig({ script: () => usage(600, 400), config: { tokensPerDay: 3000 }, quota: () => ({ windows: [] }), accounts: [{ id: 'acc', billing: 'subscription', models: [{ id: 'm' }] }] })
    expect(await until(h)).toEqual({ calls: 3, reason: 'budget' })
    h.clock.advance(11 * 3600_000)
    expect(await h.one()).toEqual({ ok: false, reason: 'budget' })
    h.clock.advance(3600_000)
    expect((await h.one()).ok).toBe(true)
    expect(h.fake.calls).toHaveLength(4)
  })

  it('a priced metered model stops at the dollar line, before the token line', async () => {
    // 每次 1000 输入 1000 输出 = 0.05 美元,5 美分一次,1 美元 20 次,此时才 4 万 token
    const h = rig({ accounts: priced40, script: () => usage(1000, 1000), quota: () => ({ windows: [{ label: 'w', usedPercent: 1 }] }) })
    expect(await until(h)).toEqual({ calls: 20, reason: 'budget' })
    const { budget } = await h.bg.status()
    expect(budget.tokens).toBe(40_000)
    expect(budget.usd).toBeCloseTo(1)
    expect(budget.tokensLimit).toBe(400_000)
    expect(budget.usdLimit).toBe(1)
  })

  it('an unpriced metered model stops near 100k tokens by the $10 per million line', async () => {
    const h = rig({ script: () => usage(5000, 5000), quota: () => ({ windows: [{ label: 'w', usedPercent: 1 }] }), config: { tokensPerDay: 10_000_000 } })
    expect(await until(h)).toEqual({ calls: 10, reason: 'budget' })
  })

  for (const [name, quota] of [['null', () => null], ['a link', () => ({ link: 'https://example.test/usage' })], ['no windows', () => ({ windows: [] })]] as const) {
    it(`a subscription account whose quota gives ${name} stops at 100k tokens`, async () => {
      const h = rig({ accounts: [{ id: 'acc', billing: 'subscription', models: [{ id: 'm' }] }], script: () => usage(5000, 5000), quota })
      expect(await until(h)).toEqual({ calls: 10, reason: 'budget' })
      expect((await h.bg.status()).budget.tokensLimit).toBe(100_000)
    })
  }

  it('a lower configured token line wins over the 100k one', async () => {
    const h = rig({ accounts: [{ id: 'acc', billing: 'subscription', models: [{ id: 'm' }] }], config: { tokensPerDay: 50 }, quota: () => null })
    expect((await h.bg.status()).budget.tokensLimit).toBe(50)
  })

  it('a prompt that would cross the line is not sent', async () => {
    const h = rig({ config: { tokensPerDay: 1000 }, quota: () => ({ windows: [{ label: 'w', usedPercent: 1 }] }) })
    const r = await new Promise(resolve => h.bg.enqueue(async run => resolve(await run.text(A, { system: '', prompt: 'x'.repeat(10_000), maxOutput: 10 }))))
    expect(r).toEqual({ ok: false, reason: 'budget' })
    expect(h.fake.calls).toHaveLength(0)
  })

  it('usage missing is estimated at chars / 3.5', async () => {
    const h = rig({ script: async function* () { yield { type: 'text', delta: 'z'.repeat(35) }; yield done() } })
    const r = await new Promise(resolve => h.bg.enqueue(async run => resolve(await run.text(A, { system: 'y'.repeat(14), prompt: 'x'.repeat(21), maxOutput: 100 }))))
    expect(r).toMatchObject({ ok: true, tokens: 20 })
    expect((await h.bg.status()).budget.tokens).toBe(20)
  })

  it('usage of zero is treated as missing: adapters default absent counts to 0', async () => {
    const h = rig({ script: () => say('z'.repeat(35), { input: 0, output: 0 }) })
    expect((await h.one()).ok).toBe(true)
    expect((await h.bg.status()).budget.tokens).toBeGreaterThanOrEqual(10)
  })

  it('a call that fails after sending is still charged', async () => {
    const h = rig({ script: async function* () { yield { type: 'text', delta: 'z'.repeat(35) }; yield { type: 'done', reason: 'error', error: { kind: 'network', message: 'x', retryable: true } } } })
    expect(await h.one()).toEqual({ ok: false, reason: 'error' })
    expect((await h.bg.status()).budget.tokens).toBeGreaterThanOrEqual(10)
  })

  it('a call the provider refused outright costs nothing', async () => {
    const h = rig({ script: () => failing('bad_request') })
    expect(await h.one()).toEqual({ ok: false, reason: 'error' })
    expect((await h.bg.status()).budget.tokens).toBe(0)
  })

  it('the ledger survives a restart, and old days are dropped', async () => {
    const h = rig({ script: () => usage(600, 400), config: { tokensPerDay: 1500 }, quota: () => ({ windows: [{ label: 'w', usedPercent: 1 }] }) })
    expect((await h.one()).ok).toBe(true)
    expect((await h.one()).ok).toBe(true)
    await h.bg.close()
    h.reopen()
    expect(await h.one()).toEqual({ ok: false, reason: 'budget' })
    h.clock.advance(24 * 3600_000)
    expect((await h.one()).ok).toBe(true)
    expect(h.store.metaWithPrefix('budget:')).toHaveLength(1)
  })

  it('a damaged ledger decides nothing: no call, today only', async () => {
    for (const bad of ['not json', '{"tokens":"NaN"}', '{"tokens":null,"usd":0,"out":[]}', '{"tokens":-5,"usd":0,"out":[]}']) {
      const h = rig()
      const today = await h.bg.status()
      expect(today.budget.tokens).toBe(0)
      h.store.setMeta(`budget:${dateKey(noon)}`, bad)
      expect(await h.one()).toEqual({ ok: false, reason: 'budget' })
      expect(h.fake.calls).toHaveLength(0)
      h.clock.advance(24 * 3600_000)
      expect((await h.one()).ok).toBe(true)
    }
  })

  it('a database that cannot be read or written: no call, nothing thrown', async () => {
    const h = rig()
    h.store.db.close()
    expect((await h.one()).ok).toBe(false)
    expect(h.fake.calls).toHaveLength(0)
  })

  it('a ledger that stops accepting writes before the call: no call', async () => {
    const h = rig()
    h.store.setMeta = () => { throw new Error('disk full') }
    expect((await h.one()).ok).toBe(false)
    expect(h.fake.calls).toHaveLength(0)
  })

  it('a ledger that stops accepting writes after the call: no more calls today', async () => {
    const h = rig({
      script: () => {
        h.store.setMeta = () => { throw new Error('disk full') }
        return say('ok', { input: 1, output: 1 })
      },
    })
    expect((await h.one()).ok).toBe(true)
    expect((await h.one()).ok).toBe(false)
    expect(h.fake.calls).toHaveLength(1)
  })

  it('spend already reserved stays recorded if the process dies mid-call', async () => {
    const blocked = gate()
    const h = rig({ script: async function* () { await blocked.opened; yield done() } })
    const seen = new Promise(resolve => h.bg.enqueue(async run => resolve(await run.text(A, { system: '', prompt: 'x'.repeat(350), maxOutput: 10 }))))
    await expect.poll(() => h.fake.calls.length).toBe(1)
    expect((await h.bg.status()).budget.tokens).toBe(100)
    blocked.open()
    await seen
  })
})

describe('errors', () => {
  const dayOut: [ModelError['kind'], string][] = [['quota', 'account_out'], ['auth', 'account_out'], ['restricted', 'restricted']]
  it.each(dayOut)('%s: that account is out for the day, also after a restart', async (kind, reason) => {
    const h = rig({ script: () => failing(kind), accounts: [{ id: 'acc', models: [{ id: 'm' }] }, { id: 'b', models: [{ id: 'm' }] }] })
    expect(await h.one()).toEqual({ ok: false, reason })
    expect(await h.one()).toEqual({ ok: false, reason: 'account_out' })
    await h.bg.close()
    h.reopen()
    expect(await h.one()).toEqual({ ok: false, reason: 'account_out' })
    expect(h.fake.calls).toHaveLength(1)
    // 别的账号不受影响
    expect(await h.one(ref('b', 'm'))).toEqual({ ok: false, reason })
    expect(h.fake.calls).toHaveLength(2)
    h.clock.advance(24 * 3600_000)
    await h.one()
    expect(h.fake.calls).toHaveLength(3)
  })

  it.each(['network', 'unavailable', 'rate_limit', 'bad_request'] as const)('%s: only that job', async kind => {
    const h = rig({ script: n => (n === 1 ? failing(kind) : say('ok')) })
    expect(await h.one()).toEqual({ ok: false, reason: 'error' })
    expect((await h.one()).ok).toBe(true)
  })

  it('a job looping on a failure sends one request, not many', async () => {
    const h = rig({ script: () => failing('network') })
    const results: string[] = []
    await new Promise<void>(resolve => h.bg.enqueue(async run => {
      for (let i = 0; i < 50; i++) {
        const r = await run.text(A, REQ)
        if (!r.ok) results.push(r.reason)
      }
      resolve()
    }))
    expect(h.fake.calls).toHaveLength(1)
    expect(new Set(results)).toEqual(new Set(['error']))
  })

  it('a length finish is reported as length, not ok, and still charged', async () => {
    const h = rig({ script: async function* () { yield { type: 'text', delta: 'partial' }; yield { type: 'usage', input: 5, output: 5 }; yield { type: 'done', reason: 'length' } } })
    expect(await h.one()).toEqual({ ok: false, reason: 'length' })
    expect((await h.bg.status()).budget.tokens).toBe(10)
  })

  const broken: [string, () => AsyncIterable<ModelEvent>][] = [
    ['ends without done', async function* () { yield { type: 'text', delta: 'x' } }],
    ['throws while streaming', async function* () { yield { type: 'text', delta: 'x' }; throw new Error('boom') }],
    ['throws on the call', () => { throw new Error('boom') }],
    ['done:error without detail', async function* () { yield { type: 'done', reason: 'error' } }],
    ['done:cancelled nobody asked for', async function* () { yield { type: 'done', reason: 'cancelled' } }],
    ['done:tool_calls with no tools', async function* () { yield { type: 'done', reason: 'tool_calls' } }],
  ]
  it.each(broken)('a stream that %s is an error, never ok', async (_name, script) => {
    const h = rig({ script })
    expect(await h.one()).toEqual({ ok: false, reason: 'error' })
  })
})

describe('timeout', () => {
  it('a fake that never sends done hits the timeout, and the slot frees', async () => {
    let signal: AbortSignal | undefined
    const h = rig({
      timeoutMs: 40,
      script: (n, req) => {
        signal = req.signal
        return n === 1 ? (async function* (): AsyncIterable<ModelEvent> { yield { type: 'text', delta: 'x' }; await new Promise(() => {}) })() : say('ok')
      },
    })
    expect(await h.one()).toEqual({ ok: false, reason: 'timeout' })
    expect(signal?.aborted).toBe(true) // 这是第一个请求的:第二个还没发
    expect((await h.one()).ok).toBe(true)
    expect(signal?.aborted).toBe(false)
    expect(h.fake.calls[0].req.signal.aborted).toBe(true)
  })

  it('a stream that never yields to the event loop still hits the timeout', async () => {
    const h = rig({ timeoutMs: 20, script: async function* () { for (;;) yield { type: 'reasoning', delta: '' } } })
    expect(await h.one()).toEqual({ ok: false, reason: 'timeout' })
  })

  it('a stream that ignores maxOutput is cut off as length', async () => {
    const chunk = 'x'.repeat(10_000)
    const h = rig({ timeoutMs: 5000, script: async function* () { for (;;) yield { type: 'text', delta: chunk } } })
    expect(await h.one()).toEqual({ ok: false, reason: 'length' })
    expect(h.fake.calls[0].req.signal.aborted).toBe(true)
  })
})

describe('the queue', () => {
  it('one request at a time, queue of 8, drops new work when full', async () => {
    const blocked = gate()
    let inFlight = 0
    let most = 0
    const h = rig({
      script: async function* () {
        most = Math.max(most, ++inFlight)
        await blocked.opened
        inFlight--
        yield done()
      },
    })
    let finished = 0
    const job = async (run: BackgroundRun) => {
      await run.text(A, REQ)
      finished++
    }
    expect(h.bg.enqueue(job)).toBe(true) // 跑着的
    await expect.poll(() => h.fake.calls.length).toBe(1)
    for (let i = 0; i < 8; i++) expect(h.bg.enqueue(job)).toBe(true)
    expect(h.bg.enqueue(job)).toBe(false)
    blocked.open()
    await expect.poll(() => finished).toBe(9)
    expect(most).toBe(1)
    expect(h.fake.calls).toHaveLength(9)
    expect(h.bg.enqueue(job)).toBe(true) // 有空位了
  })

  it('enqueue returns before the job starts: the caller is not blocked', async () => {
    const h = rig()
    let started = false
    h.bg.enqueue(async () => { started = true })
    await Promise.resolve()
    expect(started).toBe(false)
    await expect.poll(() => started).toBe(true)
  })

  it('a job calling text twice at once still sends one at a time', async () => {
    const blocked = gate()
    let inFlight = 0
    let most = 0
    const h = rig({
      script: async function* () {
        most = Math.max(most, ++inFlight)
        await blocked.opened
        inFlight--
        yield done()
      },
    })
    const both = new Promise(resolve => h.bg.enqueue(async run => resolve(await Promise.all([run.text(A, REQ), run.text(A, REQ)]))))
    await expect.poll(() => h.fake.calls.length).toBe(1)
    blocked.open()
    await both
    expect(most).toBe(1)
    expect(h.fake.calls).toHaveLength(2)
  })

  it('a job that throws does not block the next, sync or async', async () => {
    const h = rig()
    expect(h.bg.enqueue(() => { throw new Error('sync') })).toBe(true)
    expect(h.bg.enqueue(async () => { throw new Error('async') })).toBe(true)
    expect((await h.one()).ok).toBe(true)
  })

  it('a run kept after its job ended cannot send', async () => {
    const h = rig()
    let kept: BackgroundRun | undefined
    await new Promise<void>(resolve => h.bg.enqueue(async run => { kept = run; resolve() }))
    await h.one()
    expect(h.fake.calls).toHaveLength(1)
    expect(await kept!.text(A, REQ)).toEqual({ ok: false, reason: 'aborted' })
    expect(h.fake.calls).toHaveLength(1)
  })
})

describe('close', () => {
  it('aborts a blocked call, awaits the running job, and drops the queue', async () => {
    let signal: AbortSignal | undefined
    let after = false
    let queuedRan = false
    const h = rig({
      script: (_n, req) => {
        signal = req.signal
        return (async function* (): AsyncIterable<ModelEvent> { await new Promise(() => {}) })() // 不理 signal
      },
    })
    let result: unknown
    h.bg.enqueue(async run => {
      result = await run.text(A, REQ)
      await new Promise(r => setTimeout(r, 10))
      after = true
    })
    h.bg.enqueue(async () => { queuedRan = true })
    await expect.poll(() => h.fake.calls.length).toBe(1)
    await h.bg.close()
    expect(signal?.aborted).toBe(true)
    expect(result).toEqual({ ok: false, reason: 'aborted' })
    expect(after).toBe(true)
    expect(queuedRan).toBe(false)
    expect(h.bg.enqueue(async () => {})).toBe(false)
    await h.bg.close() // 再关一次没事
  })

  it('text after close returns aborted without calling models', async () => {
    const h = rig()
    let release!: () => void
    const held = new Promise<void>(r => (release = r))
    let result: unknown
    h.bg.enqueue(async run => {
      await held
      result = await run.text(A, REQ)
    })
    await new Promise(r => setTimeout(r, 5))
    const closing = h.bg.close()
    release()
    await closing
    expect(result).toEqual({ ok: false, reason: 'aborted' })
    expect(h.fake.calls).toHaveLength(0)
  })

  it('close while the quota read hangs: no call', async () => {
    const h = rig({ quota: () => new Promise(() => {}) })
    let result: unknown
    h.bg.enqueue(async run => { result = await run.text(A, REQ) })
    await new Promise(r => setTimeout(r, 5))
    await h.bg.close()
    expect(result).toEqual({ ok: false, reason: 'aborted' })
    expect(h.fake.calls).toHaveLength(0)
  })
})

describe('status', () => {
  it('reports the model, spend and limits; a refused explicit model is a problem', async () => {
    const h = rig({ accounts: [{ id: 'acc', models: [{ id: 'm' }] }, { id: 'r', restriction: 'coding-tools-only', models: [{ id: 'x' }] }], config: { backgroundModel: ref('r', 'x') } })
    const s = await h.bg.status()
    expect(s.backgroundModel).toBeUndefined()
    expect(s.problem).toBe('background_model:restricted')
    expect(s.budget.tokens).toBe(0)
  })

  it('without config the default account model shows, and no model is no problem', async () => {
    const ok = await rig({ quota: () => ({ windows: [{ label: 'w', usedPercent: 1 }] }) }).bg.status()
    expect(ok).toEqual({ backgroundModel: A, budget: { tokens: 0, usd: 0, tokensLimit: 400_000, usdLimit: 1 } })
    const none = await rig({ noModels: true }).bg.status()
    expect(none).toEqual({ budget: { tokens: 0, usd: 0, tokensLimit: 400_000, usdLimit: 1 } })
  })
})

describe('inside the plugin', () => {
  const boot = async (o: FakeModelsOpts & { memory?: object } = {}) => {
    const fake = fakeModels(o)
    const memory: MemoryDefaultPlugin = createMemoryDefault({ nightly: false })
    const r: MemoryRig = await memoryKernel({ models: fake, plugins: [memory], ...(o.memory && { config: { memory: o.memory } }) })
    cleanups.push(() => r.close())
    return { fake, memory, r, health: () => r.k.handle('memory.health', {}) as Promise<MemoryHealth> }
  }

  it('memory.health shows the model, the spend and the limits', async () => {
    const h = await boot({ script: () => say('ok', { input: 30, output: 12 }) })
    const before = await h.health()
    expect(MemoryHealthSchema.safeParse(before).success).toBe(true)
    expect(before.backgroundModel).toEqual({ accountId: 'acc', modelId: 'gpt-5' })
    expect(before.budget).toEqual({ tokens: 0, usd: 0, tokensLimit: 100_000, usdLimit: 1 })
    const { background } = h.memory.inspect()
    await new Promise(resolve => background.enqueue(async run => resolve(await run.text({ accountId: 'acc', modelId: 'gpt-5' }, REQ))))
    expect((await h.health()).budget).toMatchObject({ tokens: 42, usd: (30 * 10 + 12 * 10) / 1e6 })
  })

  it('an explicit model on a restricted account is refused and reported, and nothing is called', async () => {
    const pick = ref('r', 'x')
    const h = await boot({ accounts: [{ id: 'r', restriction: 'coding-tools-only', models: [{ id: 'x' }] }], memory: { backgroundModel: pick } })
    const seen = await h.health()
    expect(seen.backgroundModel).toBeUndefined()
    expect(seen.problems).toContain('background_model:restricted')
    const { background } = h.memory.inspect()
    expect(await new Promise(resolve => background.enqueue(async run => resolve(await run.text(pick, REQ))))).toEqual({ ok: false, reason: 'restricted' })
    expect(h.fake.calls).toHaveLength(0)
  })

  it('closing the kernel aborts a blocked call and waits for the job, then the database closes', async () => {
    const h = await boot({ script: () => (async function* (): AsyncIterable<ModelEvent> { await new Promise(() => {}) })() })
    const { store, background } = h.memory.inspect()
    const seen: { result?: unknown; openAfterAbort?: boolean; openAtEnd?: boolean } = {}
    background.enqueue(async run => {
      seen.result = await run.text({ accountId: 'acc', modelId: 'gpt-5' }, REQ)
      seen.openAfterAbort = store.db.isOpen
      await new Promise(r => setTimeout(r, 10))
      seen.openAtEnd = store.db.isOpen
    })
    await expect.poll(() => h.fake.calls.length).toBe(1)
    const signal = h.fake.calls[0].req.signal
    await h.r.k.close()
    expect(signal.aborted).toBe(true)
    expect(seen).toEqual({ result: { ok: false, reason: 'aborted' }, openAfterAbort: true, openAtEnd: true })
    expect(store.db.isOpen).toBe(false)
  })
})
