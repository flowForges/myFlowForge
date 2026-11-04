// memory-default:记忆插件的装配(06 spec §4)。记忆坏了不能挡内核启动,也不能挡这一轮:
// 库打不开时插件仍是 active,服务和工具都在,问题报在 memory.health
import { join } from 'node:path'
import type { Plugin, PluginContext } from '../../kernel/pluginHost'
import type { Sessions } from '../../kernel/sessions'
import { parseMemoryConfig, type MemoryService } from '../../lib/memory/types'
import type { ToolsService } from '../../lib/tools/types'
import { createContextFor } from './context'
import { MemoryFiles } from './files'
import { Ingest, type IngestTimers } from './ingest'
import { manifest } from './manifest'
import { scopeOf } from './policy'
import { faultCode, registerMemoryRpc, type LiveMemory, type PurgeStep } from './rpc'
import { openStore, type Store } from './store'
import { createMemoryTools, storeProposals } from './tools'

export interface MemoryDefaultOpts {
  now?: () => number
  timers?: IngestTimers
  flushMs?: number
  /** 测试用:轮和工具替接入追赶的时间上限 */
  catchUpMs?: number
  /** false:不跑夜间整合(Task 10 接上) */
  nightly?: false
  /** 测试用:memory.delete 每一步之前调,抛错 = 这一步失败 */
  onPurgeStep?(step: PurgeStep): void
}

export interface MemoryDefaultPlugin extends Plugin {
  /** 测试用:不等批量定时器,把日志拉进原始层 */
  flushNow(): void
  /** 测试用:最近一次激活打开的库 */
  inspect(): { store: Store }
}

function openLive(ctx: PluginContext, sessions: Sessions, o: MemoryDefaultOpts, now: () => number): LiveMemory {
  const store = openStore(join(ctx.dataDir, 'memory.sqlite'), { log: ctx.log, now })
  try {
    const files = new MemoryFiles(ctx.dataDir, store, { now, log: ctx.log, append: e => ctx.append(e) })
    // 库是重建的时候:回滚事件重放之前,notes 里要先有 turn_id,否则那些日记行留下来
    files.reconcile('all')
    const ingest = new Ingest({
      store,
      events: ctx.events,
      sessions,
      scopeOf,
      // removeByTurn 只看现状,重放也安全
      onRolledBack: turnId => files.removeByTurn(turnId),
      timers: o.timers,
      flushMs: o.flushMs,
      log: ctx.log,
    })
    ingest.start()
    return { store, files, ingest }
  } catch (err) {
    store.close()
    throw err
  }
}

export function createMemoryDefault(opts: MemoryDefaultOpts = {}): MemoryDefaultPlugin {
  let current: LiveMemory | undefined
  return {
    manifest,
    flushNow: () => current?.ingest.flush(),
    inspect() {
      if (!current) throw new Error('memory store is not open')
      return { store: current.store }
    },
    activate(ctx) {
      const sessions = ctx.services.get<Sessions>('sessions')
      if (!sessions) throw new Error('sessions service missing')
      const now = opts.now ?? Date.now
      const problems: string[] = []
      let live: LiveMemory | undefined
      try {
        live = openLive(ctx, sessions, opts, now)
      } catch (err) {
        const code = faultCode('store_unavailable', err)
        problems.push(code)
        ctx.log.error('memory is unavailable', { problem: code })
      }
      current = live
      if (live) {
        const { store, ingest } = live
        // 最先登记、最后释放:工具和 RPC 都撤了才停接入、关库
        ctx.effect(() => {
          try {
            ingest.stop()
          } finally {
            store.close()
            if (current === live) current = undefined
          }
        })
      }

      const config = parseMemoryConfig(ctx.config.memory, m => ctx.log.warn(m))
      const opened = live
      const service: MemoryService = {
        contextFor: opened
          ? createContextFor({ store: opened.store, files: opened.files, sessions, catchUp: () => opened.ingest.catchUp(opts.catchUpMs), recall: () => config.recall, log: ctx.log })
          : () => [],
        noteContext() {},
      }
      ctx.services.provide<MemoryService>('memory', service)
      const rpc = registerMemoryRpc({ ctx, sessions, live, problems, dbFile: join(ctx.dataDir, 'memory.sqlite'), ...(opts.onPurgeStep && { onPurgeStep: opts.onPurgeStep }) })
      // 后登记先释放:库关之前等扫到一半的删除停下
      ctx.effect(() => rpc.stop())

      const tools = ctx.services.get<ToolsService>('tools')
      if (!tools) {
        ctx.log.warn('tools service is missing, memory tools are not registered')
        return
      }
      const deps = live && {
        store: live.store,
        files: live.files,
        sessions,
        proposals: storeProposals(live.store, now, e => ctx.append(e)),
        now,
        append: (e: Parameters<PluginContext['append']>[0]) => ctx.append(e),
        catchUp: () => live.ingest.catchUp(opts.catchUpMs),
        log: ctx.log,
      }
      for (const tool of createMemoryTools(deps)) ctx.effect(tools.register(tool))
    },
  }
}

export default createMemoryDefault()
