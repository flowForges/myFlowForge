import { describe, expect, it } from 'vitest'
import { ModelFailure, postStream, toModelError } from './http'

describe('toModelError', () => {
  it('401 / 403 → auth, not retryable', () => {
    expect(toModelError(401, '{"error":{"message":"Incorrect API key"}}')).toEqual({ kind: 'auth', message: 'Incorrect API key', retryable: false })
    expect(toModelError(403, 'forbidden')).toMatchObject({ kind: 'auth', message: 'forbidden', retryable: false })
  })
  it('429 with retry-after seconds → rate_limit + retryAfterMs', () => {
    const e = toModelError(429, '{"message":"slow down"}', new Headers({ 'retry-after': '7' }))
    expect(e).toEqual({ kind: 'rate_limit', message: 'slow down', retryable: true, retryAfterMs: 7000 })
    // retry-after-ms 优先
    expect(toModelError(429, '', new Headers({ 'retry-after-ms': '1500', 'retry-after': '7' })).retryAfterMs).toBe(1500)
    expect(toModelError(429, '', new Headers({ 'retry-after-ms': 'junk', 'retry-after': '2' })).retryAfterMs).toBe(2000)
    expect(toModelError(429, '')).toEqual({ kind: 'rate_limit', message: 'HTTP 429', retryable: true })
  })
  it('400 / 404 / 422 → bad_request', () => {
    for (const s of [400, 404, 422]) expect(toModelError(s, '{"detail":"nope"}')).toMatchObject({ kind: 'bad_request', message: 'nope', retryable: false })
  })
  it('5xx → unavailable, retryable', () => {
    for (const s of [500, 502, 503, 529]) expect(toModelError(s, '<html>')).toMatchObject({ kind: 'unavailable', retryable: true })
  })
  it('long bodies are truncated in the message', () => {
    expect(toModelError(500, 'x'.repeat(5000)).message.length).toBeLessThanOrEqual(500)
  })
})

const okStream = () => new Response('data: a\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })

describe('postStream', () => {
  it('returns the response on 2xx and passes method/body through', async () => {
    let seen: RequestInit | undefined
    const fetchImpl = (async (_u: string, init: RequestInit) => { seen = init; return okStream() }) as typeof fetch
    const res = await postStream('http://x/v1', { body: '{}', headers: { a: 'b' }, signal: new AbortController().signal, fetch: fetchImpl })
    expect(res.status).toBe(200)
    expect(seen?.method).toBe('POST')
    expect(seen?.body).toBe('{}')
  })

  it('non-2xx → ModelFailure carrying toModelError', async () => {
    const fetchImpl = (async () => new Response('{"error":{"message":"bad key"}}', { status: 401 })) as unknown as typeof fetch
    const err = await postStream('http://x', { signal: new AbortController().signal, fetch: fetchImpl }).catch(e => e)
    expect(err).toBeInstanceOf(ModelFailure)
    expect(err.error).toEqual({ kind: 'auth', message: 'bad key', retryable: false })
  })

  it('fetch failure → network, retryable', async () => {
    const fetchImpl = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    const err = await postStream('http://x', { signal: new AbortController().signal, fetch: fetchImpl }).catch(e => e)
    expect(err).toBeInstanceOf(ModelFailure)
    expect(err.error).toMatchObject({ kind: 'network', retryable: true })
  })

  it('timeout before headers → network; caller abort rethrows the abort', async () => {
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as unknown as typeof fetch
    const err = await postStream('http://x', { signal: new AbortController().signal, timeoutMs: 20, fetch: hang }).catch(e => e)
    expect(err).toBeInstanceOf(ModelFailure)
    expect(err.error).toMatchObject({ kind: 'network', message: 'timeout', retryable: true })

    const ac = new AbortController()
    const p = postStream('http://x', { signal: ac.signal, fetch: hang }).catch(e => e)
    ac.abort()
    const e2 = await p
    expect(e2).not.toBeInstanceOf(ModelFailure)
    expect(e2.name).toBe('AbortError')
  })

  it('timeout only covers the headers; caller abort still reaches the body', async () => {
    let fetchSignal: AbortSignal | undefined
    const fetchImpl = (async (_u: string, init: RequestInit) => { fetchSignal = init.signal!; return okStream() }) as typeof fetch
    const ac = new AbortController()
    await postStream('http://x', { signal: ac.signal, timeoutMs: 10, fetch: fetchImpl })
    await new Promise(r => setTimeout(r, 30))
    expect(fetchSignal!.aborted).toBe(false)
    ac.abort()
    expect(fetchSignal!.aborted).toBe(true)
  })

  it('caller abort while reading the error body rethrows the abort, not a ModelFailure', async () => {
    const ac = new AbortController()
    const fetchImpl = (async () => {
      const body = new ReadableStream<Uint8Array>({ pull() { /* 错误体迟迟不结束 */ } })
      setTimeout(() => ac.abort(), 10) // 读错误体时调用方取消
      return new Response(body, { status: 500 })
    }) as unknown as typeof fetch
    const err = await postStream('http://x', { signal: ac.signal, fetch: fetchImpl }).catch(e => e)
    expect(err).not.toBeInstanceOf(ModelFailure)
    expect(err.name).toBe('AbortError')
  })

  it('leaves no listeners on the caller signal after the request settles', async () => {
    const ac = new AbortController()
    let added = 0
    let removed = 0
    const add = ac.signal.addEventListener.bind(ac.signal)
    const remove = ac.signal.removeEventListener.bind(ac.signal)
    ac.signal.addEventListener = ((...a: Parameters<typeof add>) => { added++; return add(...a) }) as typeof add
    ac.signal.removeEventListener = ((...a: Parameters<typeof remove>) => { removed++; return remove(...a) }) as typeof remove
    const ok = (async () => okStream()) as unknown as typeof fetch
    const bad = (async () => new Response('x', { status: 400 })) as unknown as typeof fetch
    const boom = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    for (const f of [ok, bad, boom]) await postStream('http://x', { signal: ac.signal, timeoutMs: 1000, fetch: f }).catch(() => {})
    expect(added - removed).toBe(0)
  })
})
