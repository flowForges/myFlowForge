// loop-default:接管带工作目录的会话(spec §8);没有 cwd / 没有模型时让位给 loop-direct / loop-echo
import type { Plugin } from '../../kernel/pluginHost'
import type { Sessions } from '../../kernel/sessions'
import type { ModelsService } from '../../lib/models/types'
import type { ToolsService } from '../../lib/tools/types'
import type { ModelRef } from '../../protocol/index'
import { runTurn, type LoopDeps } from './loop'
import { manifest } from './manifest'

export interface LoopDefaultOpts {
  /** 步数上限,默认 50 */
  maxSteps?: number
  /** 限流重试的等待;测试注入 */
  sleep?: LoopDeps['sleep']
}

interface PromptReq { sessionId: string; turnId: string; text: string; signal: AbortSignal }

export function createLoopDefault(opts: LoopDefaultOpts = {}): Plugin {
  return {
    manifest,
    activate(ctx) {
      const sessions = ctx.services.get<Sessions>('sessions')
      if (!sessions) throw new Error('sessions service missing')

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
        // Task 12 接入点:开始快照(spec §8 第 1 步)在 runTurn 之前;结束快照(第 7 步)包成 try/finally 放在它之后,取消、出错也拍
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
        return true
      })
    },
  }
}

export default createLoopDefault()
