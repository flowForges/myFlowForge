import { homedir } from 'node:os'
import { join } from 'node:path'
import { configHomes } from '../sessionImport/types'

export type ExtProvider = 'codex' | 'claude' | 'qoder'

/** 外部记录里的一轮。tool = 工具调用折叠成的一行摘要。ts = 毫秒时间戳,未知为 0。 */
export interface ExtTurn { who: 'user' | 'assistant' | 'tool'; text: string; ts: number; id: string }

/** 读到哪了。offset = 已消费的字节数(总在行尾 `\n` 之后);lastId = 最后一条已消费行的指纹,用来发现改写。 */
export interface ExtCursor { offset: number; lastId?: string }

export interface ExtRead {
  turns: ExtTurn[]
  next: ExtCursor
  /** 游标对不上(文件被截断/改写)→ 已从头重读,turns 是全量。 */
  reset: boolean
  /** 文件末条有效记录是该轮的结束标记(且末尾没有写到一半的行)。 */
  endedCleanly: boolean
  /** 读到的范围里出现过的最新 cwd;没出现则 undefined,调用方沿用之前的值。 */
  cwd?: string
  /** 文件不存在 / 读不了。 */
  exists: boolean
}

/** 一条 JSON 记录的解析结果。end: true = 结束标记,false = 轮次进行中,undefined = 与轮次状态无关的记录。 */
export interface LineInfo { turns: ExtTurn[]; cwd?: string; end?: boolean }
export type LineParser = (o: any, lineOffset: number) => LineInfo

export function linkRoots(env: Record<string, string | undefined> = process.env, home = homedir()): Record<ExtProvider, string> {
  const h = configHomes(home, env)
  return { codex: join(h.codex, 'sessions'), claude: join(h.claude, 'projects'), qoder: join(h.qoder, 'projects') }
}

const ARG_KEYS = ['command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt']
function oneLine(s: string, max = 80): string { const t = s.replace(/\s+/g, ' ').trim(); return t.length > max ? t.slice(0, max) + '…' : t }

/** 工具调用 → `名字 主要参数` 一行。input 可以是对象、JSON 字符串或纯文本。 */
export function toolSummary(name: string, input: unknown): string {
  let v: unknown = input
  if (typeof input === 'string') { try { v = JSON.parse(input) } catch { return oneLine(`${name} ${input.split('\n')[0]}`) } }
  let arg = ''
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    const k = ARG_KEYS.find(k => o[k] != null) ?? Object.keys(o).find(k => typeof o[k] === 'string')
    const val = k ? o[k] : undefined
    arg = Array.isArray(val) ? val.join(' ') : typeof val === 'string' ? val : ''
  }
  return oneLine(arg ? `${name} ${arg}` : name)
}

export const tsOf = (s: unknown): number => { const n = typeof s === 'string' ? Date.parse(s) : NaN; return Number.isFinite(n) ? n : 0 }
