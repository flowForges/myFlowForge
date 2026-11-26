import { readJsonl, type ReadOpts } from './jsonl'
import { parseClaudeRecord } from './claudeLog'
import { parseCodexRecord } from './codexLog'
import { parseQoderRecord } from './qoderLog'
import type { ExtCursor, ExtProvider, ExtRead, LineParser } from './types'

export type { ExtCursor, ExtProvider, ExtRead, ExtTurn } from './types'
export { linkRoots } from './types'

const PARSERS: Record<ExtProvider, LineParser> = { claude: parseClaudeRecord, codex: parseCodexRecord, qoder: parseQoderRecord }

/** 只读地从游标处增量读外部会话记录。从不写文件,从不抛(读不了 → exists:false)。 */
export function readExternal(provider: ExtProvider, file: string, from: ExtCursor, opts?: ReadOpts): Promise<ExtRead> {
  return readJsonl(file, from, PARSERS[provider], opts)
}
