import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { KernelEvent, SecretsBackend, WorkerMethodName } from '../protocol/index'
import type { KernelConfig } from './config'
import type { EventLog, RedactEdit } from './eventLog'
import type { EventBus } from './events'
import type { ServiceRegistry } from './services'
import { EffectScope } from './effects'
import type { Logger } from './log'
import type { RpcRegistry } from './rpcRegistry'
import { scopedSecrets, type SecretStore } from './secrets/secretStore'

export interface PluginManifest {
  id: string
  version: string
  kernel: string
  provides?: string[]
  inject?: string[]
}

export interface PluginContext {
  services: { provide<T>(key: string, impl: T): void; get<T>(key: string): T | undefined }
  events: Pick<EventBus, 'declare' | 'on' | 'emit' | 'waterfall' | 'serial' | 'bail'> & {
    /** 只读:某会话的事件(seq 升序) */
    history(sessionId: string): KernelEvent[]
    /** 只读:seq 之后的事件(所有会话,seq 升序),最多 limit 条 */
    after(seq: number, limit: number): KernelEvent[]
    /** 日志提交后才通知;回滚的事务不通知。给的是副本,改了不影响别人。抛错、reject 只记日志。随插件停用注销。在调用方的写入路径上同步跑:不要做 I/O */
    onAppend(cb: (e: KernelEvent) => void): () => void
    /** 用户删除记忆时就地换掉文本(见 EventLog.redact);只有 EVENT_REDACTORS 能调,否则抛错。返回改了几个事件 */
    redact(edits: RedactEdit[]): number
    /**
     * redact 之后把文本从库文件的空隙里也清掉(见 EventLog.purge);权限同 redact。做不到就 reject。
     * 这期间整个工作进程同步阻塞,所以先向监管要时间,要不到就不做。then:同一段时间里要做的别的阻塞活,extraBytes 是它的体量
     */
    purge(o?: { then?(): void; extraBytes?: number }): Promise<void>
    /** 删会话:整会话抹除(见 EventLog.eraseSession);权限同 redact。会话还没有 session.deleted 就抛错。返回改了几条 */
    eraseSession(sessionId: string): number
  }
  effect(dispose: () => void | Promise<void>): void
  /** 注册工作进程 RPC 方法:参数先由内核按 WorkerMethods 校验;随插件停用自动注销 */
  rpc: { register(method: WorkerMethodName, handler: (params: unknown) => Promise<unknown>): void }
  log: Logger
  /** 本插件可写配置段在激活时的快照(见 CONFIG_SECTIONS);其他插件为空对象 */
  config: Record<string, unknown>
  /** 写本插件声明的配置段:按 KernelConfigSchema 校验后原子落盘;非本插件的段 → 抛错 */
  updateConfig(section: string, value: unknown): void
  /** 凭据存储后端(启动时探测后固定) */
  readonly secretsBackend: SecretsBackend
  dataDir: string
  /** 只能读写本插件的键(内核自动加 `<pluginId>/` 前缀);没有列举接口 */
  secrets: { get(k: string): Promise<string | undefined>; set(k: string, v: string): Promise<void>; delete(k: string): Promise<void> }
  append(e: Omit<KernelEvent, 'seq' | 'ts'>): KernelEvent
}

export interface Plugin {
  manifest: PluginManifest
  activate(ctx: PluginContext): void | Promise<void>
}

/** 插件可写的内核配置段:收紧为白名单 */
export const CONFIG_SECTIONS: Record<string, (keyof KernelConfig)[]> = { 'models-registry': ['models'], 'executor-cli': ['executors'], 'memory-default': ['memory'], 'channel-telegram': ['channels'] }

/** 能就地改事件日志的插件:日志只追加的唯一例外(06 spec §16) */
export const EVENT_REDACTORS: readonly string[] = ['memory-default']
/** loadDevPlugins 的替身抛的稳定代码 */
const DEV_CODE = /^dev_[a-z_]{1,40}$/

export interface PluginConfigAccess {
  get(): KernelConfig
  /** 校验 + 原子落盘;失败抛错,内存配置不变 */
  update(section: keyof KernelConfig, value: unknown): void
}

export interface PluginState {
  id: string
  state: 'active' | 'failed' | 'disabled'
  error?: string
  /** 开发插件:什么都能做。08 要一直显示 */
  trust?: 'dev'
}

/** 实测约 13 ms/MB;机器忙的时候留够 7 倍,再加一段启动余量 */
export function purgeHoldMs(bytes: number): number {
  return 30_000 + Math.ceil(bytes / 1_048_576) * 100
}

export interface PluginHostDeps {
  services: ServiceRegistry
  events: EventBus
  rpc: RpcRegistry
  append(e: Omit<KernelEvent, 'seq' | 'ts'>): KernelEvent
  history?(sessionId: string): KernelEvent[]
  eventLog?: Pick<EventLog, 'after' | 'onAppend' | 'redact' | 'purge' | 'sizeBytes' | 'eraseSession'>
  holdWatchdog?: (ms: number) => Promise<void>
  log: Logger
  dataDir: string
  injectTimeoutMs?: number
  secrets: SecretStore
  config?: PluginConfigAccess
  /** 开发插件的 id(entry/worker.ts 给) */
  devIds?: readonly string[]
}

export class PluginHost {
  private scopes = new Map<string, EffectScope>()
  private list: PluginState[] = []

  constructor(private deps: PluginHostDeps) {}

  async activateAll(plugins: Plugin[], disabled: string[]): Promise<void> {
    for (const p of plugins) {
      const id = p.manifest.id
      if (disabled.includes(id)) {
        this.list.push({ id, state: 'disabled' })
        continue
      }
      await this.activateOne(p)
    }
  }

  private async activateOne(p: Plugin): Promise<void> {
    const { id } = p.manifest
    const { services, events, rpc, append, log } = this.deps
    const scope = new EffectScope()
    const entry: PluginState = { id, state: 'active' }
    this.list.push(entry)
    this.scopes.set(id, scope)
    try {
      if (!id || id.includes('/')) throw new Error(`invalid plugin id: ${id}`) // 凭据前缀 `<id>/` 不能互相覆盖
      await this.waitInject(p.manifest.inject ?? [])
      const dataDir = join(this.deps.dataDir, 'plugins', id)
      mkdirSync(dataDir, { recursive: true })
      const pluginLog: Logger = {
        info: (m, d) => log.info(`[${id}] ${m}`, d),
        warn: (m, d) => log.warn(`[${id}] ${m}`, d),
        error: (m, d) => log.error(`[${id}] ${m}`, d),
      }
      const sections = CONFIG_SECTIONS[id] ?? []
      const cfg = this.deps.config
      const ownConfig: Record<string, unknown> = {}
      for (const k of sections) if (cfg) ownConfig[k] = structuredClone(cfg.get()[k])
      const secretStore = this.deps.secrets
      const ctx: PluginContext = {
        services: {
          provide: (key, impl) => scope.add(services.provide(key, impl)),
          get: key => services.get(key),
        },
        events: {
          declare: (t, m) => events.declare(t, m),
          // 监听者随插件停用自动注销
          on: (t, h, o) => {
            const off = events.on(t, h, o)
            scope.add(off)
            return off
          },
          emit: (t, ...a) => events.emit(t, ...a),
          waterfall: (t, v, ...a) => events.waterfall(t, v, ...a),
          serial: (t, ...a) => events.serial(t, ...a),
          bail: (t, ...a) => events.bail(t, ...a),
          history: sid => this.deps.history?.(sid) ?? [],
          after: (seq, limit) => this.deps.eventLog?.after(seq, limit) ?? [],
          onAppend: cb => {
            const failed = (err: unknown) => pluginLog.error('event tap failed', { error: err instanceof Error ? err.message : String(err) })
            const off = this.deps.eventLog?.onAppend(e => {
              try {
                // 回调可能是 async 的:拒绝没人接就是 unhandledRejection,整个进程退出
                Promise.resolve(cb(structuredClone(e))).catch(failed)
              } catch (err) {
                failed(err)
              }
            }) ?? (() => {})
            scope.add(off)
            return off
          },
          redact: edits => {
            const log = this.deps.eventLog
            if (!log || !EVENT_REDACTORS.includes(id)) throw new Error(`plugin ${id} may not redact events`)
            return log.redact(edits, id)
          },
          eraseSession: sessionId => {
            const log = this.deps.eventLog
            if (!log || !EVENT_REDACTORS.includes(id)) throw new Error(`plugin ${id} may not redact events`)
            return log.eraseSession(sessionId, id)
          },
          purge: async o => {
            const log = this.deps.eventLog
            if (!log || !EVENT_REDACTORS.includes(id)) throw new Error(`plugin ${id} may not redact events`)
            const hold = this.deps.holdWatchdog
            await hold?.(purgeHoldMs(log.sizeBytes() + (o?.extraBytes ?? 0)))
            try {
              log.purge()
              o?.then?.()
            } finally {
              await hold?.(0)
            }
          },
        },
        effect: d => scope.add(d),
        rpc: { register: (method, handler) => scope.add(rpc.register(id, method, handler)) },
        log: pluginLog,
        config: ownConfig,
        updateConfig: (section, value) => {
          if (!cfg || !(sections as string[]).includes(section)) throw new Error(`config section not writable: ${section}`)
          cfg.update(section as keyof KernelConfig, value)
        },
        get secretsBackend() {
          return secretStore.backend
        },
        dataDir,
        secrets: scopedSecrets(this.deps.secrets, id),
        append,
      }
      await p.activate(ctx)
      append({ type: 'plugin.activated', payload: { id } })
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      // 开发插件:只报稳定代码。导入器和它自己的报错里有路径和原话(final review)
      const dev = this.deps.devIds?.includes(id) === true
      const message = dev ? (DEV_CODE.test(raw) ? raw : 'dev_activate_failed') : raw
      entry.state = 'failed'
      entry.error = message
      log.error(`plugin ${id} failed`, { error: message })
      try { await scope.disposeAll() } catch { /* 清理失败不再上报 */ }
      append({ type: 'plugin.failed', payload: { id, error: message } })
    }
  }

  private async waitInject(keys: string[]): Promise<void> {
    if (!keys.length) return
    const ms = this.deps.injectTimeoutMs ?? 10_000
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`inject timeout: ${keys.join(', ')}`)), ms)
    })
    try {
      await Promise.race([this.deps.services.whenReady(keys), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  async deactivateAll(): Promise<void> {
    const scopes = [...this.scopes.values()].reverse()
    this.scopes.clear()
    for (const s of scopes) {
      try { await s.disposeAll() } catch (e) { this.deps.log.error('plugin dispose failed', { error: String(e) }) }
    }
  }

  states(): PluginState[] {
    return this.list.map(s => ({ ...s, ...(this.deps.devIds?.includes(s.id) && { trust: 'dev' as const }) }))
  }
}
