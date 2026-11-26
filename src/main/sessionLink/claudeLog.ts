import { parseClaudeObj, TAG_NOISE, textOf } from '../sessionImport/sources/claude'
import { toolSummary, tsOf, type ExtTurn, type LineInfo } from './types'

// Claude Code 记录 `<CLAUDE_CONFIG_DIR|~/.claude>/projects/<slug>/<id>.jsonl`。
// 结束标记(末条与轮次有关的记录):
//   result                                   → 结束
//   system stop_hook_summary / turn_duration → 结束(Claude Code 每轮收尾写这条)
//   system api_error                         → 进行中(正在重试)
//   assistant 有文本块且 stop_reason ∈ end_turn/stop_sequence/max_tokens → 结束
//   assistant 其它 → 进行中:含 tool_use / stop_reason=tool_use(工具还没回)、只有思考块(Claude Code
//     每个内容块写一行、每行都带整条消息最终的 stop_reason,思考块 end_turn 之后总还跟着文本块)、
//     stop_reason 为空或未知(写到中途)
//   user「[Request interrupted by user…」     → 结束(用户打断)
//   user 其它(提问 / tool_result)          → 进行中(等模型)
//   isMeta / 本地命令回显 / isSidechain / 记账类行(attachment、mode、last-prompt…)→ 无关

const ENDED_SYSTEM = new Set(['stop_hook_summary', 'turn_duration'])
const FINAL_STOP = new Set(['end_turn', 'stop_sequence', 'max_tokens'])
const INTERRUPT = /^\[Request interrupted by user/

function blocks(o: any): any[] { const c = o?.message?.content; return Array.isArray(c) ? c : [] }

export function parseClaudeRecord(o: any, lineOffset: number): LineInfo {
  const type = o.type
  const id = typeof o.uuid === 'string' && o.uuid ? o.uuid : `@${lineOffset}`
  const ts = tsOf(o.timestamp)
  const cwd = typeof o.cwd === 'string' && o.cwd ? o.cwd : undefined
  if (type === 'result') return { turns: [], cwd, end: true }
  if (type === 'system') return { turns: [], cwd, end: ENDED_SYSTEM.has(o.subtype) ? true : o.subtype === 'api_error' ? false : undefined }
  if (type !== 'user' && type !== 'assistant') return { turns: [], cwd }
  if (o.isSidechain || o.isCompactSummary) return { turns: [], cwd }

  const p = parseClaudeObj(o)
  const turns: ExtTurn[] = []
  if (type === 'user') {
    const raw = textOf(o.message?.content).trim()
    if (o.isMeta || TAG_NOISE.test(raw)) return { turns: [], cwd }
    if (INTERRUPT.test(raw)) return { turns: [], cwd, end: true }
    if (p.who === 'user' && p.text) turns.push({ who: 'user', text: p.text, ts, id })
    return { turns, cwd, end: false }
  }
  if (p.text) turns.push({ who: 'assistant', text: p.text, ts, id })
  const tools = blocks(o).filter(b => b?.type === 'tool_use')
  tools.forEach((b, i) => turns.push({ who: 'tool', text: toolSummary(String(b.name ?? 'tool'), b.input), ts, id: `${id}#${b.id ?? i}` }))
  const final = tools.length === 0 && !!p.text && FINAL_STOP.has(o.message?.stop_reason)
  return { turns, cwd, end: final }
}
