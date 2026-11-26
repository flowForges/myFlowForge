import { parseClaudeRecord } from './claudeLog'
import type { LineInfo } from './types'

// Qoder 记录 `<QODER_CONFIG_DIR|QODER_HOME|~/.qoder>/projects/<project>/<session-id>.jsonl`。
// 格式未经官方说明、本机也还没有样本 → 假定与 Claude 同格式(type user/assistant/system/result + message.content)。
// 宽容处理:没有顶层 type 时用 message.role 补;id 回退 uuid → id → 行偏移。
// 结束标记同 Claude;一条都认不出时 endedCleanly 恒为 false,占用判定实际只看 mtime(设计 §4.5)。

export function parseQoderRecord(o: any, lineOffset: number): LineInfo {
  const role = o.message?.role
  const type = typeof o.type === 'string' ? o.type : (role === 'user' || role === 'assistant' ? role : undefined)
  const uuid = typeof o.uuid === 'string' ? o.uuid : typeof o.id === 'string' ? o.id : undefined
  if (type === o.type && uuid === o.uuid) return parseClaudeRecord(o, lineOffset)
  return parseClaudeRecord({ ...o, type, uuid }, lineOffset)
}
