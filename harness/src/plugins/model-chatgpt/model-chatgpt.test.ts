import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { createKernel, type Kernel } from '../../kernel/kernel'
import type { Plugin } from '../../kernel/pluginHost'
import type { ModelEvent, ModelsService } from '../../lib/models/types'
import type { AccountView } from '../../protocol/models'
import { fixture } from '../../../test/modelPluginHarness'
import { createModelsRegistry } from '../models-registry/index'
import { createModelChatgpt } from './index'

// —— 假服务:记录原始请求体(zstd 用)
interface Req { method: string; path: string; headers: IncomingMessage['headers']; raw: Buffer; form: URLSearchParams }
type H = (q: Req, res: ServerResponse) => unknown
const servers: Server[] = []
async function serve(handler: H): Promise<string> {
  const s = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      const url = new URL(req.url ?? '/', 'http://x')
      void handler({ method: req.method ?? '', path: url.pathname, headers: req.headers, raw, form: new URLSearchParams(raw.toString('utf8')) }, res)
    })
  })
  servers.push(s)
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`
}
const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'kid-1', alg: 'RS256', use: 'sig' }
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')

let clock = 1_800_000_000_000
const now = () => clock

/** 假授权服务:token / jwks / openid-configuration / revoke */
function fakeAuth() {
  const st = {
    nonce: '' as string, sub: 'user-1', scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
    tokenReqs: [] as URLSearchParams[], revokes: [] as URLSearchParams[], n: 0, idTokens: [] as string[],
    refreshDelayMs: 0, refuse: undefined as string | undefined, nonceOverride: undefined as string | undefined,
    codeDelayMs: 0, omitRefresh: false,
  }
  const idToken = (aud: string) => {
    const head = `${b64({ alg: 'RS256', kid: 'kid-1' })}.${b64({ iss: 'https://auth.openai.com', aud, sub: st.sub, email: 'me@example.com', exp: Math.floor(clock / 1000) + 3600, iat: Math.floor(clock / 1000), nonce: st.nonceOverride ?? st.nonce })}`
    const t = `${head}.${sign('RSA-SHA256', Buffer.from(head), privateKey).toString('base64url')}`
    st.idTokens.push(t)
    return t
  }
  const handler: H = async (q, res) => {
    if (q.path === '/.well-known/jwks.json') return json(res, 200, { keys: [JWK] })
    if (q.path === '/.well-known/openid-configuration') return json(res, 200, { issuer: 'https://auth.openai.com', revocation_endpoint: `${base}/oauth/revoke`, jwks_uri: `${base}/.well-known/jwks.json` })
    if (q.path === '/oauth/revoke') { st.revokes.push(q.form); res.writeHead(200); return res.end() }
    if (q.path === '/api/accounts/oauth/token') {
      st.tokenReqs.push(q.form)
      if (q.form.get('grant_type') === 'authorization_code' && st.codeDelayMs) await new Promise(r => setTimeout(r, st.codeDelayMs))
      if (q.form.get('grant_type') === 'refresh_token') {
        if (st.refreshDelayMs) await new Promise(r => setTimeout(r, st.refreshDelayMs))
        if (st.refuse) return json(res, 400, { error: st.refuse, error_description: 'nope' })
      }
      st.n++
      return json(res, 200, {
        access_token: `at-${st.n}`, ...(!(st.omitRefresh && q.form.get('grant_type') === 'refresh_token') && { refresh_token: `rt-${st.n}` }), token_type: 'Bearer', expires_in: 3600, scope: st.scope,
        ...(q.form.get('grant_type') === 'authorization_code' && { id_token: idToken(q.form.get('client_id')!) }),
      })
    }
    res.writeHead(404); res.end()
  }
  let base = ''
  return { st, start: async () => (base = await serve(handler)) }
}

/** 假 API:/v1/models 与 /v1/responses */
function fakeApi() {
  const st = { calls: [] as Req[], respond: undefined as H | undefined }
  const handler: H = (q, res) => {
    st.calls.push(q)
    if (q.path === '/v1/models') return json(res, 200, { models: [{ slug: 'gpt-x', display_name: 'GPT X', visibility: 'list' }, { slug: 'hidden', display_name: 'H', visibility: 'hide' }] })
    if (st.respond) return st.respond(q, res)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(fixture('responses-text.txt'))
  }
  return { st, start: () => serve(handler) }
}

let dir: string
let kernels: Kernel[] = []
let auth: ReturnType<typeof fakeAuth>
let api: ReturnType<typeof fakeApi>
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mffai-chatgpt-'))
  clock = 1_800_000_000_000
  auth = fakeAuth()
  api = fakeApi()
})
afterEach(async () => {
  for (const k of kernels) await k.close().catch(() => {})
  kernels = []
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise(r => s.close(r)) }
  rmSync(dir, { recursive: true, force: true })
})

async function boot(o: { openPortPreferred?: number; flowTimeoutMs?: number } = {}) {
  const authBase = await auth.start()
  const apiBase = `${await api.start()}/v1`
  let svc: ModelsService | undefined
  const capture: Plugin = { manifest: { id: 'capture', version: '1', kernel: '*', inject: ['models'] }, activate(ctx) { svc = ctx.services.get<ModelsService>('models') } }
  const k = await createKernel({
    dataDir: dir,
    plugins: [createModelsRegistry({ catalogRefresh: false }), createModelChatgpt({ authBase, apiBase, now, openPortPreferred: o.openPortPreferred ?? 0, flowTimeoutMs: o.flowTimeoutMs }), capture],
    secrets: { osBackend: false },
  })
  kernels.push(k)
  return { k, svc: svc! }
}

type Begin = { flowId: string; authUrl: string }
/** begin 只回本机一次性地址;像浏览器一样打开它,拿到 302 指向的授权页 */
async function openStart(authUrl: string) {
  const res = await fetch(authUrl, { redirect: 'manual' })
  await res.text()
  return { status: res.status, location: res.headers.get('location') }
}
async function begin(k: Kernel) {
  const r = (await k.handle('auth.chatgpt.begin', {})) as Begin
  const start = await openStart(r.authUrl)
  const u = new URL(start.location!)
  auth.st.nonce = u.searchParams.get('nonce')!
  return { ...r, u, p: u.searchParams, redirect: u.searchParams.get('redirect_uri')! }
}
const callbackOf = (authUrl: string) => `${new URL(authUrl).origin}/auth/callback`
const ends = (k: Kernel) => k.events.tail(200).filter(e => e.type === 'auth.chatgpt.ended').map(e => e.payload as { flowId: string; ok: boolean; accountId?: string })
async function callback(redirect: string, params: Record<string, string>) {
  const res = await fetch(`${redirect}?${new URLSearchParams(params)}`)
  return { status: res.status, type: res.headers.get('content-type'), text: await res.text() }
}
async function login(k: Kernel, extra: Record<string, string | undefined> = {}) {
  const b = await begin(k)
  const params: Record<string, string> = { code: 'code-1', state: b.p.get('state')!, client_id: 'oaiapp_1', scope: auth.st.scope }
  for (const [key, v] of Object.entries(extra)) if (v === undefined) delete params[key]; else params[key] = v
  return { b, r: await callback(b.redirect, params) }
}
const accounts = async (k: Kernel) => ((await k.handle('models.accounts', {})) as { accounts: AccountView[] }).accounts
const updates = (k: Kernel) => k.events.tail(200).filter(e => e.type === 'account.updated').map(e => (e.payload as { account: AccountView }).account)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const portClosed = async (redirect: string) => fetch(redirect).then(() => false, () => true)
const req = (extra: object = {}) => ({ messages: [{ role: 'user' as const, parts: [{ type: 'text' as const, text: 'hi' }] }], interactive: true, signal: new AbortController().signal, ...extra })
async function collect(it: AsyncIterable<ModelEvent>) { const out: ModelEvent[] = []; for await (const e of it) out.push(e); return out }
const responsesCalls = () => api.st.calls.filter(c => c.path === '/v1/responses')

describe('model-chatgpt 登录', () => {
  it('完整登录:授权参数、PKCE、换 token、建账号、回调页「已完成」、关闭监听', async () => {
    const { k } = await boot()
    const { b, r } = await login(k)
    // 授权 URL
    expect(b.u.pathname).toBe('/api/accounts/authorize')
    expect(b.p.get('response_type')).toBe('code')
    expect(b.p.get('client_id')).toBe('dynamic_agent_client')
    expect(b.p.get('agent_name_hint')).toBe('myFlowForge')
    expect(b.p.has('id_token_hint')).toBe(false)
    expect(b.p.get('scope')).toBe('openid profile email offline_access resource.invoke chatgpt.tokens.use.direct')
    expect(b.p.get('resource')).toBe('https://api.openai.com/v1')
    expect(b.p.get('code_challenge_method')).toBe('S256')
    expect(b.redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)
    // 主机 ID:持久化 0600
    const hostFile = join(dir, 'plugins', 'model-chatgpt', 'host-id')
    expect(readFileSync(hostFile, 'utf8').trim()).toBe(b.p.get('ext_agent_host_id'))
    expect(b.p.get('ext_agent_host_id')).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(statSync(hostFile).mode & 0o777).toBe(0o600)
    // 回调页
    expect(r).toEqual({ status: 200, type: 'text/plain; charset=utf-8', text: '已完成' })
    // 换 token:签发的 client_id + PKCE verifier + 同一 redirect_uri
    const f = auth.st.tokenReqs[0]
    expect(f.get('grant_type')).toBe('authorization_code')
    expect(f.get('client_id')).toBe('oaiapp_1')
    expect(f.get('code')).toBe('code-1')
    expect(f.get('redirect_uri')).toBe(b.redirect)
    expect(f.get('resource')).toBe('https://api.openai.com/v1')
    expect(createHash('sha256').update(f.get('code_verifier')!).digest('base64url')).toBe(b.p.get('code_challenge'))
    // 账号 + 事件
    const list = await accounts(k)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ presetId: 'chatgpt', state: 'ok', label: 'me@example.com' })
    expect(updates(k).at(-1)).toMatchObject({ id: list[0].id, state: 'ok' })
    expect(await portClosed(b.redirect)).toBe(true)
    expect(ends(k)).toEqual([{ flowId: b.flowId, ok: true, accountId: list[0].id }])
    // 事件 / RPC 结果里不出现令牌
    expect(JSON.stringify(k.events.tail(200))).not.toMatch(/at-1|rt-1|code-1/)
    // 同一主机再次 begin:主机 ID 不变
    const again = await begin(k)
    expect(again.p.get('ext_agent_host_id')).toBe(b.p.get('ext_agent_host_id'))
    await k.handle('auth.chatgpt.cancel', { flowId: again.flowId })
  })

  it('state 不匹配 → 拒绝,不换 token,监听仍在,可取消', async () => {
    const { k } = await boot()
    const b = await begin(k)
    const r = await callback(b.redirect, { code: 'c', state: 'wrong', client_id: 'oaiapp_1' })
    expect(r.status).toBe(400)
    expect(r.text).not.toBe('已完成')
    expect(auth.st.tokenReqs).toHaveLength(0)
    expect(await accounts(k)).toHaveLength(0)
    expect(ends(k)).toEqual([]) // 流程未结束
    expect(await k.handle('auth.chatgpt.cancel', { flowId: b.flowId })).toEqual({ ok: true })
    expect(await portClosed(b.redirect)).toBe(true)
    expect(ends(k)).toEqual([{ flowId: b.flowId, ok: false }])
  })

  it('nonce 不匹配 → 拒绝,不建账号', async () => {
    const { k } = await boot()
    auth.st.nonceOverride = 'evil'
    const { b, r } = await login(k)
    expect(r.status).toBe(400)
    expect(await accounts(k)).toHaveLength(0)
    expect(await portClosed(b.redirect)).toBe(true)
    expect(ends(k)).toEqual([{ flowId: b.flowId, ok: false }])
  })

  it('error=access_denied → 拒绝,不换 token', async () => {
    const { k } = await boot()
    const { b, r } = await login(k, { code: undefined, error: 'access_denied' })
    expect(r.status).toBe(400)
    expect(auth.st.tokenReqs).toHaveLength(0)
    expect(ends(k)).toEqual([{ flowId: b.flowId, ok: false }])
  })

  it('首次注册回调缺 client_id → 拒绝', async () => {
    const { k } = await boot()
    const { r } = await login(k, { client_id: undefined })
    expect(r.status).toBe(400)
    expect(auth.st.tokenReqs).toHaveLength(0)
  })

  it('scope 缺 chatgpt.tokens.use.direct → not_authorized,不发推理', async () => {
    const { k, svc } = await boot()
    auth.st.scope = 'openid profile email offline_access resource.invoke'
    const { r } = await login(k)
    expect(r.text).toBe('已完成')
    const [a] = await accounts(k)
    expect(a.state).toBe('not_authorized')
    expect(updates(k).at(-1)).toMatchObject({ id: a.id, state: 'not_authorized' })
    const evs = await collect(svc.stream({ accountId: a.id, modelId: 'gpt-x' }, req()))
    expect(evs.at(-1)).toMatchObject({ type: 'done', reason: 'error' })
    expect(api.st.calls).toHaveLength(0)
    expect((await accounts(k))[0].state).toBe('not_authorized')
  })

  it('签发的 client_id 持久化;需重新登录时 begin 用它 + id_token_hint,不带 agent_name_hint;同一账号更新', async () => {
    const { k, svc } = await boot()
    await login(k)
    const [a] = await accounts(k)
    svc.setState(a.id, 'needs_login')
    const { b, r } = await login(k, { client_id: undefined, code: 'code-2' })
    expect(b.p.get('client_id')).toBe('oaiapp_1')
    expect(b.p.get('id_token_hint')).toBe(auth.st.idTokens[0])
    expect(b.authUrl).not.toContain(auth.st.idTokens[0])
    expect(b.p.has('agent_name_hint')).toBe(false)
    expect(r.text).toBe('已完成')
    expect(auth.st.tokenReqs[1].get('client_id')).toBe('oaiapp_1')
    const list = await accounts(k)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: a.id, state: 'ok' })
    // 新令牌生效
    await collect(svc.stream({ accountId: a.id, modelId: 'gpt-x' }, req()))
    expect(responsesCalls()[0].headers.authorization).toBe('Bearer at-2')
  })

  it('重新授权:回调给出不同的 client_id → 拒绝', async () => {
    const { k, svc } = await boot()
    await login(k)
    svc.setState((await accounts(k))[0].id, 'needs_login')
    const { r } = await login(k, { client_id: 'oaiapp_other' })
    expect(r.status).toBe(400)
    expect(auth.st.tokenReqs).toHaveLength(1)
  })

  it('重新授权:id_token 的 sub 与账号不一致 → 拒绝,不覆盖凭据', async () => {
    const { k, svc } = await boot()
    await login(k)
    const [a] = await accounts(k)
    svc.setState(a.id, 'needs_login')
    auth.st.sub = 'someone-else'
    const { r } = await login(k, { client_id: undefined })
    expect(r.status).toBe(400)
    expect((await accounts(k))[0].state).toBe('needs_login')
  })

  it('同一 sub + client_id 再次登录 → 更新原账号并发 account.updated', async () => {
    const { k } = await boot()
    await login(k)
    const before = updates(k).length
    await login(k)
    expect(await accounts(k)).toHaveLength(1)
    expect(updates(k).length).toBeGreaterThan(before)
  })

  it('非回调路径 → 404,流程不受影响', async () => {
    const { k } = await boot()
    const b = await begin(k)
    const res = await fetch(new URL('/other', b.redirect))
    expect(res.status).toBe(404)
    await res.text()
    expect((await callback(b.redirect, { code: 'c', state: b.p.get('state')!, client_id: 'oaiapp_1' })).text).toBe('已完成')
  })

  it('缺少 code → 错误页,流程结束', async () => {
    const { k } = await boot()
    const { b, r } = await login(k, { code: undefined })
    expect(r.status).toBe(400)
    expect(r.type).toBe('text/plain; charset=utf-8')
    expect(await portClosed(b.redirect)).toBe(true)
  })

  it('处理中再来回调 → 409', async () => {
    const { k } = await boot()
    auth.st.codeDelayMs = 150
    const b = await begin(k)
    const params = { code: 'c', state: b.p.get('state')!, client_id: 'oaiapp_1' }
    const first = callback(b.redirect, params)
    await sleep(30)
    expect((await callback(b.redirect, params)).status).toBe(409)
    expect((await first).text).toBe('已完成')
    expect(await accounts(k)).toHaveLength(1)
  })

  it('浏览器在换 token 时断开 → 监听仍会关闭', async () => {
    const { k } = await boot()
    auth.st.codeDelayMs = 150
    const b = await begin(k)
    const ac = new AbortController()
    const p = fetch(`${b.redirect}?${new URLSearchParams({ code: 'c', state: b.p.get('state')!, client_id: 'oaiapp_1' })}`, { signal: ac.signal }).catch(() => undefined)
    await sleep(30)
    ac.abort()
    await p
    await sleep(300)
    expect(await portClosed(b.redirect)).toBe(true)
  })

  it('处理中取消 → 立即关闭监听,不建账号', async () => {
    const { k } = await boot()
    auth.st.codeDelayMs = 150
    const b = await begin(k)
    const cb = callback(b.redirect, { code: 'c', state: b.p.get('state')!, client_id: 'oaiapp_1' }).catch(() => undefined)
    await sleep(30)
    expect(await k.handle('auth.chatgpt.cancel', { flowId: b.flowId })).toEqual({ ok: true })
    expect(await portClosed(b.redirect)).toBe(true)
    await cb
    await sleep(200)
    expect(await accounts(k)).toHaveLength(0)
    expect(ends(k)).toEqual([{ flowId: b.flowId, ok: false }])
  })

  it('处理中关闭内核 → 监听关闭', async () => {
    const { k } = await boot()
    auth.st.codeDelayMs = 150
    const b = await begin(k)
    const cb = callback(b.redirect, { code: 'c', state: b.p.get('state')!, client_id: 'oaiapp_1' }).catch(() => undefined)
    await sleep(30)
    await k.close()
    kernels = kernels.filter(x => x !== k)
    expect(await portClosed(b.redirect)).toBe(true)
    await cb
  })

  it('并发 begin → 串行,前一个的监听被关闭', async () => {
    const { k } = await boot()
    const [x, y] = await Promise.all([k.handle('auth.chatgpt.begin', {}), k.handle('auth.chatgpt.begin', {})]) as Begin[]
    const rx = callbackOf(x.authUrl)
    const ry = callbackOf(y.authUrl)
    expect(await portClosed(rx)).toBe(true)
    expect(await portClosed(ry)).toBe(false)
    // 被顶替的那个结束于 ok:false
    expect(ends(k)).toEqual([{ flowId: x.flowId, ok: false }])
    await k.handle('auth.chatgpt.cancel', { flowId: y.flowId })
    expect(ends(k)).toEqual([{ flowId: x.flowId, ok: false }, { flowId: y.flowId, ok: false }])
  })

  it('以令牌响应的 scope 为准:回调 scope 含 direct 但令牌响应不含 → not_authorized', async () => {
    const { k } = await boot()
    const full = auth.st.scope
    auth.st.scope = 'openid profile email offline_access resource.invoke'
    await login(k, { scope: full })
    expect((await accounts(k))[0].state).toBe('not_authorized')
  })

  it('1455 被占用 → 回退到系统分配端口,authUrl 带该端口', async () => {
    const blocker = createNetServer()
    await new Promise<void>(r => blocker.listen(0, '127.0.0.1', r))
    const busy = (blocker.address() as AddressInfo).port
    try {
      const { k } = await boot({ openPortPreferred: busy })
      const b = await begin(k)
      const port = Number(new URL(b.redirect).port)
      expect(port).toBeGreaterThan(0)
      expect(port).not.toBe(busy)
      const r = await callback(b.redirect, { code: 'c', state: b.p.get('state')!, client_id: 'oaiapp_1' })
      expect(r.text).toBe('已完成')
    } finally {
      await new Promise(r => blocker.close(r))
    }
  })

  it('首选端口空闲 → 用首选端口', async () => {
    const probe = createNetServer()
    await new Promise<void>(r => probe.listen(0, '127.0.0.1', r))
    const free = (probe.address() as AddressInfo).port
    await new Promise(r => probe.close(r))
    const { k } = await boot({ openPortPreferred: free })
    const b = await begin(k)
    expect(new URL(b.redirect).port).toBe(String(free))
    await k.handle('auth.chatgpt.cancel', { flowId: b.flowId })
  })

  it('begin 只回本机一次性 /auth/start:302 到授权页,第二次 / 错 flow → 404;令牌不在 authUrl 里', async () => {
    const { k, svc } = await boot()
    await login(k)
    svc.setState((await accounts(k))[0].id, 'needs_login')
    const r = (await k.handle('auth.chatgpt.begin', {})) as Begin
    const u = new URL(r.authUrl)
    expect(`${u.origin}${u.pathname}`).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/start$/)
    expect([...u.searchParams.keys()]).toEqual(['flow'])
    expect(u.searchParams.get('flow')).toBe(r.flowId)
    expect(r.authUrl).not.toMatch(/id_token|eyJ/)
    const bad = new URL(r.authUrl)
    bad.searchParams.set('flow', 'other')
    expect((await openStart(bad.href)).status).toBe(404)
    const first = await openStart(r.authUrl)
    expect(first.status).toBe(302)
    expect(new URL(first.location!).pathname).toBe('/api/accounts/authorize')
    expect(new URL(first.location!).searchParams.get('id_token_hint')).toBe(auth.st.idTokens[0])
    expect(await openStart(r.authUrl)).toEqual({ status: 404, location: null })
    await k.handle('auth.chatgpt.cancel', { flowId: r.flowId })
  })

  it('新账号:先写凭据再公布;登录后列出模型,可设为默认', async () => {
    const { k } = await boot()
    // account.updated 发出的那一刻凭据文件里已有该账号
    const credsAtAnnounce: boolean[] = []
    k.events.onAppend(e => {
      if (e.type !== 'account.updated') return
      const id = (e.payload as { account: AccountView }).account.id
      credsAtAnnounce.push(readFileSync(join(dir, 'credentials.json'), 'utf8').includes(`model-chatgpt/account/${id}/oauth`))
    })
    const { b } = await login(k)
    const [a] = await accounts(k)
    expect(credsAtAnnounce[0]).toBe(true)
    await expect.poll(async () => (await accounts(k))[0].models?.map(m => m.id)).toEqual(['gpt-x'])
    expect(api.st.calls.find(c => c.path === '/v1/models')?.headers.authorization).toBe('Bearer at-1')
    expect(updates(k).at(-1)).toMatchObject({ id: a.id, models: [expect.objectContaining({ id: 'gpt-x', name: 'GPT X' })] })
    expect(ends(k)).toEqual([{ flowId: b.flowId, ok: true, accountId: a.id }])
    expect(await k.handle('models.setDefault', { accountId: a.id, modelId: 'gpt-x' })).toEqual({ ok: true })
    expect(((await k.handle('models.catalog', {})) as { default?: unknown }).default).toEqual({ accountId: a.id, modelId: 'gpt-x' })
    expect(JSON.stringify(k.events.tail(200))).not.toMatch(/at-1|rt-1/)
  })

  it('超时 → 自动关闭监听', async () => {
    const { k } = await boot({ flowTimeoutMs: 50 })
    const b = await begin(k)
    await new Promise(r => setTimeout(r, 120))
    expect(await portClosed(b.redirect)).toBe(true)
    expect(ends(k)).toEqual([{ flowId: b.flowId, ok: false }])
  })
})

describe('model-chatgpt 推理与令牌', () => {
  async function ready(o?: Parameters<typeof boot>[0]) {
    const env = await boot(o)
    await login(env.k)
    const [a] = await accounts(env.k)
    return { ...env, a, ref: { accountId: a.id, modelId: 'gpt-x' } }
  }

  it('流式:只发 /v1/responses,Bearer + session-id + x-client-request-id,请求体已清洗', async () => {
    const { svc, ref } = await ready()
    const evs = await collect(svc.stream(ref, req({ system: 'be nice', maxOutput: 100 })))
    expect(evs.flatMap(e => (e.type === 'text' ? [e.delta] : [])).join('')).toContain('你好')
    expect(evs.at(-1)).toMatchObject({ type: 'done', reason: 'stop' })
    const [c] = responsesCalls()
    expect(c.method).toBe('POST')
    expect(c.headers.authorization).toBe('Bearer at-1')
    expect(c.headers['session-id']).toMatch(/^[0-9a-f-]{36}$/)
    expect(c.headers['x-client-request-id']).toMatch(/^[0-9a-f-]{36}$/)
    expect(c.headers['content-encoding']).toBeUndefined()
    const body = JSON.parse(c.raw.toString('utf8'))
    expect(body).toMatchObject({ model: 'gpt-x', store: false, stream: true, instructions: 'be nice' })
    expect(body).not.toHaveProperty('max_output_tokens')
    expect(Array.isArray(body.input)).toBe(true)
  })

  it('请求体 > 1 MiB → zstd 压缩', async () => {
    const { svc, ref } = await ready()
    const big = 'x'.repeat(1024 * 1024 + 10)
    await collect(svc.stream(ref, req({ messages: [{ role: 'user', parts: [{ type: 'text', text: big }] }] })))
    const [c] = responsesCalls()
    expect(c.headers['content-encoding']).toBe('zstd')
    const body = JSON.parse(zstdDecompressSync(c.raw).toString('utf8'))
    expect(body.input[0].content[0].text).toBe(big)
  })

  it('工具:顶层 function 工具', async () => {
    const { svc, ref } = await ready()
    await collect(svc.stream(ref, req({ tools: [{ name: 'f', description: 'd', parameters: { type: 'object' } }] })))
    expect(JSON.parse(responsesCalls()[0].raw.toString('utf8')).tools).toEqual([{ type: 'function', name: 'f', description: 'd', parameters: { type: 'object' } }])
  })

  it('两个并发请求在临期 3 分钟内 → 只刷新一次,两者都用新 token', async () => {
    const { svc, ref } = await ready()
    clock += (3600 - 100) * 1000
    auth.st.refreshDelayMs = 50
    const [x, y] = await Promise.all([collect(svc.stream(ref, req())), collect(svc.stream(ref, req()))])
    expect(x.at(-1)).toMatchObject({ reason: 'stop' })
    expect(y.at(-1)).toMatchObject({ reason: 'stop' })
    const refreshes = auth.st.tokenReqs.filter(f => f.get('grant_type') === 'refresh_token')
    expect(refreshes).toHaveLength(1)
    expect(refreshes[0].get('client_id')).toBe('oaiapp_1')
    expect(refreshes[0].get('refresh_token')).toBe('rt-1')
    expect(refreshes[0].get('resource')).toBe('https://api.openai.com/v1')
    expect(refreshes[0].has('scope')).toBe(false)
    expect(responsesCalls().map(c => c.headers.authorization)).toEqual(['Bearer at-2', 'Bearer at-2'])
    // 轮换后的 refresh token 用于下一次刷新
    clock += (3600 - 100) * 1000
    await collect(svc.stream(ref, req()))
    expect(auth.st.tokenReqs.filter(f => f.get('grant_type') === 'refresh_token')[1].get('refresh_token')).toBe('rt-2')
  })

  for (const refuse of ['refresh_token_reused', undefined]) {
    it(`刷新进行中重新登录(刷新${refuse ? '失败' : '成功'})→ 保留新凭据,不回到 needs_login`, async () => {
      const { k, svc, ref, a } = await ready()
      svc.setState(a.id, 'needs_login')
      clock += 3600 * 1000
      auth.st.refreshDelayMs = 150
      auth.st.refuse = refuse
      const pending = collect(svc.stream(ref, req()))
      await sleep(30)
      const { r } = await login(k, { client_id: undefined, code: 'code-2' })
      expect(r.text).toBe('已完成')
      const evs = await pending
      expect(evs.at(-1)).toMatchObject({ reason: 'stop' })
      expect(responsesCalls()[0].headers.authorization).toBe('Bearer at-2') // 登录换来的令牌
      expect((await accounts(k))[0].state).toBe('ok')
      await collect(svc.stream(ref, req()))
      expect(responsesCalls()[1].headers.authorization).toBe('Bearer at-2')
      expect((await accounts(k))[0].state).toBe('ok')
    })
  }

  it('刷新响应不带 refresh_token → 沿用旧的', async () => {
    const { svc, ref } = await ready()
    auth.st.omitRefresh = true
    clock += 3600 * 1000
    expect((await collect(svc.stream(ref, req()))).at(-1)).toMatchObject({ reason: 'stop' })
    clock += 3600 * 1000
    await collect(svc.stream(ref, req()))
    const refreshes = auth.st.tokenReqs.filter(f => f.get('grant_type') === 'refresh_token')
    expect(refreshes.map(f => f.get('refresh_token'))).toEqual(['rt-1', 'rt-1'])
    expect(responsesCalls().map(c => c.headers.authorization)).toEqual(['Bearer at-2', 'Bearer at-3'])
  })

  it('流中 unsupported_capability 保留 param', async () => {
    const { svc, ref } = await ready()
    api.st.respond = (_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"subscription_sharing_unsupported_capability","param":"tools[0]","message":"nope"}}}\n\n')
    }
    const evs = await collect(svc.stream(ref, req()))
    expect(evs.at(-1)).toMatchObject({ type: 'done', reason: 'error', error: { kind: 'bad_request', retryable: false } })
    expect((evs.at(-1) as { error: { message: string } }).error.message).toContain('tools[0]')
  })

  it('距过期超过 3 分钟 → 不刷新', async () => {
    const { svc, ref } = await ready()
    clock += (3600 - 600) * 1000
    await collect(svc.stream(ref, req()))
    expect(auth.st.tokenReqs.filter(f => f.get('grant_type') === 'refresh_token')).toHaveLength(0)
  })

  it('refresh_token_reused → needs_login + account.updated,done{auth},不发推理', async () => {
    const { k, svc, ref, a } = await ready()
    clock += 3600 * 1000
    auth.st.refuse = 'refresh_token_reused'
    const evs = await collect(svc.stream(ref, req()))
    expect(evs.at(-1)).toMatchObject({ type: 'done', reason: 'error', error: { kind: 'auth' } })
    expect((await accounts(k))[0].state).toBe('needs_login')
    expect(updates(k).at(-1)).toMatchObject({ id: a.id, state: 'needs_login' })
    expect(responsesCalls()).toHaveLength(0)
    // 令牌已清除:再请求不再刷新
    await collect(svc.stream(ref, req()))
    expect(auth.st.tokenReqs.filter(f => f.get('grant_type') === 'refresh_token')).toHaveLength(1)
  })

  it('429 subscription_sharing_usage_limit_exceeded → quota + quota_exhausted', async () => {
    const { k, svc, ref } = await ready()
    api.st.respond = (_q, res) => json(res, 429, { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } })
    const evs = await collect(svc.stream(ref, req()))
    expect(evs.at(-1)).toMatchObject({ type: 'done', reason: 'error', error: { kind: 'quota' } })
    expect((await accounts(k))[0].state).toBe('quota_exhausted')
    expect(await k.handle('models.quota', { accountId: ref.accountId })).toEqual({ link: 'https://chatgpt.com/settings/usage' })
  })

  it('403 chatpass_v2_scope_not_authorized → not_authorized', async () => {
    const { k, svc, ref } = await ready()
    api.st.respond = (_q, res) => json(res, 403, { error: { code: 'chatpass_v2_scope_not_authorized', message: 'no' } })
    const evs = await collect(svc.stream(ref, req()))
    expect(evs.at(-1)).toMatchObject({ error: { kind: 'auth' } })
    expect((await accounts(k))[0].state).toBe('not_authorized')
  })

  it('流中途 response.failed(usage_unavailable)→ done{unavailable, retryable}', async () => {
    const { svc, ref } = await ready()
    api.st.respond = (_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(fixture('responses-failed.txt').replace('rate_limit_exceeded', 'subscription_sharing_usage_unavailable'))
    }
    const evs = await collect(svc.stream(ref, req()))
    expect(evs.at(-1)).toMatchObject({ type: 'done', reason: 'error', error: { kind: 'unavailable', retryable: true } })
  })

  it('listModels 过滤 visibility,test() 走 /v1/models', async () => {
    const { k, ref } = await ready()
    expect(await k.handle('models.testAccount', { accountId: ref.accountId })).toEqual({ ok: true })
    const c = api.st.calls.find(x => x.path === '/v1/models')!
    expect(c.headers.authorization).toBe('Bearer at-1')
  })

  it('删除账号 → 吊销 refresh token,之后再登录会新建账号', async () => {
    const { k, a } = await ready()
    await k.handle('models.removeAccount', { commandId: 'rm1', accountId: a.id })
    expect(auth.st.revokes).toHaveLength(1)
    expect(Object.fromEntries(auth.st.revokes[0])).toEqual({ token: 'rt-1', token_type_hint: 'refresh_token', client_id: 'oaiapp_1' })
    expect(await accounts(k)).toHaveLength(0)
  })

  it('重启后从凭据恢复:状态 ok,令牌仍可用', async () => {
    const { k, ref } = await ready()
    await k.close()
    kernels = kernels.filter(x => x !== k)
    const authBase = await auth.start()
    const apiBase = `${await api.start()}/v1`
    let svc2: ModelsService | undefined
    const capture: Plugin = { manifest: { id: 'capture', version: '1', kernel: '*', inject: ['models'] }, activate(ctx) { svc2 = ctx.services.get<ModelsService>('models') } }
    const k2 = await createKernel({ dataDir: dir, plugins: [createModelsRegistry({ catalogRefresh: false }), createModelChatgpt({ authBase, apiBase, now, openPortPreferred: 0 }), capture], secrets: { osBackend: false } })
    kernels.push(k2)
    expect((await accounts(k2))[0].state).toBe('ok')
    const evs = await collect(svc2!.stream(ref, req()))
    expect(evs.at(-1)).toMatchObject({ reason: 'stop' })
    expect(existsSync(join(dir, 'plugins', 'model-chatgpt', 'host-id'))).toBe(true)
  })
})
