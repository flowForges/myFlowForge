import type { ImportedMessage } from '@shared/types'

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
