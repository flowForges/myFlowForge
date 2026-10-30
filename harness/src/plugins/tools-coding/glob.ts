// 自写的最小 glob(不引依赖):`**`、`*`、`?`、`{a,b}`、`[...]` / `[!...]`;匹配 `/` 分隔的相对路径
// glob 工具:按模式找文件,按修改时间新 → 旧,最多 200(spec §7)
import { lstatSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Tool } from '../../lib/tools/types'
import { allowedReads, type CodingDeps, jsonSchema, parsed, request } from './common'
import { listFiles } from './files'
import { shownPath, stillSame } from './safeFs'

const SPECIAL = /[.+^$()|\\]/

/** glob → 整串匹配的正则 */
export function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${convert(pattern)}$`)
}

function convert(p: string): string {
  let out = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '*') {
      if (p[i + 1] === '*') {
        const atStart = i === 0 || p[i - 1] === '/'
        if (atStart && p[i + 2] === '/') {
          out += '(?:.*/)?' // `**/` = 零或多级目录
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else out += '[^/]*'
    } else if (c === '?') out += '[^/]'
    else if (c === '[') {
      const end = p.indexOf(']', i + 2)
      if (end === -1) out += '\\['
      else {
        let body = p.slice(i + 1, end)
        const neg = body[0] === '!' || body[0] === '^'
        if (neg) body = body.slice(1)
        out += `[${neg ? '^' : ''}${body.replace(/\\/g, '\\\\')}]`
        i = end
      }
    } else if (c === '{') {
      const end = closing(p, i)
      if (end === -1) out += '\\{'
      else {
        out += `(?:${split(p.slice(i + 1, end)).map(convert).join('|')})`
        i = end
      }
    } else if (SPECIAL.test(c) || c === ']' || c === '}') out += `\\${c}`
    else out += c
  }
  return out
}

/** 与 p[i] 的 `{` 配对的 `}`(支持嵌套) */
function closing(p: string, i: number): number {
  let depth = 0
  for (let j = i; j < p.length; j++) {
    if (p[j] === '{') depth++
    else if (p[j] === '}' && --depth === 0) return j
  }
  return -1
}

/** 按顶层逗号切 `{a,b{c,d}}` 的内部 */
function split(s: string): string[] {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const c of s) {
    if (c === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
      continue
    }
    if (c === '{') depth++
    else if (c === '}') depth--
    cur += c
  }
  parts.push(cur)
  return parts
}

/** 不含 `/` 的模式匹配任意一级的文件名(`*.ts` 也找到 `src/a.ts`,与 rg --glob 一致);含 `/` 的匹配整条相对路径 */
export function globMatcher(pattern: string): (rel: string) => boolean {
  const re = globToRegExp(pattern)
  if (pattern.includes('/')) return rel => re.test(rel)
  return rel => re.test(rel.slice(rel.lastIndexOf('/') + 1))
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
      const hits = allowedReads(deps, ctx, files.filter(match).map(f => join(abs, f)))
      const dated: { p: string; t: number }[] = []
      for (const p of hits) {
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
