// 自写的最小 glob(不引依赖):`**`、`*`、`?`、`{a,b}`、`[...]` / `[!...]`;匹配 `/` 分隔的相对路径
// glob 工具:按模式找文件,按修改时间新 → 旧,最多 200(spec §7)
import { lstatSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Tool } from '../../lib/tools/types'
import { allowedReads, type CodingDeps, jsonSchema, parsed, request, YIELD_EVERY, yieldLoop } from './common'
import { listFiles } from './files'
import { shownPath, stillSame } from './safeFs'

// 不编译成正则(模型给的模式编成回溯正则可能卡死内核,§16.7):
// 先展开花括号(上限 64 个),每个分支按段匹配——段内是带星号回退的双指针,`**` 段用备忘递归,都是多项式时间
export const MAX_BRACE_ALTERNATIVES = 64

type Tok = { t: 'lit'; c: string } | { t: 'one' } | { t: 'star' } | { t: 'set'; neg: boolean; items: (string | [string, string])[] }
/** 一段:`**` 或 token 序列 */
type Seg = 'globstar' | Tok[]

/** `{a,b}` 展开(支持嵌套);超过上限 → 抛错。没有顶层逗号的 `{…}` 按字面量 */
export function expandBraces(p: string, max = MAX_BRACE_ALTERNATIVES): string[] {
  const out: string[] = []
  const go = (s: string) => {
    const b = firstBrace(s)
    if (!b) {
      out.push(s)
      if (out.length > max) throw new Error(`glob 花括号展开超过 ${max} 个分支`)
      return
    }
    for (const alt of b.alts) go(s.slice(0, b.start) + alt + s.slice(b.end + 1))
  }
  go(p)
  return [...new Set(out)]
}

/** 第一个带顶层逗号的 `{…}`;`\` 转义的跳过 */
function firstBrace(s: string): { start: number; end: number; alts: string[] } | undefined {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      i++
      continue
    }
    if (s[i] !== '{') continue
    let depth = 0
    const alts: string[] = []
    let cur = ''
    for (let j = i; j < s.length; j++) {
      const c = s[j]
      if (c === '\\' && j + 1 < s.length) {
        cur += c + s[++j]
        continue
      }
      if (c === '{' && depth++ === 0) continue
      if (c === '}' && --depth === 0) {
        alts.push(cur)
        if (alts.length > 1) return { start: i, end: j, alts }
        break // `{a}`:按字面量,继续找下一个
      }
      if (c === ',' && depth === 1) {
        alts.push(cur)
        cur = ''
        continue
      }
      cur += c
    }
  }
  return undefined
}

function tokens(seg: string): Tok[] {
  const out: Tok[] = []
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]
    if (c === '\\' && i + 1 < seg.length) out.push({ t: 'lit', c: seg[++i] })
    else if (c === '*') {
      if (out.at(-1)?.t !== 'star') out.push({ t: 'star' }) // 连续星号合并
    } else if (c === '?') out.push({ t: 'one' })
    else if (c === '[') {
      let j = i + 1
      const neg = seg[j] === '!' || seg[j] === '^'
      if (neg) j++
      const bodyStart = j
      if (seg[j] === ']') j++ // 开头的 `]` 是字面量
      while (j < seg.length && seg[j] !== ']') j++
      if (j >= seg.length) {
        out.push({ t: 'lit', c: '[' })
        continue
      }
      const body = seg.slice(bodyStart, j)
      const items: (string | [string, string])[] = []
      for (let k = 0; k < body.length; k++) {
        if (body[k + 1] === '-' && k + 2 < body.length) {
          items.push([body[k], body[k + 2]])
          k += 2
        } else items.push(body[k])
      }
      out.push({ t: 'set', neg, items })
      i = j
    } else out.push({ t: 'lit', c })
  }
  return out
}

const one = (t: Tok, c: string): boolean => {
  if (t.t === 'one') return true
  if (t.t === 'lit') return t.c === c
  if (t.t === 'set') return t.items.some(x => (typeof x === 'string' ? x === c : x[0] <= c && c <= x[1])) !== t.neg
  return false
}

/** 段内匹配:双指针 + 最近一个星号回退,O(n·m) */
function segMatch(toks: Tok[], s: string): boolean {
  let p = 0
  let i = 0
  let starP = -1
  let starI = 0
  while (i < s.length) {
    if (p < toks.length && toks[p].t === 'star') {
      starP = p++
      starI = i
    } else if (p < toks.length && one(toks[p], s[i])) {
      p++
      i++
    } else if (starP >= 0) {
      p = starP + 1
      i = ++starI
    } else return false
  }
  while (p < toks.length && toks[p].t === 'star') p++
  return p === toks.length
}

function compileOne(p: string): Seg[] {
  return p.split('/').map(s => (s === '**' ? 'globstar' : tokens(s)))
}

/** 按段匹配;`**` 匹配零或多段;(段号, 路径段号) 备忘,O(P·S) 次段匹配 */
function pathMatch(segs: Seg[], parts: string[]): boolean {
  const memo = new Map<number, boolean>()
  const go = (pi: number, si: number): boolean => {
    const key = pi * (parts.length + 1) + si
    const hit = memo.get(key)
    if (hit !== undefined) return hit
    let r: boolean
    if (pi === segs.length) r = si === parts.length
    else {
      const seg = segs[pi]
      if (seg === 'globstar') r = go(pi + 1, si) || (si < parts.length && go(pi, si + 1))
      else r = si < parts.length && segMatch(seg, parts[si]) && go(pi + 1, si + 1)
    }
    memo.set(key, r)
    return r
  }
  return go(0, 0)
}

/** glob → 整条相对路径(`/` 分隔)的匹配函数;花括号分支过多 → 抛错 */
export function compileGlob(pattern: string): (rel: string) => boolean {
  const alts = expandBraces(pattern).map(compileOne)
  return rel => {
    const parts = rel.split('/')
    return alts.some(a => pathMatch(a, parts))
  }
}

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
