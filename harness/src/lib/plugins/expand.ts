// 技能和命令正文里的变量(09 spec §5.2、§9.5)。一遍替换:替换进去的值不会再被展开,
// 所以参数里的 `$2` 不会变成第二个参数
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
