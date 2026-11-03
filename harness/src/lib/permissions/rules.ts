// `Tool(pattern)` 规则引擎(05 spec §4):纯函数。模式来自用户配置 → 一律不编译成正则,
// 路径与命令都走 lib/fs/glob 的段匹配(多项式时间,无回溯)
import { posix, win32 } from 'node:path'
import { basicSegments, pathMatch, type Seg, starMatcher } from '../fs/glob'
import { foldedSegments, isComparablePath, isInside } from '../fs/paths'
import { isPlainCommand } from '../tools/commandKey'

export type Effect = 'deny' | 'ask' | 'allow'
export type Subject = 'read' | 'write' | 'shell'

/** 配置里的一条规则;match / noMatch 是自带的测试用例 */
export interface RuleSpec {
  effect: Effect
  rule: string
  match?: string[]
  noMatch?: string[]
}

export interface Rule {
  effect: Effect
  subject: Subject
  /** shell:trim 并折叠空白后的命令模式;路径:原样 */
  pattern: string
  spec: RuleSpec
}

/** index = 规则在列表里的位置;`network` 给网络白名单条目用(R12) */
export interface RuleError {
  index: number
  rule: string
  reason: 'syntax' | 'subject' | 'pattern' | 'test_failed' | 'network'
  case?: string
}

export interface MatchCtx {
  cwd: string
  home: string
  platform: NodeJS.Platform
  /** 给了才把模式的字面前缀取 realpath(`/var` → `/private/var`);抛错 → 往上找存在的祖先 */
  realpath?: (p: string) => string
}

/** 默认网络白名单(spec §4) */
export const DEFAULT_NETWORK_ALLOW: readonly string[] = [
  'registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org', 'github.com', 'codeload.github.com',
  'objects.githubusercontent.com', 'crates.io', 'static.crates.io', 'proxy.golang.org',
]

const EFFECTS = new Set<string>(['deny', 'ask', 'allow'])
const SUBJECTS = new Set<string>(['read', 'write', 'shell'])

const collapse = (s: string) => s.trim().replace(/\s+/g, ' ')

/** 括号成对(命令模式里可以有 `$(…)`,但不能让外层括号失配) */
function balanced(s: string): boolean {
  let depth = 0
  for (const c of s) {
    if (c === '(') depth++
    else if (c === ')' && --depth < 0) return false
  }
  return depth === 0
}

/** 用例列表:没有,或字符串数组 */
const stringList = (v: unknown) => v === undefined || (Array.isArray(v) && v.every(x => typeof x === 'string'))

/** 解析一条规则;无效 → RuleError(syntax:写法 / 括号;subject:主语不是 read / write / shell;pattern:模式不可用) */
export function parseRule(spec: RuleSpec, index = 0): Rule | RuleError {
  const err = (reason: RuleError['reason']): RuleError => ({ index, rule: spec.rule, reason })
  if (!EFFECTS.has(spec.effect) || typeof spec.rule !== 'string') return err('syntax')
  if (!stringList(spec.match) || !stringList(spec.noMatch)) return err('syntax')
  const text = spec.rule.trim()
  const open = text.indexOf('(')
  if (open < 1 || !text.endsWith(')')) return err('syntax')
  const name = text.slice(0, open)
  const body = text.slice(open + 1, -1)
  if (!/^[A-Za-z]+$/.test(name) || !balanced(body)) return err('syntax')
  if (!SUBJECTS.has(name)) return err('subject')
  const subject = name as Subject
  if (body.includes('\0')) return err('pattern')
  if (subject === 'shell') {
    const pattern = collapse(body)
    // `*` 开头的 allow 等于不看沙箱的 auto(§15)
    if (pattern === '' || (spec.effect === 'allow' && pattern.startsWith('*'))) return err('pattern')
    return { effect: spec.effect, subject, pattern, spec }
  }
  if (body.trim() === '' || body.split(/[\\/]/).includes('..')) return err('pattern')
  return { effect: spec.effect, subject, pattern: body, spec }
}

// ── 路径 ──────────────────────────────────────────────────────────────

const pathOf = (platform: NodeJS.Platform) => (platform === 'win32' ? win32 : posix)
const hasGlob = (seg: string) => seg.includes('*') || seg.includes('?')

/**
 * 模式 / 用例 → 绝对路径:`~` 开头按 home,绝对路径原样(win32 认 `X:\` 与 `X:/`),其余相对 cwd;结尾 `/` = `/**`。
 * anchor = 代入的 home / cwd:它们是字面量,里面的 `*`、`?` 不能当通配符(否则 cwd `/h/a*` 会放开兄弟目录)
 */
function anchoredPattern(p: string, ctx: MatchCtx): { abs: string; anchor?: string } {
  const path = pathOf(ctx.platform)
  const win = ctx.platform === 'win32'
  if (p.endsWith('/') || (win && p.endsWith('\\'))) p += '**'
  if (p === '~' || p.startsWith('~/') || (win && p.startsWith('~\\'))) return { abs: path.join(ctx.home, p.slice(1)), anchor: ctx.home }
  const absolute = win ? /^[A-Za-z]:[\\/]/.test(p) : p.startsWith('/')
  return absolute ? { abs: path.normalize(p) } : { abs: path.join(ctx.cwd, p), anchor: ctx.cwd }
}

const absolutePattern = (p: string, ctx: MatchCtx) => anchoredPattern(p, ctx).abs

/** 路径按分隔符拆段,根只算一段(posix `/` → `['']`,win32 `C:\` → `['C:']`) */
function rawSegments(p: string, platform: NodeJS.Platform): string[] {
  const path = pathOf(platform)
  return path.normalize(p).split(path.sep).filter((x, i) => i === 0 || x !== '')
}

/** 最近能 realpath 的祖先取 realpath,拼回其余部分;没注入 realpath 或一路失败 → undefined */
function realPrefix(p: string, ctx: MatchCtx): string | undefined {
  if (!ctx.realpath) return undefined
  const path = pathOf(ctx.platform)
  const tail: string[] = []
  let cur = p
  for (;;) {
    try {
      const real = ctx.realpath(cur)
      return tail.length ? path.join(real, ...tail) : real
    } catch {
      const up = path.dirname(cur)
      if (up === cur) return undefined
      tail.unshift(path.basename(cur))
      cur = up
    }
  }
}

/** 一种绝对形态;literal 是它的字面前缀(anchor 与其后第一个通配段之前的部分,或其 realpath),整段按字面量比 */
interface PatternForm {
  path: string
  literal: string
}

/** 模式的两种绝对形态:原样,与字面前缀取 realpath 后的 */
function patternForms(pattern: string, ctx: MatchCtx): PatternForm[] {
  const path = pathOf(ctx.platform)
  const { abs, anchor } = anchoredPattern(pattern, ctx)
  const segs = abs.split(path.sep)
  const fixed = anchor === undefined ? 0 : Math.min(rawSegments(anchor, ctx.platform).length, segs.length)
  let k = segs.findIndex((seg, i) => i >= fixed && hasGlob(seg))
  if (k < 0) k = segs.length
  // 只剩根(posix 的 `''`、win32 的 `C:`)时用 `/`、`C:\`:`C:` 本身是盘符上的当前目录
  const prefix = k <= 1 ? segs[0] + path.sep : segs.slice(0, k).join(path.sep)
  const raw: PatternForm = { path: abs, literal: prefix }
  const real = realPrefix(prefix, ctx)
  if (real === undefined) return [raw]
  const realAbs = k < segs.length ? path.join(real, ...segs.slice(k)) : real
  return realAbs === abs ? [raw] : [raw, { path: realAbs, literal: real }]
}

/**
 * deny / ask 规则里能化成字面路径根的(04 spec §8.4),其余只计数,由调用方按 mustAsk 处理。
 * 字面 = 没有通配符,或只有结尾的 `/**`、`/`;`**` 按 `<cwd>/**` 算,代入的 cwd / home 不算通配符。
 * `ask` 盖住整个 cwd 的例外(`**`、`./**`、`/**`、cwd 的祖先):人放行之后整个 cwd 仍被挡住,这次运行就白跑了,所以留给 mustAsk 和事后检查。
 * `[` 在规则引擎里是字面量,照样进 roots;Codex 那边由 profileGaps 降级。
 * 根比规则宽(`a` 也盖住 `a/x`),只会多拒。两种写法都给:Codex 的权限档自己不取 realpath
 */
export function literalRoots(rules: Rule[], subject: 'read' | 'write', ctx: MatchCtx): { roots: string[]; untranslated: number } {
  const path = pathOf(ctx.platform)
  const roots = new Set<string>()
  let untranslated = 0
  const withoutSep = (p: string) => (p.endsWith(path.sep) && path.parse(p).root !== p ? p.slice(0, -1) : p)
  for (const rule of rules) {
    if (rule.subject !== subject || rule.effect === 'allow') continue
    const forms = patternForms(rule.pattern, ctx)
    const [{ path: abs, literal }] = forms
    const askAboutAll = rule.effect === 'ask' && forms.some(f => isInside(ctx.cwd, withoutSep(f.literal), ctx.platform))
    if (!askAboutAll && (abs === literal || abs === path.join(literal, '**'))) for (const f of forms) roots.add(withoutSep(f.literal))
    else untranslated++
  }
  return { roots: [...roots], untranslated }
}

interface CompiledPath {
  forms: PatternForm[]
  folded: Map<boolean, Seg[][]>
}

/** 每条规则缓存最近一次的上下文(权限门对 glob / grep 的每个文件都判一次) */
const cache = new WeakMap<Rule, { cwd: string; home: string; platform: string; realpath?: MatchCtx['realpath']; compiled: CompiledPath }>()

function compiledPath(rule: Rule, ctx: MatchCtx): CompiledPath {
  const hit = cache.get(rule)
  if (hit && hit.cwd === ctx.cwd && hit.home === ctx.home && hit.platform === ctx.platform && hit.realpath === ctx.realpath) return hit.compiled
  const compiled: CompiledPath = { forms: patternForms(rule.pattern, ctx), folded: new Map() }
  cache.set(rule, { cwd: ctx.cwd, home: ctx.home, platform: ctx.platform, realpath: ctx.realpath, compiled })
  return compiled
}

function foldedForms(c: CompiledPath, platform: NodeJS.Platform, strong: boolean): Seg[][] {
  let segs = c.folded.get(strong)
  if (!segs) {
    segs = c.forms.map(f => basicSegments(foldedSegments(f.path, platform, strong), foldedSegments(f.literal, platform, strong).length))
    c.folded.set(strong, segs)
  }
  return segs
}

/**
 * 资源是工具解析好的 realpath。两边按 03 的段折叠比较:deny / ask 强折叠与弱折叠任一命中即命中
 * (强折叠盖住 `ſ`、`ß`;弱折叠让 `?` 仍能对上 `ß` 这样的单个字符),allow 只用弱折叠 —— 只会多拒不会漏拒。
 * 不可比较的资源:deny / ask 命中,allow 不命中
 */
function matchesPath(rule: Rule, resource: string, ctx: MatchCtx): boolean {
  if (!isComparablePath(resource, ctx.platform)) return rule.effect !== 'allow'
  const compiled = compiledPath(rule, ctx)
  const folds = rule.effect === 'allow' ? [false] : [true, false]
  return folds.some(strong => {
    const parts = foldedSegments(resource, ctx.platform, strong)
    return foldedForms(compiled, ctx.platform, strong).some(segs => pathMatch(segs, parts))
  })
}

// ── 命令 ──────────────────────────────────────────────────────────────

/** 切段:`; && || | &`、换行、`$(`、反引号与括号(子 shell);`&&` / `||` 切出的空段丢掉 */
const SEGMENT_SPLIT = /\$\(|[;&|\n\r`()]/
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^ ]*) ?/
/** 前缀命令 → 带参数的选项(`env -u NAME`、`exec -a name`):选项与其参数一起去掉 */
const PREFIX_COMMANDS = new Map<string, Set<string>>([
  ['env', new Set(['-u', '--unset', '-C', '--chdir'])],
  ['command', new Set()],
  ['exec', new Set(['-a'])],
  ['time', new Set()],
])
/** 段首的 shell 关键字与保留字(`if git push`、`{ git push`、`! git push`) */
const KEYWORDS = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '{', '!'])

/**
 * 去掉段首的 `VAR=x` 赋值、shell 关键字与 `env` / `command` / `exec` / `time` 前缀
 * (及紧跟它们的 `-` 选项;带参数的选项连参数一起)
 */
function stripPrefixes(segment: string): string {
  let words = collapse(segment).split(' ')
  let options: Set<string> | undefined
  for (;;) {
    const s = words.join(' ')
    const m = ASSIGNMENT.exec(s)
    if (m) {
      words = s.slice(m[0].length).split(' ')
      continue
    }
    const [word] = words
    if (word === '') return ''
    const prefix = PREFIX_COMMANDS.get(word)
    if (prefix) options = prefix
    else if (options && word.startsWith('-')) {
      if (options.has(word)) words.shift() // 选项的参数
    } else if (KEYWORDS.has(word)) options = undefined
    else return s
    words.shift()
  }
}

function commandSegments(command: string): string[] {
  return command.split(SEGMENT_SPLIT).map(stripPrefixes).filter(s => s !== '')
}

/**
 * deny / ask:整条命令或任一段命中(尽力而为,不是安全边界,边界是沙箱);
 * allow:命令必须是 isPlainCommand 且整条命中
 */
function matchesShell(rule: Rule, command: string): boolean {
  const m = starMatcher(rule.pattern)
  if (rule.effect === 'allow') return isPlainCommand(command) && m(collapse(command))
  return m(collapse(command)) || commandSegments(command).some(m)
}

/** 规则是否命中资源(read / write:绝对路径;shell:命令原文) */
export function matches(rule: Rule, resource: string, ctx: MatchCtx): boolean {
  return rule.subject === 'shell' ? matchesShell(rule, resource) : matchesPath(rule, resource, ctx)
}

/** 跑规则自带的用例;路径用例按假 cwd `/__cwd__`(win32 `C:\__cwd__`)解析,`~` 按 ctx.home。返回第一个失败 */
export function runTests(rule: Rule, ctx: MatchCtx, index = 0): RuleError | undefined {
  const tctx: MatchCtx = { ...ctx, cwd: ctx.platform === 'win32' ? 'C:\\__cwd__' : '/__cwd__' }
  const resolve = (c: string) => (rule.subject === 'shell' ? c : absolutePattern(c, tctx))
  const fail = (c: string): RuleError => ({ index, rule: rule.spec.rule, reason: 'test_failed', case: c })
  for (const c of rule.spec.match ?? []) if (!matches(rule, resolve(c), tctx)) return fail(c)
  for (const c of rule.spec.noMatch ?? []) if (matches(rule, resolve(c), tctx)) return fail(c)
  return undefined
}

const SUBJECT_OF = { read: 'read', write: 'write', exec: 'shell' } as const

/** 同一层内 deny > ask > allow;undefined = 没有规则命中 */
export function evaluate(rules: Rule[], req: { action: 'read' | 'write' | 'exec'; resource: string }, ctx: MatchCtx): Effect | undefined {
  const subject = SUBJECT_OF[req.action]
  let ask = false
  let allow = false
  for (const r of rules) {
    if (r.subject !== subject || !matches(r, req.resource, ctx)) continue
    if (r.effect === 'deny') return 'deny'
    if (r.effect === 'ask') ask = true
    else allow = true
  }
  return ask ? 'ask' : allow ? 'allow' : undefined
}
