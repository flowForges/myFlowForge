// loop-default:接管带工作目录的会话(spec §8);没有 cwd / 没有模型时让位给 loop-direct / loop-echo。
// 每轮前后拍快照(spec §11),并注册 turn.rollback / turn.changes
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from '../../kernel/pluginHost'
import { RpcError } from '../../kernel/rpcError'
import type { Sessions } from '../../kernel/sessions'
import { createGit, type Git } from '../../lib/git/snapshot'
import type { ModelsService } from '../../lib/models/types'
import type { ToolsService } from '../../lib/tools/types'
import { ERR_BUSY, type ModelRef, type WorkerParams } from '../../protocol/index'
import { runTurn, type LoopDeps } from './loop'
import { manifest } from './manifest'
import { endSnapshot, hasOpenTurn, rollbackTurn, startSnapshot, turnChanges, type SnapshotDeps } from './snapshots'

export interface LoopDefaultOpts {
  /** 步数上限,默认 50 */
  maxSteps?: number
  /** 限流重试的等待;测试注入 */
  sleep?: LoopDeps['sleep']
  /** 快照用的 git;默认 createGit()(测试注入隔离的环境) */
  git?: Git
  /** 快照的临时目录;默认插件数据目录下的 tmp/ */
  snapshotTmpDir?: string
}

interface PromptReq { sessionId: string; turnId: string; text: string; signal: AbortSignal }

export function createLoopDefault(opts: LoopDefaultOpts = {}): Plugin {
  return {
    manifest,
    activate(ctx) {
      const sessions = ctx.services.get<Sessions>('sessions')
      if (!sessions) throw new Error('sessions service missing')
      const tmpDir = opts.snapshotTmpDir ?? join(ctx.dataDir, 'tmp')
      mkdirSync(tmpDir, { recursive: true })
      const snap: SnapshotDeps = { git: opts.git ?? createGit(), tmpDir, log: ctx.log, append: e => ctx.append(e) }

      /** 本插件正在跑的轮(从接管到结束快照拍完),按会话 */
      const active = new Set<string>()
      /** 每会话的回滚串行链:回滚之间、回滚与随后开始的轮之间不交错 */
      const locks = new Map<string, Promise<void>>()
      const exclusive = <T>(sessionId: string, fn: () => Promise<T>): Promise<T> => {
        const run = (locks.get(sessionId) ?? Promise.resolve()).then(fn)
        const tail = run.then(() => {}, () => {})
        locks.set(sessionId, tail)
        void tail.then(() => {
          if (locks.get(sessionId) === tail) locks.delete(sessionId)
        })
        return run
      }
      ctx.effect(async () => {
        await Promise.all([...locks.values()]) // 停用前等进行中的回滚写完事件
      })

      ctx.events.on('session.prompt', async ({ sessionId, turnId, text, signal }: PromptReq) => {
        const info = sessions.get(sessionId)
        const cwd = info?.cwd
        if (!info || !cwd) return undefined // 纯对话:交给 loop-direct
        const models = ctx.services.get<ModelsService>('models')
        const ref: ModelRef | 'default' | undefined = info.model ?? (models?.catalog().default ? 'default' : undefined)
        if (!models || !ref) return undefined // 没有模型:loop-direct / loop-echo 依次让位,最后回显

        const ev = (type: 'turn.started' | 'turn.failed', payload: object) => ctx.append({ type, sessionId, payload: { turnId, ...payload } })
        ev('turn.started', {})
        const tools = ctx.services.get<ToolsService>('tools')
        if (!tools) {
          ev('turn.failed', { reason: 'tools_unavailable' }) // 不降级成纯对话
          return true
        }
        active.add(sessionId)
        const target = { sessionId, cwd }
        let startRef: string | undefined
        try {
          await locks.get(sessionId) // 已开始的回滚先做完
          startRef = await startSnapshot(snap, target, turnId)
          await runTurn(
            {
              models, tools, signal, sessions, log: ctx.log,
              append: e => ctx.append(e),
              history: sid => ctx.events.history(sid),
              ...(opts.maxSteps !== undefined && { maxSteps: opts.maxSteps }),
              ...(opts.sleep && { sleep: opts.sleep }),
            },
            { sessionId, turnId, text, info: { ...info, cwd }, ref },
          )
        } finally {
          // 不论怎样结束(含取消、出错)都拍结束快照;内核已关库等写入失败只记日志
          try {
            await endSnapshot(snap, target, turnId, startRef)
          } catch (err) {
            ctx.log.warn('end snapshot not recorded', { error: err instanceof Error ? err.message : String(err) })
          }
          active.delete(sessionId)
        }
        return true
      })

      const cwdOf = (sessionId: string) => {
        const cwd = sessions.get(sessionId)?.cwd
        if (!cwd) throw new RpcError(-32602, 'not rollbackable')
        return cwd
      }

      ctx.rpc.register('turn.rollback', async params => {
        const { sessionId, turnId } = params as WorkerParams<'turn.rollback'>
        const cwd = cwdOf(sessionId)
        return exclusive(sessionId, async () => {
          const events = ctx.events.history(sessionId)
          if (active.has(sessionId) || hasOpenTurn(sessionId, events)) throw new RpcError(ERR_BUSY, 'turn in progress')
          const files = await rollbackTurn(snap, { sessionId, cwd }, events, turnId)
          return { ok: true as const, files }
        })
      })

      ctx.rpc.register('turn.changes', async params => {
        const { sessionId, turnId } = params as WorkerParams<'turn.changes'>
        const cwd = sessions.get(sessionId)?.cwd
        if (!cwd) throw new RpcError(-32602, 'snapshots missing')
        return { files: await turnChanges(snap, { sessionId, cwd }, ctx.events.history(sessionId), turnId) }
      })
    },
  }
}

export default createLoopDefault()
