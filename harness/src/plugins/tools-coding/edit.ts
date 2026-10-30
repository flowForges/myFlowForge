// edit:精确替换(spec §7)
import { z } from 'zod'
import type { Tool } from '../../lib/tools/types'
import { type CodingDeps, jsonSchema, parsed, request } from './common'
import { lineNo } from './read'
import { readRegular, shownPath, stillSame, writeChecked } from './safeFs'
import { writeAgain } from './write'

const WINDOW = 3
const PREFIX = /^\s*\d+\t/

const Args = z.object({
  path: z.string().describe('File path, relative to the working directory or absolute'),
  old: z.string().describe('Exact text to replace; must occur exactly once unless replaceAll is set'),
  new: z.string().describe('Replacement text'),
  replaceAll: z.boolean().optional().describe('Replace every occurrence'),
})

const MAX_EDIT_BYTES = 10 * 1024 * 1024

/** 出现次数;overlap = 重叠的也算(唯一性判断用:`}\n}` 在 `}\n}\n}` 里有两处) */
function count(hay: string, needle: string, overlap: boolean): number {
  let n = 0
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + (overlap ? 1 : needle.length))) n++
  return n
}

/** 去掉从 read 输出里误复制的行号前缀(`     12\t`) */
const strip = (s: string) =>
  s
    .split('\n')
    .map(l => l.replace(PREFIX, ''))
    .join('\n')
/** new 只在每个非空行都带前缀时才去(确实是整段复制来的) */
const allPrefixed = (s: string) => s.split('\n').every(l => l === '' || PREFIX.test(l))

/** 找不到时给模型看的一段:第一处含 old 首行(去空白)的行 ±3 行 */
function nearest(text: string, old: string): string | undefined {
  const first = old.split('\n').map(l => l.replace(PREFIX, '').trim()).find(l => l !== '')
  if (!first) return undefined
  const lines = text.split('\n')
  const at = lines.findIndex(l => l.includes(first))
  if (at === -1) return undefined
  const from = Math.max(0, at - WINDOW)
  const to = Math.min(lines.length - 1, at + WINDOW)
  return lines
    .slice(from, to + 1)
    .map((l, i) => lineNo(from + i + 1) + l)
    .join('\n')
}

export function editTool(deps: CodingDeps): Tool {
  return {
    name: 'edit',
    description: 'Replace exact text in a file. old must match exactly (including whitespace) and occur once, unless replaceAll is true. Do not include the line-number prefixes from read output.',
    parameters: jsonSchema(Args),
    permission: (raw, ctx) => [request('write', parsed(Args, raw, ctx).abs)],
    async run(raw, ctx) {
      const { args, raw: rawPath, abs } = parsed(Args, raw, ctx)
      if (args.old === '') return { content: 'old 不能为空;新建文件用 write', isError: true }
      if (args.old === args.new) return { content: 'old 与 new 相同,没有可改的', isError: true }
      stillSame(ctx, rawPath, abs)
      const shown = shownPath(ctx, abs)
      const buf = readRegular(abs, MAX_EDIT_BYTES) // FIFO / 设备 / 多硬链接 → 抛错,不会卡住
      if (buf === undefined) return { content: `${shown} 不存在;新建文件用 write`, isError: true }
      if (buf.subarray(0, 8192).includes(0)) return { content: `${shown} 是二进制文件,不能编辑`, isError: true }
      const text = buf.toString('utf8')

      let old = args.old
      let neu = args.new
      let n = count(text, old, true)
      if (n === 0) {
        const stripped = strip(old)
        if (stripped !== old && stripped !== '') {
          old = stripped
          if (allPrefixed(neu)) neu = strip(neu)
          n = count(text, old, true)
        }
      }
      if (n === 0) {
        const win = nearest(text, args.old)
        return {
          content: win ? `在 ${shown} 里找不到 old。最相近的一段:\n${win}` : `在 ${shown} 里找不到 old,也没有含其首行的地方`,
          isError: true,
        }
      }
      if (n > 1 && !args.replaceAll) return { content: `old 在 ${shown} 里出现了 ${n} 次;加更多上下文使其唯一,或设 replaceAll`, isError: true }

      let next: string
      if (args.replaceAll) next = text.split(old).join(neu)
      else {
        const i = text.indexOf(old)
        next = text.slice(0, i) + neu + text.slice(i + old.length) // 不用 String.replace:new 里的 `$&` 要原样
      }
      writeChecked(abs, next, writeAgain(deps, ctx, rawPath, abs))
      return { content: `已修改 ${shown}(替换 ${args.replaceAll ? count(text, old, false) : 1} 处)` }
    },
  }
}
