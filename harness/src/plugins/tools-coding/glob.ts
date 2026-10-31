// glob 工具:按模式找文件,按修改时间新 → 旧,最多 200(spec §7)
import { lstatSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { compileGlob } from '../../lib/fs/glob'
import type { Tool } from '../../lib/tools/types'
import { allowedReads, type CodingDeps, jsonSchema, parsed, request, YIELD_EVERY, yieldLoop } from './common'
import { listFiles } from './files'
import { shownPath, stillSame } from './safeFs'

// 匹配器在 lib(权限规则也用);测试与 grep 仍从这里取
export { compileGlob, expandBraces, MAX_BRACE_ALTERNATIVES } from '../../lib/fs/glob'

/** 不含 `/` 的模式匹配任意一级的文件名(`*.ts` 也找到 `src/a.ts`,与 rg --glob 一致);含 `/` 的匹配整条相对路径 */
export function globMatcher(pattern: string): (rel: string) => boolean {
  const m = compileGlob(pattern)
  if (pattern.includes('/')) return m
  return rel => m(rel.slice(rel.lastIndexOf('/') + 1))
}

export const MAX_FILES = 20_000
const MAX_RESULTS = 200

const Args = z.object({
  pattern: z.string().min(1).describe('Glob pattern: **, *, ?, {a,b}, [...]. A pattern without / matches file names at any depth'),
  path: z.string().optional().describe('Directory to search (default: the working directory)'),
})

export function globTool(deps: CodingDeps): Tool {
  return {
    name: 'glob',
    description: `Find files by glob pattern. Inside a git repository, files ignored by .gitignore are skipped; otherwise node_modules and .git are skipped. Results are sorted by modification time (newest first), at most ${MAX_RESULTS}.`,
    parameters: jsonSchema(Args),
    permission: (raw, ctx) => [request('read', parsed(Args, raw, ctx).abs)],
    async run(raw, ctx) {
      const { args, raw: rawPath, abs } = parsed(Args, raw, ctx)
      stillSame(ctx, rawPath, abs)
      if (!statSync(abs).isDirectory()) return { content: `${shownPath(ctx, abs)} 不是目录`, isError: true }
      const { files, truncated } = await listFiles(abs, { signal: ctx.signal, max: MAX_FILES, git: deps.git })
      const match = globMatcher(args.pattern)
      const hits = await allowedReads(deps, ctx, files.filter(match).map(f => join(abs, f)))
      const dated: { p: string; t: number }[] = []
      for (const [k, p] of hits.entries()) {
        if (k % YIELD_EVERY === YIELD_EVERY - 1) await yieldLoop()
        try {
          const st = lstatSync(p)
          if (st.isFile()) dated.push({ p, t: st.mtimeMs })
        } catch {
          // 已被删除(git 索引里还有)
        }
      }
      dated.sort((a, b) => b.t - a.t || (a.p < b.p ? -1 : a.p > b.p ? 1 : 0))
      const notes: string[] = []
      if (dated.length > MAX_RESULTS) notes.push(`…(共 ${dated.length} 个匹配,只列最新的 ${MAX_RESULTS} 个)`)
      if (truncated) notes.push(`…(只查看了前 ${MAX_FILES} 个文件)`)
      if (dated.length === 0) return { content: ['没有匹配的文件', ...notes].join('\n') }
      return { content: [...dated.slice(0, MAX_RESULTS).map(d => shownPath(ctx, d.p)), ...notes].join('\n') }
    },
  }
}
