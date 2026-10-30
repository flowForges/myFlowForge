// models-registry:账号、目录、受限规则、用量;提供服务 `models`(spec §6.1)
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { AccountConfig, ModelsConfig } from '../../kernel/config'
import type { Plugin, PluginContext } from '../../kernel/pluginHost'
import { RpcError } from '../../kernel/rpcError'
import { mergeCatalog, resolveListed, type Snapshot } from '../../lib/models/catalog/merge'
import { PRESETS, type Preset } from '../../lib/models/catalog/presets'
import snapshotJson from '../../lib/models/catalog/models.snapshot.json'
import type {
  Account,
  AddAccountInput,
  ModelAdapter,
  ModelError,
  ModelEvent,
  ModelProtocol,
  ModelsService,
  Quota,
} from '../../lib/models/types'
import type { AccountState, CatalogView, ModelRef } from '../../protocol/models'
import { AccountStore } from './accounts'
import { startCatalogRefresh, type Timers } from './catalog'
import { manifest } from './manifest'
import { probeQuota } from './quota'

export interface RegistryOpts {
  /** 目录刷新与用量探针用的 fetch(测试注入) */
  fetch?: typeof fetch
  timers?: Timers
  now?: () => number
  /** false:不做运行时目录刷新(端到端测试) */
  catalogRefresh?: boolean
}

const ERR_INVALID_PARAMS = -32602
const QUOTA_TTL_MS = 5 * 60_000
const CHATGPT_USAGE = 'https://chatgpt.com/settings/usage'
const OK_REASONS = new Set(['stop', 'length', 'tool_calls'])

const invalid = (m: string) => new RpcError(ERR_INVALID_PARAMS, m)
const keyName = (id: string) => `account/${id}/apiKey`
const errKind = (err: unknown) => (err instanceof Error ? err.name : 'error')
const fail = (kind: ModelError['kind'], message: string, retryable = false): ModelEvent => ({
  type: 'done', reason: 'error', error: { kind, message, retryable },
})

/** 错误文本里出现的密钥一律打码 */
function redact(e: ModelError, secret?: string): ModelError {
  return secret ? { ...e, message: e.message.split(secret).join('***') } : e
}

function toModelError(err: unknown): ModelError {
  const e = (err as { error?: Partial<ModelError> } | undefined)?.error
  if (e && typeof e.kind === 'string' && typeof e.message === 'string')
    return { kind: e.kind, message: e.message, retryable: !!e.retryable, ...(e.retryAfterMs !== undefined && { retryAfterMs: e.retryAfterMs }) }
  return { kind: 'network', message: err instanceof Error ? err.message : String(err), retryable: true }
}

function validUrl(u: string): boolean {
  try {
    const p = new URL(u).protocol
    return p === 'https:' || p === 'http:'
  } catch {
    return false
  }
}

export function createModelsRegistry(opts: RegistryOpts = {}): Plugin {
  return {
    manifest,
    async activate(ctx: PluginContext) {
      const fetchImpl = opts.fetch ?? fetch
      const now = opts.now ?? Date.now
      const presets = new Map(PRESETS.map(p => [p.id, p]))
      const adapters = new Map<ModelProtocol, ModelAdapter>()
      const removeHooks = new Map<ModelProtocol, (a: Account) => void | Promise<void>>()
      const quotaCache = new Map<string, { at: number; value: Quota | null }>()
      const store = new AccountStore(ctx.config.models as ModelsConfig | undefined, cfg => ctx.updateConfig('models', cfg))

      // 目录:预设 > 运行时缓存 > 入库快照
      const snapshot = snapshotJson as Snapshot
      let cache: Snapshot | undefined
      let merged: CatalogView | undefined
      if (opts.catalogRefresh !== false) {
        const r = startCatalogRefresh({
          file: join(ctx.dataDir, 'cache', 'models.json'),
          providers: new Set(PRESETS.flatMap(p => (p.snapshotProvider ? [p.snapshotProvider] : []))),
          fetch: fetchImpl,
          timers: opts.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: h => clearTimeout(h as NodeJS.Timeout) },
          now,
          log: ctx.log,
          onUpdate: s => { cache = s; merged = undefined },
        })
        cache = r.cache
        ctx.effect(() => r.stop())
      }

      let alive = true
      ctx.effect(() => { alive = false })
      const readKey = async (id: string) => {
        try {
          return await ctx.secrets.get(keyName(id))
        } catch {
          return undefined
        }
      }
      const emit = (a: AccountConfig) => ctx.append({ type: 'account.updated', payload: { account: store.view(a) } })
      const setState = (a: AccountConfig, s: AccountState) => { if (store.setState(a.id, s)) emit(a) }
      const mustGet = (id: string) => {
        const a = store.get(id)
        if (!a) throw invalid('unknown account')
        return a
      }
      const protocolOf = (a: AccountConfig, p: Preset): ModelProtocol => a.protocol ?? p.preferred
      // 错误种类 → 账号状态
      // ChatGPT:适配器已标 not_authorized(未授权套餐使用)时保留,不改成 needs_login
      const applyError = (a: AccountConfig, p: Preset, e: ModelError) => {
        if (e.kind === 'auth')
          setState(a, p.auth !== 'chatgpt-oauth' ? 'error' : store.state(a.id) === 'not_authorized' ? 'not_authorized' : 'needs_login')
        else if (e.kind === 'quota') setState(a, 'quota_exhausted')
      }

      // 启动:状态默认 ok;api-key 账号读不到密钥 → error(不发事件)
      for (const a of store.list()) {
        const p = presets.get(a.presetId)
        if (!p || (p.auth === 'api-key' && !(await readKey(a.id)))) store.setState(a.id, 'error')
      }

      /** 组装交给适配器的运行时账号;apiKey 只在内存里 */
      async function prepare(a: AccountConfig, p: Preset): Promise<{ account: Account; adapter: ModelAdapter } | { error: ModelError }> {
        const protocol = protocolOf(a, p)
        const adapter = adapters.get(protocol)
        if (!adapter) return { error: { kind: 'unavailable', message: `no adapter for ${protocol}`, retryable: false } }
        const baseUrl = a.baseUrl ?? p.protocols[protocol]
        if (!baseUrl) return { error: { kind: 'bad_request', message: 'no base url', retryable: false } }
        let apiKey: string | undefined
        if (p.auth === 'api-key') {
          apiKey = await readKey(a.id)
          if (!apiKey) {
            setState(a, 'error')
            return { error: { kind: 'auth', message: 'api key unavailable', retryable: false } }
          }
        }
        const testModel = modelsOf(a)[0]?.id
        const account: Account = {
          id: a.id, presetId: a.presetId, label: a.label, protocol, baseUrl, state: store.state(a.id), quirks: p.quirks,
          ...(testModel !== undefined && { testModel }),
          ...(apiKey !== undefined && { apiKey }),
        }
        return { account, adapter }
      }

      /** 该账号可选的模型:目录(预设)非空时以它为准,否则用账号上的清单 */
      const modelsOf = (a: AccountConfig) => {
        const c = service.catalog().models[a.presetId]
        return c?.length ? c : a.models ?? []
      }

      // 列模型:同一账号同一时刻只跑一次;只给目录里为空的预设(models:'list')用
      const listing = new Map<string, Promise<void>>()
      function refreshModels(id: string): Promise<void> {
        const a = store.get(id)
        const p = a && presets.get(a.presetId)
        if (!a || !p || service.catalog().models[a.presetId]?.length) return Promise.resolve()
        let run = listing.get(id)
        if (run) return run
        run = (async () => {
          const r = await prepare(a, p)
          if ('error' in r || !r.adapter.listModels) return
          const listed = await r.adapter.listModels(r.account)
          const cur = store.get(id)
          if (!alive || !cur || !listed.length) return
          // 手填的在前,列出的补在后(按 id 去重);上次列出的条目保留其元数据,这次没列出的去掉
          const wasListed = new Set(cur.listedModelIds ?? [])
          const manual = (cur.models ?? []).filter(m => !wasListed.has(m.id))
          const prev = new Map((cur.models ?? []).map(m => [m.id, m]))
          const have = new Set(manual.map(m => m.id))
          const added = resolveListed(listed, p.snapshotProvider, snapshot, cache)
            .filter(m => !have.has(m.id) && (have.add(m.id), true))
            .map(m => prev.get(m.id) ?? m)
          const models = [...manual, ...added]
          const listedIds = added.map(m => m.id)
          if (JSON.stringify(models) === JSON.stringify(cur.models) && JSON.stringify(listedIds) === JSON.stringify(cur.listedModelIds ?? [])) return
          store.setModels(id, models, listedIds)
          emit(store.get(id)!)
        })()
          .catch(err => ctx.log.warn('model list failed', { failure: toModelError(err).kind }))
          .finally(() => listing.delete(id))
        listing.set(id, run)
        return run
      }

      const service: ModelsService = {
        registerAdapter(protocol, a) {
          if (adapters.has(protocol)) throw new Error(`adapter already registered: ${protocol}`)
          adapters.set(protocol, a)
          // 启动后(以及适配器重新注册时):给状态 ok 的账号刷新模型清单,不阻塞
          if (a.listModels) {
            queueMicrotask(() => {
              for (const acc of store.list()) {
                const p = presets.get(acc.presetId)
                if (p && protocolOf(acc, p) === protocol && store.state(acc.id) === 'ok') void refreshModels(acc.id)
              }
            })
          }
          return () => { if (adapters.get(protocol) === a) adapters.delete(protocol) }
        },

        registerRemoveHook(protocol, fn) {
          removeHooks.set(protocol, fn)
          return () => { if (removeHooks.get(protocol) === fn) removeHooks.delete(protocol) }
        },

        catalog() {
          merged ??= mergeCatalog(PRESETS, snapshot, cache)
          const d = store.default
          return d ? { ...merged, default: d } : merged
        },

        accounts: () => store.list().map(a => store.view(a)),

        async addAccount(input: AddAccountInput, opts = {}) {
          const p = presets.get(input.presetId)
          if (!p) throw invalid('unknown preset')
          if (p.restriction === 'coding-tools-only' && input.restrictionAck !== true) throw invalid('restriction acknowledgement required')
          const apiKey = input.apiKey?.trim()
          if (p.auth === 'api-key' && !apiKey) throw invalid('api key required')
          const protocols = Object.keys(p.protocols)
          if (input.protocol && (protocols.length ? !protocols.includes(input.protocol) : input.protocol === 'chatgpt')) throw invalid('unsupported protocol')
          const baseUrl = input.baseUrl?.trim() || undefined
          if (baseUrl !== undefined && !validUrl(baseUrl)) throw invalid('invalid base url')
          if (!protocols.length && !baseUrl) throw invalid('base url required')

          const id = opts.id ?? randomUUID()
          if (store.get(id)) throw invalid('account exists')
          if (p.auth === 'api-key' && apiKey) await ctx.secrets.set(keyName(id), apiKey)
          const acc: AccountConfig = {
            id,
            presetId: p.id,
            label: input.label?.trim() || p.label,
            ...(baseUrl !== undefined && { baseUrl }),
            ...(input.protocol && { protocol: input.protocol }),
            ...(p.restriction === 'coding-tools-only' && { restrictionAckAt: now() }),
            ...(input.models && { models: input.models }),
          }
          try {
            store.add(acc)
          } catch (err) {
            await ctx.secrets.delete(keyName(id)).catch(() => {})
            throw err
          }
          emit(acc)
          void refreshModels(id)
          return store.view(acc)
        },

        async removeAccount(id) {
          const a = mustGet(id)
          const p = presets.get(a.presetId)
          const protocol = p ? protocolOf(a, p) : a.protocol
          const hook = protocol && removeHooks.get(protocol)
          if (hook && protocol) {
            const account: Account = {
              id: a.id, presetId: a.presetId, label: a.label, protocol, baseUrl: a.baseUrl ?? p?.protocols[protocol] ?? '',
              state: store.state(a.id), quirks: p?.quirks,
            }
            try { await hook(account) } catch (err) { ctx.log.warn('remove hook failed', { failure: errKind(err) }) }
          }
          store.remove(id)
          quotaCache.delete(id)
          try { await ctx.secrets.delete(keyName(id)) } catch (err) { ctx.log.warn('secret delete failed', { failure: errKind(err) }) }
        },

        async testAccount(id) {
          const a = mustGet(id)
          const p = presets.get(a.presetId)
          if (!p) return { ok: false, error: { kind: 'bad_request', message: 'unknown preset', retryable: false } }
          const r = await prepare(a, p)
          if ('error' in r) return { ok: false, error: r.error }
          try {
            await r.adapter.test(r.account)
            setState(a, 'ok')
            void refreshModels(id)
            return { ok: true }
          } catch (err) {
            const e = redact(toModelError(err), r.account.apiKey)
            applyError(a, p, e)
            return { ok: false, error: e }
          }
        },

        setDefault(ref: ModelRef) {
          const a = mustGet(ref.accountId)
          const known = modelsOf(a)
          if (known.length && !known.some(m => m.id === ref.modelId)) throw invalid('unknown model')
          store.setDefault(ref)
        },

        setState(id, s) {
          const a = store.get(id)
          if (a) setState(a, s)
        },

        refreshModels,

        announce(id) {
          const a = store.get(id)
          if (a) emit(a)
        },

        async *stream(ref, req) {
          const r = ref === 'default' ? store.default : ref
          if (!r) return yield fail('bad_request', 'no default model')
          const a = store.get(r.accountId)
          if (!a) return yield fail('bad_request', 'unknown account')
          const p = presets.get(a.presetId)
          if (!p) return yield fail('bad_request', 'unknown preset')
          // 受限规则:先于读密钥 / 选适配器,零网络
          if (!req.interactive && p.restriction === 'coding-tools-only')
            return yield fail('restricted', 'this plan only allows interactive use in coding tools')
          const prep = await prepare(a, p)
          if ('error' in prep) return yield { type: 'done', reason: 'error', error: prep.error }
          const key = prep.account.apiKey
          // 目录明确说该模型不支持推理:reasoning 置 'off'(各线路的关闭形式);未知模型原样透传
          const entry = modelsOf(a).find(m => m.id === r.modelId)
          const sent = entry?.reasoning === 'none' ? { ...req, reasoning: 'off' as const } : req
          try {
            for await (const e of prep.adapter.stream(prep.account, { ...sent, model: r.modelId })) {
              if (e.type !== 'done') {
                yield e
                continue
              }
              const out: ModelEvent = e.error ? { ...e, error: redact(e.error, key) } : e
              if (out.type === 'done' && out.error) applyError(a, p, out.error)
              else if (OK_REASONS.has(e.reason)) setState(a, 'ok')
              return yield out
            }
          } catch (err) {
            // 适配器违约(应以 done 结束而不是抛错)
            ctx.log.warn('adapter stream threw', { failure: errKind(err) })
            if (req.signal.aborted) return yield { type: 'done', reason: 'cancelled' }
            return yield { type: 'done', reason: 'error', error: redact(toModelError(err), key) }
          }
          yield req.signal.aborted ? { type: 'done', reason: 'cancelled' } : fail('network', 'stream ended without done', true)
        },

        async quota(id) {
          const a = mustGet(id)
          const hit = quotaCache.get(id)
          if (hit && now() - hit.at < QUOTA_TTL_MS) return hit.value
          const p = presets.get(a.presetId)
          let value: Quota | null = null
          if (p?.quotaProbe === 'link') value = { link: CHATGPT_USAGE }
          else if (p?.quotaProbe) {
            const kind = p.quotaProbe
            // Kimi 用量挂在 coding base(OpenAI 线路)下;其余只取 origin
            const base = kind === 'kimi'
              ? (a.protocol === 'openai-chat' && a.baseUrl) || p.protocols['openai-chat']
              : a.baseUrl ?? p.protocols[protocolOf(a, p)]
            const apiKey = await readKey(id)
            if (!apiKey) setState(a, 'error')
            else if (base) {
              const r = await probeQuota(kind, { baseUrl: base, apiKey, fetch: fetchImpl })
              if (r.authFailed) setState(a, 'error')
              value = r.quota
            }
          }
          quotaCache.set(id, { at: now(), value })
          return value
        },
      }

      ctx.services.provide('models', service)

      const view = (e: ModelError) => ({ kind: e.kind, message: e.message })
      ctx.rpc.register('models.catalog', async () => service.catalog())
      ctx.rpc.register('models.accounts', async () => ({ accounts: service.accounts(), secretsBackend: ctx.secretsBackend }))
      ctx.rpc.register('models.addAccount', async params => {
        const { commandId: _c, ...input } = params as AddAccountInput & { commandId: string }
        if (presets.get(input.presetId)?.auth === 'chatgpt-oauth') throw invalid('chatgpt accounts are added by login')
        return service.addAccount(input)
      })
      ctx.rpc.register('models.removeAccount', async params => {
        await service.removeAccount((params as { accountId: string }).accountId)
        return { ok: true }
      })
      ctx.rpc.register('models.testAccount', async params => {
        const r = await service.testAccount((params as { accountId: string }).accountId)
        return r.error ? { ok: false, error: view(r.error) } : { ok: r.ok }
      })
      ctx.rpc.register('models.setDefault', async params => {
        service.setDefault(params as ModelRef)
        return { ok: true }
      })
      ctx.rpc.register('models.quota', async params => service.quota((params as { accountId: string }).accountId))
    },
  }
}

// MFFAI_CATALOG_OFFLINE=1:端到端测试不联网
export default createModelsRegistry({ catalogRefresh: process.env.MFFAI_CATALOG_OFFLINE !== '1' })
