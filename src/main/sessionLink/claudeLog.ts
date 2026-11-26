import { parseClaudeObj, TAG_NOISE, textOf } from '../sessionImport/sources/claude'
import { toolSummary, tsOf, type ExtTurn, type LineInfo } from './types'

// Claude Code 记录 `<CLAUDE_CONFIG_DIR|~/.claude>/projects/<slug>/<id>.jsonl`。
// 结束标记(末条与轮次有关的记录):
//   result                                   → 结束
//   system stop_hook_summary / turn_duration → 结束(Claude Code 每轮收尾写这条)
//   system api_error                         → 进行中(正在重试)
//   assistant 含 tool_use 或 stop_reason=tool_use → 进行中(工具还没回)
//   assistant 其它(纯文本/思考)             → 结束
//   user「[Request interrupted by user…」     → 结束(用户打断)
//   user 其它(提问 / tool_result)          → 进行中(等模型)
//   isMeta / 本地命令回显 / isSidechain / 记账类行(attachment、mode、last-prompt…)→ 无关

const ENDED_SYSTEM = new Set(['stop_hook_summary', 'turn_duration'])
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
  const pendingTool = tools.length > 0 || o.message?.stop_reason === 'tool_use'
  return { turns, cwd, end: !pendingTool }
}
