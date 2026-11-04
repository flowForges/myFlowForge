import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeClock, type FakeClock } from '../../../test/memoryRig'
import { startFakeTelegram, type FakeReply, type FakeRequest, type FakeTelegram } from '../../../test/fakeTelegram'
import { createApi, TelegramError, type TelegramApi } from './api'
import type { Chunk } from './render'
import { Sender, type Delivery } from './sender'

const TOKEN = '123456789:' + 'A'.repeat(35)
const CHAT = '1001'
const HOUR = 3_600_000
const WRITES = new Set(['sendMessage', 'editMessageText'])

const chunk = (text: string, o: Partial<Chunk> = {}): Chunk => ({ text, entities: [], ...o })
const delivery = (turnId = 't1'): Delivery => ({ turnId, messageIds: [], hashes: [], done: false })
const FAIL_500: FakeReply = { status: 500 }
const limited = (seconds: number): FakeReply => ({ status: 429, body: { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: seconds } } })
const badEntities: FakeReply = { status: 400, body: { ok: false, error_code: 400, description: "Bad Request: can't parse entities" } }
const BOLD = [{ type: 'bold', offset: 0, length: 2 }]

describe('Sender', () => {
  let fake: FakeTelegram
  let clock: FakeClock
  let inFlight: number
  let changes: string[]
  let undelivered: string[]
  let blockedNow: Set<string>
  let logs: string[]
  let sender: Sender

  /** 假服务器在真的 HTTP 上;等到手上的请求都回来了,才让假时间往下走 */
  const idle = async () => {
    await new Promise(r => setImmediate(r))
    while (inFlight > 0) await new Promise(r => setTimeout(r, 1))
    await new Promise(r => setImmediate(r))
  }
  const run = async (ms: number, step = 100) => {
    await idle()
    for (let left = ms; left > 0; left -= step) {
      clock.advance(Math.min(step, left))
      await idle()
    }
  }

  const writes = (chat?: string): FakeRequest[] => fake.requests.filter(q => WRITES.has(q.method) && (chat === undefined || String(q.body.chat_id) === chat))
  const texts = (chat: string = CHAT) => fake.outbox(chat).map(m => m.text)

  const build = (api?: TelegramApi) => {
    const real = api ?? createApi({ base: fake.base, token: () => TOKEN, timers: clock.timers })
    const counted: TelegramApi = {
      call: async (method, body, opts) => {
        inFlight++
        try {
          return await real.call(method, body, opts)
        } finally {
          inFlight--
        }
      },
    }
    return new Sender({
      api: counted,
      now: clock.now,
      timers: clock.timers,
      random: () => 0.5,
      onChange: chatId => void changes.push(chatId),
      onUndelivered: chatId => void undelivered.push(chatId),
      isBlocked: chatId => blockedNow.has(chatId),
      onBlocked: chatId => void blockedNow.add(chatId),
      log: {
        info: (m: string, d?: unknown) => void logs.push(JSON.stringify({ m, d })),
        warn: (m: string, d?: unknown) => void logs.push(JSON.stringify({ m, d })),
        error: (m: string, d?: unknown) => void logs.push(JSON.stringify({ m, d })),
      },
    })
  }

  beforeEach(async () => {
    clock = fakeClock()
    fake = await startFakeTelegram({ token: TOKEN, now: clock.now })
    inFlight = 0
    changes = []
    undelivered = []
    blockedNow = new Set()
    logs = []
    sender = build()
  })

  afterEach(async () => {
    sender.close()
    await fake.close()
  })

  describe('chunk sync', () => {
    it('new chunks are sent, changed ones edited, unchanged ones left alone', async () => {
      const d = delivery()
      sender.sync(CHAT, 't1', [chunk('a'), chunk('b')], { final: false, delivery: d })
      await run(3000)
      expect(writes().map(q => q.method)).toEqual(['sendMessage', 'sendMessage'])
      expect(d.messageIds).toHaveLength(2)
      expect(d.hashes).toHaveLength(2)

      sender.sync(CHAT, 't1', [chunk('a'), chunk('b2'), chunk('c')], { final: false, delivery: d })
      await run(3000)
      expect(writes().slice(2).map(q => q.method)).toEqual(['editMessageText', 'sendMessage'])
      expect(writes()[2].body.message_id).toBe(d.messageIds[1])
      expect(texts()).toEqual(['a', 'b2', 'c'])
    })

    it('entities are part of the comparison', async () => {
      const d = delivery()
      sender.sync(CHAT, 't1', [chunk('ab')], { final: false, delivery: d })
      await run(2000)
      sender.sync(CHAT, 't1', [chunk('ab', { entities: BOLD as Chunk['entities'] })], { final: false, delivery: d })
      await run(2000)
      expect(fake.outbox(CHAT)[0].entities).toEqual(BOLD)
    })

    it('final marks the delivery done and persists; interim does not', async () => {
      const d = delivery()
      sender.sync(CHAT, 't1', [chunk('a')], { final: false, delivery: d })
      await run(2000)
      expect(d.done).toBe(false)
      expect(changes).toEqual([CHAT])
      sender.sync(CHAT, 't1', [chunk('a')], { final: true, delivery: d })
      await run(100)
      expect(d.done).toBe(true)
      expect(changes).toEqual([CHAT, CHAT])
    })

    it('a delivery replayed after a restart sends only what differs', async () => {
      const d = delivery()
      sender.sync(CHAT, 't1', [chunk('a'), chunk('b')], { final: true, delivery: d })
      await run(3000)
      const before = writes().length
      const again = build()
      const restored: Delivery = JSON.parse(JSON.stringify({ ...d, done: false }))
      again.sync(CHAT, 't1', [chunk('a'), chunk('b')], { final: true, delivery: restored })
      await run(3000)
      again.close()
      expect(writes()).toHaveLength(before)
      expect(restored.done).toBe(true)
    })

    it('fewer chunks than messages: the extra message stays and the delivery still finishes', async () => {
      const d = delivery()
      sender.sync(CHAT, 't1', [chunk('a'), chunk('b')], { final: false, delivery: d })
      await run(3000)
      sender.sync(CHAT, 't1', [chunk('a')], { final: true, delivery: d })
      await run(3000)
      expect(d.done).toBe(true)
      expect(texts()).toEqual(['a', 'b'])
    })

    it('a delivery that belongs to another turn is refused, so an old message is never overwritten', async () => {
      const d = delivery('old')
      sender.sync(CHAT, 't1', [chunk('old text')], { final: false, delivery: d })
      await run(3000)
      expect(writes()).toEqual([])
      expect(logs.join('\n')).toContain('delivery')
    })

    it('only a chunk with notify notifies', async () => {
      const d = delivery()
      sender.sync(CHAT, 't1', [chunk('a', { notify: true }), chunk('b'), chunk('c', { notify: true })], { final: true, delivery: d })
      await run(5000)
      expect(fake.outbox(CHAT).map(m => m.silent === true)).toEqual([false, true, false])
    })
  })

  describe('rates', () => {
    it('100 syncs in a second: at most one edit per 1500 ms, and the last content wins', async () => {
      const d = delivery()
      sender.sync(CHAT, 't1', [chunk('v0')], { final: false, delivery: d })
      await run(50, 50)
      for (let i = 1; i <= 100; i++) {
        sender.sync(CHAT, 't1', [chunk(`v${i}`)], { final: false, delivery: d })
        await run(10, 10)
      }
      await run(5000)
      const edits = fake.requests.filter(q => q.method === 'editMessageText')
      expect(edits.length).toBeGreaterThan(0)
      expect(edits.length).toBeLessThanOrEqual(2)
      const firstAt = fake.requests.find(q => q.method === 'sendMessage')?.at ?? 0
      let last = firstAt
      for (const e of edits) {
        expect(e.at - last).toBeGreaterThanOrEqual(1500)
        last = e.at
      }
      expect(texts()).toEqual(['v100'])
    })

    it('writes to one chat are at least 1100 ms apart', async () => {
      const d = delivery()
      sender.sync(CHAT, 't1', ['a', 'b', 'c', 'd'].map(t => chunk(t)), { final: true, delivery: d })
      await run(6000)
      const at = writes().map(q => q.at)
      expect(at).toHaveLength(4)
      for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(1100)
    })

    it('five chats each move at their own pace: one busy chat does not hold another', async () => {
      const chats = ['1', '2', '3', '4', '5']
      for (const c of chats) sender.sync(c, 't1', [chunk(`${c}a`), chunk(`${c}b`)], { final: true, delivery: delivery() })
      await run(100)
      for (const c of chats) expect(texts(c)).toEqual([`${c}a`])
      await run(1100)
      for (const c of chats) expect(texts(c)).toEqual([`${c}a`, `${c}b`])
    })

    it('the global limit holds: never more than 25 requests in any second, and nothing is lost', async () => {
      const chats = Array.from({ length: 60 }, (_, i) => String(i + 1))
      for (const c of chats) sender.sync(c, 't1', [chunk('x')], { final: true, delivery: delivery() })
      await run(4000)
      const at = writes().map(q => q.at)
      expect(at).toHaveLength(60)
      for (let i = 25; i < at.length; i++) expect(at[i] - at[i - 25]).toBeGreaterThanOrEqual(1000)
    })
  })

  describe('429', () => {
    it('pauses that chat for exactly retry_after, not the others, and the final arrives', async () => {
      fake.fail('sendMessage', 1, limited(7))
      const d = delivery()
      sender.sync('1', 't1', [chunk('final')], { final: true, delivery: d })
      await run(100)
      expect(texts('1')).toEqual([])

      sender.sync('2', 't1', [chunk('other')], { final: true, delivery: delivery() })
      await run(100)
      expect(texts('2')).toEqual(['other'])

      await run(6700)
      expect(writes('1')).toHaveLength(1)
      await run(300)
      expect(texts('1')).toEqual(['final'])
      expect(d.done).toBe(true)
      expect(writes('1')[1].at - writes('1')[0].at).toBe(7000)
    })

    it('a command reply survives a 429', async () => {
      fake.fail('sendMessage', 1, limited(3))
      const id = sender.send(CHAT, { text: '已配对' })
      await run(3000)
      expect(texts()).toEqual(['已配对'])
      expect(await id).toBe(fake.outbox(CHAT)[0].id)
    })

    it('interim edits during the pause collapse into the newest', async () => {
      const d = delivery()
      sender.sync(CHAT, 't1', [chunk('v0')], { final: false, delivery: d })
      await run(2000)
      fake.fail('editMessageText', 1, limited(5))
      sender.sync(CHAT, 't1', [chunk('v1')], { final: false, delivery: d })
      await run(100)
      for (let i = 2; i <= 9; i++) {
        sender.sync(CHAT, 't1', [chunk(`v${i}`)], { final: false, delivery: d })
        await run(100)
      }
      await run(6000)
      const edits = fake.requests.filter(q => q.method === 'editMessageText')
      expect(edits.map(q => q.body.text)).toEqual(['v1', 'v9'])
    })

    it('an interim hit by a 429 with nothing newer is dropped, not retried', async () => {
      fake.fail('sendMessage', 1, limited(2))
      const d = delivery()
      sender.sync(CHAT, 't1', [chunk('v0')], { final: false, delivery: d })
      await run(10_000, 500)
      expect(writes()).toHaveLength(1)
      expect(d.messageIds).toEqual([])
    })

    it('never gives up a final on 429s alone, even past the hour', async () => {
      fake.fail('sendMessage', 100, limited(600))
      const d = delivery()
      sender.sync(CHAT, 't1', [chunk('final')], { final: true, delivery: d })
      await run(3 * HOUR, 60_000)
      expect(undelivered).toEqual([])
      expect(d.done).toBe(false)
      expect(writes().length).toBeLessThanOrEqual(20)
    })

    it('time spent paused by a 429 does not count against the hour', async () => {
      fake.fail('sendMessage', 1, FAIL_500)
      fake.fail('sendMessage', 1, limited(2 * 3600))
      fake.fail('sendMessage', 1, FAIL_500)
      const d = delivery()
      sender.sync(CHAT, 't1', [chunk('final')], { final: true, delivery: d })
      await run(3 * HOUR, 60_000)
      expect(undelivered).toEqual([])
      expect(texts()).toEqual(['final'])
    })

    it('a 429 with no retry_after still waits', async () => {
      fake.fail('sendMessage', 1, { status: 429 })
      const d = delivery()
      sender.sync(CHAT, 't1', [chunk('final')], { final: true, delivery: d })
      await run(100)
      await run(4000)
      expect(writes()).toHaveLength(1)
      await run(1000)
      expect(texts()).toEqual(['final'])
    })

    it('a retry_after too large for a timer does not turn into a tight loop', async () => {
      fake.fail('sendMessage', 1, limited(60 * 24 * 3600))
      sender.sync(CHAT, 't1', [chunk('final')], { final: true, delivery: delivery() })
      await run(HOUR, 60_000)
      expect(writes()).toHaveLength(1)
    })
  })

  describe('failures', () => {
    it('an interim failure is not retried; the next sync carries on', async () => {
      fake.fail('sendMessage', 1, FAIL_500)
      const d = delivery()
      sender.sync(CHAT, 't1', [chunk('v0')], { final: false, delivery: d })
      await run(30_000, 500)
      expect(writes()).toHaveLength(1)
      sender.sync(CHAT, 't1', [chunk('v1')], { final: false, delivery: d })
      await run(2000)
      expect(texts()).toEqual(['v1'])
    })

    it('five consecutive 500s on editMessageText: the final content arrives, no interim edit is retried', async () => {
      const d = delivery()
      sender.sync(CHAT, 't1', [chunk('v0')], { final: false, delivery: d })
      await run(2000)
      fake.fail('editMessageText', 1, FAIL_500)
      sender.sync(CHAT, 't1', [chunk('v1')], { final: false, delivery: d })
      await run(30_000, 500)
      expect(fake.requests.filter(q => q.method === 'editMessageText')).toHaveLength(1)

      fake.fail('editMessageText', 5, FAIL_500)
      sender.sync(CHAT, 't1', [chunk('final')], { final: true, delivery: d })
      await run(120_000, 500)
      expect(fake.requests.filter(q => q.method === 'editMessageText')).toHaveLength(7)
      expect(texts()).toEqual(['final'])
      expect(d.done).toBe(true)
      expect(undelivered).toEqual([])
    })

    it('backoff grows from 1 s, is capped at 60 s', async () => {
      fake.fail('sendMessage', 9, FAIL_500)
      sender.sync(CHAT, 't1', [chunk('final')], { final: true, delivery: delivery() })
      await run(300_000, 500)
      const at = writes().map(q => q.at)
      const gaps = at.slice(1).map((t, i) => t - at[i])
      expect(gaps[0]).toBeGreaterThanOrEqual(1000)
      expect(gaps[0]).toBeLessThanOrEqual(1700)
      expect(gaps[3]).toBeGreaterThanOrEqual(8000)
      expect(Math.max(...gaps)).toBeLessThanOrEqual(60_500)
    })

    it('an hour of failures: one undelivered, nothing more goes out, and the delivery stays open for the next start', async () => {
      fake.fail('sendMessage', 1_000_000, FAIL_500)
      const d = delivery()
      sender.sync(CHAT, 't1', [chunk('final')], { final: true, delivery: d })
      await run(HOUR - 120_000, 10_000)
      expect(undelivered).toEqual([])
      await run(240_000, 10_000)
      expect(undelivered).toEqual([CHAT])
      expect(d.done).toBe(false)
      const n = writes().length
      await run(600_000, 10_000)
      expect(writes()).toHaveLength(n)
    })

    it('progress restarts the hour', async () => {
      let allowed = 0
      let next = 1
      const scripted = build({
        call: async <T,>() => {
          if (allowed-- <= 0) throw new TelegramError('server')
          return { message_id: next++ } as T
        },
      })
      const d = delivery()
      scripted.sync(CHAT, 't1', [chunk('a'), chunk('b')], { final: true, delivery: d })
      await run(HOUR - 120_000, 10_000)
      allowed = 1
      await run(70_000, 10_000)
      expect(d.messageIds).toHaveLength(1)
      await run(HOUR - 180_000, 10_000)
      expect(undelivered).toEqual([])
      await run(300_000, 10_000)
      expect(undelivered).toEqual([CHAT])
      scripted.close()
    })

    it('a send that failed for good resolves undefined, it never rejects', async () => {
      fake.fail('sendMessage', 1, { status: 400, body: { ok: false, description: 'Bad Request: nope' } })
      await expect(
        (async () => {
          const p = sender.send(CHAT, { text: 'x' })
          await run(100)
          return p
        })(),
      ).resolves.toBeUndefined()
    })

    it('a send with retryWhile retries past the hour until told to stop, then resolves undefined', async () => {
      fake.fail('sendMessage', 1_000_000, FAIL_500)
      let open = true
      const p = sender.send(CHAT, { text: 'card', keyboard: { inline_keyboard: [[{ text: 'y', callback_data: 'a:y' }]] } }, { retryWhile: () => open })
      await run(2 * HOUR, 30_000)
      const n = writes().length
      expect(n).toBeGreaterThan(60)
      open = false
      await run(120_000, 10_000)
      expect(await p).toBeUndefined()
      expect(writes()).toHaveLength(n)
      expect(undelivered).toEqual([])
    })

    it('a queued send whose retryWhile is already false never goes out', async () => {
      sender.sync(CHAT, 't1', [chunk('a')], { final: true, delivery: delivery() })
      const p = sender.send(CHAT, { text: 'card' }, { retryWhile: () => false })
      await run(5000)
      expect(await p).toBeUndefined()
      expect(texts()).toEqual(['a'])
    })

    it('a card that succeeds after failures returns its message id', async () => {
      fake.fail('sendMessage', 3, FAIL_500)
      const p = sender.send(CHAT, { text: 'card' }, { retryWhile: () => true })
      await run(30_000, 500)
      expect(await p).toBe(fake.outbox(CHAT)[0].id)
    })

    it('400 not-modified counts as success', async () => {
      const d = delivery()
      sender.sync(CHAT, 't1', [chunk('a')], { final: false, delivery: d })
      await run(2000)
      fake.fail('editMessageText', 1, { status: 400, body: { ok: false, description: 'Bad Request: message is not modified: same' } })
      sender.sync(CHAT, 't1', [chunk('a2')], { final: true, delivery: d })
      await run(3000)
      expect(d.done).toBe(true)
      expect(fake.requests.filter(q => q.method === 'editMessageText')).toHaveLength(1)
      expect(undelivered).toEqual([])
    })

    it('message deleted by the user: a new one is sent and takes its place', async () => {
      const d = delivery()
      sender.sync(CHAT, 't1', [chunk('a', { notify: true })], { final: false, delivery: d })
      await run(2000)
      const old = d.messageIds[0]
      fake.deleteMessage(CHAT, old)
      sender.sync(CHAT, 't1', [chunk('a2', { notify: true })], { final: true, delivery: d })
      await run(5000)
      expect(texts()).toEqual(['a2'])
      expect(d.messageIds).toHaveLength(1)
      expect(d.messageIds[0]).not.toBe(old)
      expect(d.done).toBe(true)
    })

    it('a card edit on a deleted message is dropped, nothing new appears', async () => {
      const id = sender.send(CHAT, { text: 'card' })
      await run(100)
      fake.deleteMessage(CHAT, (await id) as number)
      sender.edit(CHAT, (await id) as number, { text: '已允许' })
      await run(5000)
      expect(texts()).toEqual([])
      expect(writes()).toHaveLength(2)
    })

    it('a card edit is retried with backoff and the newest wins', async () => {
      const id = (await (async () => {
        const p = sender.send(CHAT, { text: 'card' })
        await run(100)
        return p
      })()) as number
      await run(2000)
      fake.fail('editMessageText', 2, FAIL_500)
      sender.edit(CHAT, id, { text: 'first' })
      await run(100)
      sender.edit(CHAT, id, { text: 'second' })
      await run(30_000, 500)
      expect(texts()).toEqual(['second'])
    })

    it('a final that a 400 refuses for good stops at once and counts as undelivered', async () => {
      const d = delivery()
      sender.sync(CHAT, 't1', [chunk('   ')], { final: true, delivery: d })
      await run(5000)
      expect(writes()).toHaveLength(1)
      expect(undelivered).toEqual([CHAT])
      expect(d.done).toBe(false)
    })

    it('401 is not retried: no request after the first', async () => {
      const badToken = build(createApi({ base: fake.base, token: () => 'x'.repeat(40), timers: clock.timers }))
      const d = delivery()
      badToken.sync(CHAT, 't1', [chunk('final')], { final: true, delivery: d })
      await run(120_000, 1000)
      badToken.close()
      expect(writes()).toHaveLength(1)
      expect(undelivered).toEqual([CHAT])
    })
  })

  describe('blocked', () => {
    it('403 stops the chat, drops what was queued, retries nothing and reports it', async () => {
      fake.fail('sendMessage', 1, { status: 403, body: { ok: false, description: 'Forbidden: bot was blocked by the user' } })
      const d = delivery()
      sender.sync(CHAT, 't1', [chunk('final')], { final: true, delivery: d })
      const queued = sender.send(CHAT, { text: 'queued' })
      await run(60_000, 1000)
      expect(writes()).toHaveLength(1)
      expect(blockedNow.has(CHAT)).toBe(true)
      expect(await queued).toBeUndefined()
      expect(undelivered).toEqual([])
      expect(d.done).toBe(false)
    })

    it('a blocked chat sends nothing, and starts again when unblocked', async () => {
      blockedNow.add(CHAT)
      sender.sync(CHAT, 't1', [chunk('a')], { final: true, delivery: delivery() })
      expect(await sender.send(CHAT, { text: 'b' })).toBeUndefined()
      sender.typing(CHAT)
      await run(5000)
      expect(fake.requests).toEqual([])

      blockedNow.delete(CHAT)
      sender.sync(CHAT, 't1', [chunk('c')], { final: true, delivery: delivery() })
      await run(1000)
      expect(texts()).toEqual(['c'])
    })

    it('403 on typing also stops the chat', async () => {
      fake.fail('sendChatAction', 1, { status: 403 })
      sender.typing(CHAT)
      await run(100)
      expect(blockedNow.has(CHAT)).toBe(true)
    })
  })

  describe('entities fallback', () => {
    it('bad entities: resent as plain text, so the message still arrives', async () => {
      fake.fail('sendMessage', 1, badEntities)
      const d = delivery()
      sender.sync(CHAT, 't1', [chunk('ab', { entities: BOLD as Chunk['entities'] })], { final: true, delivery: d })
      await run(3000)
      expect(fake.outbox(CHAT)).toMatchObject([{ text: 'ab' }])
      expect(fake.outbox(CHAT)[0].entities).toBeUndefined()
      expect(d.done).toBe(true)
      expect(undelivered).toEqual([])
    })

    it('an interim edit gets the plain resend too', async () => {
      const d = delivery()
      sender.sync(CHAT, 't1', [chunk('ab')], { final: false, delivery: d })
      await run(2000)
      fake.fail('editMessageText', 1, badEntities)
      sender.sync(CHAT, 't1', [chunk('cd', { entities: BOLD as Chunk['entities'] })], { final: false, delivery: d })
      await run(3000)
      expect(texts()).toEqual(['cd'])
    })

    it('plain text is tried once: a second 400 ends it', async () => {
      fake.fail('sendMessage', 2, badEntities)
      const p = sender.send(CHAT, { text: 'ab', entities: BOLD as Chunk['entities'] })
      await run(5000)
      expect(await p).toBeUndefined()
      expect(writes()).toHaveLength(2)
      expect(writes()[1].body.entities).toBeUndefined()
    })

    it('a 400 with no entities is not resent', async () => {
      fake.fail('sendMessage', 1, badEntities)
      const p = sender.send(CHAT, { text: 'ab' })
      await run(5000)
      expect(await p).toBeUndefined()
      expect(writes()).toHaveLength(1)
    })

    it('card edits fall back as well', async () => {
      const id = sender.send(CHAT, { text: 'card' })
      await run(2000)
      fake.fail('editMessageText', 1, badEntities)
      sender.edit(CHAT, (await id) as number, { text: 'done', entities: [{ type: 'bold', offset: 0, length: 4 }] as Chunk['entities'] })
      await run(3000)
      expect(texts()).toEqual(['done'])
    })
  })

  describe('order', () => {
    it('within a chat, work leaves in the order it came, across retries', async () => {
      fake.fail('sendMessage', 2, FAIL_500)
      sender.sync(CHAT, 't1', [chunk('text')], { final: true, delivery: delivery('t1') })
      void sender.send(CHAT, { text: 'card' })
      sender.sync(CHAT, 't2', [chunk('next')], { final: true, delivery: delivery('t2') })
      await run(30_000, 500)
      expect(texts()).toEqual(['text', 'card', 'next'])
    })

    it('text after a card comes after the card, even when the first sync has not gone yet', async () => {
      fake.fail('sendMessage', 1, limited(5))
      const d = delivery()
      sender.sync(CHAT, 't1', [chunk('before')], { final: false, delivery: d })
      sender.sync(CHAT, 't1', [chunk('before2')], { final: false, delivery: d })
      void sender.send(CHAT, { text: 'card' })
      sender.sync(CHAT, 't1', [chunk('before2'), chunk('after')], { final: true, delivery: d })
      await run(30_000, 500)
      expect(texts()).toEqual(['before2', 'card', 'after'])
      expect(d.done).toBe(true)
    })

    it('two turns with undelivered finals both arrive', async () => {
      fake.fail('sendMessage', 3, limited(1))
      const d1 = delivery('t1')
      const d2 = delivery('t2')
      sender.sync(CHAT, 't1', [chunk('one')], { final: true, delivery: d1 })
      sender.sync(CHAT, 't2', [chunk('two')], { final: true, delivery: d2 })
      await run(30_000, 500)
      expect(texts()).toEqual(['one', 'two'])
      expect(d1.done && d2.done).toBe(true)
    })
  })

  describe('never stalls the caller', () => {
    it('with Telegram hung, sync, send and edit return at once and other chats keep going', async () => {
      fake.fail('sendMessage', 1, 'hang')
      sender.sync('1', 't1', [chunk('stuck')], { final: true, delivery: delivery() })
      await new Promise(r => setTimeout(r, 5))
      const started = Date.now()
      for (let i = 0; i < 50; i++) sender.sync('1', 't1', [chunk(`stuck${i}`)], { final: true, delivery: delivery() })
      void sender.send('1', { text: 'x' })
      sender.edit('1', 1, { text: 'y' })
      expect(Date.now() - started).toBeLessThan(200)

      const fast = sender.send('2', { text: 'free' })
      await expect.poll(() => texts('2')).toEqual(['free'])
      expect(typeof (await fast)).toBe('number')
    })

    it('a request that never answers is timed out by the api, and the final still arrives', async () => {
      fake.fail('sendMessage', 1, 'hang')
      const d = delivery()
      sender.sync(CHAT, 't1', [chunk('final')], { final: true, delivery: d })
      await expect.poll(() => writes().length).toBe(1)
      clock.advance(30_000)
      await run(5000)
      expect(texts()).toEqual(['final'])
    })

    it('an api that throws synchronously or a callback that throws stops nothing', async () => {
      const throwing = new Sender({
        api: {
          call: () => {
            throw new Error('boom')
          },
        },
        now: clock.now,
        timers: clock.timers,
        random: () => 0.5,
        onChange: () => {
          throw new Error('disk full')
        },
        log: { info: () => {}, warn: () => {}, error: () => {} },
      })
      const d = delivery()
      expect(() => throwing.sync(CHAT, 't1', [chunk('x')], { final: false, delivery: d })).not.toThrow()
      const answer = throwing.send(CHAT, { text: 'y' })
      await run(2000)
      await expect(answer).resolves.toBeUndefined()
      throwing.close()

      const onChangeThrows = new Sender({
        api: createApi({ base: fake.base, token: () => TOKEN, timers: clock.timers }),
        now: clock.now,
        timers: clock.timers,
        random: () => 0.5,
        onChange: () => {
          throw new Error('disk full')
        },
        log: { info: () => {}, warn: () => {}, error: () => {} },
      })
      const d2 = delivery()
      onChangeThrows.sync(CHAT, 't1', [chunk('a'), chunk('b')], { final: true, delivery: d2 })
      await expect.poll(() => d2.messageIds.length).toBe(1)
      clock.advance(1100)
      await expect.poll(() => d2.done).toBe(true)
      onChangeThrows.close()
    })
  })

  describe('flush', () => {
    it('returns at once when nothing is queued', async () => {
      await sender.flush(500)
    })

    it('sends what is waiting only for the pace, without waiting for it', async () => {
      const d = delivery()
      sender.sync(CHAT, 't1', [chunk('a')], { final: false, delivery: d })
      await run(100)
      sender.sync(CHAT, 't1', [chunk('b')], { final: true, delivery: d })
      const flushed = sender.flush(500)
      await idle()
      await flushed
      expect(texts()).toEqual(['b'])
      expect(d.done).toBe(true)
    })

    it('is bounded: a hung request or a 429 does not hold it past its time', async () => {
      fake.fail('sendMessage', 1, 'hang')
      sender.sync(CHAT, 't1', [chunk('a')], { final: true, delivery: delivery() })
      await expect.poll(() => writes().length).toBe(1)
      let done = false
      const flushed = sender.flush(500).then(() => void (done = true))
      clock.advance(499)
      await new Promise(r => setImmediate(r))
      expect(done).toBe(false)
      clock.advance(1)
      await flushed
      expect(done).toBe(true)
    })

    it('does not cut a 429 pause short', async () => {
      fake.fail('sendMessage', 1, limited(10))
      sender.sync(CHAT, 't1', [chunk('a')], { final: true, delivery: delivery() })
      await run(100)
      const flushed = sender.flush(500)
      await run(500)
      await flushed
      expect(writes()).toHaveLength(1)
    })
  })

  describe('close and drop', () => {
    it('after close nothing goes out and pending sends resolve', async () => {
      fake.fail('sendMessage', 1, FAIL_500)
      sender.sync(CHAT, 't1', [chunk('a')], { final: true, delivery: delivery() })
      const p = sender.send(CHAT, { text: 'b' })
      await run(100)
      const n = fake.requests.length
      sender.close()
      expect(await p).toBeUndefined()
      await run(10_000, 500)
      expect(fake.requests).toHaveLength(n)
      sender.sync(CHAT, 't1', [chunk('c')], { final: true, delivery: delivery() })
      expect(await sender.send(CHAT, { text: 'd' })).toBeUndefined()
      await run(1000)
      expect(fake.requests).toHaveLength(n)
    })

    it('close during a request leaves the delivery as it was and writes nothing to it', async () => {
      fake.fail('sendMessage', 1, 'hang')
      const d = delivery()
      sender.sync(CHAT, 't1', [chunk('a')], { final: true, delivery: d })
      await expect.poll(() => writes().length).toBe(1)
      sender.close()
      await idle()
      expect(d).toEqual(delivery())
      expect(undelivered).toEqual([])
    })

    it('drop clears one chat only', async () => {
      fake.fail('sendMessage', 1, limited(5))
      fake.fail('sendMessage', 1, limited(5))
      sender.sync('1', 't1', [chunk('a')], { final: true, delivery: delivery() })
      sender.sync('2', 't1', [chunk('b')], { final: true, delivery: delivery() })
      await run(100)
      sender.drop('1')
      await run(6000)
      expect(texts('1')).toEqual([])
      expect(texts('2')).toEqual(['b'])
    })
  })

  describe('one-shot calls and typing', () => {
    it('fire goes out once; a failure stays a code in the log', async () => {
      fake.fail('leaveChat', 1, { status: 500, body: { ok: false, description: 'marker-desc' } })
      sender.fire('leaveChat', { chat_id: '-1' })
      await run(10_000, 500)
      expect(fake.requests.filter(q => q.method === 'leaveChat')).toHaveLength(1)
      expect(logs.join('\n')).not.toContain('marker-desc')
    })

    it('fire honours one 429', async () => {
      fake.fail('answerCallbackQuery', 1, limited(2))
      sender.fire('answerCallbackQuery', { callback_query_id: 'q' })
      await run(1900)
      expect(fake.requests.filter(q => q.method === 'answerCallbackQuery')).toHaveLength(1)
      await run(100)
      expect(fake.requests.filter(q => q.method === 'answerCallbackQuery')).toHaveLength(2)
    })

    it('fire does not wait for a chat, and counts toward the global limit', async () => {
      const chats = Array.from({ length: 30 }, (_, i) => String(i + 1))
      for (const c of chats) void sender.send(c, { text: 'x' })
      sender.fire('leaveChat', { chat_id: '-1' })
      await run(3000)
      const at = fake.requests.map(q => q.at)
      expect(at).toHaveLength(31)
      for (let i = 25; i < at.length; i++) expect(at[i] - at[i - 25]).toBeGreaterThanOrEqual(1000)
    })

    it('typing goes out at most once per 5 s per chat', async () => {
      for (let i = 0; i < 20; i++) {
        sender.typing(CHAT)
        await run(500)
      }
      expect(fake.requests.filter(q => q.method === 'sendChatAction').map(q => q.body.action)).toEqual(['typing', 'typing'])
    })

    it('typing does not push back the next write and is skipped during a pause', async () => {
      sender.typing(CHAT)
      void sender.send(CHAT, { text: 'x' })
      await run(100)
      expect(texts()).toEqual(['x'])

      fake.fail('sendMessage', 1, limited(30))
      void sender.send(CHAT, { text: 'y' })
      await run(1200)
      const before = fake.requests.filter(q => q.method === 'sendChatAction').length
      await run(5000)
      sender.typing(CHAT)
      await run(100)
      expect(fake.requests.filter(q => q.method === 'sendChatAction')).toHaveLength(before)
    })

    it('queue is bounded: past the cap a send resolves undefined, a final still goes', async () => {
      fake.fail('sendMessage', 1, limited(5))
      void sender.send(CHAT, { text: 'first' })
      const over: Promise<number | undefined>[] = []
      for (let i = 0; i < 300; i++) over.push(sender.send(CHAT, { text: `n${i}` }))
      expect(await over[299]).toBeUndefined()
      const d = delivery()
      sender.sync(CHAT, 't1', [chunk('final')], { final: true, delivery: d })
      expect(logs.join('\n')).toContain('queue full')
      await run(300_000, 500)
      expect(d.done).toBe(true)
      await Promise.all(over)
      // 名额都还回来了
      const again = sender.send(CHAT, { text: 'again' })
      await run(2000)
      expect(typeof (await again)).toBe('number')
    })
  })

  it('every send and edit has previews off', async () => {
    const d = delivery()
    sender.sync(CHAT, 't1', [chunk('https://evil/?d=1')], { final: false, delivery: d })
    await run(2000)
    sender.sync(CHAT, 't1', [chunk('https://evil/?d=2')], { final: false, delivery: d })
    await run(2000)
    const id = await sender.send(CHAT, { text: 'card', silent: true })
    await run(2000)
    sender.edit(CHAT, id as number, { text: 'edited' })
    await run(2000)
    fake.fail('sendMessage', 1, badEntities)
    void sender.send(CHAT, { text: 'ab', entities: BOLD as Chunk['entities'] })
    await run(3000)
    const all = writes()
    expect(all.length).toBeGreaterThanOrEqual(6)
    for (const q of all) expect(q.body.link_preview_options).toEqual({ is_disabled: true })
  })

  it('logs hold codes only', async () => {
    const marker = 'marker-text-' + 'z'.repeat(8)
    fake.fail('sendMessage', 1, { status: 500, body: { ok: false, description: marker } })
    fake.fail('sendMessage', 1, { status: 400, body: { ok: false, description: marker } })
    void sender.send(CHAT, { text: marker })
    await run(5000)
    expect(logs.join('\n')).not.toContain(marker)
    expect(logs.join('\n')).not.toContain(TOKEN)
  })
})
