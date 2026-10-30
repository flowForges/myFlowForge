// model-chatgpt:Sign in with ChatGPT(套餐共享)——登录、令牌刷新 / 吊销、Responses 推理(spec §6.4 / §9)
// ★code / token / authUrl(可能含 id_token_hint)一律不进日志、事件、RPC 结果之外的地方
import { randomUUID } from 'node:crypto'
import type { Plugin } from '../../kernel/pluginHost'
import { ModelFailure } from '../../lib/models/http'
import { buildResponsesBody, decodeResponsesStream } from '../../lib/models/responses'
import type { SSEEvent } from '../../lib/models/sse'
import type { AccountState, AccountView } from '../../protocol/models'
import type { ModelAdapter, ModelError, ModelEvent, ModelsService } from '../../lib/models/types'
import { getJson, joinUrl, streamWire } from '../../lib/models/wire'
import { errorCodeOf, mapChatgptCode, mapChatgptError, NOT_AUTHORIZED_CODES, RELOGIN_CODES } from './errors'
import { verifyIdToken } from './jwks'
import { manifest } from './manifest'
import {
  API_BASE, AUTH_BASE, authorizeUrl, DIRECT_SCOPE, fetchJwks, hostId, listenCallback, type OAuthRecord, pkce, postToken,
  randomToken, REGISTRATION_CLIENT, RESOURCE, revoke, TokenError, type TokenSet,
} from './oauth'
import { encodeChatgptBody, sanitizeChatgptBody } from './sanitize'

export interface ChatgptOpts {
  authBase?: string
  apiBase?: string
  now?: () => number
  /** 回调监听首选端口;被占用时系统分配 */
  openPortPreferred?: number
  flowTimeoutMs?: number
}

const PRESET = 'chatgpt'
const REFRESH_AHEAD_MS = 180_000
const FLOW_TIMEOUT_MS = 5 * 60_000
const USAGE_LINK = 'https://chatgpt.com/settings/usage'

const keyName = (id: string) => `account/${id}/oauth`
const fail = (kind: ModelError['kind'], message: string, retryable = false) => new ModelFailure({ kind, message, retryable })
/** 日志里只记失败种类 */
const errKind = (err: unknown) => (err instanceof TokenError ? err.code ?? `http_${err.status}` : err instanceof Error ? err.name : 'error')
const failureOf = (err: unknown): ModelError =>
  err instanceof ModelFailure ? err.error : { kind: 'unavailable', message: 'ChatGPT credentials unavailable', retryable: true }

function validRecord(v: unknown): v is OAuthRecord {
  const r = v as OAuthRecord | null
  return !!r && typeof r.clientId === 'string' && typeof r.sub === 'string' && Array.isArray(r.scopes)
}

/** 刷新期间账号重新登录过:结果作废 */
class Superseded extends Error {
  name = 'Superseded'
}

/** Responses 解码 + 套餐共享错误码:流中 response.failed 的码按 §6.4 表改写,并记下供状态判断 */
async function* decodeChatgptStream(events: AsyncIterable<SSEEvent>, seen: { code?: string }): AsyncIterable<ModelEvent> {
  let failed: { code?: string; param?: string } | undefined
  async function* tap() {
    for await (const e of events) {
      if (e.data.includes('"error"') || e.data.includes('failed')) {
        try {
          type Err = { code?: string; param?: string }
          const f = JSON.parse(e.data) as Err & { type?: string; error?: Err; response?: { error?: Err } }
          const type = e.event ?? f.type
          if (type === 'response.failed' || type === 'error') failed = f.response?.error ?? f.error ?? f
        } catch { /* 非 JSON 帧 */ }
      }
      yield e
    }
  }
  for await (const ev of decodeResponsesStream(tap())) {
    if (ev.type === 'done' && ev.error && failed?.code) {
      seen.code = failed.code
      const mapped = mapChatgptCode(failed.code, ev.error.message, failed.param)
      if (mapped) {
        yield { ...ev, error: mapped }
        continue
      }
    }
    yield ev
  }
}

export function createModelChatgpt(opts: ChatgptOpts = {}): Plugin {
  const authBase = opts.authBase ?? AUTH_BASE
  const apiBase = opts.apiBase ?? API_BASE
  const now = opts.now ?? Date.now
  const preferredPort = opts.openPortPreferred ?? 1455
  const flowTimeoutMs = opts.flowTimeoutMs ?? FLOW_TIMEOUT_MS

  return {
    manifest,
    async activate(ctx) {
      const models = ctx.services.get<ModelsService>('models')!
      const flows = new Map<string, () => void>() // flowId → 关闭
      const inflight = new Map<string, Promise<string>>() // accountId → 进行中的取令牌(含刷新)
      // 登录代次:重新登录写凭据前后各加一;刷新落盘前代次变了 → 作废结果,等登录写完再取
      const gen = new Map<string, number>()
      const logins = new Map<string, Promise<void>>()
      const genOf = (id: string) => gen.get(id) ?? 0
      const bump = (id: string) => gen.set(id, genOf(id) + 1)

      const read = async (id: string): Promise<OAuthRecord | undefined> => {
        const v = await ctx.secrets.get(keyName(id))
        if (!v) return undefined
        try {
          const r = JSON.parse(v) as unknown
          return validRecord(r) ? r : undefined
        } catch {
          return undefined
        }
      }
      const write = (id: string, r: OAuthRecord) => ctx.secrets.set(keyName(id), JSON.stringify(r))
      const chatgptAccounts = () => models.accounts().filter(a => a.presetId === PRESET)
      const stateOf = (r: OAuthRecord | undefined): AccountState =>
        !r?.refreshToken || !r.accessToken ? 'needs_login' : r.scopes.includes(DIRECT_SCOPE) ? 'ok' : 'not_authorized'

      // 启动:按凭据恢复账号状态
      for (const a of chatgptAccounts()) {
        try {
          const s = stateOf(await read(a.id))
          if (s !== 'ok') models.setState(a.id, s)
        } catch (err) {
          ctx.log.warn('credential read failed', { failure: errKind(err) })
          models.setState(a.id, 'error')
        }
      }

      // —— 令牌:同一账号同一时刻只有一个取令牌 / 刷新(刷新令牌每次轮换)
      async function accessToken(id: string): Promise<string> {
        try {
          return await sharedToken(id)
        } catch (err) {
          if (!(err instanceof Superseded)) throw err
          await logins.get(id)?.catch(() => {})
          try {
            return await sharedToken(id)
          } catch (e) {
            throw e instanceof Superseded ? fail('unavailable', 'ChatGPT sign-in changed; retry', true) : e
          }
        }
      }

      function sharedToken(id: string): Promise<string> {
        let p = inflight.get(id)
        if (!p) {
          p = ensureToken(id).finally(() => inflight.delete(id))
          inflight.set(id, p)
        }
        return p
      }

      async function ensureToken(id: string): Promise<string> {
        const g = genOf(id)
        let rec: OAuthRecord | undefined
        try {
          rec = await read(id)
        } catch {
          throw fail('unavailable', 'credential store unavailable', true)
        }
        const s = stateOf(rec)
        if (s !== 'ok' || !rec) {
          models.setState(id, s)
          throw fail('auth', s === 'not_authorized' ? 'ChatGPT plan usage is not authorized' : 'ChatGPT sign-in required')
        }
        const t = now()
        const left = (rec.expiresAt ?? 0) - t
        if (left >= REFRESH_AHEAD_MS) return rec.accessToken!
        // 未过期且服务端要求稍后再刷:先用旧令牌
        if (left > 0 && rec.earliestRefreshAt !== undefined && t < rec.earliestRefreshAt) return rec.accessToken!

        let next: TokenSet
        try {
          next = await postToken(authBase, { grant_type: 'refresh_token', client_id: rec.clientId, refresh_token: rec.refreshToken!, resource: RESOURCE }, t)
        } catch (err) {
          if (genOf(id) !== g) throw new Superseded()
          ctx.log.warn('token refresh failed', { failure: errKind(err) })
          const te = err instanceof TokenError ? err : new TokenError(0)
          if (te.code && RELOGIN_CODES.has(te.code)) {
            // 清掉不可用的令牌,保留 client_id / sub / id_token 供重新授权
            const { accessToken: _a, refreshToken: _r, expiresAt: _e, earliestRefreshAt: _x, ...keep } = rec
            await write(id, keep).catch(e => ctx.log.warn('credential write failed', { failure: errKind(e) }))
            models.setState(id, 'needs_login')
            throw fail('auth', 'ChatGPT sign-in expired; sign in again')
          }
          if (te.code === 'invalid_client') {
            models.setState(id, 'error')
            throw fail('bad_request', 'ChatGPT client registration is invalid')
          }
          if (left > 0) return rec.accessToken! // 暂时失败,旧令牌仍有效
          if (te.status === 0) throw fail('network', 'ChatGPT token refresh failed', true)
          if (te.status >= 500) throw fail('unavailable', 'ChatGPT token refresh failed', true)
          throw fail('auth', 'ChatGPT token refresh rejected')
        }
        if (genOf(id) !== g) throw new Superseded() // 期间重新登录过:不覆盖新凭据
        const updated: OAuthRecord = { ...rec, accessToken: next.accessToken, refreshToken: next.refreshToken ?? rec.refreshToken, expiresAt: next.expiresAt, scopes: next.scopes ?? rec.scopes }
        if (next.earliestRefreshAt !== undefined) updated.earliestRefreshAt = next.earliestRefreshAt
        else delete updated.earliestRefreshAt
        await write(id, updated) // 与上面的代次检查同一 tick 入队;写入按调用顺序串行
        if (!updated.scopes.includes(DIRECT_SCOPE)) {
          models.setState(id, 'not_authorized')
          throw fail('auth', 'ChatGPT plan usage is not authorized')
        }
        return next.accessToken
      }

      // —— 适配器
      const adapter: ModelAdapter = {
        async *stream(account, req) {
          const cancelled: ModelEvent = { type: 'done', reason: 'cancelled' }
          if (req.signal.aborted) return yield cancelled
          let token: string
          try {
            token = await accessToken(account.id)
          } catch (err) {
            return yield req.signal.aborted ? cancelled : { type: 'done', reason: 'error', error: failureOf(err) }
          }
          if (req.signal.aborted) return yield cancelled
          const enc = encodeChatgptBody(sanitizeChatgptBody(buildResponsesBody(req, { store: false, includeEncryptedReasoning: true })))
          const headers = {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            authorization: `Bearer ${token}`,
            'session-id': randomUUID(),
            'x-client-request-id': randomUUID(),
            ...enc.headers,
          }
          const seen: { code?: string } = {}
          const mapError = (status: number, body: string, h: Headers) => {
            seen.code = errorCodeOf(body).code
            return mapChatgptError(status, body, h)
          }
          // 推理只发往 apiBase(正式环境 https://api.openai.com/v1),不用账号里的 baseUrl
          for await (const ev of streamWire(joinUrl(apiBase, '/responses'), headers, enc.body, req, e => decodeChatgptStream(e, seen), { mapError })) {
            if (ev.type === 'done' && ev.error && seen.code && NOT_AUTHORIZED_CODES.has(seen.code)) models.setState(account.id, 'not_authorized')
            yield ev
          }
        },

        async listModels(account) {
          const token = await accessToken(account.id)
          const j = (await getJson(joinUrl(apiBase, '/models'), { authorization: `Bearer ${token}` })) as { models?: unknown; data?: unknown } | undefined
          const list = Array.isArray(j?.models) ? j.models : Array.isArray(j?.data) ? j.data : []
          return (list as Record<string, unknown>[]).flatMap(m => {
            if (m?.visibility !== undefined && m.visibility !== 'list') return []
            const id = typeof m?.slug === 'string' ? m.slug : typeof m?.id === 'string' ? m.id : undefined
            if (!id) return []
            const name = typeof m.display_name === 'string' ? m.display_name : undefined
            return [{ id, ...(name && name !== id && { name }) }]
          })
        },

        async test(account) {
          await adapter.listModels!(account)
        },

        async quota() {
          return { link: USAGE_LINK }
        },
      }
      ctx.effect(models.registerAdapter('chatgpt', adapter))

      // 删除账号:先吊销 refresh token(失败只记日志),再删本地凭据
      ctx.effect(models.registerRemoveHook('chatgpt', async a => {
        const r = await read(a.id).catch(() => undefined)
        if (r?.refreshToken)
          await revoke(authBase, { refreshToken: r.refreshToken, clientId: r.clientId }).catch(err => ctx.log.warn('token revoke failed', { failure: errKind(err) }))
        await ctx.secrets.delete(keyName(a.id))
      }))

      // —— 登录
      /** 需要重新登录 / 未授权的账号:用它签发的 client_id 重新授权 */
      async function reauthTarget(): Promise<{ accountId: string; record: OAuthRecord; consent: boolean } | undefined> {
        for (const a of chatgptAccounts()) {
          if (a.state !== 'needs_login' && a.state !== 'not_authorized') continue
          const record = await read(a.id).catch(() => undefined)
          if (record) return { accountId: a.id, record, consent: a.state === 'not_authorized' }
        }
        return undefined
      }

      async function findAccount(sub: string, clientId: string): Promise<AccountView | undefined> {
        for (const a of chatgptAccounts()) {
          const r = await read(a.id).catch(() => undefined)
          if (r?.sub === sub && r.clientId === clientId) return a
        }
        return undefined
      }

      async function begin(): Promise<{ flowId: string; authUrl: string }> {
        for (const close of [...flows.values()]) close() // 同一时刻只有一个登录
        const host = hostId(ctx.dataDir)
        const target = await reauthTarget()
        const state = randomToken()
        const nonce = randomToken()
        const { verifier, challenge } = pkce()
        const flowId = randomUUID()
        let redirectUri = ''
        let busy = false
        const ac = new AbortController() // 取消 / 超时 / 停用:中止进行中的换 token,且不再写账号

        /** 成功返回 undefined,否则返回给浏览器的短错误 */
        async function complete(q: URLSearchParams): Promise<string | undefined> {
          if (q.get('error')) return '授权未完成'
          const code = q.get('code')
          if (!code) return '缺少授权码'
          const issued = q.get('client_id') || undefined
          let clientId: string
          if (target) {
            if (issued && issued !== target.record.clientId) return 'client_id 不一致'
            clientId = target.record.clientId
          } else {
            if (!issued || issued === REGISTRATION_CLIENT) return '注册未完成'
            clientId = issued
          }
          const tokens = await postToken(authBase, { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE }, now(), ac.signal)
          if (!tokens.idToken) return '缺少 id_token'
          if (!tokens.refreshToken) return '缺少 refresh_token'
          const claims = verifyIdToken(tokens.idToken, { jwks: await fetchJwks(authBase, ac.signal), clientId, nonce, now: now() })
          if (target && claims.sub !== target.record.sub) return '账号不一致'
          // 以令牌响应的 scope 为准;仅当它缺省时才看回调里的 scope
          const scopes = tokens.scopes ?? (q.get('scope') ?? '').split(' ').filter(Boolean)
          const record: OAuthRecord = {
            clientId, sub: claims.sub, scopes, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt,
            ...(tokens.earliestRefreshAt !== undefined && { earliestRefreshAt: tokens.earliestRefreshAt }), idToken: tokens.idToken,
          }
          const nextState: AccountState = scopes.includes(DIRECT_SCOPE) ? 'ok' : 'not_authorized'
          const existing = target ? chatgptAccounts().find(a => a.id === target.accountId) : await findAccount(claims.sub, clientId)
          if (ac.signal.aborted) return '登录已取消'
          if (existing) {
            const id = existing.id
            // 先加代次让进行中的刷新作废,等它结束,写入后再加一次(写入前开始的刷新读到的是旧凭据)
            bump(id)
            const done = (async () => {
              await inflight.get(id)?.catch(() => {})
              await write(id, record)
            })()
            logins.set(id, done)
            try {
              await done
            } finally {
              bump(id)
              if (logins.get(id) === done) logins.delete(id)
            }
            const cur = chatgptAccounts().find(a => a.id === existing.id)?.state
            if (cur === nextState) models.announce(existing.id)
            else models.setState(existing.id, nextState)
            return undefined
          }
          const label = typeof claims.email === 'string' && claims.email ? claims.email : undefined
          const view = await models.addAccount({ presetId: PRESET, ...(label && { label }) })
          try {
            await write(view.id, record)
          } catch (err) {
            await models.removeAccount(view.id).catch(() => {})
            throw err
          }
          if (nextState !== 'ok') models.setState(view.id, nextState)
          return undefined
        }

        // 处理中仍留在 flows 里:取消 / 新的 begin / 停用都能关掉监听;回复发完或浏览器断开后监听自行关闭
        const listener = await listenCallback(preferredPort, async q => {
          if (q.get('state') !== state) return { status: 400, text: '登录状态不匹配' }
          if (busy) return { status: 409, text: '登录处理中' }
          busy = true
          try {
            const err = await complete(q)
            return err ? { status: 400, text: err, close: true } : { status: 200, text: '已完成', close: true }
          } catch (err) {
            ctx.log.warn('chatgpt login failed', { failure: errKind(err) })
            return { status: 400, text: '登录失败', close: true }
          } finally {
            clearTimeout(timer)
            flows.delete(flowId)
          }
        })
        redirectUri = `http://127.0.0.1:${listener.port}/auth/callback`
        const close = () => {
          clearTimeout(timer)
          flows.delete(flowId)
          ac.abort()
          listener.close()
        }
        const timer = setTimeout(close, flowTimeoutMs)
        timer.unref()
        flows.set(flowId, close)
        const authUrl = authorizeUrl(authBase, {
          redirectUri, state, nonce, challenge, hostId: host,
          ...(target && { reauth: { clientId: target.record.clientId, idToken: target.record.idToken, consent: target.consent } }),
        })
        return { flowId, authUrl }
      }

      // begin 串行:后一个先关掉前一个的监听再开始
      let beginning: Promise<unknown> = Promise.resolve()
      ctx.rpc.register('auth.chatgpt.begin', async () => {
        const run = beginning.then(begin, begin)
        beginning = run.catch(() => {})
        return run
      })
      ctx.rpc.register('auth.chatgpt.cancel', async params => {
        flows.get((params as { flowId: string }).flowId)?.()
        return { ok: true }
      })
      ctx.effect(() => { for (const close of [...flows.values()]) close() })
    },
  }
}

export default createModelChatgpt()
