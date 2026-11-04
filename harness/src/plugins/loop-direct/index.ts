// loop-direct:直连模型层的对话循环(无工具);没有可用模型时让位给 loop-echo
import type { KernelEvent } from '../../protocol/index'
import type { ModelRef } from '../../protocol/models'
import type { Plugin } from '../../kernel/pluginHost'
import { blocksOf, injectMemory } from '../../lib/memory/inject'
import type { MemoryService } from '../../lib/memory/types'
import { contextWindow } from '../../lib/models/contextWindow'
import type { Message, ModelsService } from '../../lib/models/types'
import { manifest } from './manifest'

interface Req { sessionId: string; turnId: string; text: string; signal: AbortSignal }
const turnOf = (e: KernelEvent) => (e.payload as { turnId?: string } | null)?.turnId
const textOf = (e: KernelEvent) => (e.payload as { text?: string } | null)?.text ?? ''

/** 一轮的 token 估算:ASCII 字符 / 3.5,其余每字符 1(中文按 3.5 字符一个会低估 2–3 倍) */
export function turnTokens(text: string): number {
  let ascii = 0
  let other = 0
  for (const ch of text) (ch.charCodeAt(0) < 128 ? ascii++ : other++)
  return ascii / 3.5 + other
}

/**
 * 总量 ≤ 70% 窗口不裁;否则按窗口 25% 的整块从最早的轮往后丢:
 * k = ceil((总量 − 70%) / 块),丢到累计 ≥ k 块的第一个轮为止。k 随总量单调,切点不会往回退,
 * 两次切点之间发出的请求是上一次的逐字节前缀延续。dropFrom = 第一个保留的轮的下标
 */
export function trimHistory(turns: { id: string; tokens: number }[], context: number): { dropFrom: number } {
  const total = turns.reduce((a, t) => a + t.tokens, 0)
  const limit = 0.7 * context
  if (total <= limit) return { dropFrom: 0 }
  const chunk = 0.25 * context
  const target = Math.ceil((total - limit) / chunk) * chunk
  let acc = 0
  for (let i = 0; i < turns.length; i++) {
    acc += turns[i].tokens
    if (acc >= target) return { dropFrom: i + 1 }
  }
  return { dropFrom: turns.length }
}

/**
 * 已完成的 turn 的问答按序入历史;失败 / 未完成的 turn 整个跳过;当前提问放最后。
 * 记忆块只从事件来:会话块进第一条消息,不管它原来那一轮还在不在;轮块进它那一轮
 */
export function buildHistory(events: KernelEvent[], currentTurnId: string, currentText: string, context?: number): Message[] {
  const users = new Map<string, string>()
  const order: string[] = []
  const answers = new Map<string, string>()
  const ended = new Set<string>()
  for (const e of events) {
    const id = turnOf(e)
    if (!id) continue
    if (e.type === 'message.user') {
      if ((e.payload as { followUp?: boolean }).followUp) continue // 一轮一问一答;否则同一轮进两次
      users.set(id, textOf(e))
      order.push(id)
    }
    else if (e.type === 'message.assistant') answers.set(id, textOf(e))
    else if (e.type === 'turn.ended') ended.add(id)
  }
  const blocks = blocksOf(events)
  const out: Message[] = []
  const done = order.filter(id => id !== currentTurnId && ended.has(id) && answers.has(id))
  let dropped = 0
  if (context !== undefined) {
    // 当前这一轮也计入总量但永不丢:再大也交给服务商报错,不在这里循环
    const turns = [...done, currentTurnId].map(id => ({
      id, tokens: turnTokens((blocks.turns.get(id) ?? '') + (users.get(id) ?? currentText) + (answers.get(id) ?? '')),
    }))
    dropped = Math.min(trimHistory(turns, context).dropFrom, done.length)
  }
  const user = (id: string, text: string): Message => {
    const first = out.length === 0
    const texts = [
      ...(first && blocks.session ? [blocks.session] : []),
      ...(first && dropped > 0 ? [`[已省略较早的 ${dropped} 轮,事件日志里还在]`] : []),
      ...(blocks.turns.has(id) ? [blocks.turns.get(id)!] : []),
      text,
    ]
    return { role: 'user', parts: texts.map(t => ({ type: 'text' as const, text: t })) }
  }
  for (const id of done.slice(dropped)) {
    out.push(user(id, users.get(id)!))
    out.push({ role: 'assistant', parts: [{ type: 'text', text: answers.get(id)! }] })
  }
  out.push(user(currentTurnId, currentText))
  return out
}

const loopDirect: Plugin = {
  manifest,
  activate(ctx) {
    ctx.events.on('session.prompt', async (req: Req) => {
      const { sessionId, turnId, text, signal } = req
      const models = ctx.services.get<ModelsService>('models')
      if (!models) return undefined
      const created = ctx.events.history(sessionId).find(e => e.type === 'session.created')
      const sessionModel = (created?.payload as { model?: ModelRef } | null)?.model
      const ref: ModelRef | 'default' | undefined = sessionModel ?? (models.catalog().default ? 'default' : undefined)
      if (!ref) return undefined

      const ev = (type: KernelEvent['type'], payload: object) => ctx.append({ type, sessionId, payload: { turnId, ...payload } })
      ev('turn.started', {})
      const memory = ctx.services.get<MemoryService>('memory')
      if (memory) {
        // 没有系统提示词和工具定义要扣,整个窗口都算
        injectMemory(memory, { sessionId, turnId, text, events: ctx.events.history(sessionId), contextTokens: contextWindow(models, ref) }, p => ev('memory.injected', p), ctx.log)
      }
      let acc = ''
      const stream = models.stream(ref, {
        interactive: true, signal, messages: buildHistory(ctx.events.history(sessionId), turnId, text, contextWindow(models, ref)), reasoning: 'medium',
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
