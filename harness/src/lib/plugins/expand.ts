// 技能和命令正文里的变量(09 spec §5.2、§9.5)。一遍替换:替换进去的值不会再被展开,
// 所以参数里的 `$2` 不会变成第二个参数
import { randomBytes } from 'node:crypto'
import { escapeTags } from '../memory/wrap'
import { cleanText } from '../tools/diagnostics'

export interface ExpandVars {
  root: string
  skillDir?: string
  settings: Map<string, string>
  sensitive: Set<string>
  args?: string
  argNames?: string[]
}

/** 按空白切,双引号和单引号里的空白保留。没有转义规则 */
export function splitArgs(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let has = false
  let quote = ''
  for (const c of s) {
    if (quote) {
      if (c === quote) quote = ''
      else cur += c
    } else if (c === '"' || c === "'") {
      quote = c
      has = true
    } else if (/\s/.test(c)) {
      if (has || cur !== '') out.push(cur)
      cur = ''
      has = false
    } else cur += c
  }
  if (has || cur !== '') out.push(cur)
  return out
}

const TOKEN = /\$\{([^}\s]{1,200})\}|\$([A-Za-z_][A-Za-z0-9_]*)|\$([0-9]+)/g

/** 展开后的字数上限:技能 256 KB、命令 64 KB 的正文展开后也不会失控 */
export const EXPAND_MAX = 512 * 1024

export type Expanded = { ok: true; text: string } | { ok: false; error: 'too_large' }
const TOO_LARGE: Expanded = { ok: false, error: 'too_large' }

/** 每段输出在拼接前先记账:超了就停,不会先分配一个巨大的字符串 */
export function expandBody(text: string, v: ExpandVars, max = EXPAND_MAX): Expanded {
  if (text.length > max) return TOO_LARGE
  const given = v.args !== undefined
  const args = v.args ?? ''
  const parts = given ? splitArgs(args) : []
  const names = v.argNames ?? []
  let placeholder = false
  const out: string[] = []
  let used = 0
  const push = (s: string): boolean => {
    used += s.length
    if (used > max) return false
    out.push(s)
    return true
  }

  const replacement = (whole: string, braced?: string, word?: string, digits?: string): string => {
    if (braced !== undefined) {
      if (braced === 'CLAUDE_PLUGIN_ROOT' || braced === 'MFF_PLUGIN_ROOT') return v.root
      if (braced === 'CLAUDE_PLUGIN_DATA' || braced === 'MFF_PLUGIN_DATA') return '[plugin data]'
      if (braced === 'CLAUDE_SKILL_DIR') return v.skillDir ?? whole
      const cfg = /^user_config\.(.+)$/.exec(braced)
      if (cfg) {
        if (v.sensitive.has(cfg[1])) return '[hidden]'
        return v.settings.get(cfg[1]) ?? whole
      }
      return whole
    }
    // 没给参数(技能的 read):`$1`、`$ARGUMENTS` 原样留着,脚本里的 awk '{print $1}' 不能被吃掉
    if (!given) return whole
    if (word !== undefined) {
      if (word === 'ARGUMENTS') {
        placeholder = true
        return args
      }
      const at = names.indexOf(word)
      if (at !== -1) {
        placeholder = true
        return parts[at] ?? ''
      }
      return whole
    }
    if (digits !== undefined && digits.length === 1 && digits !== '0') {
      placeholder = true
      return parts[Number(digits) - 1] ?? ''
    }
    return whole
  }

  let last = 0
  for (const m of text.matchAll(TOKEN)) {
    if (!push(text.slice(last, m.index))) return TOO_LARGE
    if (!push(replacement(m[0], m[1], m[2], m[3]))) return TOO_LARGE
    last = m.index + m[0].length
  }
  if (!push(text.slice(last))) return TOO_LARGE
  if (given && !placeholder && args.trim() !== '' && !push(`\n\nARGUMENTS: ${args}`)) return TOO_LARGE
  return { ok: true, text: out.join('') }
}

/** 包裹之后调,把哨兵换回真实路径 */
export type PathSeal = (wrapped: string) => string

/** 路径不是第三方能写的文字以外的东西:技能目录名是它写的,所以写不出标签、换不了行,其余原样 */
const safePath = (p: string) => escapeTags(cleanText(p)).replace(/\n/g, '\\n')

/**
 * 路径是已知的,不是密钥,但打码规则分不出来:一长串没有点的路径会被当成令牌,脚本就跑不了。
 * 所以先放哨兵:全小写、带点,打码碰不到,也不和前后的文字连成一串;每次调用都不同,正文和设置值都猜不到。
 * 设置值和参数还在正文里,照样打码。上限按真实路径算
 */
export function expandSealed(text: string, v: ExpandVars, max = EXPAND_MAX): { ok: true; text: string; seal: PathSeal } | { ok: false; error: 'too_large' } {
  const real = expandBody(text, v, max)
  if (!real.ok) return real
  const nonce = randomBytes(16).toString('hex')
  const root = `.mffroot.${nonce}.`
  const skillDir = `.mffskill.${nonce}.`
  // 路径比哨兵短时展开后会变长:哨兵不到 50 字,每个变量至少 20 字
  const sealed = expandBody(text, { ...v, root, ...(v.skillDir !== undefined && { skillDir }) }, max * 4)
  if (!sealed.ok) return sealed
  const realRoot = safePath(v.root)
  const realDir = v.skillDir === undefined ? '' : safePath(v.skillDir)
  // 替换值用函数:路径里的 `$&` 不是替换模式
  return { ok: true, text: sealed.text, seal: s => s.replaceAll(root, () => realRoot).replaceAll(skillDir, () => realDir) }
}
