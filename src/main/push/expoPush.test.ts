import { describe, it, expect, vi } from 'vitest'
import { sendExpoPush, isExpoPushToken, chunk, EXPO_BATCH, EXPO_PUSH_URL, type ExpoMessage } from './expoPush'

const msg = (to: string): ExpoMessage => ({ to, title: 't', body: 'b' })
const TOK = (n: number | string) => `ExponentPushToken[${n}]`

const okJson = (tickets: unknown[]) => ({
  ok: true,
  status: 200,
  json: async () => ({ data: tickets }),
}) as unknown as Response

describe('isExpoPushToken', () => {
  it('认 Exponent 和 Expo 两种前缀', () => {
    expect(isExpoPushToken('ExponentPushToken[abc]')).toBe(true)
    expect(isExpoPushToken('ExpoPushToken[abc]')).toBe(true)
  })
  it('两头带空白也认', () => {
    expect(isExpoPushToken('  ExponentPushToken[abc]  ')).toBe(true)
  })
  it('别的一律不认', () => {
    for (const bad of ['', 'abc', 'ExponentPushToken[]', 'ExponentPushToken[a b]', 'fcm:abc', 'ExponentPushToken[a]x'])
      expect(isExpoPushToken(bad)).toBe(false)
  })
})

describe('chunk', () => {
  it('切得刚好和切不齐都对', () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]])
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]])
    expect(chunk([], 2)).toEqual([])
  })
})

describe('sendExpoPush', () => {
  it('全部成功', async () => {
    const f = vi.fn(async (_u: string, _init: RequestInit) => okJson([{ status: 'ok' }, { status: 'ok' }]))
    const r = await sendExpoPush([msg(TOK(1)), msg(TOK(2))], { fetchImpl: f as never })
    expect(r).toEqual({ sent: 2, failed: 0, dropTokens: [], errors: [] })
    expect(f).toHaveBeenCalledTimes(1)
    expect(f.mock.calls[0]![0]).toBe(EXPO_PUSH_URL)
  })

  it('★DeviceNotRegistered 的令牌要摘掉 —— 再推一万次也是这个结果', async () => {
    const f = vi.fn(async () => okJson([
      { status: 'error', message: '没这设备', details: { error: 'DeviceNotRegistered' } },
      { status: 'ok' },
    ]))
    const r = await sendExpoPush([msg(TOK(1)), msg(TOK(2))], { fetchImpl: f as never })
    expect(r.dropTokens).toEqual([TOK(1)])
    expect(r.sent).toBe(1)
    expect(r.failed).toBe(1)
  })

  it('★别的错误不摘令牌(比如 MessageRateExceeded,过会儿还能用)', async () => {
    const f = vi.fn(async () => okJson([{ status: 'error', message: '太快了', details: { error: 'MessageRateExceeded' } }]))
    const r = await sendExpoPush([msg(TOK(1))], { fetchImpl: f as never })
    expect(r.dropTokens).toEqual([])
    expect(r.failed).toBe(1)
  })

  it('★格式不对的令牌根本不发出去,而且当场摘掉', async () => {
    const f = vi.fn(async (_u: string, _init: RequestInit) => okJson([{ status: 'ok' }]))
    const r = await sendExpoPush([msg('垃圾令牌'), msg(TOK(1))], { fetchImpl: f as never })
    expect(r.dropTokens).toEqual(['垃圾令牌'])
    expect(r.sent).toBe(1)
    // 只有合法的那一条被真的发出去 —— 整批被 Expo 拒掉是最难查的一种「推送全没了」
    const body = JSON.parse((f.mock.calls[0]![1] as RequestInit).body as string)
    expect(body).toHaveLength(1)
    expect(body[0].to).toBe(TOK(1))
  })

  it('一条合法的都没有时压根不联网', async () => {
    const f = vi.fn()
    const r = await sendExpoPush([msg('x')], { fetchImpl: f as never })
    expect(f).not.toHaveBeenCalled()
    expect(r.failed).toBe(1)
  })

  it(`超过 ${EXPO_BATCH} 条要分批 —— 多了 Expo 会整个请求报错`, async () => {
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      const n = JSON.parse(init.body as string).length
      return okJson(Array.from({ length: n }, () => ({ status: 'ok' })))
    })
    const many = Array.from({ length: EXPO_BATCH + 5 }, (_, i) => msg(TOK(i)))
    const r = await sendExpoPush(many, { fetchImpl: f as never })
    expect(f).toHaveBeenCalledTimes(2)
    expect(JSON.parse((f.mock.calls[0]![1] as RequestInit).body as string)).toHaveLength(EXPO_BATCH)
    expect(JSON.parse((f.mock.calls[1]![1] as RequestInit).body as string)).toHaveLength(5)
    expect(r.sent).toBe(EXPO_BATCH + 5)
  })

  it('HTTP 不是 2xx 时整批算失败,但不抛', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) }) as unknown as Response)
    const r = await sendExpoPush([msg(TOK(1))], { fetchImpl: f as never })
    expect(r.failed).toBe(1)
    expect(r.errors[0]).toContain('502')
  })

  it('请求级 errors 时整批算失败', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ errors: [{ message: '密钥不对' }] }) }) as unknown as Response)
    const r = await sendExpoPush([msg(TOK(1))], { fetchImpl: f as never })
    expect(r.failed).toBe(1)
    expect(r.errors).toContain('密钥不对')
  })

  it('★票据少回了几条时,少的那些算失败 —— 绝不拿别人的票据当自己的结果', async () => {
    // 拿错票据的后果是摘错令牌:把一台好设备当成「app 已卸载」永久摘掉。
    const f = vi.fn(async () => okJson([{ status: 'error', details: { error: 'DeviceNotRegistered' } }]))
    const r = await sendExpoPush([msg(TOK(1)), msg(TOK(2))], { fetchImpl: f as never })
    expect(r.dropTokens).toEqual([TOK(1)])
    expect(r.failed).toBe(2)
  })

  it('fetch 抛出来时不往外抛,压成一行错误', async () => {
    const f = vi.fn(async () => { throw new Error('ENOTFOUND') })
    const r = await sendExpoPush([msg(TOK(1))], { fetchImpl: f as never })
    expect(r.failed).toBe(1)
    expect(r.errors[0]).toContain('ENOTFOUND')
  })

  it('json 解析失败时也不抛', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json') } }) as unknown as Response)
    const r = await sendExpoPush([msg(TOK(1))], { fetchImpl: f as never })
    expect(r.failed).toBe(1)
  })

  it('一批炸了不影响下一批', async () => {
    let n = 0
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      const len = JSON.parse(init.body as string).length
      if (n++ === 0) throw new Error('网络抖了一下')
      return okJson(Array.from({ length: len }, () => ({ status: 'ok' })))
    })
    const many = Array.from({ length: EXPO_BATCH + 3 }, (_, i) => msg(TOK(i)))
    const r = await sendExpoPush(many, { fetchImpl: f as never })
    expect(r.failed).toBe(EXPO_BATCH)
    expect(r.sent).toBe(3)
  })

  it('空清单直接回,不联网', async () => {
    const f = vi.fn()
    expect(await sendExpoPush([], { fetchImpl: f as never })).toEqual({ sent: 0, failed: 0, dropTokens: [], errors: [] })
    expect(f).not.toHaveBeenCalled()
  })
})
