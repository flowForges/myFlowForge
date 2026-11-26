import { blockText, parseCodexObj } from '../sessionImport/sources/codex'
import { toolSummary, tsOf, type LineInfo } from './types'

// Codex 记录 `<CODEX_HOME|~/.codex>/sessions/YYYY/MM/DD/rollout-*.jsonl`。
// 结束标记(末条与轮次有关的记录):
//   event_msg task_complete / turn_complete / turn_aborted → 结束
//   event_msg task_started / user_message、turn_context、任何 response_item → 进行中
//   其它(session_meta、token_count、item_completed、world_state…)→ 无关
// cwd:session_meta.payload.cwd,之后的 turn_context.payload.cwd 覆盖(以最新为准)。

const ENDED = new Set(['task_complete', 'turn_complete', 'turn_aborted'])
const STARTED = new Set(['task_started', 'turn_started', 'user_message'])
const TOOL_CALLS = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call'])

// 用户消息里 Codex 自己注入的上下文块:整块包在一个标签里(<environment_context>…</environment_context>)或 AGENTS.md 指令
function injected(text: string): boolean {
  const t = text.trim()
  if (t.startsWith('# AGENTS.md instructions')) return true
  const m = /^<([\w-]+)[^>]*>/.exec(t)
  return !!m && t.endsWith(`</${m[1]}>`)
}

export function parseCodexRecord(o: any, lineOffset: number): LineInfo {
  const p = o.payload ?? {}
  const ts = tsOf(o.timestamp)
  const id = (typeof p.id === 'string' && p.id) || (typeof p.call_id === 'string' && p.call_id) || `@${lineOffset}`
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  if (o.type === 'session_meta') return { turns: [], cwd: str(parseCodexObj(o).cwd) }
  if (o.type === 'turn_context') return { turns: [], cwd: str(p.cwd), end: false }
  if (o.type === 'event_msg') return { turns: [], end: ENDED.has(p.type) ? true : STARTED.has(p.type) ? false : undefined }
  if (o.type !== 'response_item') return { turns: [] }
  if (p.type === 'message') {
    const parsed = parseCodexObj(o)
    if (parsed.who === 'user') {
      const text = blockText((Array.isArray(p.content) ? p.content : []).filter((b: any) => typeof b?.text === 'string' && !injected(b.text)))
      return { turns: text.trim() ? [{ who: 'user', text, ts, id }] : [], end: false }
    }
    if (parsed.who === 'ai' && parsed.text) return { turns: [{ who: 'assistant', text: parsed.text, ts, id }], end: false }
    return { turns: [], end: false }
  }
  if (TOOL_CALLS.has(p.type)) {
    const name = String(p.name ?? p.type)
    return { turns: [{ who: 'tool', text: toolSummary(name, p.arguments ?? p.input ?? p.action), ts, id }], end: false }
  }
  return { turns: [], end: false }
}
