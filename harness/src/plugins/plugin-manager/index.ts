// plugin-manager:唯一的插件管理者(09 spec §4)。这一步只有存储、安装、启用、卸载、授权和配置;
// 技能工具、命令、MCP 进程后面接进来,杀进程走 killPluginProcesses 这个缝
import type { spawn as nodeSpawn } from 'node:child_process'
import { resolve } from 'node:path'
import type { Plugin, PluginContext } from '../../kernel/pluginHost'
import { RpcError } from '../../kernel/rpcError'
import { effectiveGrants, escapeDisplay, type Declared } from '../../lib/plugins/consent'
import { scrub } from '../../lib/memory/scrub'
import type { FetchTimers } from '../../lib/plugins/fetchGit'
import { USER_CONFIG_KEY_RE } from '../../lib/plugins/manifest'
import type { PgidRegistry } from '../../lib/proc/pgids'
import type { SessionCommands } from '../../lib/tools/types'
import { MCP_SERVER_NAME, type Grants, type WorkerParams } from '../../protocol/index'
import { fail, Installer } from './installer'
import { manifest } from './manifest'
import { PluginStore, type InstalledRecord } from './store'

export interface PluginManagerOpts {
  /** 只给测试。配置、环境变量、RPC 都改不了 */
  allowFileProtocol?: boolean
  now?: () => number
  timers?: FetchTimers
  spawn?: typeof nodeSpawn
  sizeOf?: (dir: string) => number
  /** 内置插件的 id。懒求值:BUILTIN_PLUGINS 里有 plugin-manager 自己 */
  reservedIds?: () => Set<string>
  /** git 的基础环境,fetchGit 只从里面取 PATH、语言和代理。默认 process.env */
  env?: NodeJS.ProcessEnv
  /** 杀这个插件的全部进程。服务进程接进来之前没有东西可杀 */
  killPluginProcesses?: (id: string) => Promise<void>
}

const defaultTimers: FetchTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimeout: h => clearTimeout(h as NodeJS.Timeout),
}

const LOCKED_BACKENDS = new Set(['unavailable', 'unreadable'])
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const canon = (g: Grants) => JSON.stringify(Object.entries(g.servers).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, [...v.network].sort(), v.cwd]))

const isSet = (rec: InstalledRecord, key: string) => Object.hasOwn(rec.settings, key) || rec.secretKeys.includes(key)
const without = <T,>(xs: T[], x: T) => xs.filter(v => v !== x)

/** Task 9 换成进程的真实状态。这里只有记录能回答的 */
function serverRows(rec: InstalledRecord) {
  return rec.consent.mcp
    .filter(m => MCP_SERVER_NAME.test(m.name))
    .map(m => {
      const refs = rec.servers.find(s => s.name === m.name)?.configRefs ?? []
      const missing = rec.config.some(c => c.required && refs.includes(c.key) && !isSet(rec, c.key))
      if (m.problems.length > 0) return { name: m.name, state: 'problem', reason: m.problems[0] }
      if (rec.state !== 'ok') return { name: m.name, state: 'integrity_failed' }
      if (!rec.enabled) return { name: m.name, state: 'disabled' }
      if (missing) return { name: m.name, state: 'needs_config', reason: 'needs_config' }
      return { name: m.name, state: 'stopped' }
    })
}

function declaredOf(rec: InstalledRecord): Record<string, Declared | null> {
  return Object.fromEntries(rec.consent.mcp.map(m => [m.name, m.declared]))
}

export function createPluginManager(o: PluginManagerOpts = {}): Plugin {
  return {
    manifest,
    activate(ctx: PluginContext) {
      const commands = ctx.services.get<SessionCommands>('sessionCommands')
      if (!commands) throw new Error('sessionCommands service missing')
      const pgids = process.platform === 'win32' ? undefined : ctx.services.get<PgidRegistry>('pgids')
      const now = o.now ?? Date.now
      const timers = o.timers ?? defaultTimers
      const killPluginProcesses = o.killPluginProcesses ?? (async () => {})
      // pluginHost:ctx.dataDir = <数据目录>/plugins/<id>
      const dataDir = resolve(ctx.dataDir, '..', '..')
      const store = PluginStore.open({ dataDir }, ctx.log)

      const secretKey = (id: string, key: string) => `${id}/${key}`
      const installer = new Installer({
        store,
        commands,
        deleteSecret: (id, key) => ctx.secrets.delete(secretKey(id, key)),
        append: e => ctx.append(e),
        log: ctx.log,
        dataDir,
        env: o.env ?? process.env,
        now,
        timers,
        reservedIds: o.reservedIds ?? (() => new Set(['plugin-manager'])),
        killPluginProcesses,
        ...(pgids && { pgids }),
        ...(o.spawn && { spawn: o.spawn }),
        ...(o.sizeOf && { sizeOf: o.sizeOf }),
        ...(o.allowFileProtocol === true && { allowFileProtocol: true }),
      })
      ctx.effect(() => installer.close())

      const failIntegrity = (rec: InstalledRecord) => {
        store.put({ ...rec, enabled: false, state: 'integrity_failed' })
        try {
          store.save()
        } catch (err) {
          // 内存里已经关了;下次启动会再查一遍
          ctx.log.warn('plugin record not saved', { code: (err as NodeJS.ErrnoException).code ?? 'unknown' })
        }
        ctx.append({ type: 'plugins.integrity.failed', payload: { id: rec.id } })
      }

      // 启动:已启用的都重算(§13)。不符的这次就关掉,不等谁来用
      for (const rec of store.list()) {
        if (rec.enabled && !store.verify(rec)) {
          ctx.log.warn('plugin failed its integrity check', { id: rec.id })
          failIntegrity(rec)
        }
      }

      // 改记录的 RPC 排队:改写是读旧记录、等杀进程、写新记录,交错了会丢更新
      let tail: Promise<unknown> = Promise.resolve()
      const serial = <T,>(fn: () => Promise<T>): Promise<T> => {
        const next = tail.then(fn, fn)
        tail = next.catch(() => {})
        return next
      }
      const need = (id: string) => {
        const rec = store.get(id)
        if (!rec) throw fail('plugin_not_installed')
        return rec
      }
      /** 磁盘写不了是稳定代码,不是内部错误 */
      const persist = (rec?: InstalledRecord, undo?: InstalledRecord) => {
        if (rec) store.put(rec)
        try {
          store.save()
        } catch (err) {
          ctx.log.warn('plugin record not saved', { code: (err as NodeJS.ErrnoException).code ?? 'unknown' })
          if (undo) store.put(undo)
          throw fail('store_error')
        }
      }
      const kill = async (id: string) => {
        try {
          await killPluginProcesses(id)
        } catch (err) {
          ctx.log.warn('killing plugin processes failed', { code: (err as NodeJS.ErrnoException).code ?? 'unknown' })
        }
      }
      const secretsLocked = () => LOCKED_BACKENDS.has(ctx.secretsBackend)
      /** 后端的错误里可能有路径:不外传,也不进日志 */
      const guarded = async <T,>(fn: () => Promise<T>): Promise<T> => {
        try {
          return await fn()
        } catch {
          throw new RpcError(-32602, 'secrets_unavailable')
        }
      }

      type Params<M extends Parameters<typeof ctx.rpc.register>[0]> = WorkerParams<M>
      const on = <M extends Parameters<typeof ctx.rpc.register>[0]>(method: M, handler: (p: Params<M>) => unknown) =>
        ctx.rpc.register(method, async params => handler(params as Params<M>))

      on('plugins.list', () => ({
        plugins: store.list().map(r => ({
          id: r.id,
          version: r.version,
          format: r.format,
          enabled: r.enabled,
          state: r.state,
          problems: r.state === 'ok' ? [] : [r.state],
          source: r.consent.source,
          integrity: r.integrity,
          installedAt: r.installedAt,
        })),
        dev: [],
        problems: store.problems,
      }))

      on('plugins.get', p => {
        const rec = need(p.id)
        return {
          consent: rec.consent,
          grants: rec.grants,
          settings: rec.config.map(c => {
            const secret = c.sensitive || rec.secretKeys.includes(c.key)
            const value = !secret && Object.hasOwn(rec.settings, c.key) ? rec.settings[c.key] : undefined
            // 落盘时查过,但打码规则可能是后来才加的
            return { key: escapeDisplay(c.key), set: isSet(rec, c.key), sensitive: secret, ...(value !== undefined && { value: scrub(value).text }) }
          }),
          servers: serverRows(rec),
        }
      })

      on('plugins.install.prepare', p => installer.prepare(p.source))
      on('plugins.upgrade.prepare', p => installer.prepareUpgrade(p.id, p.ref))
      on('plugins.install.status', p => installer.status(p.stagingId))
      on('plugins.install.cancel', p => serial(async () => installer.cancel(p.stagingId)))
      on('plugins.install.confirm', p => serial(() => installer.confirm(p)))

      on('plugins.setEnabled', p =>
        serial(async () => {
          const rec = need(p.id)
          if (p.enabled) {
            if (!store.verify(rec)) {
              failIntegrity(rec)
              await kill(rec.id)
              throw fail('integrity_failed')
            }
            persist({ ...rec, enabled: true, state: 'ok' }, rec)
            if (!rec.enabled) ctx.append({ type: 'plugins.enabled', payload: { id: rec.id } })
            return { ok: true }
          }
          // 先改记录:杀进程期间起不来新的
          persist({ ...rec, enabled: false }, rec)
          await kill(rec.id)
          if (rec.enabled) ctx.append({ type: 'plugins.disabled', payload: { id: rec.id } })
          return { ok: true }
        }),
      )

      on('plugins.uninstall', p =>
        serial(async () => {
          const rec = need(p.id)
          // 钥匙串锁着就不删记录:secret 没有列举接口,记录没了这些键就再也找不回来
          if (rec.secretKeys.length > 0 && secretsLocked()) throw fail('secrets_unavailable')
          persist({ ...rec, enabled: false }, rec)
          await kill(rec.id)
          await guarded(async () => {
            for (const key of rec.secretKeys) await ctx.secrets.delete(secretKey(rec.id, key))
          })
          store.remove(rec.id)
          try {
            store.save()
          } catch (err) {
            store.put({ ...rec, enabled: false, secretKeys: [] })
            ctx.log.warn('plugin record not saved', { code: (err as NodeJS.ErrnoException).code ?? 'unknown' })
            throw fail('store_error')
          }
          // 记录已经没了:这里删不掉的,下次打开时对账收拾
          store.removeFiles(rec.id)
          store.tidy()
          ctx.append({ type: 'plugins.uninstalled', payload: { id: rec.id } })
          return { ok: true }
        }),
      )

      // 记录丢了以后留下的东西,只有用户说不要才删
      on('plugins.store.discard', () =>
        serial(async () => {
          if (store.unreadable) throw fail('store_unreadable')
          const orphans = store.badSecrets()
          if (orphans.length > 0 && secretsLocked()) throw fail('secrets_unavailable')
          await guarded(async () => {
            for (const { id, key } of orphans) await ctx.secrets.delete(secretKey(id, key))
          })
          store.discardUnknown()
          ctx.append({ type: 'plugins.store.discarded', payload: {} })
          return { ok: true }
        }),
      )

      on('plugins.grants.set', p =>
        serial(async () => {
          const rec = need(p.id)
          const next = effectiveGrants(declaredOf(rec), p.grants)
          if (!next.ok) throw fail(next.error)
          const changed = canon(next.grants) !== canon(rec.grants)
          persist({ ...rec, grants: next.grants }, rec)
          // 收窄也杀:跑着的进程带的是旧的放行表,不杀就没有生效
          if (changed) await kill(rec.id)
          ctx.append({ type: 'plugins.grants.updated', payload: { id: rec.id } })
          return { ok: true }
        }),
      )

      on('plugins.settings.set', p =>
        serial(async () => {
          const rec = need(p.id)
          const decl = rec.config.find(c => c.key === p.key)
          // 只收声明过的键;形状里没有 `/`,secret 键的前缀碰不到别的插件
          if (!decl || !USER_CONFIG_KEY_RE.test(p.key) || PROTO_KEYS.has(p.key)) throw fail('unknown_setting')
          if (p.value.includes('\0')) throw fail('bad_value')
          // 插件说是普通值,但长得像密钥:一样进 secrets,不落 installed.json
          const secret = decl.sensitive || scrub(p.value).text !== p.value
          if (!secret) {
            if (rec.secretKeys.includes(p.key)) await guarded(() => ctx.secrets.delete(secretKey(rec.id, p.key)))
            persist({ ...rec, settings: { ...rec.settings, [p.key]: p.value }, secretKeys: without(rec.secretKeys, p.key) }, rec)
            return { ok: true }
          }
          if (secretsLocked()) throw fail('secrets_unavailable')
          // 先记键再写值:崩在中间时卸载还找得到它
          const { [p.key]: _dropped, ...settings } = rec.settings
          const wasKnown = rec.secretKeys.includes(p.key)
          const next = { ...rec, settings, secretKeys: wasKnown ? rec.secretKeys : [...rec.secretKeys, p.key].sort() }
          persist(next, rec)
          try {
            await guarded(() => ctx.secrets.set(secretKey(rec.id, p.key), p.value))
          } catch (err) {
            if (!wasKnown) persist(rec)
            throw err
          }
          return { ok: true }
        }),
      )

      on('plugins.settings.clear', p =>
        serial(async () => {
          const rec = need(p.id)
          if (rec.secretKeys.includes(p.key)) await guarded(() => ctx.secrets.delete(secretKey(rec.id, p.key)))
          const { [p.key]: _dropped, ...settings } = rec.settings
          persist({ ...rec, settings, secretKeys: without(rec.secretKeys, p.key) }, rec)
          return { ok: true }
        }),
      )
    },
  }
}
