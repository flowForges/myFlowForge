import { describe, expect, it } from 'vitest'
import { probeQuota } from './quota'

type Call = { url: string; headers: Record<string, string> }
function fakeFetch(status: number, body: unknown, calls: Call[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()) })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }) as typeof fetch
}

describe('probeQuota', () => {
  it('zhipu: 裸 key 放 Authorization,解析 limits[]', async () => {
    const calls: Call[] = []
    const body = {
      code: 200,
      success: true,
      data: {
        limits: [
          { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 12, nextResetTime: 1798000000000 },
          { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 1000, currentValue: 250, nextResetTime: 1798000000 },
        ],
      },
    }
    const r = await probeQuota('zhipu', { baseUrl: 'https://open.bigmodel.cn/api/anthropic', apiKey: 'zk-1', fetch: fakeFetch(200, body, calls) })
    expect(calls[0].url).toBe('https://open.bigmodel.cn/api/monitor/usage/quota/limit')
    expect(calls[0].headers.authorization).toBe('zk-1')
    expect(r).toEqual({
      quota: {
        windows: [
          { label: '5h', usedPercent: 12, resetsAt: 1798000000000 },
          { label: '1mo', usedPercent: 25, resetsAt: 1798000000000 },
        ],
      },
    })
  })

  it('kimi: Bearer {coding base}/usages,字符串数字', async () => {
    const calls: Call[] = []
    const body = {
      usage: { limit: '100', used: '40', remaining: '60', resetTime: '2026-11-02T00:00:00Z' },
      limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '50', remaining: '45', resetTime: '2026-10-30T05:00:00Z' } }],
    }
    const r = await probeQuota('kimi', { baseUrl: 'https://api.kimi.com/coding/v1/', apiKey: 'kk', fetch: fakeFetch(200, body, calls) })
    expect(calls[0].url).toBe('https://api.kimi.com/coding/v1/usages')
    expect(calls[0].headers.authorization).toBe('Bearer kk')
    expect(r).toEqual({
      quota: {
        windows: [
          { label: 'total', usedPercent: 40, resetsAt: Date.parse('2026-11-02T00:00:00Z') },
          { label: '5h', usedPercent: 10, resetsAt: Date.parse('2026-10-30T05:00:00Z') },
        ],
      },
    })
  })

  it('minimax: Bearer /v1/token_plan/remains,解析 model_remains', async () => {
    const calls: Call[] = []
    const body = {
      model_remains: [{ model_name: 'MiniMax-M3', current_interval_total_count: 1500, current_interval_usage_count: 300, end_time: 1798000000000 }],
      base_resp: { status_code: 0, status_msg: 'success' },
    }
    const r = await probeQuota('minimax', { baseUrl: 'https://api.minimaxi.com/anthropic', apiKey: 'mk', fetch: fakeFetch(200, body, calls) })
    expect(calls[0].url).toBe('https://api.minimaxi.com/v1/token_plan/remains')
    expect(calls[0].headers.authorization).toBe('Bearer mk')
    expect(r).toEqual({ quota: { windows: [{ label: 'MiniMax-M3', usedPercent: 20, resetsAt: 1798000000000 }] } })
  })

  it('minimax: HTTP 200 但 base_resp 报错 → null + authFailed', async () => {
    const body = { base_resp: { status_code: 1004, status_msg: 'login fail: invalid api key' } }
    const r = await probeQuota('minimax', { baseUrl: 'https://api.minimax.io/v1', apiKey: 'bad', fetch: fakeFetch(200, body) })
    expect(r).toEqual({ quota: null, authFailed: true })
  })

  it('401 → null + authFailed;未知形状 / 非 JSON / 网络错误 → null', async () => {
    expect(await probeQuota('kimi', { baseUrl: 'https://x/v1', apiKey: 'k', fetch: fakeFetch(401, {}) })).toEqual({ quota: null, authFailed: true })
    expect(await probeQuota('zhipu', { baseUrl: 'https://x', apiKey: 'k', fetch: fakeFetch(200, { data: { nope: 1 } }) })).toEqual({ quota: null })
    expect(await probeQuota('kimi', { baseUrl: 'https://x/v1', apiKey: 'k', fetch: fakeFetch(200, '<html>') })).toEqual({ quota: null })
    expect(await probeQuota('zhipu', { baseUrl: 'https://x', apiKey: 'k', fetch: fakeFetch(500, 'oops') })).toEqual({ quota: null })
    const boom = (async () => { throw new Error('ECONNRESET') }) as typeof fetch
    expect(await probeQuota('minimax', { baseUrl: 'https://x', apiKey: 'k', fetch: boom })).toEqual({ quota: null })
  })
})
