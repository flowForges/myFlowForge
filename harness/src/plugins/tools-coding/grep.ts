// grep 工具:JS 正则逐行匹配,在 worker 线程里跑(spec §7、§16.7)
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Tool } from '../../lib/tools/types'
import { allowedReads, type CodingDeps, jsonSchema, parsed, request } from './common'
import { listFiles } from './files'
import { globMatcher, MAX_FILES } from './glob'
import { runGrep } from './grepWorker'
import { stillSame } from './safeFs'

const MAX_MATCHES = 200
const MAX_LINE = 2000

const Args = z.object({
  pattern: z.string().min(1).describe('JavaScript regular expression, matched line by line'),
  path: z.string().optional().describe('File or directory to search (default: the working directory)'),
  glob: z.string().optional().describe('Only search files matching this glob, e.g. *.ts'),
  ignoreCase: z.boolean().optional(),
})

export function grepTool(deps: CodingDeps): Tool {
  return {
    name: 'grep',
    description: `Search file contents with a JavaScript regular expression. Output lines are path:line: text, at most ${MAX_MATCHES}. Files are chosen like glob; files over 2 MB and binary files are skipped.`,
    parameters: jsonSchema(Args),
    permission: (raw, ctx) => [request('read', parsed(Args, raw, ctx).abs)],
    async run(raw, ctx) {
      const { args, raw: rawPath, abs } = parsed(Args, raw, ctx)
      const flags = args.ignoreCase ? 'i' : ''
      try {
        new RegExp(args.pattern, flags) // 编译不回溯;语法错误在这里报
      } catch (e) {
        return { content: `正则无效:${(e as Error).message}`, isError: true }
      }
      stillSame(ctx, rawPath, abs)
      let candidates: string[]
      let truncated = false
      if (statSync(abs).isDirectory()) {
        const listed = await listFiles(abs, { signal: ctx.signal, max: MAX_FILES, git: deps.git })
        truncated = listed.truncated
        const match = args.glob ? globMatcher(args.glob) : () => true
        candidates = listed.files.filter(match).map(f => join(abs, f))
      } else candidates = [abs]
      const files = allowedReads(deps, ctx, candidates)
      const timeoutMs = deps.grepTimeoutMs ?? 30_000
      const r = await runGrep({ files, base: ctx.cwd, pattern: args.pattern, flags, maxMatches: MAX_MATCHES, maxLine: MAX_LINE }, { timeoutMs, signal: ctx.signal })
      if (r.aborted) return { content: '已取消', isError: true }
      const notes: string[] = []
      if (r.matches.length >= MAX_MATCHES) notes.push(`…(已达 ${MAX_MATCHES} 条上限,结果不全;缩小 path 或 glob)`)
      if (truncated) notes.push(`…(只查看了前 ${MAX_FILES} 个文件)`)
      if (r.timedOut) {
        const head = `grep 超时(${timeoutMs / 1000} s),已终止匹配线程;正则可能有灾难回溯,换个写法再试`
        return { content: [head, ...r.matches, ...notes].join('\n'), isError: true }
      }
      if (r.error) return { content: [`grep 失败:${r.error}`, ...r.matches].join('\n'), isError: true }
      if (r.matches.length === 0) return { content: ['没有匹配', ...notes].join('\n') }
      return { content: [...r.matches, ...notes].join('\n') }
    },
  }
}
