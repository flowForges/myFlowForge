// memory-default:记忆插件的装配(06 spec §4)。记忆坏了不能挡内核启动,也不能挡这一轮:
// 库打不开时插件仍是 active,服务和工具都在,问题报在 memory.health
import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin, PluginContext } from '../../kernel/pluginHost'
import type { Sessions } from '../../kernel/sessions'
import { parseMemoryConfig, type MemoryService } from '../../lib/memory/types'
import type { ToolsService } from '../../lib/tools/types'
import type { MemoryHealth } from '../../protocol/rpc'
import { createContextFor } from './context'
import { MemoryFiles } from './files'
import { Ingest, type IngestTimers } from './ingest'
import { manifest } from './manifest'
import { scopeOf } from './policy'
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
}

export interface MemoryDefaultPlugin extends Plugin {
  /** 测试用:不等批量定时器,把日志拉进原始层 */
  flushNow(): void
  /** 测试用:最近一次激活打开的库 */
  inspect(): { store: Store }
}

interface Live {
  store: Store
  files: MemoryFiles
  ingest: Ingest
}

/** 错误信息里有路径,给 health 的只留代码 */
function problemCode(err: unknown): string {
  const e = err as { code?: unknown; errstr?: unknown; name?: unknown }
  const code = [e.code, e.errstr, e.name].find(v => typeof v === 'string' && v !== '')
  return `store_unavailable:${String(code ?? 'unknown').replace(/\s+/g, '_')}`
}

function openLive(ctx: PluginContext, sessions: Sessions, o: MemoryDefaultOpts, now: () => number): Live {
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

/** Task 7 的 rpc.ts 接手之前,先让问题看得见 */
function healthOf(ctx: PluginContext, file: string, live: Live | undefined, problems: string[]): MemoryHealth {
  if (!live) return { dbBytes: 0, rawRows: 0, noteRows: 0, cursorLag: 0, pendingProposals: 0, problems }
  const { db, problems: storeProblems } = live.store
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n
  return {
    dbBytes: statSync(file, { throwIfNoEntry: false })?.size ?? 0,
    rawRows: count('SELECT COUNT(*) AS n FROM raw'),
    noteRows: count('SELECT COUNT(*) AS n FROM notes'),
    cursorLag: ctx.events.after(live.store.cursor(), 500).length,
    pendingProposals: count("SELECT COUNT(*) AS n FROM proposals WHERE status = 'pending'"),
    problems: [...problems, ...storeProblems],
  }
}

export function createMemoryDefault(opts: MemoryDefaultOpts = {}): MemoryDefaultPlugin {
  let current: Live | undefined
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
      let live: Live | undefined
      try {
        live = openLive(ctx, sessions, opts, now)
      } catch (err) {
        const code = problemCode(err)
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
      const file = join(ctx.dataDir, 'memory.sqlite')
      ctx.rpc.register('memory.health', async () => healthOf(ctx, file, live, problems))

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
