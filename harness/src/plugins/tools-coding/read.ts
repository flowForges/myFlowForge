// read:带行号读文本文件(spec §7)
import { closeSync, constants, createReadStream, fstatSync, openSync, readSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import type { Tool } from '../../lib/tools/types'
import { jsonSchema, parsed, request } from './common'
import { O_NOFOLLOW, shownPath, stillSame } from './safeFs'

const DEFAULT_LIMIT = 2000
const MAX_LINE = 2000
const SNIFF = 8 * 1024

const Args = z.object({
  path: z.string().describe('File path, relative to the working directory or absolute'),
  offset: z.number().int().min(1).optional().describe('1-based line number to start from'),
  limit: z.number().int().min(1).optional().describe(`Maximum number of lines (default ${DEFAULT_LIMIT})`),
})

export const lineNo = (n: number) => `${String(n).padStart(6)}\t`

export function readTool(): Tool {
  return {
    name: 'read',
    description: `Read a text file. Output lines are prefixed with the line number and a tab. Reads up to ${DEFAULT_LIMIT} lines by default; use offset/limit for more. Lines longer than ${MAX_LINE} characters are cut. Binary files are refused.`,
    parameters: jsonSchema(Args),
    permission: (raw, ctx) => [request('read', parsed(Args, raw, ctx).abs)],
    async run(raw, ctx) {
      const { args, raw: rawPath, abs } = parsed(Args, raw, ctx)
      stillSame(ctx, rawPath, abs)
      const shown = shownPath(ctx, abs)
      const fd = openSync(abs, constants.O_RDONLY | O_NOFOLLOW)
      let owned = true
      try {
        if (fstatSync(fd).isDirectory()) return { content: `${shown} 是目录;用 list 查看`, isError: true }
        const head = Buffer.alloc(SNIFF)
        const n = readSync(fd, head, 0, SNIFF, 0)
        if (head.subarray(0, n).includes(0)) return { content: `${shown} 是二进制文件,不能读取`, isError: true }
        const start = args.offset ?? 1
        const end = start + (args.limit ?? DEFAULT_LIMIT) - 1
        owned = false // 交给流,读完 / 中断时由流关闭
        const stream = createReadStream('', { fd, start: 0, autoClose: true })
        const rl = createInterface({ input: stream, crlfDelay: Infinity })
        const out: string[] = []
        let line = 0
        let more = false
        try {
          for await (const text of rl) {
            line++
            if (line < start) continue
            if (line > end) {
              more = true
              break
            }
            out.push(lineNo(line) + (text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)} …[行已截断]` : text))
          }
        } finally {
          rl.close()
          stream.destroy()
        }
        if (line === 0) return { content: `(${shown} 是空文件)` }
        if (out.length === 0) return { content: `offset ${start} 超出文件末尾(共 ${line} 行)`, isError: true }
        if (more) out.push(`…(还有更多行;用 offset=${end + 1} 继续读)`)
        return { content: out.join('\n') }
      } finally {
        if (owned) closeSync(fd)
      }
    },
  }
}
