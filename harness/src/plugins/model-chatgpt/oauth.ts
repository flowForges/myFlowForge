// Sign in with ChatGPT 的 OAuth 细节(spec §9):主机 ID、PKCE、授权 URL、令牌端点、吊销、本地回调监听
// ★任何函数都不把 code / token 写进日志或错误消息
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { Jwks } from './jwks'

export const AUTH_BASE = 'https://auth.openai.com'
export const API_BASE = 'https://api.openai.com/v1'
export const RESOURCE = 'https://api.openai.com/v1'
export const DIRECT_SCOPE = 'chatgpt.tokens.use.direct'
export const SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`
export const REGISTRATION_CLIENT = 'dynamic_agent_client'
export const AGENT_NAME = 'myFlowForge'
export const CALLBACK_PATH = '/auth/callback'
const HTTP_TIMEOUT_MS = 15_000

/** 每个账号一条,存 ctx.secrets `account/<id>/oauth`;令牌缺失 = 需要重新登录 */
export interface OAuthRecord {
  clientId: string
  sub: string
  scopes: string[]
  accessToken?: string
  refreshToken?: string
  expiresAt?: number // ms
  earliestRefreshAt?: number // ms
  idToken?: string // 供重新授权的 id_token_hint
}

const HOST_ID = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** 本机 ext_agent_host_id:首次生成后不变 */
export function hostId(dataDir: string): string {
  const file = join(dataDir, 'host-id')
  try {
    const v = readFileSync(file, 'utf8').trim()
    if (HOST_ID.test(v)) return v
  } catch { /* 首次 */ }
  const id = `urn:uuid:${randomUUID()}`
  try {
    writeFileSync(file, id + '\n', { mode: 0o600, flag: 'wx' })
  } catch {
    // 并发创建或内容损坏:以盘上合法值为准,否则覆盖
    try {
      const v = readFileSync(file, 'utf8').trim()
      if (HOST_ID.test(v)) return v
    } catch { /* 读不到 */ }
    writeFileSync(file, id + '\n', { mode: 0o600 })
  }
  return id
}

export const randomToken = () => randomBytes(32).toString('base64url')

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomToken()
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

export interface AuthorizeParams {
  redirectUri: string
  state: string
  nonce: string
  challenge: string
  hostId: string
  /** 重新授权:已签发的 client_id + 上次的 id_token */
  reauth?: { clientId: string; idToken?: string; consent?: boolean }
}

export function authorizeUrl(authBase: string, p: AuthorizeParams): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: p.reauth?.clientId ?? REGISTRATION_CLIENT,
    redirect_uri: p.redirectUri,
    scope: SCOPE,
    resource: RESOURCE,
    state: p.state,
    nonce: p.nonce,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    ext_agent_host_id: p.hostId,
  })
  if (!p.reauth) q.set('agent_name_hint', AGENT_NAME)
  else {
    if (p.reauth.idToken) q.set('id_token_hint', p.reauth.idToken)
    // 之前拒绝了套餐共享:重新征求同意
    if (p.reauth.consent) q.set('prompt', 'consent')
  }
  return `${authBase}/api/accounts/authorize?${q}`
}

/** 令牌端点失败;code 为 OAuth 错误码(网络失败时 status = 0) */
export class TokenError extends Error {
  constructor(readonly status: number, readonly code?: string) {
    super(`token endpoint failed: ${code ?? (status ? `HTTP ${status}` : 'network')}`)
    this.name = 'TokenError'
  }
}

export interface TokenSet {
  accessToken: string
  refreshToken: string
  idToken?: string
  expiresAt: number
  earliestRefreshAt?: number
  scopes?: string[]
}

/** earliest_refresh_at:秒或毫秒时间戳,或日期字符串 */
function toMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v
  if (typeof v === 'string' && v) {
    const n = Number(v)
    if (Number.isFinite(n)) return toMs(n)
    const t = Date.parse(v)
    return Number.isNaN(t) ? undefined : t
  }
  return undefined
}

const oauthCode = (text: string): string | undefined => {
  try {
    const j = JSON.parse(text) as { error?: unknown; code?: unknown }
    if (typeof j.error === 'string') return j.error
    const e = j.error as { code?: unknown; type?: unknown } | undefined
    if (e && typeof e.code === 'string') return e.code
    if (e && typeof e.type === 'string') return e.type
    if (typeof j.code === 'string') return j.code
  } catch { /* 非 JSON */ }
  return undefined
}

async function post(url: string, form: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })
}

export async function postToken(authBase: string, form: Record<string, string>, now: number): Promise<TokenSet> {
  let res: Response
  let text: string
  try {
    res = await post(`${authBase}/api/accounts/oauth/token`, form)
    text = await res.text()
  } catch {
    throw new TokenError(0)
  }
  if (!res.ok) throw new TokenError(res.status, oauthCode(text))
  let j: Record<string, unknown>
  try {
    j = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new TokenError(res.status, 'invalid_response')
  }
  const { access_token: at, refresh_token: rt, id_token: it, expires_in: exp, scope } = j
  if (typeof at !== 'string' || !at || typeof rt !== 'string' || !rt) throw new TokenError(res.status, 'invalid_response')
  const earliest = toMs(j.earliest_refresh_at)
  return {
    accessToken: at,
    refreshToken: rt,
    ...(typeof it === 'string' && it && { idToken: it }),
    expiresAt: now + (typeof exp === 'number' && exp > 0 ? exp : 3600) * 1000,
    ...(earliest !== undefined && { earliestRefreshAt: earliest }),
    ...(typeof scope === 'string' && { scopes: scope.split(' ').filter(Boolean) }),
  }
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as Record<string, unknown>
}

/** openid-configuration 里的 revocation_endpoint;只接受与 authBase 同源的地址 */
async function revocationEndpoint(authBase: string): Promise<string> {
  const v = (await getJson(`${authBase}/.well-known/openid-configuration`)).revocation_endpoint
  if (typeof v !== 'string' || new URL(v).origin !== new URL(authBase).origin) throw new Error('bad revocation_endpoint')
  return v
}

export async function fetchJwks(authBase: string): Promise<Jwks> {
  const j = await getJson(`${authBase}/.well-known/jwks.json`)
  if (!Array.isArray(j.keys)) throw new Error('bad jwks')
  return j as unknown as Jwks
}

/** 吊销 refresh token;2xx(含空体)= 成功 */
export async function revoke(authBase: string, r: { refreshToken: string; clientId: string }): Promise<void> {
  const url = await revocationEndpoint(authBase)
  const res = await post(url, { token: r.refreshToken, token_type_hint: 'refresh_token', client_id: r.clientId })
  await res.body?.cancel().catch(() => {})
  if (!res.ok) throw new Error(`revoke HTTP ${res.status}`)
}

// —— 本地回调监听

export interface CallbackListener {
  port: number
  close(): void
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err)
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })
}

export interface CallbackReply {
  status: number
  text: string
  /** 回复发完后关闭监听 */
  close?: boolean
}

/**
 * 127.0.0.1 上起回调监听:先试首选端口,EADDRINUSE 则系统分配。
 * onCallback 返回给浏览器的纯文本;非回调路径 404。
 */
export async function listenCallback(preferredPort: number, onCallback: (q: URLSearchParams) => Promise<CallbackReply>): Promise<CallbackListener> {
  const close = () => {
    server.close()
    server.closeAllConnections()
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const reply = (r: CallbackReply) => {
      res.writeHead(r.status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', connection: 'close' })
      res.end(r.text, () => { if (r.close) close() })
    }
    if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH) return reply({ status: 404, text: 'not found' })
    onCallback(url.searchParams).then(reply, () => reply({ status: 500, text: '登录失败', close: true }))
  })
  try {
    await listen(server, preferredPort)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || preferredPort === 0) throw err
    await listen(server, 0)
  }
  return { port: (server.address() as AddressInfo).port, close }
}
