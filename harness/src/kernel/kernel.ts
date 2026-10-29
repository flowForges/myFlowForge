import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  ERR_BUSY,
  ERR_DRAINING,
  PROTOCOL_VERSION,
  WorkerMethods,
  type KernelEvent,
  type SnapshotResult,
  type StatusResult,
  type WorkerMethodName,
} from '../protocol/index'
import { loadConfig } from './config'
import { EventBus } from './events'
import { EventLog, openDb, transaction } from './eventLog'
import { nullLogger, type Logger } from './log'
import { PermissionGate } from './permissionGate'
import { PluginHost, type Plugin } from './pluginHost'
import { Receipts } from './receipts'
import { RpcError } from './rpcError'
import { ServiceRegistry } from './services'
import { HARNESS_VERSION } from './version'

export interface Kernel {
  handle(method: string, params: unknown): Promise<unknown>
  events: EventLog
  status(): StatusResult
  snapshot(): SnapshotResult
  readonly draining: boolean
  drain(timeoutMs: number): Promise<void>
  close(): Promise<void>
}

export interface KernelOpts {
  dataDir: string
  plugins: Plugin[]
  log?: Logger
  injectTimeoutMs?: number
}

const ERR_METHOD_NOT_FOUND = -32601
const ERR_INVALID_PARAMS = -32602
const CANCEL_GRACE_MS = 1000

type Turn = { turnId: string; sessionId: string; ended: boolean; controller: AbortController; settled: Promise<void> }

export async function createKernel(opts: KernelOpts): Promise<Kernel> {
  const log = opts.log ?? nullLogger
  const startedAt = Date.now()
  mkdirSync(join(opts.dataDir, 'db'), { recursive: true })
  const db = openDb(join(opts.dataDir, 'db', 'events.sqlite'))
  const eventLog = new EventLog(db, { onListenerError: err => log.error('event listener failed', { error: String(err) }) })
  const receipts = new Receipts(db)
  const services = new ServiceRegistry()
  const bus = new EventBus({ onError: (type, err) => log.error(`handler for ${type} failed`, { error: String(err) }) })
  bus.declare('session.prompt', 'bail')
  const gate = new PermissionGate()
  const append = (e: Omit<KernelEvent, 'seq' | 'ts'>) => eventLog.append(e)
  const config = loadConfig(join(opts.dataDir, 'config.json'))
  const host = new PluginHost({
    services, events: bus, append, log, dataDir: opts.dataDir, injectTimeoutMs: opts.injectTimeoutMs,
  })

  let state: StatusResult['state'] = 'starting'
  const turns = new Map<string, Turn>() // turnId -> 进行中的 turn
  const activeBySession = new Map<string, string>() // sessionId -> turnId(每会话最多一个)

  // 插件(或内核)写入 turn 终态事件时按 payload.turnId 标记
  eventLog.onAppend(e => {
    if (e.type === 'turn.ended' || e.type === 'turn.failed') {
      const id = (e.payload as { turnId?: string } | null)?.turnId
      const t = id ? turns.get(id) : undefined
      if (t) t.ended = true
    }
  })

  const failTurn = (t: Turn, reason: string, extra?: Record<string, unknown>) => {
    if (t.ended) return
    t.ended = true
    append({ type: 'turn.failed', sessionId: t.sessionId, payload: { turnId: t.turnId, reason, ...extra } })
  }

  // 崩溃恢复:有开始痕迹却无终态的 turn 标记 interrupted,不重放(副作用不确定)
  const open = new Map<string, string | undefined>()
  for (const e of eventLog.after(0)) {
    const id = (e.payload as { turnId?: string } | null)?.turnId
    if (!id) continue
    if (e.type === 'turn.started' || e.type === 'message.user') open.set(id, e.sessionId)
    else if (e.type === 'turn.ended' || e.type === 'turn.failed') open.delete(id)
  }
  for (const [turnId, sessionId] of open) append({ type: 'turn.failed', sessionId, payload: { turnId, reason: 'interrupted' } })

  const dispatchPrompt = (sessionId: string, turnId: string, text: string) => {
    const controller = new AbortController()
    const turn: Turn = { turnId, sessionId, controller, ended: false, settled: Promise.resolve() }
    turns.set(turnId, turn)
    activeBySession.set(sessionId, turnId) // 先登记:处理者可能同步写完终态事件
    turn.settled = (async () => {
      let failure: string | undefined
      try {
        await bus.bail('session.prompt', { sessionId, turnId, text, signal: controller.signal })
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err)
        log.error('session.prompt handler failed', { error: failure })
      }
      // 处理者结束后 turn 仍未终结:补 turn.failed
      if (!controller.signal.aborted) {
        failTurn(turn, failure ? 'error' : 'unhandled', failure ? { message: failure } : undefined)
      }
      turns.delete(turnId)
      if (activeBySession.get(sessionId) === turnId) activeBySession.delete(sessionId)
    })()
  }

  /** 回执重放 / 事务内写入;返回 [result, after-commit 副作用] */
  function command<R>(
    method: string,
    commandId: string,
    run: () => { result: R; after?: () => void },
    opts: { allowDraining?: boolean } = {},
  ): { result: R; replayed: boolean } {
    const prior = receipts.get(commandId)
    if (prior) {
      if (prior.method !== method) throw new RpcError(ERR_INVALID_PARAMS, 'commandId already used by another method')
      return { result: prior.result as R, replayed: true }
    }
    if (state === 'draining' && !opts.allowDraining) throw new RpcError(ERR_DRAINING, 'draining')
    let after: (() => void) | undefined
    const result = transaction(db, () => {
      const r = run()
      receipts.put(commandId, method, r.result)
      after = r.after
      return r.result
    })
    after?.()
    return { result, replayed: false }
  }

  async function cancel(sessionId: string): Promise<void> {
    const id = activeBySession.get(sessionId)
    const t = id ? turns.get(id) : undefined
    if (!t) return
    t.controller.abort()
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([t.settled, new Promise<void>(r => { timer = setTimeout(r, CANCEL_GRACE_MS) })])
    clearTimeout(timer)
    failTurn(t, 'cancelled')
  }

  function status(): StatusResult {
    return {
      state,
      uptimeMs: Date.now() - startedAt,
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
      version: HARNESS_VERSION,
      plugins: host.states(),
    }
  }

  function snapshot(): SnapshotResult {
    const sessions = new Map<string, { id: string; title: string; updatedAt: number }>()
    for (const e of eventLog.after(0)) {
      if (!e.sessionId) continue
      if (e.type === 'session.created') {
        const title = (e.payload as { title?: string } | null)?.title
        sessions.set(e.sessionId, { id: e.sessionId, title: title || '新会话', updatedAt: e.ts })
      } else {
        const s = sessions.get(e.sessionId)
        if (s) s.updatedAt = e.ts
      }
    }
    return { status: status(), sessions: [...sessions.values()], lastSeq: eventLog.lastSeq() }
  }

  const kernel: Kernel = {
    events: eventLog,
    status,
    snapshot,
    get draining() {
      return state === 'draining'
    },

    async handle(method, rawParams) {
      if (!Object.hasOwn(WorkerMethods, method)) throw new RpcError(ERR_METHOD_NOT_FOUND, `method not found: ${method}`)
      const name = method as WorkerMethodName
      const parsed = WorkerMethods[name].params.safeParse(rawParams === undefined ? {} : rawParams)
      if (!parsed.success) throw new RpcError(ERR_INVALID_PARAMS, 'invalid params', parsed.error.issues)
      const p = parsed.data as any

      switch (name) {
        case 'hello':
          return { version: HARNESS_VERSION, protocolVersion: PROTOCOL_VERSION, compatible: p.protocolVersion === PROTOCOL_VERSION }
        case 'status':
          return status()
        case 'snapshot':
          return snapshot()
        case 'events.tail':
          return { events: eventLog.tail(p.limit) }
        case 'session.create':
          return command(name, p.commandId, () => {
            const sessionId = randomUUID()
            append({ type: 'session.created', sessionId, payload: { title: p.title } })
            return { result: { sessionId } }
          }).result
        case 'session.prompt':
          return command(name, p.commandId, () => {
            if (activeBySession.has(p.sessionId)) throw new RpcError(ERR_BUSY, 'turn in progress') // 回滚,不留回执
            const turnId = randomUUID()
            append({ type: 'message.user', sessionId: p.sessionId, payload: { turnId, text: p.text } })
            // 提交之后才交给循环插件
            return { result: { accepted: true, turnId }, after: () => dispatchPrompt(p.sessionId, turnId, p.text) }
          }).result
        case 'session.cancel': {
          const r = command(name, p.commandId, () => ({ result: { ok: true } }), { allowDraining: true })
          if (!r.replayed) await cancel(p.sessionId) // 重放不产生副作用
          return r.result
        }
        default:
          // auth / events.subscribe 属于传输层
          throw new RpcError(ERR_METHOD_NOT_FOUND, `method not handled by kernel: ${method}`)
      }
    },

    async drain(timeoutMs) {
      state = 'draining'
      let timer: ReturnType<typeof setTimeout> | undefined
      const inflight = Promise.all([...turns.values()].map(t => t.settled))
      await Promise.race([inflight, new Promise<void>(r => { timer = setTimeout(r, timeoutMs) })])
      clearTimeout(timer)
    },

    async close() {
      append({ type: 'kernel.stopping', payload: {} })
      for (const t of turns.values()) t.controller.abort()
      await host.deactivateAll()
      db.close()
    },
  }

  services.provide('permissionGate', gate)
  append({ type: 'kernel.started', payload: { version: HARNESS_VERSION } })
  await host.activateAll(opts.plugins, config.plugins.disabled)
  state = 'running'
  return kernel
}
