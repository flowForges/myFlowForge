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

export function expandBody(text: string, v: ExpandVars): string {
  const args = v.args ?? ''
  const parts = splitArgs(args)
  const names = v.argNames ?? []
  let placeholder = false

  const out = text.replace(TOKEN, (whole, braced?: string, word?: string, digits?: string) => {
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
  })

  if (!placeholder && args.trim() !== '') return `${out}\n\nARGUMENTS: ${args}`
  return out
}
