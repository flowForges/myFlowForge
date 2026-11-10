// mff-ai 的 CSS 守卫(08b spec §3.1、§3.4,R1、R16):
// 每个选择器都挂在 mffai 类下面;颜色只来自 app 变量,字面色和 color-mix 只在 styles/theme.css;
// 用到的变量都有定义;类名不含说明文字的六个子串;关键帧名不和 app 的撞。
import { describe, it, expect, afterEach } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

const HERE = __dirname
const THEME = 'styles/theme.css'
const BANNED = ['hint', 'desc', 'help', 'note', 'tip', 'caption']
const PREFIX_ATTR = /^\[data-(theme|glass|skin|accent|bg-scope)(\]|[~|^$*]?=[^\]]*\])/
const NAMED = new Set(('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood '
  + 'cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey '
  + 'darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey '
  + 'darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite '
  + 'gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon '
  + 'lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue '
  + 'lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid '
  + 'mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin '
  + 'navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff '
  + 'peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver '
  + 'skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow '
  + 'yellowgreen canvas canvastext linktext visitedtext activetext buttonface buttontext buttonborder field fieldtext highlight highlighttext '
  + 'mark marktext graytext accentcolor accentcolortext').split(' '))

interface Decl { prop: string; value: string }
interface Rule { file: string; selector: string; decls: Decl[]; keyframe?: boolean }
interface Sheet { file: string; rules: Rule[]; imports: string[]; keyframes: string[]; atRules: string[] }

/** 从 i 开始找配对的右括号(跳过字符串) */
function matchBrace(s: string, i: number): number {
  let depth = 0
  for (let j = i; j < s.length; j++) {
    const c = s[j]
    if (c === '"' || c === "'") { j = s.indexOf(c, j + 1); if (j < 0) return s.length; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return j }
  }
  return s.length
}

/** 顶层按分隔符切(括号、方括号、字符串里的不算) */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0, start = 0
  for (let j = 0; j < s.length; j++) {
    const c = s[j]
    if (c === '"' || c === "'") { const k = s.indexOf(c, j + 1); j = k < 0 ? s.length : k; continue }
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (c === sep && depth === 0) { out.push(s.slice(start, j)); start = j + 1 }
  }
  out.push(s.slice(start))
  return out.map((x) => x.trim()).filter(Boolean)
}

function decls(body: string): Decl[] {
  return splitTop(body, ';').map((d) => {
    const k = d.indexOf(':')
    return { prop: d.slice(0, k).trim(), value: d.slice(k + 1).trim() }
  }).filter((d) => d.prop)
}

function parse(file: string, src: string): Sheet {
  const sheet: Sheet = { file, rules: [], imports: [], keyframes: [], atRules: [] }
  const walk = (s: string, inKeyframes: boolean) => {
    let i = 0
    while (i < s.length) {
      while (i < s.length && /\s/.test(s[i])) i++
      if (i >= s.length) break
      const brace = s.indexOf('{', i), semi = s.indexOf(';', i)
      if (s[i] === '@' && semi >= 0 && (brace < 0 || semi < brace)) {
        const stmt = s.slice(i, semi).trim()
        if (/^@import\b/.test(stmt)) sheet.imports.push(stmt)
        else sheet.atRules.push(stmt)
        i = semi + 1
        continue
      }
      if (brace < 0) break
      const prelude = s.slice(i, brace).trim()
      const end = matchBrace(s, brace)
      const inner = s.slice(brace + 1, end)
      if (prelude.startsWith('@')) {
        const kf = /^@(?:-webkit-)?keyframes\s+([\w-]+)/.exec(prelude)
        if (kf) { sheet.keyframes.push(kf[1]); walk(inner, true) }
        else if (/^@(media|supports|container|layer)\b/.test(prelude)) walk(inner, false)
        else sheet.atRules.push(prelude)
      } else {
        sheet.rules.push({ file, selector: prelude, decls: decls(inner), keyframe: inKeyframes || undefined })
      }
      i = end + 1
    }
  }
  walk(src.replace(/\/\*[\s\S]*?\*\//g, ''), false)
  return sheet
}

/** 一个复合选择器去掉方括号和圆括号里的内容 */
const bare = (compound: string) => compound.replace(/\[[^\]]*\]/g, '').replace(/\((?:[^()]|\([^()]*\))*\)/g, '')

function compounds(sel: string): string[] {
  const out: string[] = []
  let depth = 0, cur = ''
  for (const c of sel) {
    if (c === '(' || c === '[') depth++
    if (c === ')' || c === ']') depth--
    if (depth === 0 && (/\s/.test(c) || c === '>' || c === '+' || c === '~')) { if (cur) out.push(cur); cur = ''; continue }
    cur += c
  }
  if (cur) out.push(cur)
  return out
}

/** 每个选择器都挂在 mffai 类下:之前只许 html、:root 和 [data-theme|glass|skin|accent|bg-scope…] */
function scoped(sel: string): boolean {
  for (const c of compounds(sel)) {
    if (/\.mffai[\w-]*/.test(bare(c))) return true
    let rest = c.replace(/^(html|:root)/, '')
    while (rest) {
      const m = PREFIX_ATTR.exec(rest) ?? /^:root/.exec(rest)
      if (!m) return false
      rest = rest.slice(m[0].length)
    }
  }
  return false
}

const classesOf = (sel: string) => [...sel.replace(/\[[^\]]*\]/g, '').matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1])

/** 值里的字面色(不含 var 名、字符串、url) */
function literals(value: string): string[] {
  const v = value.replace(/"[^"]*"|'[^']*'/g, '').replace(/url\([^)]*\)/g, '').replace(/--[\w-]+/g, '')
  const out: string[] = []
  for (const m of v.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) out.push(m[0])
  for (const m of v.matchAll(/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi)) out.push(m[0])
  for (const m of v.matchAll(/(?<![\w-])([a-zA-Z]+)(?![\w-(])/g)) if (NAMED.has(m[1].toLowerCase())) out.push(m[1])
  return out
}

function walkCss(dir: string): string[] {
  const out: string[] = []
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) out.push(...walkCss(p))
    else if (n.endsWith('.css')) out.push(p)
  }
  return out.sort()
}

function appVars(): Set<string> {
  const out = new Set<string>()
  for (const f of ['tokens.css', 'glass.css']) {
    const src = readFileSync(resolve(HERE, '../theme', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const m of src.matchAll(/(--[\w-]+)\s*:/g)) out.add(m[1])
  }
  return out
}
const APP_VARS = appVars()

/** 检查一棵 mff-ai CSS 树,返回违规列表(空 = 通过) */
function checkCss(root: string): string[] {
  const bad: string[] = []
  const sheets = walkCss(root).map((p) => parse(relative(root, p), readFileSync(p, 'utf8')))
  const theme = sheets.find((s) => s.file === THEME)
  if (!theme) return [`missing ${THEME}`]
  const defined = new Set(theme.rules.flatMap((r) => r.decls.map((d) => d.prop)).filter((p) => p.startsWith('--mffai')))
  let themeLiterals = 0
  for (const s of sheets) {
    const isTheme = s.file === THEME
    for (const a of s.atRules) bad.push(`${s.file}: at-rule not allowed: ${a}`)
    if (s.imports.length && s.file !== 'mffai.css') bad.push(`${s.file}: @import only in mffai.css`)
    for (const k of s.keyframes) if (!k.startsWith('mffai')) bad.push(`${s.file}: keyframes ${k} must start with mffai`)
    for (const r of s.rules) {
      if (!r.keyframe) {
        for (const sel of splitTop(r.selector, ',')) {
          if (!scoped(sel)) bad.push(`${s.file}: not scoped under an mffai class: ${sel}`)
          for (const c of classesOf(sel)) {
            const hit = BANNED.find((b) => c.toLowerCase().includes(b))
            if (hit) bad.push(`${s.file}: class .${c} contains "${hit}"`)
          }
        }
      }
      for (const d of r.decls) {
        const lits = literals(d.value)
        if (isTheme) themeLiterals += lits.length
        else {
          for (const l of lits) bad.push(`${s.file}: literal colour ${l} in ${r.selector} { ${d.prop} }`)
          if (/color-mix\(/i.test(d.value)) bad.push(`${s.file}: color-mix outside ${THEME} in ${r.selector} { ${d.prop} }`)
          if (d.prop.startsWith('--mffai')) bad.push(`${s.file}: --mffai-* defined outside ${THEME}: ${d.prop}`)
        }
        for (const m of d.value.matchAll(/var\(\s*(--[\w-]+)/g)) {
          const v = m[1]
          if (v.startsWith('--mffai')) { if (!defined.has(v)) bad.push(`${s.file}: ${v} not defined in ${THEME}`) }
          else if (!APP_VARS.has(v)) bad.push(`${s.file}: ${v} is not an app variable`)
        }
      }
    }
  }
  if (themeLiterals !== 1) bad.push(`${THEME}: ${themeLiterals} literal colours, exactly one allowed (--mffai-knob)`)
  return bad
}

/** 玻璃下没有从 --glass-* 重定义的三个底色 */
function glassGaps(themeSrc: string): string[] {
  const glass = parse(THEME, themeSrc).rules.filter((r) => r.selector.replace(/\s+/g, ' ') === '[data-glass="on"] .mffai-page')
  const got = Object.fromEntries(glass.flatMap((r) => r.decls).map((d) => [d.prop, d.value]))
  return ['--mffai-rail-bg', '--mffai-col-bg', '--mffai-panel-bg'].filter((v) => !/var\(--glass-/.test(got[v] ?? ''))
}

/** 整页的 import 顺序 */
const ORDER = ['styles/theme.css', 'styles/base.css', 'styles/shell.css', 'styles/chat.css', 'styles/pages.css']

describe('mff-ai CSS guard', () => {
  const tmps: string[] = []
  afterEach(() => { for (const t of tmps.splice(0)) rmSync(t, { recursive: true, force: true }) })

  /** 把真实的 CSS 树复制到临时目录,往 file 末尾种一段 */
  const plant = (file: string, css: string, replace?: (src: string) => string) => {
    const dir = mkdtempSync(join(tmpdir(), 'mffai-css-'))
    tmps.push(dir)
    for (const p of walkCss(HERE)) {
      const to = join(dir, relative(HERE, p))
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(p, to)
    }
    const target = join(dir, file)
    const src = readFileSync(target, 'utf8')
    writeFileSync(target, (replace ? replace(src) : src) + '\n' + css + '\n')
    return checkCss(dir)
  }

  it('the real tree passes', () => {
    expect(checkCss(HERE)).toEqual([])
  })

  it('mffai.css is only the five @imports, in order', () => {
    const s = parse('mffai.css', readFileSync(join(HERE, 'mffai.css'), 'utf8'))
    expect(s.rules).toEqual([])
    expect(s.imports.map((i) => /['"]\.\/(.+?)['"]/.exec(i)?.[1])).toEqual(ORDER)
  })

  it('every selector is scoped under an mffai class', () => {
    expect(plant('styles/chat.css', '.chip { color: var(--fg) }').join('\n')).toMatch(/not scoped.*\.chip/)
    expect(plant('styles/chat.css', '.chip .mffai-x { color: var(--fg) }').join('\n')).toMatch(/not scoped/)
    expect(plant('styles/chat.css', '.mffai-x, .set-btn { color: var(--fg) }').join('\n')).toMatch(/not scoped.*\.set-btn/)
    expect(plant('styles/chat.css', '.set-btn:not(.mffai-x) { color: var(--fg) }').join('\n')).toMatch(/not scoped/)
    expect(plant('styles/chat.css', '@media (max-width: 900px) { .chip { color: var(--fg) } }').join('\n')).toMatch(/not scoped/)
    expect(plant('styles/chat.css', '[data-glass="on"] .mffai-rail { color: var(--fg) }')).toEqual([])
    expect(plant('styles/chat.css', '.mffai-page .set-btn { color: var(--fg) }')).toEqual([])
    expect(plant('styles/chat.css', 'html[data-theme="light"] [data-skin] .mffai-page :where(.menu-item) { color: var(--fg) }')).toEqual([])
    expect(plant('styles/chat.css', ':root[data-accent="amber"] .mffai-a > .b { color: var(--fg) }')).toEqual([])
  })

  it('no selector class contains a banned substring', () => {
    expect(plant('styles/chat.css', '.mffai-tooltip { color: var(--fg) }').join('\n')).toMatch(/mffai-tooltip.*"tip"/)
    expect(plant('styles/chat.css', '.mffai-page .x-desc { color: var(--fg) }').join('\n')).toMatch(/"desc"/)
  })

  it('keyframes are namespaced so they cannot replace the app ones', () => {
    expect(plant('styles/chat.css', '@keyframes pulse { 0% { opacity: 1 } }').join('\n')).toMatch(/keyframes pulse/)
    expect(plant('styles/chat.css', '@keyframes mffai-x { 0% { opacity: 1 } to { opacity: 0 } }')).toEqual([])
    expect(plant('styles/chat.css', '@font-face { font-family: x }').join('\n')).toMatch(/at-rule/)
  })

  it('colours outside theme.css are only var(--…), transparent, currentColor, inherit', () => {
    for (const lit of ['#0b1020', 'rgba(0,0,0,.3)', 'oklch(50% .1 200)', 'white', 'var(--del, #e5484d)']) {
      expect(plant('styles/chat.css', `.mffai-x { color: ${lit} }`).join('\n'), lit).toMatch(/literal colour/)
    }
    expect(plant('styles/pages.css', '.mffai-x { box-shadow: 0 1px 2px rgba(0,0,0,.3) }').join('\n')).toMatch(/literal colour/)
    expect(plant('styles/chat.css', '.mffai-x { background: color-mix(in oklab, var(--fg) 5%, transparent) }').join('\n')).toMatch(/color-mix outside/)
    expect(plant('styles/chat.css', '.mffai-x { color: transparent; border-color: currentColor; background: inherit; outline-color: var(--accent) }')).toEqual([])
    expect(plant('styles/chat.css', '.mffai-x { --mffai-local: 1px }').join('\n')).toMatch(/defined outside/)
  })

  it('theme.css: color-mix freely, exactly one literal colour', () => {
    expect(plant(THEME, '.mffai-page { --mffai-x2: color-mix(in oklab, var(--ok) 20%, transparent) }')).toEqual([])
    expect(plant(THEME, '.mffai-page { --mffai-x2: #000 }').join('\n')).toMatch(/2 literal colours/)
    expect(plant(THEME, '.mffai-page { --mffai-x2: black }').join('\n')).toMatch(/2 literal colours/)
    const theme = parse(THEME, readFileSync(join(HERE, THEME), 'utf8'))
    const knob = theme.rules.flatMap((r) => r.decls).find((d) => d.prop === '--mffai-knob')
    expect(knob?.value).toBe('#fff')
  })

  it('every var() exists: --mffai-* in theme.css, the rest in the app tokens', () => {
    expect(plant('styles/chat.css', '.mffai-x { color: var(--mffai-nope) }').join('\n')).toMatch(/--mffai-nope not defined/)
    expect(plant('styles/chat.css', '.mffai-x { color: var(--not-an-app-var) }').join('\n')).toMatch(/--not-an-app-var is not an app variable/)
    expect(plant('styles/chat.css', '.mffai-x { color: var(--fg); background: var(--glass-panel); border-color: var(--mffai-tint) }')).toEqual([])
  })

  it('theme.css redefines the rail, column and panel backgrounds under glass from --glass-*', () => {
    const src = readFileSync(join(HERE, THEME), 'utf8')
    expect(glassGaps(src)).toEqual([])
    expect(glassGaps(src.replace(/\[data-glass="on"\]\s*\.mffai-page\s*\{[^}]*\}/, ''))).toEqual(['--mffai-rail-bg', '--mffai-col-bg', '--mffai-panel-bg'])
    const base = parse(THEME, src).rules.filter((r) => r.selector === '.mffai-page')
    const vars = new Set(base.flatMap((r) => r.decls).map((d) => d.prop))
    for (const v of ['--mffai-ok-dim', '--mffai-warn-dim', '--mffai-err-dim', '--mffai-tint', '--mffai-add-dim', '--mffai-del-dim', '--mffai-add-fg', '--mffai-del-fg',
      '--mffai-warn-line', '--mffai-err-line', '--mffai-acc-line', '--mffai-warn-wash', '--mffai-err-wash', '--mffai-ring-warn', '--mffai-ring-err', '--mffai-on-status',
      '--mffai-rail-bg', '--mffai-col-bg', '--mffai-panel-bg', '--mffai-scrim', '--mffai-dim', '--mffai-shadow', '--mffai-brand', '--mffai-o-tg', '--mffai-o-sc', '--mffai-o-ed',
      '--mffai-p-anth', '--mffai-p-oai', '--mffai-p-ds', '--mffai-p-or', '--mffai-p-cc', '--mffai-p-cx', '--mffai-p-gm', '--mffai-knob']) expect(vars.has(v), v).toBe(true)
  })
})
