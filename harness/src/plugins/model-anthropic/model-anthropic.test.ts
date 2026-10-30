import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { account, bootAdapters, collect, cutStream, fakeServer, fixture, request, sse, text } from '../../../test/modelPluginHarness'
import modelAnthropic, { createModelAnthropic } from './index'

let servers: Server[] = []
let closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const s of servers) { s.closeAllConnections(); await new Promise((r) => s.close(r)) }
  for (const c of closers) await c()
  servers = []
  closers = []
})
async function setup(handler: Parameters<typeof fakeServer>[0], probeTimeoutMs?: number) {
  const f = await fakeServer(handler)
  servers.push(f.server)
  const b = await bootAdapters(probeTimeoutMs ? createModelAnthropic({ probeTimeoutMs }) : modelAnthropic)
  closers.push(b.close)
  return { ...f, adapter: b.adapters.get('anthropic')!, adapters: b.adapters }
}
const acc = (base: string, extra = {}) => account('anthropic', base, extra)

describe('model-anthropic', () => {
  it('注册 anthropic 协议', async () => {
    const { adapters } = await setup((_q, r) => r.end())
    expect([...adapters.keys()]).toEqual(['anthropic'])
  })

  it('流式:/v1/messages(兼容厂商前缀)、只有一个认证头', async () => {
    const { base, seen, adapter } = await setup((_q, r, _s) => sse(r, fixture('anthropic-text.txt')))
    const evs = await collect(adapter.stream(acc(base + '/apps/anthropic/'), request()))
    expect(text(evs).length).toBeGreaterThan(0)
    expect(evs.at(-1)).toMatchObject({ type: 'done', reason: 'stop' })
    expect(seen[0].method).toBe('POST')
    expect(seen[0].url).toBe('/apps/anthropic/v1/messages')
    expect(seen[0].headers['x-api-key']).toBe('sk-test')
    expect(seen[0].headers.authorization).toBeUndefined()
    expect(seen[0].headers['anthropic-version']).toBe('2023-06-01')
    expect(seen[0].headers.accept).toBe('text/event-stream')
    const body = JSON.parse(seen[0].body)
    expect(body.model).toBe('m1')
    expect(body.stream).toBe(true)
  })

  it('401 → auth', async () => {
    const { base, adapter } = await setup((_q, r) => { r.writeHead(401, { 'content-type': 'application/json' }); r.end('{"type":"error","error":{"type":"authentication_error","message":"nope"}}') })
    const evs = await collect(adapter.stream(acc(base), request()))
    expect(evs).toEqual([{ type: 'done', reason: 'error', error: { kind: 'auth', message: 'nope', retryable: false } }])
  })

  it('429 + retry-after → rate_limit + retryAfterMs', async () => {
    const { base, adapter } = await setup((_q, r) => { r.writeHead(429, { 'retry-after': '7' }); r.end('{}') })
    const evs = await collect(adapter.stream(acc(base), request()))
    expect(evs.at(-1)).toMatchObject({ type: 'done', reason: 'error', error: { kind: 'rate_limit', retryAfterMs: 7000 } })
  })

  it('流中取消 → cancelled', async () => {
    const { base, adapter } = await setup((_q, r) => { r.writeHead(200, { 'content-type': 'text/event-stream' }); r.write(fixture('anthropic-cut.txt')) })
    const ac = new AbortController()
    const evs: unknown[] = []
    for await (const e of adapter.stream(acc(base), request(ac.signal))) {
      evs.push(e)
      if ((e as { type: string }).type === 'text') ac.abort()
    }
    expect(evs.at(-1)).toEqual({ type: 'done', reason: 'cancelled' })
  })

  it('服务端中途断连 → 部分文本后 network 错误', async () => {
    const { base, adapter } = await setup((q, r) => cutStream(q, r, fixture('anthropic-cut.txt')))
    const evs = await collect(adapter.stream(acc(base), request()))
    expect(text(evs).length).toBeGreaterThan(0)
    expect(evs.at(-1)).toMatchObject({ type: 'done', reason: 'error', error: { kind: 'network' } })
  })

  it('test() 与 listModels() 走 GET /v1/models,只发 x-api-key', async () => {
    const { base, seen, adapter } = await setup((_q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end('{"data":[{"id":"claude-a","display_name":"Claude A"}]}') })
    await adapter.test(acc(base))
    expect(await adapter.listModels!(acc(base))).toEqual([{ id: 'claude-a', name: 'Claude A' }])
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['GET /v1/models', 'GET /v1/models'])
    expect(seen[0].headers['x-api-key']).toBe('sk-test')
    expect(seen[0].headers.authorization).toBeUndefined()
  })

  it('test():/v1/models 404 → 退回 1 token 流式请求,2xx 即通过', async () => {
    const { base, seen, adapter } = await setup((q, r) => {
      if (q.method === 'GET') { r.writeHead(404); return r.end() }
      sse(r, fixture('anthropic-text.txt'))
    })
    await adapter.test(acc(base))
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['GET /v1/models', 'POST /v1/messages'])
    const body = JSON.parse(seen[1].body)
    expect(body.max_tokens).toBe(1)
    expect(body.stream).toBe(true)
    expect(seen[1].headers.authorization).toBeUndefined()
  })

  it('开流前取消 → cancelled', async () => {
    const { base, adapter } = await setup((_q, r) => r.end())
    const ac = new AbortController()
    ac.abort()
    expect(await collect(adapter.stream(acc(base), request(ac.signal)))).toEqual([{ type: 'done', reason: 'cancelled' }])
  })

  it('test() 回退用 account.testModel;400 模型无效视为通过', async () => {
    const { base, seen, adapter } = await setup((q, r) => {
      if (q.method === 'GET') { r.writeHead(404); return r.end() }
      r.writeHead(400); r.end('{"type":"error","error":{"type":"invalid_request_error","message":"model: unknown"}}')
    })
    await adapter.test(acc(base, { testModel: 'glm-x' }))
    expect(JSON.parse(seen[1].body).model).toBe('glm-x')
  })

  it('test() 回退:只发头不发体 → 超时失败而不是挂起', async () => {
    const { base, adapter } = await setup((q, r) => { if (q.method === 'GET') { r.writeHead(404); return r.end() } r.writeHead(200, { 'content-type': 'text/event-stream' }); r.flushHeaders() }, 100)
    await expect(adapter.test(acc(base))).rejects.toMatchObject({ error: { kind: 'network' } })
  })

  it('test() 404 后回退请求 401 → 抛 auth', async () => {
    const { base, adapter } = await setup((q, r) => { r.writeHead(q.method === 'GET' ? 404 : 401); r.end() })
    await expect(adapter.test(acc(base))).rejects.toMatchObject({ error: { kind: 'auth' } })
  })
})
