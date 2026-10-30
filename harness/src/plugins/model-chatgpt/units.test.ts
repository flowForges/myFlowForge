import { describe, expect, it } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'
import { verifyIdToken } from './jwks'
import { encodeChatgptBody, sanitizeChatgptBody } from './sanitize'
import { mapChatgptError } from './errors'

// —— 自签 RS256 id_token
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }
const jwks = { keys: [jwk] }
const NOW = 1_800_000_000_000
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
function idToken(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', kid: 'k1' }, key = privateKey) {
  const head = `${b64(header)}.${b64({ iss: 'https://auth.openai.com', aud: 'oaiapp_1', sub: 'u1', exp: NOW / 1000 + 3600, iat: NOW / 1000, nonce: 'n1', ...claims })}`
  return `${head}.${sign('RSA-SHA256', Buffer.from(head), key).toString('base64url')}`
}
const opts = { jwks, clientId: 'oaiapp_1', nonce: 'n1', now: NOW }

describe('verifyIdToken', () => {
  it('合法 token → claims', () => {
    expect(verifyIdToken(idToken({ email: 'a@b.c' }), opts)).toMatchObject({ sub: 'u1', email: 'a@b.c' })
  })
  it('aud 为数组且含 client_id → 通过', () => {
    expect(verifyIdToken(idToken({ aud: ['oaiapp_1'] }), opts).sub).toBe('u1')
  })
  const bad: [string, () => string][] = [
    ['iss 不对', () => idToken({ iss: 'https://evil.example' })],
    ['aud 不对', () => idToken({ aud: 'oaiapp_2' })],
    ['已过期', () => idToken({ exp: NOW / 1000 - 3600 })],
    ['nonce 不对', () => idToken({ nonce: 'n2' })],
    ['缺 sub', () => idToken({ sub: '' })],
    ['alg none', () => idToken({}, { alg: 'none', kid: 'k1' })],
    ['HS256', () => idToken({}, { alg: 'HS256', kid: 'k1' })],
    ['未知 kid', () => idToken({}, { alg: 'RS256', kid: 'k9' })],
    ['别的私钥签名', () => idToken({}, undefined, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey)],
    ['篡改载荷', () => { const [h, , s] = idToken({}).split('.'); return `${h}.${b64({ sub: 'u2' })}.${s}` }],
    ['格式错误', () => 'abc.def'],
  ]
  for (const [name, make] of bad) it(`拒绝:${name}`, () => expect(() => verifyIdToken(make(), opts)).toThrow())
})

describe('sanitizeChatgptBody', () => {
  const DROPPED = ['background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation', 'multi_agent', 'prompt',
    'prompt_cache_retention', 'safety_identifier', 'temperature', 'top_logprobs', 'top_p', 'truncation', 'user']
  it('删除全部 15 个字段与 previous_response_id,强制 store:false / stream:true', () => {
    const body: Record<string, unknown> = { model: 'm', input: [], store: true, stream: false, previous_response_id: 'r1', instructions: 'sys' }
    for (const k of DROPPED) body[k] = 1
    const out = sanitizeChatgptBody(body)
    expect(DROPPED).toHaveLength(15)
    for (const k of [...DROPPED, 'previous_response_id']) expect(out).not.toHaveProperty(k)
    expect(out).toMatchObject({ model: 'm', store: false, stream: true, instructions: 'sys' })
  })
  it('role:system → developer;字符串 input → 完整数组', () => {
    const out = sanitizeChatgptBody({ input: [{ type: 'message', role: 'system', content: 'x' }, { type: 'message', role: 'user', content: 'y' }] })
    expect((out.input as { role: string }[]).map(i => i.role)).toEqual(['developer', 'user'])
    expect(sanitizeChatgptBody({ input: 'hi' }).input).toEqual([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }])
  })
  it('工具:顶层 function 保留,托管工具去掉;去光后不发 tools / tool_choice', () => {
    const fn = { type: 'function', name: 'f', description: 'd', parameters: {} }
    expect(sanitizeChatgptBody({ input: [], tools: [fn, { type: 'image_generation' }] }).tools).toEqual([fn])
    const none = sanitizeChatgptBody({ input: [], tools: [{ type: 'file_search' }], tool_choice: 'auto' })
    expect(none).not.toHaveProperty('tools')
    expect(none).not.toHaveProperty('tool_choice')
  })
  it('不改动入参', () => {
    const body = { input: [{ role: 'system', content: 'x' }], temperature: 1 }
    sanitizeChatgptBody(body)
    expect(body).toEqual({ input: [{ role: 'system', content: 'x' }], temperature: 1 })
  })
})

describe('encodeChatgptBody', () => {
  it('≤ 1 MiB:原样 JSON,不带 content-encoding', () => {
    const r = encodeChatgptBody({ a: 1 })
    expect(r.body).toBe('{"a":1}')
    expect(r.headers).toEqual({})
  })
  it('> 1 MiB:zstd 压缩 + content-encoding: zstd', () => {
    const big = { input: 'x'.repeat(1024 * 1024 + 1) }
    const r = encodeChatgptBody(big)
    expect(r.headers).toEqual({ 'content-encoding': 'zstd' })
    expect(typeof r.body).not.toBe('string')
    expect(JSON.parse(zstdDecompressSync(r.body as Uint8Array).toString('utf8'))).toEqual(big)
  })
})

describe('mapChatgptError', () => {
  const j = (code: string, param?: string) => JSON.stringify({ error: { code, message: `m:${code}`, ...(param && { param }) } })
  const table: [number, string, object][] = [
    [429, j('subscription_sharing_usage_limit_exceeded'), { kind: 'quota', retryable: false }],
    [403, j('subscription_sharing_user_not_eligible'), { kind: 'restricted', retryable: false }],
    [400, j('subscription_sharing_unsupported_capability', 'tools[0]'), { kind: 'bad_request', retryable: false }],
    [403, j('subscription_sharing_route_not_supported'), { kind: 'bad_request', retryable: false }],
    [401, j('subscription_sharing_invalid_user'), { kind: 'auth', retryable: false }],
    [403, j('chatpass_v2_scope_not_authorized'), { kind: 'auth', retryable: false }],
    [403, j('chatpass_v2_invalid_authorization_context'), { kind: 'auth', retryable: false }],
    [503, j('subscription_sharing_usage_unavailable'), { kind: 'unavailable', retryable: true }],
    [503, j('subscription_sharing_user_unavailable'), { kind: 'unavailable', retryable: true }],
    // 开流前的 {"detail": …} 形状
    [401, '{"detail":"Unauthorized"}', { kind: 'auth', message: 'Unauthorized' }],
    [403, '{"detail":"Region not supported"}', { kind: 'restricted', retryable: false }],
    [503, '{"detail":"Direct routing unavailable"}', { kind: 'unavailable', retryable: true }],
    [429, '{"detail":"blocked: subscription_sharing_usage_limit_exceeded"}', { kind: 'quota' }],
    [403, '{"detail":{"code":"subscription_sharing_user_not_eligible","message":"no"}}', { kind: 'restricted' }],
    // 其他 429 仍是限流
    [429, j('rate_limit_exceeded'), { kind: 'rate_limit', retryable: true }],
  ]
  for (const [status, body, want] of table) it(`${status} ${body}`, () => expect(mapChatgptError(status, body)).toMatchObject(want))
  it('unsupported_capability 消息带 param', () => {
    expect(mapChatgptError(400, j('subscription_sharing_unsupported_capability', 'tools[0]')).message).toContain('tools[0]')
  })
  it('retry-after 头 → retryAfterMs', () => {
    expect(mapChatgptError(503, j('subscription_sharing_usage_unavailable'), new Headers({ 'retry-after': '2' })).retryAfterMs).toBe(2000)
  })
})
