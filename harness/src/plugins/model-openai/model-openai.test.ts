import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { account, bootAdapters, collect, cutStream, fakeServer, fixture, request, sse, text } from '../../../test/modelPluginHarness'
import modelOpenai, { createModelOpenai } from './index'

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
  const b = await bootAdapters(probeTimeoutMs ? createModelOpenai({ probeTimeoutMs }) : modelOpenai)
  closers.push(b.close)
  return { ...f, adapters: b.adapters }
}
const cases = [
  { protocol: 'openai-chat', path: '/chat/completions', ok: 'chat-text.txt', cut: 'chat-cut.txt' },
  { protocol: 'openai-responses', path: '/responses', ok: 'responses-text.txt', cut: 'responses-cut.txt' },
] as const

describe('model-openai', () => {
  it('注册两个协议', async () => {
    const { adapters } = await setup((_q, r) => r.end())
    expect([...adapters.keys()].sort()).toEqual(['openai-chat', 'openai-responses'])
  })

  for (const c of cases) {
    describe(c.protocol, () => {
      it('流式:路径、头、体正确,文本解码', async () => {
        const { base, seen, adapters } = await setup((_q, r) => sse(r, fixture(c.ok)))
        const evs = await collect(adapters.get(c.protocol)!.stream(account(c.protocol, base + '/v1/'), request()))
        expect(text(evs)).toContain('你好')
        expect(evs.at(-1)).toMatchObject({ type: 'done', reason: 'stop' })
        expect(seen[0].method).toBe('POST')
        expect(seen[0].url).toBe('/v1' + c.path)
        expect(seen[0].headers.authorization).toBe('Bearer sk-test')
        expect(seen[0].headers['content-type']).toBe('application/json')
        expect(seen[0].headers.accept).toBe('text/event-stream')
        const body = JSON.parse(seen[0].body)
        expect(body.model).toBe('m1')
        expect(body.stream).toBe(true)
        if (c.protocol === 'openai-responses') {
          expect(body.store).toBe(false)
          expect(body.include).toEqual(['reasoning.encrypted_content'])
        }
      })

      it('401 → auth', async () => {
        const { base, adapters } = await setup((_q, r) => { r.writeHead(401, { 'content-type': 'application/json' }); r.end('{"error":{"message":"bad key"}}') })
        const evs = await collect(adapters.get(c.protocol)!.stream(account(c.protocol, base), request()))
        expect(evs).toEqual([{ type: 'done', reason: 'error', error: { kind: 'auth', message: 'bad key', retryable: false } }])
      })

      it('429 + retry-after → rate_limit + retryAfterMs', async () => {
        const { base, adapters } = await setup((_q, r) => { r.writeHead(429, { 'retry-after': '3' }); r.end('{}') })
        const evs = await collect(adapters.get(c.protocol)!.stream(account(c.protocol, base), request()))
        expect(evs.at(-1)).toMatchObject({ type: 'done', reason: 'error', error: { kind: 'rate_limit', retryable: true, retryAfterMs: 3000 } })
      })

      it('流中取消 → cancelled', async () => {
        const { base, adapters } = await setup((_q, r) => { r.writeHead(200, { 'content-type': 'text/event-stream' }); r.write(fixture(c.cut)) })
        const ac = new AbortController()
        const evs: unknown[] = []
        for await (const e of adapters.get(c.protocol)!.stream(account(c.protocol, base), request(ac.signal))) {
          evs.push(e)
          if ((e as { type: string }).type === 'text') ac.abort()
        }
        expect(evs.at(-1)).toEqual({ type: 'done', reason: 'cancelled' })
      })

      it('开流前取消 → cancelled', async () => {
        const { base, adapters } = await setup((_q, r) => r.end())
        const ac = new AbortController()
        ac.abort()
        expect(await collect(adapters.get(c.protocol)!.stream(account(c.protocol, base), request(ac.signal)))).toEqual([{ type: 'done', reason: 'cancelled' }])
      })

      it('服务端中途断连 → 部分文本后 network 错误', async () => {
        const { base, adapters } = await setup((q, r) => cutStream(q, r, fixture(c.cut)))
        const evs = await collect(adapters.get(c.protocol)!.stream(account(c.protocol, base), request()))
        expect(text(evs).length).toBeGreaterThan(0)
        expect(evs.at(-1)).toMatchObject({ type: 'done', reason: 'error', error: { kind: 'network' } })
      })

      it('test() 与 listModels() 走 GET /models', async () => {
        const { base, seen, adapters } = await setup((_q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end('{"data":[{"id":"gpt-x"},{"id":"gpt-y"}]}') })
        const a = adapters.get(c.protocol)!
        await a.test(account(c.protocol, base))
        expect(await a.listModels!(account(c.protocol, base))).toEqual([{ id: 'gpt-x' }, { id: 'gpt-y' }])
        expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['GET /models', 'GET /models'])
        expect(seen[0].headers.authorization).toBe('Bearer sk-test')
      })

      it('test():/models 404 → 1 token 流式回退,用 account.testModel', async () => {
        const { base, seen, adapters } = await setup((q, r) => { if (q.method === 'GET') { r.writeHead(404); return r.end() } sse(r, fixture(c.ok)) })
        await adapters.get(c.protocol)!.test(account(c.protocol, base, { testModel: 'my-model' }))
        expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['GET /models', `POST ${c.path}`])
        const body = JSON.parse(seen[1].body)
        expect(body.model).toBe('my-model')
        expect(body.stream).toBe(true)
        expect(body.max_tokens ?? body.max_output_tokens).toBeLessThanOrEqual(16)
        expect(seen[1].headers.authorization).toBe('Bearer sk-test')
      })

      it('test() 回退:400 指向模型无效 → key 已被接受,通过', async () => {
        const { base, adapters } = await setup((q, r) => { r.writeHead(q.method === 'GET' ? 404 : 400); r.end('{"error":{"message":"The model `x` does not exist"}}') })
        await adapters.get(c.protocol)!.test(account(c.protocol, base))
      })

      it('test() 回退:服务端只发头不发体 → 超时失败而不是挂起', async () => {
        const { base, adapters } = await setup((q, r) => { if (q.method === 'GET') { r.writeHead(404); return r.end() } r.writeHead(200, { 'content-type': 'text/event-stream' }); r.flushHeaders() }, 100)
        const t = adapters.get(c.protocol)!.test(account(c.protocol, base))
        await expect(t).rejects.toMatchObject({ error: { kind: 'network' } })
      })

      it('test() 401 抛带 auth 的失败', async () => {
        const { base, adapters } = await setup((_q, r) => { r.writeHead(401); r.end() })
        await expect(adapters.get(c.protocol)!.test(account(c.protocol, base))).rejects.toMatchObject({ error: { kind: 'auth' } })
      })
    })
  }

  it('chat:account.quirks.chat 进入请求体(qwen enable_thinking)', async () => {
    const { base, seen, adapters } = await setup((_q, r) => sse(r, fixture('chat-text.txt')))
    await collect(adapters.get('openai-chat')!.stream(account('openai-chat', base, { quirks: { chat: { thinking: 'qwen' } } }), request(undefined, { reasoning: 'high' })))
    expect(JSON.parse(seen[0].body).enable_thinking).toBe(true)
  })
})
