import type { ChatAnswerAnchor } from '../types'

export type BodySegment = { kind: 'text'; text: string } | { kind: 'answer'; text: string }

/**
 * 把助手正文在「你的选择」锚点处切开,选择插在它被回答的那个位置(见 ChatMessage.answers)。
 *
 * ★锚点夹到 [0, text.length]:assistant-replace 可能把正文改短,锚点不能因此丢掉或越界。
 * ★按位置稳定排序:同一位置的多个选择保持到达顺序。
 * ★空的正文段不出:at=0 / at=len 时不留一个空块(那样会多画一段空 markdown)。
 * 零 import(除了类型),桌面端和手机端共用,node 下直接测。
 */
export function splitByAnswers(text: string, answers: readonly ChatAnswerAnchor[] | undefined): BodySegment[] {
  if (!answers?.length) return [{ kind: 'text', text }]
  const anchors = answers
    .map((a, i) => ({ at: Math.min(Math.max(0, a.at), text.length), text: a.text, i }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
  const out: BodySegment[] = []
  let pos = 0
  for (const a of anchors) {
    if (a.at > pos) out.push({ kind: 'text', text: text.slice(pos, a.at) })
    out.push({ kind: 'answer', text: a.text })
    pos = a.at
  }
  if (pos < text.length) out.push({ kind: 'text', text: text.slice(pos) })
  return out
}

/**
 * 同一条消息拼成一段纯文本:选择插在原位,前后空一行。给**喂模型**的那几处用(换代理时的本地历史、
 * 记忆蒸馏、需求总结)—— 「你的选择」原来是一条单独落档的消息,自然在这些历史里;挪进 `answers`
 * 之后若只读 `text`,换个代理接着聊时它就看不到用户选过什么了。
 */
export function inlineAnswers(text: string, answers: readonly ChatAnswerAnchor[] | undefined): string {
  if (!answers?.length) return text
  return splitByAnswers(text, answers).map(s => s.text).join('\n\n')
}
