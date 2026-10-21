import type { ChatMessage, ImportedMessage } from '@shared/types'
import { inlineAnswers } from '@shared/chat/answerSegments'
import { readMessages } from './chatStore'
import { loadCouncils } from '../council/store'

const DEFAULT_TURNS = 30
const DEFAULT_TOKENS = 40000
const estTokens = (s: string) => Math.ceil(s.length / 4)
const CHARS_PER_TOKEN = 4

function clampText(text: string, maxTokens: number): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN
  if (text.length <= maxChars) return text
  return '…(超长消息已截断)' + text.slice(text.length - maxChars)
}

export function clampHistory(
  msgs: ImportedMessage[],
  opts: { maxTurns?: number; maxTokens?: number } = {},
): { kept: ImportedMessage[]; omitted: number } {
  const maxTurns = opts.maxTurns ?? DEFAULT_TURNS
  const maxTokens = opts.maxTokens ?? DEFAULT_TOKENS
  const kept: ImportedMessage[] = []
  let tok = 0
  for (let i = msgs.length - 1; i >= 0 && kept.length < maxTurns; i--) {
    const t = estTokens(msgs[i].text)
    if (kept.length === 0) {
      // 至少保留最后一条，但若超长则截断尾部保留最近内容
      if (t > maxTokens) {
        const truncated = clampText(msgs[i].text, maxTokens)
        kept.unshift({ ...msgs[i], text: truncated })
        tok = maxTokens // 已满，后续不再放入
      } else {
        kept.unshift(msgs[i]); tok += t
      }
    } else {
      if (tok + t > maxTokens) break
      kept.unshift(msgs[i]); tok += t
    }
  }
  return { kept, omitted: msgs.length - kept.length }
}

export function renderHistoryPreamble(
  msgs: ImportedMessage[],
  omitted: number,
  opts: { incremental?: boolean } = {},
): string {
  if (!msgs.length) return ''
  const head = omitted > 0 ? `（更早历史已省略 ${omitted} 条）\n` : ''
  const body = msgs.map(m => `${m.who === 'user' ? '用户' : '助手'}：${m.text}`).join('\n')
  const title = opts.incremental ? '【你离开期间本会话继续了以下对话】' : '【历史对话(续)】'
  const footer = opts.incremental
    ? '【以上为你离开期间的对话，请先通读理解，在此基础上继续，并自行总结要点】'
    : '【以上为历史，请先通读理解，在此基础上继续，并自行总结要点】'
  return `${title}\n${head}${body}\n${footer}`
}

const COUNCIL_RESULT_MAX_CHARS = 2000

/**
 * ★AI 共商的发言和普通对话存在同一份 jsonl,但普通 agent 不该看到讨论过程:带 council 的消息一律丢掉,
 * 只有每场的 final 折成一行结果(+用户选定的候选)。必须在按 watermark/fromIndex 切完之后再调用——
 * 水位线按 jsonl 原始条数计,过滤只能发生在渲染前。
 */
export function toModelVisibleHistory(ws: string, sid: string, msgs: ChatMessage[]): ImportedMessage[] {
  const chosenById = msgs.some(m => m.council?.stage === 'final')
    ? new Map(loadCouncils(ws, sid).map(c => [c.state.id, c.state.chosen]))
    : new Map<string, string | undefined>()
  const out: ImportedMessage[] = []
  for (const m of msgs) {
    if (!m.council) { out.push({ who: m.who, text: inlineAnswers(m.text, m.answers), ts: m.ts }); continue }
    if (m.council.stage !== 'final') continue
    // councilResult 缺失 = 围栏解析失败,退回消息正文
    const conclusion = (m.councilResult?.conclusion ?? m.text).slice(0, COUNCIL_RESULT_MAX_CHARS)
    const chosen = chosenById.get(m.council.id)
    out.push({ who: 'ai', text: `【AI 共商结果】${conclusion}${chosen ? `(用户选定:${chosen})` : ''}`, ts: m.ts })
  }
  return out
}

/** 整个会话给模型看的历史(已滤掉共商过程、answers 已内联)。IPC 里凡是把会话喂给模型的路径都走这里。 */
export function modelVisibleHistory(ws: string, sid: string): ImportedMessage[] {
  return toModelVisibleHistory(ws, sid, readMessages(ws, sid))
}
