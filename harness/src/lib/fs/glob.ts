// 自写的最小 glob(不引依赖):`**`、`*`、`?`、`{a,b}`、`[...]` / `[!...]`;glob 工具与权限规则(05 spec §4)共用
// 不编译成正则(模型给的模式编成回溯正则可能卡死内核,§16.7):
// 先展开花括号(上限 64 个),每个分支按段匹配——段内是带星号回退的双指针,`**` 段用备忘递归,都是多项式时间
export const MAX_BRACE_ALTERNATIVES = 64

export type Tok = { t: 'lit'; c: string } | { t: 'one' } | { t: 'star' } | { t: 'set'; neg: boolean; items: (string | [string, string])[] }
/** 一段:`**` 或 token 序列 */
export type Seg = 'globstar' | Tok[]

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
export function segMatch(toks: Tok[], s: string): boolean {
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
export function pathMatch(segs: Seg[], parts: string[]): boolean {
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

/**
 * 基本语法(权限规则):只有 `*`(段内任意字符)与 `?`(一个字符),其余逐字——没有花括号、字符集与 `\\` 转义
 * (win32 的路径分隔符就是反斜杠;用户写的 `[` 应当按字面量)
 */
export function basicTokens(s: string): Tok[] {
  const out: Tok[] = []
  for (let i = 0; i < s.length; i++) {
    const c = s[i] // 按 UTF-16 码元,与 segMatch 一致
    if (c === '*') {
      if (out.at(-1)?.t !== 'star') out.push({ t: 'star' })
    } else if (c === '?') out.push({ t: 'one' })
    else out.push({ t: 'lit', c })
  }
  return out
}

/** 基本语法的路径段:`**` 段 → 任意层,其余按 basicTokens;前 literal 段整段按字面量(代入的 cwd / home) */
export function basicSegments(segs: string[], literal = 0): Seg[] {
  return segs.map((s, i) => {
    if (i < literal) return Array.from({ length: s.length }, (_, j): Tok => ({ t: 'lit', c: s[j] }))
    return s === '**' ? 'globstar' : basicTokens(s)
  })
}

/** 只认 `*`(任意字符,含空格与 `/`)、其余逐字的整串匹配(shell 命令模式);O(n·m),无回溯正则 */
export function starMatcher(pattern: string): (s: string) => boolean {
  const toks: Tok[] = []
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (toks.at(-1)?.t !== 'star') toks.push({ t: 'star' })
    } else toks.push({ t: 'lit', c })
  }
  return s => segMatch(toks, s)
}
