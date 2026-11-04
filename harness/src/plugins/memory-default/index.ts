// memory-default:记忆插件的装配(06 spec §4)。记忆坏了不能挡内核启动,也不能挡这一轮:
// 库打不开时插件仍是 active,服务和工具都在,问题报在 memory.health
import { join } from 'node:path'
import type { Plugin, PluginContext } from '../../kernel/pluginHost'
import type { Sessions } from '../../kernel/sessions'
import { parseMemoryConfig, type MemoryConfig, type MemoryService } from '../../lib/memory/types'
import type { ModelsService } from '../../lib/models/types'
import type { ToolsService } from '../../lib/tools/types'
import { Background } from './background'
import { CheckpointWriter } from './checkpoints'
import { Consolidator, type ConsolidateStep } from './consolidate'
import { createContextFor } from './context'
import { MemoryFiles } from './files'
import { Ingest, REAL_TIMERS, type IngestTimers } from './ingest'
import { manifest } from './manifest'
import { scopeOf } from './policy'
import { Proposals } from './proposals'
import { faultCode, registerMemoryRpc, type LiveMemory, type PurgeStep } from './rpc'
import { openStore, type Store } from './store'
import { createMemoryTools } from './tools'

export interface MemoryDefaultOpts {
  now?: () => number
  timers?: IngestTimers
  flushMs?: number
  /** 测试用:轮和工具替接入追赶的时间上限 */
  catchUpMs?: number
  /** false:不开夜间定时,memory.consolidate 还能手动跑 */
  nightly?: false
  /** Task 11 接上:整合的最后一步 */
  habits?(): void
  /** 测试用:整合走到这一步时调,抛错 = 崩溃 */
  onConsolidateStep?(step: ConsolidateStep): void
  /** 测试用:memory.delete 每一步之前调,抛错 = 这一步失败 */
  onPurgeStep?(step: PurgeStep): void
}

export interface MemoryDefaultPlugin extends Plugin {
  /** 测试用:不等批量定时器,把日志拉进原始层 */
  flushNow(): void
  /** 测试用:最近一次激活打开的库 */
  inspect(): { store: Store; background: Background; checkpoints: CheckpointWriter; proposals: Proposals; consolidator: Consolidator }
}

function openLive(ctx: PluginContext, sessions: Sessions, o: MemoryDefaultOpts, now: () => number, config: MemoryConfig): LiveMemory {
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
    // 每次取:models 插件可能比这里晚激活,也可能没有
    const background = new Background({ models: () => ctx.services.get<ModelsService>('models'), config: () => config, store, now, log: ctx.log })
    const proposals = new Proposals({ store, files, now, append: e => ctx.append(e) })
    return { store, files, ingest, background, proposals }
  } catch (err) {
    store.close()
    throw err
  }
}

export function createMemoryDefault(opts: MemoryDefaultOpts = {}): MemoryDefaultPlugin {
  let current: (LiveMemory & { checkpoints: CheckpointWriter; consolidator: Consolidator }) | undefined
  return {
    manifest,
    flushNow: () => current?.ingest.flush(),
    inspect() {
      if (!current) throw new Error('memory store is not open')
      return { store: current.store, background: current.background, checkpoints: current.checkpoints, proposals: current.proposals, consolidator: current.consolidator }
    },
    activate(ctx) {
      const sessions = ctx.services.get<Sessions>('sessions')
      if (!sessions) throw new Error('sessions service missing')
      const now = opts.now ?? Date.now
      const problems: string[] = []
      const config = parseMemoryConfig(ctx.config.memory, m => ctx.log.warn(m))
      let live: LiveMemory | undefined
      try {
        live = openLive(ctx, sessions, opts, now, config)
      } catch (err) {
        const code = faultCode('store_unavailable', err)
        problems.push(code)
        ctx.log.error('memory is unavailable', { problem: code })
      }
      const opened = live
      const checkpoints =
        opened &&
        new CheckpointWriter({
          events: ctx.events,
          append: e => ctx.append(e),
          store: opened.store,
          background: opened.background,
          models: () => ctx.services.get<ModelsService>('models'),
          config: () => config,
          catchUp: () => opened.ingest.catchUp(opts.catchUpMs),
          now,
          log: ctx.log,
        })
      const consolidator =
        opened &&
        new Consolidator({
          store: opened.store,
          files: opened.files,
          proposals: opened.proposals,
          background: opened.background,
          models: () => ctx.services.get<ModelsService>('models'),
          config: () => config,
          catchUp: () => opened.ingest.catchUp(opts.catchUpMs),
          now,
          append: e => ctx.append(e),
          log: ctx.log,
          timers: opts.timers ?? REAL_TIMERS,
          scheduled: opts.nightly !== false,
          ...(opts.habits && { habits: opts.habits }),
          ...(opts.onConsolidateStep && { onStep: opts.onConsolidateStep }),
        })
      current = opened && checkpoints && consolidator && { ...opened, checkpoints, consolidator }
      if (opened && checkpoints && consolidator) {
        const { store, ingest } = opened
        const stillCurrent = current
        // 最先登记、最后释放:工具和 RPC 都撤了才停接入、关库
        ctx.effect(() => {
          try {
            ingest.stop()
          } finally {
            store.close()
            if (current === stillCurrent) current = undefined
          }
        })
        // 后登记先释放:写手和后台任务停干净了才关库
        ctx.effect(() => checkpoints.close())
        // 再后登记:定时先停,排着的 RPC 先得到答复,然后才中止跑着的
        ctx.effect(() => consolidator.close())
        ctx.events.onAppend(e => consolidator.observe(e))
        consolidator.start()
      }

      const service: MemoryService = {
        contextFor: opened
          ? createContextFor({ store: opened.store, files: opened.files, sessions, catchUp: () => opened.ingest.catchUp(opts.catchUpMs), recall: () => config.recall, log: ctx.log })
          : () => [],
        noteContext: req => checkpoints?.note(req),
      }
      ctx.services.provide<MemoryService>('memory', service)
      const rpc = registerMemoryRpc({ ctx, sessions, live, problems, dbFile: join(ctx.dataDir, 'memory.sqlite'), now, ...(consolidator && { consolidate: () => consolidator.manual() }), ...(opts.onPurgeStep && { onPurgeStep: opts.onPurgeStep }) })
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
        proposals: live.proposals,
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
