import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeClock, type FakeClock } from '../../../test/memoryRig'
import { startFakeTelegram, type FakeRequest, type FakeTelegram } from '../../../test/fakeTelegram'
import type { Logger } from '../../kernel/log'
import { createApi } from './api'
import { Poller } from './poller'
import { TelegramState } from './state'

const TOKEN = '123456789:' + 'A'.repeat(35)
const DAY = 86_400_000

interface Rig {
  poller: Poller
  state: TelegramState
  batches: unknown[][]
  states: [string, string | undefined][]
  sleeps: number[]
}

describe('Poller', () => {
  let root: string
  let file: string
  let fake: FakeTelegram
  let clock: FakeClock
  let logs: string[]
  let log: Logger
  let running: Poller[]

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'mffai-tg-poll-'))
    file = join(root, 'tg', 'state.json')
    fake = await startFakeTelegram({ token: TOKEN })
    clock = fakeClock()
    logs = []
    running = []
    const line = (m: string, d?: unknown) => void logs.push(JSON.stringify({ m, d }))
    log = { info: line, warn: line, error: line }
  })
  afterEach(async () => {
    await Promise.all(running.map(p => p.stop()))
    await fake.close()
    rmSync(root, { recursive: true, force: true })
  })

  interface RigOpts {
    state?: TelegramState
    token?: () => string | undefined
    onBatch?: (updates: unknown[], state: TelegramState) => void | Promise<void>
    sleep?: (ms: number) => Promise<void>
    random?: () => number
    fetch?: typeof fetch
    realTimers?: boolean
  }

  function rig(o: RigOpts = {}): Rig {
    const state = o.state ?? TelegramState.open(file, log)
    const batches: unknown[][] = []
    const states: [string, string | undefined][] = []
    const sleeps: number[] = []
    const api = createApi({ base: fake.base, token: o.token ?? (() => TOKEN), ...(o.fetch && { fetch: o.fetch }), ...(!o.realTimers && { timers: clock.timers }) })
    const poller = new Poller({
      api,
      state,
      log,
      onBatch: async updates => {
        batches.push(updates)
        if (o.onBatch) return o.onBatch(updates, state)
        for (const u of updates as { update_id: number }[]) state.advance(u.update_id)
      },
      onState: (s, reason) => void states.push([s, reason]),
      sleep:
        o.sleep ??
        (async ms => {
          sleeps.push(ms)
        }),
      random: o.random ?? (() => 0.5),
      now: clock.now,
    })
    running.push(poller)
    return { poller, state, batches, states, sleeps }
  }

  const polls = (): FakeRequest[] => fake.requests.filter(r => r.method === 'getUpdates')
  /** 等第 n 次 getUpdates 到达假服务器 */
  const pollArrived = (n: number) => expect.poll(() => polls().length, { timeout: 3000, interval: 2 }).toBeGreaterThanOrEqual(n)
  const lastState = (r: Rig) => r.states.at(-1)
  const seed = (fields: { offset?: number; lastUpdateAt?: number }) => {
    const s = TelegramState.open(file, log)
    if (fields.offset !== undefined) s.data.offset = fields.offset
    if (fields.lastUpdateAt !== undefined) s.data.lastUpdateAt = fields.lastUpdateAt
    s.save()
    return TelegramState.open(file, log)
  }
  const onDisk = () => JSON.parse(readFileSync(file, 'utf8')) as { offset: number; lastUpdateAt?: number }

  it('先 getMe,再按规定的参数长轮询', async () => {
    const r = rig()
    r.poller.start()
    await pollArrived(1)
    expect(fake.requests[0].method).toBe('getMe')
    expect(polls()[0].body).toEqual({ timeout: 50, limit: 100, allowed_updates: ['message', 'callback_query', 'my_chat_member'] })
    expect(r.states.map(s => s[0])).toEqual(['starting', 'online'])
    expect(r.state.data.bot).toEqual({ id: 123456789, username: 'fake_bot' })
    expect(r.poller.lastOkAt).toBe(clock.now())
  })

  it('start 不等网络:getMe 挂着也立刻返回', async () => {
    fake.fail('getMe', 1, 'hang')
    const r = rig()
    r.poller.start()
    expect(lastState(r)?.[0]).toBe('starting')
    await expect.poll(() => fake.requests.length).toBe(1)
    await r.poller.stop()
  })

  it('getMe 失败按退避重试,成功才开始轮询', async () => {
    fake.fail('getMe', 2, { status: 500 })
    const r = rig()
    r.poller.start()
    await pollArrived(1)
    expect(fake.requests.slice(0, 3).map(q => q.method)).toEqual(['getMe', 'getMe', 'getMe'])
    expect(r.sleeps).toEqual([1000, 2000])
    expect(r.states.map(s => s[0])).toEqual(['starting', 'reconnecting', 'online'])
  })

  it('getMe 看到别的机器人:清掉旧机器人的配对', async () => {
    const s = TelegramState.open(file, log)
    s.data.bot = { id: 42, username: 'old' }
    s.data.offset = 500
    s.data.lastUpdateAt = clock.now()
    s.data.pairings.push({ accountId: '1', name: 'n', pairedAt: 1 })
    s.save()
    const r = rig({ state: TelegramState.open(file, log) })
    r.poller.start()
    await pollArrived(1)
    expect(r.state.data.pairings).toEqual([])
    expect(polls()[0].body.offset).toBeUndefined()
    expect(JSON.parse(readFileSync(file, 'utf8')).bot.id).toBe(123456789)
  })

  it('批次:先处理、再落盘,下一次 getUpdates 才带新 offset', async () => {
    const seenOnDisk: (number | undefined)[] = []
    const spying = (async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith('/getUpdates')) seenOnDisk.push(existsSync(file) ? onDisk().offset : undefined)
      return fetch(url as string, init)
    }) as typeof fetch
    const r = rig({ fetch: spying })
    const a = fake.push({ message: { chat: { id: 1 }, text: 'a' } })
    const b = fake.push({ message: { chat: { id: 1 }, text: 'b' } })
    r.poller.start()
    await pollArrived(2)
    expect(r.batches).toHaveLength(1)
    expect((r.batches[0] as { update_id: number }[]).map(u => u.update_id)).toEqual([a, b])
    expect(polls()[1].body.offset).toBe(b + 1)
    expect(seenOnDisk[1]).toBe(b + 1)
    expect(onDisk().lastUpdateAt).toBe(clock.now())
  })

  it('onBatch 正常返回却没推进:poller 自己推进到批尾,不会反复收同一批', async () => {
    const r = rig({ onBatch: () => {} })
    const a = fake.push({ message: { chat: { id: 1 }, text: 'a' } })
    r.poller.start()
    await pollArrived(2)
    expect(polls()[1].body.offset).toBe(a + 1)
    expect(r.batches).toHaveLength(1)
  })

  it('save 抛错:下一次 getUpdates 还是旧 offset,这批不重复处理;恢复后才确认', async () => {
    const r = rig()
    const real = TelegramState.prototype.save
    let failing = false
    vi.spyOn(r.state, 'save').mockImplementation(function (this: TelegramState) {
      if (failing) {
        failing = false
        throw new Error(`ENOSPC ${TOKEN}`)
      }
      real.call(this)
    })
    r.poller.start()
    await pollArrived(1)
    failing = true
    const a = fake.push({ update_id: 10, message: { chat: { id: 1 }, text: 'a' } })
    await pollArrived(2)
    expect(polls()[1].body.offset).toBeUndefined()
    await pollArrived(3)
    expect(r.batches).toHaveLength(1)
    expect(polls()[2].body.offset).toBe(a + 1)
    expect(onDisk().offset).toBe(a + 1)
    expect(r.sleeps).toEqual([1000])
    expect(r.state.problems).not.toContain('state_save_failed')
    expect(logs.join('\n')).not.toContain(TOKEN)
    expect(logs.join('\n')).not.toContain('ENOSPC')
  })

  it('save 一直失败:问题挂在 state.problems,不空转', async () => {
    const r = rig()
    r.poller.start()
    await pollArrived(1)
    vi.spyOn(r.state, 'save').mockImplementation(() => {
      throw new Error('disk')
    })
    fake.push({ update_id: 3, message: { chat: { id: 1 }, text: 'a' } })
    await expect.poll(() => r.state.problems).toContain('state_save_failed')
    await expect.poll(() => r.sleeps.length).toBeGreaterThan(1)
    expect(r.batches).toHaveLength(1)
  })

  it('落盘前崩溃:新进程收到同一条,不丢', async () => {
    const r = rig()
    r.poller.start()
    await pollArrived(1)
    vi.spyOn(r.state, 'save').mockImplementation(() => {
      throw new Error('crash')
    })
    const a = fake.push({ message: { chat: { id: 1 }, text: 'a' } })
    await expect.poll(() => r.batches.length).toBe(1)
    await r.poller.stop()
    const again = rig({ state: TelegramState.open(file, log) })
    again.poller.start()
    await expect.poll(() => again.batches.length).toBe(1)
    expect((again.batches[0] as { update_id: number }[])[0].update_id).toBe(a)
  })

  it('落盘后崩溃:新进程从新 offset 接着,不重投', async () => {
    const r = rig()
    const a = fake.push({ message: { chat: { id: 1 }, text: 'a' } })
    r.poller.start()
    await pollArrived(2)
    await r.poller.stop()
    const again = rig({ state: TelegramState.open(file, log) })
    const before = polls().length
    again.poller.start()
    await pollArrived(before + 1)
    expect(polls().at(-1)?.body.offset).toBe(a + 1)
    expect(again.batches).toEqual([])
  })

  describe('退避', () => {
    const expected = [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]

    it('翻倍到 60 s', async () => {
      const r = rig()
      fake.fail('getUpdates', expected.length, { status: 500 })
      r.poller.start()
      await pollArrived(expected.length + 1)
      expect(r.sleeps).toEqual(expected)
      // 请求到了假服务器,回应还在路上:online 要等它回来
      await expect.poll(() => r.states.map(s => s[0])).toEqual(['starting', 'online', 'reconnecting', 'online'])
      expect(r.states[2][1]).toBe('server')
    })

    for (const [name, random, factor] of [
      ['下限 -20%', () => 0, 0.8],
      ['上限 +20%', () => 1, 1.2],
    ] as const) {
      it(`抖动:${name}`, async () => {
        const r = rig({ random })
        fake.fail('getUpdates', expected.length, 'drop')
        r.poller.start()
        await pollArrived(expected.length + 1)
        r.sleeps.forEach((ms, i) => expect(ms).toBeCloseTo(expected[i] * factor, 5))
      })
    }

    it('成功后复位', async () => {
      const r = rig()
      fake.fail('getUpdates', 4, { status: 502 })
      r.poller.start()
      await pollArrived(5)
      expect(r.sleeps).toEqual([1000, 2000, 4000, 8000])
      const n = polls().length
      fake.fail('getUpdates', 1, { status: 502 })
      fake.push({ message: { chat: { id: 1 }, text: 'wake' } })
      await pollArrived(n + 1)
      await expect.poll(() => r.sleeps.length).toBe(5)
      expect(r.sleeps[4]).toBe(1000)
    })

    it('恢复后的第一次不长等,状态马上回 online;之后恢复 50 s', async () => {
      const r = rig()
      fake.fail('getUpdates', 1, 'drop')
      r.poller.start()
      await pollArrived(3)
      expect(polls().map(p => p.body.timeout)).toEqual([50, 0, 50])
    })

    it('取消退避:stop 不等 sleep', async () => {
      const r = rig({ sleep: () => new Promise(() => {}), realTimers: true })
      fake.fail('getUpdates', 1, { status: 500 })
      r.poller.start()
      await expect.poll(() => lastState(r)?.[0]).toBe('reconnecting')
      const t = Date.now()
      await r.poller.stop()
      expect(Date.now() - t).toBeLessThan(500)
    })
  })

  describe('401、404 停止', () => {
    for (const [method, reply] of [
      ['getMe', { status: 401 }],
      ['getMe', { status: 404 }],
      ['getUpdates', { status: 401 }],
      ['getUpdates', { status: 404 }],
    ] as const) {
      it(`${method} ${reply.status}:不再发任何请求`, async () => {
        fake.fail(method, 1, reply)
        const r = rig()
        r.poller.start()
        await expect.poll(() => lastState(r)?.[0]).toBe('unauthorized')
        const n = fake.requests.length
        for (let i = 0; i < 10; i++) await new Promise(res => setImmediate(res))
        expect(fake.requests.length).toBe(n)
        expect(r.sleeps).toEqual([])
      })
    }

    it('令牌错:unauthorized;换上对的令牌后 start 能重新开始', async () => {
      let token = TOKEN.replace('A', 'B')
      const r = rig({ token: () => token })
      r.poller.start()
      await expect.poll(() => lastState(r)?.[0]).toBe('unauthorized')
      token = TOKEN
      await expect.poll(() => {
        r.poller.start()
        return lastState(r)?.[0]
      }).toBe('online')
    })

    it('start 两次只有一个循环', async () => {
      const r = rig()
      r.poller.start()
      r.poller.start()
      await pollArrived(1)
      for (let i = 0; i < 10; i++) await new Promise(res => setImmediate(res))
      expect(fake.requests.filter(q => q.method === 'getMe')).toHaveLength(1)
    })
  })

  describe('409', () => {
    it('webhook:conflict + 60 s,不删 webhook;清掉后恢复', async () => {
      let release = () => {}
      const gate = new Promise<void>(res => (release = res))
      const sleeps: number[] = []
      const r = rig({
        sleep: async ms => {
          sleeps.push(ms)
          await gate
        },
      })
      fake.webhookActive = true
      r.poller.start()
      await expect.poll(() => lastState(r)).toEqual(['conflict', 'webhook'])
      await expect.poll(() => sleeps).toEqual([60_000])
      expect(fake.requests.some(q => q.method === 'deleteWebhook')).toBe(false)
      fake.webhookActive = false
      release()
      await expect.poll(() => lastState(r)?.[0]).toBe('online')
    })

    it('别的轮询:conflict + other_poller;60 s 不翻倍', async () => {
      const r = rig()
      fake.fail('getUpdates', 3, { status: 409, body: { ok: false, description: 'Conflict: terminated by other getUpdates request' } })
      r.poller.start()
      await pollArrived(4)
      expect(r.sleeps).toEqual([60_000, 60_000, 60_000])
      expect(r.states[2]).toEqual(['conflict', 'other_poller'])
    })
  })

  describe('429', () => {
    it('按 retry_after,状态不变', async () => {
      const r = rig()
      fake.fail('getUpdates', 1, { status: 429, body: { ok: false, parameters: { retry_after: 7 } } })
      r.poller.start()
      await pollArrived(2)
      expect(r.sleeps).toEqual([7000])
      expect(r.states.map(s => s[0])).toEqual(['starting', 'online'])
    })

    it('没有 retry_after 走退避', async () => {
      const r = rig()
      fake.fail('getUpdates', 1, { status: 429 })
      r.poller.start()
      await pollArrived(2)
      expect(r.sleeps).toEqual([1000])
    })

    it('离谱的 retry_after 压到 1 小时(setTimeout 溢出会变成空转)', async () => {
      const r = rig()
      fake.fail('getUpdates', 1, { status: 429, body: { parameters: { retry_after: 1e12 } } })
      r.poller.start()
      await pollArrived(2)
      expect(r.sleeps).toEqual([3_600_000])
    })
  })

  describe('空转保护', () => {
    it('长轮询立刻回空数组:歇一下再问,不空转', async () => {
      const r = rig()
      fake.fail('getUpdates', 3, { status: 200, body: { ok: true, result: [] } })
      r.poller.start()
      await pollArrived(4)
      expect(r.sleeps).toEqual([1000, 1000, 1000])
    })

    it('长轮询等够了才回空:不歇', async () => {
      let polls = 0
      const slowEmpty = (async (url: unknown, init?: RequestInit) => {
        if (String(url).endsWith('/getUpdates') && polls++ === 0) {
          clock.advance(50_000)
          return new Response('{"ok":true,"result":[]}')
        }
        return fetch(url as string, init)
      }) as typeof fetch
      const r = rig({ fetch: slowEmpty })
      r.poller.start()
      await pollArrived(1)
      expect(polls).toBeGreaterThanOrEqual(2)
      expect(r.sleeps).toEqual([])
    })

    it('恢复时 timeout:0 的空回复是预期的:不歇', async () => {
      const r = rig()
      fake.fail('getUpdates', 1, { status: 500 })
      r.poller.start()
      await pollArrived(3)
      expect(polls()[1].body.timeout).toBe(0)
      expect(r.sleeps).toHaveLength(1)
    })

    it('很小的 retry_after:至少歇 1 s', async () => {
      const r = rig()
      fake.fail('getUpdates', 1, { status: 429, body: { parameters: { retry_after: 0.001 } } })
      r.poller.start()
      await pollArrived(2)
      expect(r.sleeps).toEqual([1000])
    })
  })

  describe('离谱的 update_id', () => {
    const MAX_INT32 = 2 ** 31 - 1

    it.each([
      ['超过 32 位', MAX_INT32 + 1],
      ['接近 2^53', Number.MAX_SAFE_INTEGER - 1],
    ])('%s:丢掉、计数,offset 不动', async (_name, huge) => {
      const r = rig()
      fake.fail('getUpdates', 1, { status: 200, body: { ok: true, result: [{ update_id: huge }] } })
      const real = fake.push({ message: { chat: { id: 1 }, text: 'a' } })
      r.poller.start()
      await pollArrived(3)
      expect((r.batches.flat() as { update_id: number }[]).map(u => u.update_id)).toEqual([real])
      expect(r.state.data.offset).toBe(real + 1)
      expect(r.state.data.dropped.badUpdate).toBe(1)
    })

    it('一次跳太远:offset 推不过真实的 id,之后的更新还收得到', async () => {
      const r = rig({ state: seed({ offset: 100, lastUpdateAt: clock.now() }) })
      fake.fail('getUpdates', 1, { status: 200, body: { ok: true, result: [{ update_id: MAX_INT32 - 1 }] } })
      r.poller.start()
      await pollArrived(2)
      expect(r.batches).toEqual([])
      expect(r.state.data.offset).toBe(100)
      expect(polls()[1].body.offset).toBe(100)
      const next = fake.push({ update_id: 100, message: { chat: { id: 1 }, text: 'a' } })
      await expect.poll(() => (r.batches.flat() as { update_id: number }[]).map(u => u.update_id)).toEqual([next])
      expect(r.sleeps).toHaveLength(1)
    })

    it('还没有 offset(新机器人、闲置重置):第一个 id 不受"跳太远"限制', async () => {
      const r = rig()
      const first = fake.push({ update_id: MAX_INT32 - 5, message: { chat: { id: 1 }, text: 'a' } })
      r.poller.start()
      await expect.poll(() => r.state.ackOffset).toBe(first + 1)
    })

    it('一直收到坏条目:不空转', async () => {
      const r = rig()
      fake.fail('getUpdates', 2, { status: 200, body: { ok: true, result: [{ update_id: MAX_INT32 + 1 }] } })
      r.poller.start()
      await pollArrived(3)
      expect(r.sleeps).toHaveLength(2)
    })
  })

  describe('超时的 stop 之后 start', () => {
    it('旧循环的批次还卡着:新循环等它结束,同一时间只有一个循环', async () => {
      let finish = () => {}
      const gate = new Promise<void>(res => (finish = res))
      let inBatch = 0
      let most = 0
      const r = rig({
        realTimers: true,
        onBatch: async (updates, state) => {
          most = Math.max(most, ++inBatch)
          if (r.batches.length === 1) await gate
          for (const u of updates as { update_id: number }[]) state.advance(u.update_id)
          inBatch--
        },
      })
      const a = fake.push({ message: { chat: { id: 1 }, text: 'a' } })
      r.poller.start()
      await expect.poll(() => r.batches.length).toBe(1)
      const before = fake.requests.length
      await r.poller.stop()
      r.poller.start()
      await new Promise(res => setTimeout(res, 30))
      // 旧批次没完:一个请求都不发,也不重投同一批
      expect(fake.requests.length).toBe(before)
      expect(r.batches).toHaveLength(1)
      finish()
      await expect.poll(() => polls().at(-1)?.body.offset).toBe(a + 1)
      expect(most).toBe(1)
      expect(r.batches).toHaveLength(1)
    })

    it('start 之后马上又 stop:排着队的循环不再开始', async () => {
      let finish = () => {}
      const gate = new Promise<void>(res => (finish = res))
      const r = rig({
        realTimers: true,
        onBatch: async (updates, state) => {
          await gate
          for (const u of updates as { update_id: number }[]) state.advance(u.update_id)
        },
      })
      fake.push({ message: { chat: { id: 1 }, text: 'a' } })
      r.poller.start()
      await expect.poll(() => r.batches.length).toBe(1)
      await r.poller.stop()
      r.poller.start()
      await r.poller.stop()
      const before = fake.requests.length
      finish()
      await new Promise(res => setTimeout(res, 30))
      expect(fake.requests.length).toBe(before)
    })
  })

  describe('挂死', () => {
    it('getUpdates 挂死:注入的时钟走到 65 s 才中止,转 reconnecting', async () => {
      const r = rig()
      fake.fail('getUpdates', 1, 'hang')
      r.poller.start()
      await pollArrived(1)
      clock.advance(64_999)
      for (let i = 0; i < 20; i++) await new Promise(res => setImmediate(res))
      expect(lastState(r)?.[0]).toBe('online')
      expect(polls()).toHaveLength(1)
      clock.advance(1)
      await pollArrived(2)
      // 请求到了假服务器,回应还在路上:online 要等它回来
      await expect.poll(() => r.states.map(s => s[0])).toEqual(['starting', 'online', 'reconnecting', 'online'])
      expect(r.sleeps).toEqual([1000])
    })

    it('pollTimeoutS 改短时,中止时间跟着 +15 s', async () => {
      const state = TelegramState.open(file, log)
      const poller = new Poller({
        api: createApi({ base: fake.base, token: () => TOKEN, timers: clock.timers }),
        state,
        onBatch: () => {},
        onState: () => {},
        sleep: async () => {},
        random: () => 0.5,
        now: clock.now,
        pollTimeoutS: 1,
      })
      running.push(poller)
      fake.fail('getUpdates', 1, 'hang')
      poller.start()
      await pollArrived(1)
      expect(polls()[0].body.timeout).toBe(1)
      clock.advance(15_999)
      for (let i = 0; i < 20; i++) await new Promise(res => setImmediate(res))
      expect(polls()).toHaveLength(1)
      clock.advance(1)
      await pollArrived(2)
    })

    for (const method of ['getMe', 'getUpdates'] as const) {
      it(`stop 打断挂着的 ${method},500 ms 内返回,之后不再发请求`, async () => {
        const r = rig({ realTimers: true })
        fake.fail(method, 1, 'hang')
        r.poller.start()
        await expect.poll(() => fake.requests.some(q => q.method === method)).toBe(true)
        const t = Date.now()
        await r.poller.stop()
        expect(Date.now() - t).toBeLessThan(500)
        const n = fake.requests.length
        for (let i = 0; i < 10; i++) await new Promise(res => setImmediate(res))
        expect(fake.requests.length).toBe(n)
      })
    }

    it('stop 不被卡住的 onBatch 拖住:最多约 500 ms', async () => {
      const r = rig({ onBatch: () => new Promise(() => {}), realTimers: true })
      fake.push({ message: { chat: { id: 1 }, text: 'a' } })
      r.poller.start()
      await expect.poll(() => r.batches.length).toBe(1)
      const t = Date.now()
      await r.poller.stop()
      expect(Date.now() - t).toBeLessThan(1000)
    })

    it('stop 时正在处理的一批:处理完照样落盘', async () => {
      let finish = () => {}
      const gate = new Promise<void>(res => (finish = res))
      const r = rig({
        onBatch: async (updates, state) => {
          await gate
          for (const u of updates as { update_id: number }[]) state.advance(u.update_id)
        },
      })
      const a = fake.push({ message: { chat: { id: 1 }, text: 'a' } })
      r.poller.start()
      await expect.poll(() => r.batches.length).toBe(1)
      const stopped = r.poller.stop()
      finish()
      await stopped
      expect(onDisk().offset).toBe(a + 1)
    })
  })

  describe('update_id 重置(闲置 6 天)', () => {
    const lower = { ok: true, result: [{ update_id: 3, message: { chat: { id: 1 }, text: 'low' } }] }

    it('lastUpdateAt ≥ 6 天:不带 offset,更低的 id 也收,之后 offset 用新值', async () => {
      const r = rig({ state: seed({ offset: 900, lastUpdateAt: clock.now() - 6 * DAY }) })
      fake.fail('getUpdates', 1, { status: 200, body: lower })
      r.poller.start()
      await pollArrived(2)
      expect('offset' in polls()[0].body).toBe(false)
      expect(r.batches).toHaveLength(1)
      expect(polls()[1].body.offset).toBe(4)
      expect(onDisk().offset).toBe(4)
      expect(onDisk().lastUpdateAt).toBe(clock.now())
    })

    it('stored offset 但没有 lastUpdateAt:同样', async () => {
      const r = rig({ state: seed({ offset: 900 }) })
      fake.fail('getUpdates', 1, { status: 200, body: lower })
      r.poller.start()
      await pollArrived(2)
      expect('offset' in polls()[0].body).toBe(false)
      expect(r.batches).toHaveLength(1)
    })

    it('不到 6 天:带 offset,更低的 id 跳过,不算新更新', async () => {
      const at = clock.now() - 6 * DAY + 1
      const r = rig({ state: seed({ offset: 900, lastUpdateAt: at }) })
      fake.fail('getUpdates', 1, { status: 200, body: lower })
      r.poller.start()
      await pollArrived(2)
      expect(polls()[0].body.offset).toBe(900)
      expect(r.batches).toEqual([])
      expect(polls()[1].body.offset).toBe(900)
      expect(onDisk().lastUpdateAt).toBe(at)
    })

    it('服务器老回已确认的 id:不空转', async () => {
      const r = rig({ state: seed({ offset: 900, lastUpdateAt: clock.now() }) })
      fake.fail('getUpdates', 2, { status: 200, body: lower })
      r.poller.start()
      await pollArrived(3)
      expect(r.sleeps.length).toBeGreaterThanOrEqual(2)
    })

    it('闲置时一直没更新:一直不带 offset,也不改 offset', async () => {
      const r = rig({ state: seed({ offset: 900, lastUpdateAt: clock.now() - 7 * DAY }) })
      fake.fail('getUpdates', 2, { status: 200, body: { ok: true, result: [] } })
      r.poller.start()
      await pollArrived(3)
      for (const p of polls()) expect('offset' in p.body).toBe(false)
      expect(r.state.data.offset).toBe(900)
    })

    it('闲置后的那批落盘失败:下一次仍不带 offset(带旧的高 offset 会把新 id 确认掉),这批不重复处理', async () => {
      const r = rig({ state: seed({ offset: 900, lastUpdateAt: clock.now() - 6 * DAY }) })
      const real = TelegramState.prototype.save
      let failed = false
      vi.spyOn(r.state, 'save').mockImplementation(function (this: TelegramState) {
        // 第一次是 getMe 记 bot,第二次是这批
        if (this.data.lastUpdateAt === clock.now() && !failed) {
          failed = true
          throw new Error('disk')
        }
        real.call(this)
      })
      fake.fail('getUpdates', 2, { status: 200, body: lower })
      r.poller.start()
      await pollArrived(3)
      expect('offset' in polls()[1].body).toBe(false)
      expect(r.batches).toHaveLength(1)
      expect(polls()[2].body.offset).toBe(4)
    })
  })

  describe('坏数据', () => {
    it('onBatch 抛错:跳过卡住的那一条,计数,其余重投;原始错误不进日志', async () => {
      const marker = 'SECRET-' + 'z'.repeat(8)
      const seen: number[] = []
      const r = rig({
        onBatch: (updates, state) => {
          for (const u of updates as { update_id: number }[]) {
            if (u.update_id === 2) throw new Error(marker)
            seen.push(u.update_id)
            state.advance(u.update_id)
          }
        },
      })
      fake.push({ update_id: 1, message: { chat: { id: 1 }, text: 'a' } })
      fake.push({ update_id: 2, message: { chat: { id: 1 }, text: 'b' } })
      fake.push({ update_id: 3, message: { chat: { id: 1 }, text: 'c' } })
      r.poller.start()
      await expect.poll(() => seen).toEqual([1, 3])
      await pollArrived(3)
      expect(polls().at(-1)?.body.offset).toBe(4)
      expect(r.state.data.dropped.badUpdate).toBe(1)
      expect(logs.join('\n')).not.toContain(marker)
    })

    it('没有 update_id 的条目:丢掉、计数,不交给 onBatch', async () => {
      const r = rig()
      fake.fail('getUpdates', 1, { status: 200, body: { ok: true, result: [null, 'x', { update_id: 'y' }, { update_id: 1.5 }, { update_id: -1 }, { update_id: 8 }] } })
      r.poller.start()
      await pollArrived(2)
      expect(r.batches).toEqual([[{ update_id: 8 }]])
      expect(r.state.data.dropped.badUpdate).toBe(5)
      expect(polls()[1].body.offset).toBe(9)
    })

    it('result 不是数组 → server 退避', async () => {
      const r = rig()
      fake.fail('getUpdates', 1, { status: 200, body: { ok: true, result: { a: 1 } } })
      r.poller.start()
      await pollArrived(2)
      expect(r.sleeps).toEqual([1000])
      expect(r.states[2]).toEqual(['reconnecting', 'server'])
    })

    it('getMe 没有 id → server 退避,不开始轮询', async () => {
      const r = rig()
      fake.fail('getMe', 1, { status: 200, body: { ok: true, result: { username: 'x' } } })
      r.poller.start()
      await pollArrived(1)
      expect(fake.requests.slice(0, 2).map(q => q.method)).toEqual(['getMe', 'getMe'])
      expect(r.sleeps).toEqual([1000])
    })

    it('onState 抛错不打断循环', async () => {
      const state = TelegramState.open(file, log)
      const poller = new Poller({
        api: createApi({ base: fake.base, token: () => TOKEN, timers: clock.timers }),
        state,
        log,
        onBatch: () => {},
        onState: () => {
          throw new Error('listener')
        },
        sleep: async () => {},
        random: () => 0.5,
        now: clock.now,
      })
      running.push(poller)
      poller.start()
      await pollArrived(1)
    })
  })

  describe('令牌不外漏', () => {
    const everywhere = (r: Rig) =>
      [
        logs.join('\n'),
        JSON.stringify(r.states),
        JSON.stringify(r.state.data),
        JSON.stringify(r.state.problems),
        existsSync(file) ? readFileSync(file, 'utf8') : '',
        inspect(r.poller, { showHidden: true, depth: 12 }),
        inspect(r.state, { showHidden: true, depth: 12 }),
      ].join('\n')

    for (const status of [400, 401, 403, 404, 409, 429, 500]) {
      it(`假服务器把 URL 写进 description(${status}):日志、状态、state.json、对象上都没有`, async () => {
        const r = rig()
        fake.fail('getUpdates', 1, { status, body: { ok: false, description: `${fake.base}/bot${TOKEN}/getUpdates webhook`, parameters: { retry_after: 1 } } })
        r.poller.start()
        await pollArrived(1)
        await expect.poll(() => logs.length).toBeGreaterThan(0)
        await r.poller.stop()
        expect(everywhere(r)).not.toContain(TOKEN)
        expect(everywhere(r)).not.toContain('/bot')
      })
    }

    it('fetch 抛的错带 URL:同样', async () => {
      let calls = 0
      const throwing = (async (url: unknown, init?: RequestInit) => {
        if (++calls <= 2) throw new TypeError(`fetch failed ${String(url)}`, { cause: new Error(String(url)) })
        return fetch(url as string, init)
      }) as typeof fetch
      const r = rig({ fetch: throwing })
      r.poller.start()
      await pollArrived(1)
      await r.poller.stop()
      expect(r.sleeps).toEqual([1000, 2000])
      expect(everywhere(r)).not.toContain(TOKEN)
      expect(everywhere(r)).not.toContain('/bot')
    })

    it('断网:同样', async () => {
      const r = rig()
      r.poller.start()
      await pollArrived(1)
      fake.offline = true
      await expect.poll(() => lastState(r)?.[0]).toBe('reconnecting')
      fake.offline = false
      await r.poller.stop()
      expect(everywhere(r)).not.toContain(TOKEN)
    })

    it('正常收发之后也没有', async () => {
      const r = rig()
      fake.push({ message: { chat: { id: 1 }, text: 'a' } })
      r.poller.start()
      await pollArrived(2)
      await r.poller.stop()
      expect(everywhere(r)).not.toContain(TOKEN)
    })
  })
})
