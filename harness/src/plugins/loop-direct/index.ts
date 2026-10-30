// loop-direct:直连模型层的对话循环(无工具);没有可用模型时让位给 loop-echo
import type { KernelEvent } from '../../protocol/index'
import type { ModelRef } from '../../protocol/models'
import type { Plugin } from '../../kernel/pluginHost'
import type { Message, ModelsService } from '../../lib/models/types'
import { manifest } from './manifest'

interface Req { sessionId: string; turnId: string; text: string; signal: AbortSignal }
const turnOf = (e: KernelEvent) => (e.payload as { turnId?: string } | null)?.turnId
const textOf = (e: KernelEvent) => (e.payload as { text?: string } | null)?.text ?? ''

/** 已完成的 turn 的问答按序入历史;失败 / 未完成的 turn 整个跳过;当前提问放最后 */
export function buildHistory(events: KernelEvent[], currentTurnId: string, currentText: string): Message[] {
  const users = new Map<string, string>()
  const order: string[] = []
  const answers = new Map<string, string>()
  const ended = new Set<string>()
  for (const e of events) {
    const id = turnOf(e)
    if (!id) continue
    if (e.type === 'message.user') { users.set(id, textOf(e)); order.push(id) }
    else if (e.type === 'message.assistant') answers.set(id, textOf(e))
    else if (e.type === 'turn.ended') ended.add(id)
  }
  const out: Message[] = []
  for (const id of order) {
    if (id === currentTurnId || !ended.has(id) || !answers.has(id)) continue
    out.push({ role: 'user', parts: [{ type: 'text', text: users.get(id)! }] })
    out.push({ role: 'assistant', parts: [{ type: 'text', text: answers.get(id)! }] })
  }
  out.push({ role: 'user', parts: [{ type: 'text', text: currentText }] })
  return out
}

const loopDirect: Plugin = {
  manifest,
  activate(ctx) {
    ctx.events.on('session.prompt', async (req: Req) => {
      const { sessionId, turnId, text, signal } = req
      const models = ctx.services.get<ModelsService>('models')
      if (!models) return undefined
      const events = ctx.events.history(sessionId)
      const created = events.find(e => e.type === 'session.created')
      const sessionModel = (created?.payload as { model?: ModelRef } | null)?.model
      const ref: ModelRef | 'default' | undefined = sessionModel ?? (models.catalog().default ? 'default' : undefined)
      if (!ref) return undefined

      const ev = (type: KernelEvent['type'], payload: object) => ctx.append({ type, sessionId, payload: { turnId, ...payload } })
      ev('turn.started', {})
      let acc = ''
      const stream = models.stream(ref, {
        interactive: true, signal, messages: buildHistory(events, turnId, text), reasoning: 'medium',
      })
      for await (const e of stream) {
        if (e.type === 'text') {
          acc += e.delta
          ev('message.assistant.delta', { text: e.delta })
        } else if (e.type === 'reasoning') {
          if (e.delta) ev('message.reasoning.delta', { text: e.delta })
        } else if (e.type === 'usage') {
          ev('turn.usage', {
            input: e.input, output: e.output,
            ...(e.cacheRead !== undefined && { cacheRead: e.cacheRead }),
            ...(e.cacheWrite !== undefined && { cacheWrite: e.cacheWrite }),
          })
        } else if (e.type === 'done') {
          if (e.reason === 'cancelled') ev('turn.failed', { reason: 'cancelled' })
          else if (e.reason === 'error') ev('turn.failed', { reason: e.error?.kind ?? 'error', message: e.error?.message })
          else {
            ev('message.assistant', { text: acc })
            ev('turn.ended', {})
          }
          return true
        }
      }
      // 流未以 done 结束:交给内核补 turn.failed
      return true
    })
  },
}

export default loopDirect
