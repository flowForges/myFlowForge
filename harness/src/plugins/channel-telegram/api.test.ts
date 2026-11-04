import { inspect } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeClock } from '../../../test/memoryRig'
import { startFakeTelegram, type FakeReply, type FakeTelegram } from '../../../test/fakeTelegram'
import { createApi, MAX_BODY_BYTES, TelegramError } from './api'

const TOKEN = '123456789:' + 'A'.repeat(35)

/** 错误的每一种写出来的样子:只要带令牌,哪条路都算漏 */
function allForms(e: unknown): string {
  const err = e as Error
  return [String(err), err.message, err.stack, JSON.stringify(err), inspect(err, { showHidden: true, depth: 10 })].join('\n')
}

async function failure(p: Promise<unknown>): Promise<TelegramError> {
  const e = await p.then(
    () => {
      throw new Error('expected a rejection')
    },
    (err: unknown) => err,
  )
  expect(e).toBeInstanceOf(TelegramError)
  return e as TelegramError
}

function expectClean(e: TelegramError) {
  expect(allForms(e)).not.toContain(TOKEN)
  expect(allForms(e)).not.toContain('/bot')
  expect('cause' in e).toBe(false)
  expect(e.message).toBe(e.code)
}

describe('api', () => {
  let fake: FakeTelegram
  beforeEach(async () => {
    fake = await startFakeTelegram({ token: TOKEN })
  })
  afterEach(() => fake.close())
  const api = () => createApi({ base: fake.base, token: () => TOKEN })

  it('POST JSON 到 /bot<token>/<method>,回 result', async () => {
    const me = await api().call<{ id: number; username: string }>('getMe', {})
    expect(me).toEqual({ id: 123456789, is_bot: true, first_name: 'Fake', username: 'fake_bot' })
    await api().call('sendMessage', { chat_id: 1, text: 'hi' })
    expect(fake.requests.at(-1)).toMatchObject({ method: 'sendMessage', path: `/bot${TOKEN}/sendMessage`, body: { chat_id: 1, text: 'hi' } })
  })

  it('fetch 的参数:POST、JSON、redirect:error、带 signal', async () => {
    const seen: [unknown, RequestInit | undefined][] = []
    const fetchStub = (async (url: unknown, init?: RequestInit) => {
      seen.push([url, init])
      return new Response('{"ok":true,"result":1}')
    }) as typeof fetch
    await createApi({ base: 'http://t.invalid', token: () => TOKEN, fetch: fetchStub }).call('getMe', { a: 1 })
    const [url, init] = seen[0]
    expect(url).toBe(`http://t.invalid/bot${TOKEN}/getMe`)
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', body: '{"a":1}' })
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  const rows: { name: string; reply: FakeReply; code: TelegramError['code']; retryAfter?: number }[] = [
    { name: '401', reply: { status: 401, body: { ok: false, description: 'Unauthorized' } }, code: 'unauthorized' },
    { name: '404', reply: { status: 404, body: { ok: false, description: 'Not Found' } }, code: 'unauthorized' },
    { name: '409 webhook', reply: { status: 409, body: { ok: false, description: "Conflict: can't use getUpdates method while webhook is active" } }, code: 'conflict_webhook' },
    { name: '409 其他', reply: { status: 409, body: { ok: false, description: 'Conflict: terminated by other getUpdates request' } }, code: 'conflict_other' },
    { name: '409 没有 description', reply: { status: 409, body: {} }, code: 'conflict_other' },
    { name: '429 retry_after', reply: { status: 429, body: { ok: false, parameters: { retry_after: 7 } } }, code: 'rate_limited', retryAfter: 7 },
    { name: '429 没有 retry_after', reply: { status: 429, body: { ok: false } }, code: 'rate_limited' },
    { name: '429 retry_after 不是正数', reply: { status: 429, body: { parameters: { retry_after: -1 } } }, code: 'rate_limited' },
    { name: '429 retry_after 是字符串', reply: { status: 429, body: { parameters: { retry_after: '7' } } }, code: 'rate_limited' },
    { name: '500', reply: { status: 500 }, code: 'server' },
    { name: '502', reply: { status: 502 }, code: 'server' },
    { name: '400 not modified', reply: { status: 400, body: { ok: false, description: 'Bad Request: message is not modified: specified new message content' } }, code: 'not_modified' },
    { name: '400 找不到消息', reply: { status: 400, body: { ok: false, description: 'Bad Request: message to edit not found' } }, code: 'not_found_message' },
    { name: '400 其他', reply: { status: 400, body: { ok: false, description: "Bad Request: can't parse entities" } }, code: 'bad_request' },
    { name: '403', reply: { status: 403, body: { ok: false, description: 'Forbidden: bot was blocked by the user' } }, code: 'blocked' },
    { name: '其他 4xx', reply: { status: 418, body: {} }, code: 'bad_request' },
    { name: '连接被掐', reply: 'drop', code: 'network' },
    { name: '200 但 ok:false', reply: { status: 200, body: { ok: false } }, code: 'server' },
    { name: '200 但没有 result', reply: { status: 200, body: { ok: true } }, code: 'server' },
  ]
  for (const row of rows) {
    it(`状态表:${row.name} → ${row.code}`, async () => {
      fake.fail('getMe', 1, row.reply)
      const e = await failure(api().call('getMe', {}))
      expect(e.code).toBe(row.code)
      expect(e.retryAfter).toBe(row.retryAfter)
      expectClean(e)
    })
  }

  it('result 是 false 也算成功', async () => {
    fake.fail('getMe', 1, { status: 200, body: { ok: true, result: false } })
    await expect(api().call('getMe', {})).resolves.toBe(false)
  })

  it('Telegram 够不到 → network', async () => {
    fake.offline = true
    const e = await failure(api().call('getMe', {}))
    expect(e.code).toBe('network')
    expectClean(e)
  })

  for (const [name, status, code] of [
    ['200 → server', 200, 'server'],
    ['500 → server', 500, 'server'],
    ['401 → unauthorized', 401, 'unauthorized'],
  ] as const) {
    it(`正文不是 JSON,解析错误里的内容也带不出来:${name}`, async () => {
      const fetchStub = (async () => new Response(`<html>${TOKEN}`, { status })) as typeof fetch
      const e = await failure(createApi({ base: 'http://t.invalid', token: () => TOKEN, fetch: fetchStub }).call('getMe', {}))
      expect(e.code).toBe(code)
      expectClean(e)
    })
  }

  it('正文是 null、数组、数字:宽松解析,不抛别的', async () => {
    for (const text of ['null', '[]', '3', '""']) {
      const fetchStub = (async () => new Response(text, { status: 400 })) as typeof fetch
      const e = await failure(createApi({ base: 'http://t.invalid', token: () => TOKEN, fetch: fetchStub }).call('getMe', {}))
      expect(e.code).toBe('bad_request')
    }
  })

  for (const status of [400, 401, 403, 404, 409, 429, 500]) {
    it(`假服务器把 URL 写进 description(${status}),错误里没有`, async () => {
      fake.fail('getMe', 1, { status, body: { ok: false, description: `oops ${fake.base}/bot${TOKEN}/getMe`, parameters: { retry_after: 1 } } })
      expectClean(await failure(api().call('getMe', {})))
    })
  }

  it('fetch 抛的错把 URL 写进 message、cause、stack:一个字都出不来', async () => {
    const throwing = (async (url: unknown) => {
      const e = new TypeError(`fetch failed: ${String(url)}`, { cause: new Error(`connect ${String(url)}`) })
      e.stack = `TypeError: ${String(url)}\n    at ${String(url)}`
      throw e
    }) as typeof fetch
    const e = await failure(createApi({ base: 'http://t.invalid', token: () => TOKEN, fetch: throwing }).call('getMe', {}))
    expect(e.code).toBe('network')
    expectClean(e)
  })

  it('fetch 同步抛错:同样', async () => {
    const throwing = ((url: unknown) => {
      throw new TypeError(`Invalid URL: ${String(url)}`)
    }) as typeof fetch
    const e = await failure(createApi({ base: 'http://t.invalid', token: () => TOKEN, fetch: throwing }).call('getMe', {}))
    expect(e.code).toBe('network')
    expectClean(e)
  })

  it('读正文时断了,错里带 URL:同样', async () => {
    const res = (url: unknown) => {
      return new Response(
        new ReadableStream({
          pull(c) {
            c.error(new TypeError(`terminated ${String(url)}`))
          },
        }),
      )
    }
    const e = await failure(createApi({ base: 'http://t.invalid', token: () => TOKEN, fetch: (async (u: unknown) => res(u)) as typeof fetch }).call('getMe', {}))
    expect(e.code).toBe('network')
    expectClean(e)
  })

  it('不留 Response:结果是普通数据,客户端身上找不到令牌', async () => {
    let held: Response | undefined
    const fetchStub = (async (url: unknown) => {
      held = new Response('{"ok":true,"result":{"id":1}}')
      Object.defineProperty(held, 'url', { value: String(url) })
      return held
    }) as typeof fetch
    const client = createApi({ base: 'http://t.invalid', token: () => TOKEN, fetch: fetchStub })
    const result = await client.call('getMe', {})
    expect(held?.url).toContain(TOKEN)
    expect(result).toEqual({ id: 1 })
    expect(inspect(client, { showHidden: true, depth: 10 })).not.toContain(TOKEN)
  })

  it('302:network,跳转目标收不到请求,令牌不跟过去', async () => {
    const target = await startFakeTelegram({ token: TOKEN })
    try {
      fake.fail('getMe', 1, { status: 302, headers: { Location: `${target.base}/bot${TOKEN}/getMe` } })
      const e = await failure(api().call('getMe', {}))
      expect(e.code).toBe('network')
      expectClean(e)
      expect(target.requests).toEqual([])
    } finally {
      await target.close()
    }
  })

  it('注入的 fetch 没按 redirect:error 走、回了 3xx:也算 network', async () => {
    const fetchStub = (async () => new Response(null, { status: 302 })) as typeof fetch
    const e = await failure(createApi({ base: 'http://t.invalid', token: () => TOKEN, fetch: fetchStub }).call('getMe', {}))
    expect(e.code).toBe('network')
  })

  it('没令牌:一个请求都不发', async () => {
    const e = await failure(createApi({ base: fake.base, token: () => undefined }).call('getMe', {}))
    expect(e.code).toBe('unauthorized')
    expect(fake.requests).toEqual([])
  })

  it('取令牌抛错:错里的内容带不出来,不发请求', async () => {
    const e = await failure(
      createApi({
        base: fake.base,
        token: () => {
          throw new Error(TOKEN)
        },
      }).call('getMe', {}),
    )
    expect(e.code).toBe('unauthorized')
    expectClean(e)
    expect(fake.requests).toEqual([])
  })

  it('请求体序列化不了:bad_request,不发请求', async () => {
    const loop: Record<string, unknown> = {}
    loop.self = loop
    const e = await failure(api().call('sendMessage', loop))
    expect(e.code).toBe('bad_request')
    expect(fake.requests).toEqual([])
  })

  it('超时走注入的定时器,算 network', async () => {
    const clock = fakeClock()
    fake.fail('getMe', 1, 'hang')
    const client = createApi({ base: fake.base, token: () => TOKEN, timeoutMs: 30_000, timers: clock.timers })
    const pending = failure(client.call('getMe', {}))
    await expect.poll(() => fake.requests.length).toBe(1)
    clock.advance(29_999)
    let settled = false
    void pending.then(() => (settled = true))
    await new Promise(r => setImmediate(r))
    expect(settled).toBe(false)
    clock.advance(1)
    const e = await pending
    expect(e.code).toBe('network')
    expectClean(e)
  })

  it('每次调用可以给自己的超时', async () => {
    const clock = fakeClock()
    fake.fail('getMe', 1, 'hang')
    const client = createApi({ base: fake.base, token: () => TOKEN, timers: clock.timers })
    const pending = failure(client.call('getMe', {}, { timeoutMs: 65_000 }))
    await expect.poll(() => fake.requests.length).toBe(1)
    clock.advance(65_000)
    expect((await pending).code).toBe('network')
  })

  it('调用方取消 → aborted;已经取消的不发请求', async () => {
    fake.fail('getMe', 1, 'hang')
    const ctl = new AbortController()
    const pending = failure(api().call('getMe', {}, { signal: ctl.signal }))
    await expect.poll(() => fake.requests.length).toBe(1)
    ctl.abort(new Error(TOKEN))
    const e = await pending
    expect(e.code).toBe('aborted')
    expectClean(e)
    const before = fake.requests.length
    expect((await failure(api().call('getMe', {}, { signal: ctl.signal }))).code).toBe('aborted')
    expect(fake.requests.length).toBe(before)
  })

  it('不认 signal 的 fetch 也挡不住超时;它之后的 rejection 不会变成未处理', async () => {
    const clock = fakeClock()
    let rejectLate: (e: Error) => void = () => {}
    const fetchStub = (() => new Promise((_, reject) => (rejectLate = reject))) as typeof fetch
    const pending = failure(createApi({ base: 'http://t.invalid', token: () => TOKEN, fetch: fetchStub, timers: clock.timers }).call('getMe', {}))
    await new Promise(r => setImmediate(r))
    clock.advance(30_000)
    expect((await pending).code).toBe('network')
    rejectLate(new Error(TOKEN))
    await new Promise(r => setImmediate(r))
  })

  it('成功、失败之后都不留定时器和监听', async () => {
    const pendingTimers = new Set<object>()
    const timers = {
      setTimeout: () => {
        const h = {}
        pendingTimers.add(h)
        return h
      },
      clearTimeout: (h: object) => void pendingTimers.delete(h),
    }
    const ctl = new AbortController()
    let listeners = 0
    const add = ctl.signal.addEventListener.bind(ctl.signal)
    const remove = ctl.signal.removeEventListener.bind(ctl.signal)
    ctl.signal.addEventListener = ((...a: Parameters<typeof add>) => (listeners++, add(...a))) as typeof add
    ctl.signal.removeEventListener = ((...a: Parameters<typeof remove>) => (listeners--, remove(...a))) as typeof remove
    const client = createApi({ base: fake.base, token: () => TOKEN, timers })
    await client.call('getMe', {}, { signal: ctl.signal })
    fake.fail('getMe', 1, { status: 500 })
    await failure(client.call('getMe', {}, { signal: ctl.signal }))
    expect(pendingTimers.size).toBe(0)
    expect(listeners).toBe(0)
  })

  describe('正文上限', () => {
    /** 要多少给多少,记下实际读走了多少、有没有被取消 */
    const endless = () => {
      const seen = { bytes: 0, cancelled: false }
      const chunk = new Uint8Array(1024 * 1024).fill(0x20)
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          seen.bytes += chunk.byteLength
          c.enqueue(chunk)
        },
        cancel() {
          seen.cancelled = true
        },
      })
      return { seen, fetchStub: (async () => new Response(body)) as typeof fetch }
    }

    it('没完没了的正文:读到上限就停,取消读取,network', async () => {
      const { seen, fetchStub } = endless()
      const e = await failure(createApi({ base: 'http://t.invalid', token: () => TOKEN, fetch: fetchStub }).call('getMe', {}))
      expect(e.code).toBe('network')
      expectClean(e)
      expect(seen.bytes).toBeLessThanOrEqual(MAX_BODY_BYTES + 2 * 1024 * 1024)
      expect(seen.cancelled).toBe(true)
    })

    it('上限以内的大正文照常,多字节字符跨块也不坏', async () => {
      const text = '中'.repeat(1000)
      const bytes = Buffer.from(JSON.stringify({ ok: true, result: text }))
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          // 从一个字符中间切开
          c.enqueue(bytes.subarray(0, 20))
          c.enqueue(bytes.subarray(20))
          c.close()
        },
      })
      const fetchStub = (async () => new Response(body)) as typeof fetch
      await expect(createApi({ base: 'http://t.invalid', token: () => TOKEN, fetch: fetchStub }).call('getMe', {})).resolves.toBe(text)
    })
  })

  it('很小的 retry_after 抬到 1 s:0.001 不能变成 1 ms 的空转', async () => {
    fake.fail('getMe', 1, { status: 429, body: { parameters: { retry_after: 0.001 } } })
    expect((await failure(api().call('getMe', {}))).retryAfter).toBe(1)
    fake.fail('getMe', 1, { status: 429, body: { parameters: { retry_after: 7 } } })
    expect((await failure(api().call('getMe', {}))).retryAfter).toBe(7)
  })

  it('TelegramError 只有 code 和 retryAfter', () => {
    const e = new TelegramError('rate_limited', 3)
    expect(Object.keys(e).sort()).toEqual(['code', 'retryAfter'])
    expect(Object.keys(new TelegramError('server'))).toEqual(['code'])
  })
})
