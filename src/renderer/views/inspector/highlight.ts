export interface Token { cls: 'kw' | 'st' | 'cm' | 'nu' | null; text: string }

interface LangCfg { keywords: Set<string>; lineComment: string[]; ci?: boolean }

const JS_KW = ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'import', 'export', 'from', 'default', 'class', 'extends', 'new', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of', 'this', 'super', 'null', 'undefined', 'true', 'false', 'interface', 'type', 'as', 'enum', 'public', 'private', 'protected', 'readonly', 'static', 'void', 'yield', 'delete', 'get', 'set']
const PY_KW = ['def', 'return', 'if', 'elif', 'else', 'for', 'while', 'import', 'from', 'as', 'class', 'try', 'except', 'finally', 'raise', 'with', 'lambda', 'None', 'True', 'False', 'and', 'or', 'not', 'in', 'is', 'pass', 'yield', 'async', 'await', 'global', 'nonlocal', 'assert', 'del']
const CSS_KW = ['important', 'inherit', 'initial', 'unset', 'auto', 'none', 'flex', 'grid', 'block', 'inline']
const GO_KW = ['func', 'package', 'import', 'return', 'if', 'else', 'for', 'range', 'switch', 'case', 'default', 'break', 'continue', 'var', 'const', 'type', 'struct', 'interface', 'map', 'chan', 'go', 'defer', 'select', 'fallthrough', 'goto', 'nil', 'true', 'false', 'iota', 'make', 'new', 'append', 'len', 'cap', 'string', 'int', 'int64', 'int32', 'float64', 'bool', 'byte', 'rune', 'error', 'uint', 'uint64']
const SH_KW = ['if', 'then', 'fi', 'elif', 'else', 'for', 'do', 'done', 'echo', 'export', 'cd', 'function', 'return', 'case', 'esac', 'while', 'until', 'in', 'local', 'set', 'unset', 'source']
const SQL_KW = ['select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete', 'create', 'table', 'alter', 'drop', 'index', 'view', 'join', 'inner', 'left', 'right', 'outer', 'on', 'as', 'and', 'or', 'not', 'null', 'is', 'in', 'like', 'between', 'group', 'by', 'order', 'having', 'limit', 'offset', 'distinct', 'union', 'all', 'primary', 'key', 'foreign', 'references', 'default', 'unique', 'constraint', 'count', 'sum', 'avg', 'min', 'max', 'desc', 'asc']
const YAML_KW = ['true', 'false', 'null', 'yes', 'no']

const LANGS: Record<string, LangCfg> = {
  js: { keywords: new Set(JS_KW), lineComment: ['//'] },
  ts: { keywords: new Set(JS_KW), lineComment: ['//'] },
  tsx: { keywords: new Set(JS_KW), lineComment: ['//'] },
  jsx: { keywords: new Set(JS_KW), lineComment: ['//'] },
  vue: { keywords: new Set(JS_KW), lineComment: ['//'] },
  go: { keywords: new Set(GO_KW), lineComment: ['//'] },
  json: { keywords: new Set(['true', 'false', 'null']), lineComment: [] },
  css: { keywords: new Set(CSS_KW), lineComment: [] },
  html: { keywords: new Set([]), lineComment: [] },
  py: { keywords: new Set(PY_KW), lineComment: ['#'] },
  sh: { keywords: new Set(SH_KW), lineComment: ['#'] },
  sql: { keywords: new Set(SQL_KW), lineComment: ['--'], ci: true },
  yaml: { keywords: new Set(YAML_KW), lineComment: ['#'] },
  md: { keywords: new Set([]), lineComment: [] }
}

// Aliases: gitFile/diff hands us a normalized lang, but callers (and CLI tools)
// may pass full names. Map them to the canonical key in LANGS.
const ALIAS: Record<string, string> = {
  golang: 'go',
  javascript: 'js', mjs: 'js', cjs: 'js',
  typescript: 'ts',
  markdown: 'md',
  python: 'py',
  bash: 'sh', shell: 'sh', zsh: 'sh',
  yml: 'yaml',
  htm: 'html'
}

function resolveLang(lang: string): string {
  const key = (lang || '').toLowerCase()
  return ALIAS[key] ?? key
}

const NUM = /^(?:0[xXbBoO][0-9a-fA-F]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)$/

function tokenizeCode(code: string, cfg: LangCfg): Token[] {
  const out: Token[] = []
  const re = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g
  let last = 0, m: RegExpExecArray | null
  const pushCode = (s: string) => {
    if (!s) return
    let buf = ''
    const flush = () => { if (buf) { out.push({ cls: null, text: buf }); buf = '' } }
    s.replace(/(\w+|\W+)/g, (tok) => {
      if (/^\w+$/.test(tok)) {
        const isKw = cfg.ci ? cfg.keywords.has(tok.toLowerCase()) : cfg.keywords.has(tok)
        if (isKw) { flush(); out.push({ cls: 'kw', text: tok }) }
        else if (NUM.test(tok)) { flush(); out.push({ cls: 'nu', text: tok }) }
        else { buf += tok }
      } else { buf += tok }
      return tok
    })
    flush()
  }
  while ((m = re.exec(code)) !== null) {
    pushCode(code.slice(last, m.index))
    out.push({ cls: 'st', text: m[0] })
    last = m.index + m[0].length
  }
  pushCode(code.slice(last))
  return out
}

export function highlight(line: string, lang: string): Token[] {
  const cfg = LANGS[resolveLang(lang)]
  if (!cfg) return [{ cls: null, text: line }]
  for (const c of cfg.lineComment) {
    const idx = line.indexOf(c)
    if (idx >= 0) {
      const tokens = idx > 0 ? tokenizeCode(line.slice(0, idx), cfg) : []
      tokens.push({ cls: 'cm', text: line.slice(idx) })
      return tokens
    }
  }
  const toks = tokenizeCode(line, cfg)
  return toks.length ? toks : [{ cls: null, text: line }]
}
