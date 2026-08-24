import type { DelegateBatch, SubagentCard } from '../../../src/shared/types'

/**
 * 子代理卡 / 委派批次卡的**纯逻辑**:标题、汇总行、状态色。
 *
 * 两种东西长得像但来路不同,别混:
 *  · `SubagentCard` —— 主代理这一轮用 Task 起的**内置子代理**。**落档**在消息上(`msg.subagents`),
 *    刷新还在。我们只拿得到它的开始、它自己调的工具标题、和最终结果 —— 拿不到它的正文。
 *  · `DelegateBatch` —— `forge_delegate` 发出去的一批**后台委派**。**不落档**(纯实时),
 *    主轮次早就结束了它们还在跑,所以这张卡是唯一能看见它们进度的地方。
 */

/** 一张子代理卡的标题。description 是模型自己给这次任务起的名,最贴切;都没有才退到「子代理」。 */
export function subagentTitle(card: SubagentCard): string {
  const d = (card.description ?? '').trim()
  const t = (card.subagentType ?? '').trim()
  if (d && t) return `${t} · ${d}`
  return d || t || '子代理'
}

/** 折叠行右边那句汇总。**在跑的条数要单独说** —— 「3 个子代理」看不出还有没有人在动。 */
export function subagentSummary(cards: SubagentCard[]): string {
  const run = cards.filter((c) => c.state === 'running').length
  const err = cards.filter((c) => c.state === 'error').length
  const parts = [`${cards.length} 个子代理`]
  if (run) parts.push(`${run} 个在跑`)
  if (err) parts.push(`${err} 个失败`)
  return parts.join(' · ')
}

export function delegateSummary(batch: DelegateBatch): string {
  const run = batch.agents.filter((a) => a.status === 'run').length
  const bad = batch.agents.filter((a) => a.status === 'idle').length
  const parts = [`委派 · ${batch.agents.length} 个子代理`]
  // ★整批都报 done 了却还有人挂在 'run',说明那一条终止的 progress **丢了**(或者压根没发)。
  //  这时候继续写「在跑」是在撒谎 —— 已经没有东西会再来更新它了。也不能替它宣布成功。
  //  如实说「没有回音」:人看到这四个字就知道要去电脑上确认,而不是干等一个永远不来的完成。
  if (run) parts.push(batch.done ? `${run} 个没有回音` : `${run} 个在跑`)
  if (bad) parts.push(`${bad} 个没跑成`)
  // ★`done` 说的是「这一批派完了」,不等于每个都成功。别把它写成「全部完成」。
  if (batch.done && !run && !bad) parts.push('都结束了')
  return parts.join(' · ')
}

export type Tone = 'run' | 'ok' | 'err'

export const subagentTone = (s: SubagentCard['state']): Tone =>
  s === 'running' ? 'run' : s === 'error' ? 'err' : 'ok'

/** ★委派那边失败叫 `idle` 不叫 `error`(照 delegateRegistry 的状态名)。照着翻,别自己改名。 */
export const delegateTone = (s: 'run' | 'ok' | 'idle'): Tone => (s === 'run' ? 'run' : s === 'idle' ? 'err' : 'ok')

/**
 * 子代理正在干什么的那一行。取它自己最近一次工具调用的标题。
 * 一条都没有(provider 不流子代理的工具结构)就返回空串 —— 界面据此不画那一行,
 * 而不是画一个「正在工作…」的空话。
 */
export function latestStep(card: SubagentCard): string {
  const steps = card.steps ?? []
  return steps.length ? steps[steps.length - 1] : ''
}

/** 一张卡展开后要显示的正文:跑完看结果,还在跑就看它最近做了哪几步。 */
export function subagentBody(card: SubagentCard, maxSteps = 6): { kind: 'result' | 'steps' | 'none'; text: string } {
  const result = (card.result ?? '').trim()
  if (card.state !== 'running' && result) return { kind: 'result', text: result }
  const steps = card.steps ?? []
  if (steps.length) return { kind: 'steps', text: steps.slice(-maxSteps).join('\n') }
  // ★跑完了却什么都没有,要说清是「没回传」,不是「还在跑」。
  return { kind: 'none', text: card.state === 'running' ? '刚起来,还没有可显示的动作' : '这个子代理没有回传内容' }
}
