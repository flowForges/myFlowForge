// 代码着色的唯一语法表。两个消费方,两种取词方式:
//   1) highlight(line, lang)        —— 逐行。文件预览 / diff 用(每行单独渲染成 .code-line,拿不到上下文)。
//   2) highlightBlock(code, lang)   —— 整块。对话区的 ```围栏``` 代码块用,能跨行处理块注释 / 多行字符串,
//      并多认几类词(函数名 / 类型 / JSON 键 / 运算符 / HTML 标签),配色更接近编辑器主题。
// 语言表只有这一份 —— 两条路径共用,避免关键字两处漂移。

export type TokenClass =
  | 'kw'   // 关键字
  | 'st'   // 字符串
  | 'cm'   // 注释
  | 'nu'   // 数字
  | 'fn'   // 函数名(标识符后面紧跟 `(`)
  | 'ty'   // 类型 / 类(内置类型,或大写开头的标识符)
  | 'pr'   // 键 / 属性(JSON 的 key、YAML/CSS 的 property)
  | 'op'   // 运算符
  | 'tg'   // 标签名(HTML/XML)
  | 'at'   // 属性名(HTML/XML)、注解 / 装饰器
  | 'va'   // 变量($VAR、CSS 自定义属性)

export interface Token { cls: TokenClass | null; text: string }

interface LangCfg {
  keywords: Set<string>
  lineComment: string[]
  /** 块注释定界符(如 C 系的斜杠星号一对)。跨行,只有 highlightBlock 用得上。 */
  block?: [string, string]
  /** 引号种类。缺省 `"` 和 `'`。 */
  quotes?: string[]
  /** 关键字大小写不敏感(SQL)。 */
  ci?: boolean
  /** 内置类型 / 常用类名 → 'ty'。 */
  types?: Set<string>
  /** 标识符或字符串后面紧跟 `:` 时判成键(JSON / YAML / CSS)。 */
  keyColon?: boolean
  /** `$VAR` / `${VAR}` 判成变量(shell)。 */
  dollarVar?: boolean
  /** 标识符里允许连字符(CSS 的 font-size 是一个词,不是三个)。 */
  hyphenIdent?: boolean
  /** 三引号多行字符串(Python)。 */
  tripleQuote?: boolean
  /** 大写开头的标识符判成类型(C 系 / Go / Python 的类名约定;SQL、shell 这类不适用)。 */
  capIsType?: boolean
  /** 标记语言模式:走 tokenizeMarkup(标签 / 属性 / <!-- -->),不走通用扫描器。 */
  markup?: boolean
}

const JS_KW = ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'import', 'export', 'from', 'default', 'class', 'extends', 'new', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of', 'this', 'super', 'null', 'undefined', 'true', 'false', 'interface', 'type', 'as', 'enum', 'public', 'private', 'protected', 'readonly', 'static', 'void', 'yield', 'delete', 'get', 'set']
const JS_TY = ['string', 'number', 'boolean', 'object', 'symbol', 'bigint', 'any', 'unknown', 'never', 'Array', 'Promise', 'Record', 'Map', 'Set', 'Date', 'Error', 'JSON', 'Math', 'Object', 'String', 'Number', 'Boolean', 'RegExp', 'console', 'window', 'document']
const PY_KW = ['def', 'return', 'if', 'elif', 'else', 'for', 'while', 'import', 'from', 'as', 'class', 'try', 'except', 'finally', 'raise', 'with', 'lambda', 'None', 'True', 'False', 'and', 'or', 'not', 'in', 'is', 'pass', 'yield', 'async', 'await', 'global', 'nonlocal', 'assert', 'del', 'match', 'case']
const PY_TY = ['int', 'str', 'float', 'bool', 'list', 'dict', 'set', 'tuple', 'bytes', 'self', 'cls', 'print', 'len', 'range', 'open', 'super']
const CSS_KW = ['important', 'inherit', 'initial', 'unset', 'auto', 'none', 'flex', 'grid', 'block', 'inline']
const GO_KW = ['func', 'package', 'import', 'return', 'if', 'else', 'for', 'range', 'switch', 'case', 'default', 'break', 'continue', 'var', 'const', 'type', 'struct', 'interface', 'map', 'chan', 'go', 'defer', 'select', 'fallthrough', 'goto', 'nil', 'true', 'false', 'iota']
const GO_TY = ['string', 'int', 'int8', 'int16', 'int32', 'int64', 'float32', 'float64', 'bool', 'byte', 'rune', 'error', 'uint', 'uint8', 'uint32', 'uint64', 'any', 'make', 'new', 'append', 'len', 'cap', 'copy', 'delete', 'panic', 'recover', 'print', 'println']
const SH_KW = ['if', 'then', 'fi', 'elif', 'else', 'for', 'do', 'done', 'echo', 'export', 'cd', 'function', 'return', 'case', 'esac', 'while', 'until', 'in', 'local', 'set', 'unset', 'source', 'exit', 'read', 'shift', 'trap']
const SQL_KW = ['select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete', 'create', 'table', 'alter', 'drop', 'index', 'view', 'join', 'inner', 'left', 'right', 'outer', 'full', 'cross', 'on', 'as', 'and', 'or', 'not', 'null', 'is', 'in', 'like', 'ilike', 'between', 'exists', 'group', 'by', 'order', 'having', 'limit', 'offset', 'distinct', 'union', 'intersect', 'except', 'all', 'primary', 'key', 'foreign', 'references', 'default', 'unique', 'constraint', 'desc', 'asc', 'with', 'case', 'when', 'then', 'else', 'end', 'begin', 'commit', 'rollback', 'transaction', 'add', 'column', 'if', 'cascade', 'using', 'returning']
const SQL_TY = ['count', 'sum', 'avg', 'min', 'max', 'coalesce', 'cast', 'now', 'int', 'integer', 'bigint', 'smallint', 'serial', 'varchar', 'text', 'char', 'boolean', 'date', 'time', 'timestamp', 'timestamptz', 'numeric', 'decimal', 'real', 'json', 'jsonb', 'uuid']
const YAML_KW = ['true', 'false', 'null', 'yes', 'no', 'on', 'off']
const JAVA_KW = ['public', 'private', 'protected', 'class', 'interface', 'enum', 'extends', 'implements', 'static', 'final', 'abstract', 'synchronized', 'native', 'transient', 'volatile', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'new', 'this', 'super', 'try', 'catch', 'finally', 'throw', 'throws', 'import', 'package', 'instanceof', 'null', 'true', 'false', 'var', 'record', 'sealed', 'yield']
const JAVA_TY = ['int', 'long', 'short', 'byte', 'char', 'float', 'double', 'boolean', 'void', 'String', 'Integer', 'Long', 'Double', 'Boolean', 'Object', 'List', 'Map', 'Set', 'Optional', 'System']
const RUST_KW = ['fn', 'let', 'mut', 'const', 'static', 'struct', 'enum', 'trait', 'impl', 'for', 'while', 'loop', 'if', 'else', 'match', 'return', 'use', 'mod', 'pub', 'crate', 'self', 'super', 'as', 'where', 'move', 'ref', 'dyn', 'async', 'await', 'unsafe', 'extern', 'type', 'in', 'break', 'continue', 'true', 'false']
const RUST_TY = ['i8', 'i16', 'i32', 'i64', 'i128', 'u8', 'u16', 'u32', 'u64', 'u128', 'usize', 'isize', 'f32', 'f64', 'bool', 'char', 'str', 'String', 'Vec', 'Option', 'Result', 'Box', 'Rc', 'Arc', 'HashMap', 'Some', 'None', 'Ok', 'Err']
const C_KW = ['auto', 'break', 'case', 'const', 'continue', 'default', 'do', 'else', 'enum', 'extern', 'for', 'goto', 'if', 'inline', 'register', 'return', 'sizeof', 'static', 'struct', 'switch', 'typedef', 'union', 'volatile', 'while', 'class', 'public', 'private', 'protected', 'virtual', 'template', 'typename', 'namespace', 'using', 'new', 'delete', 'this', 'try', 'catch', 'throw', 'nullptr', 'true', 'false', 'constexpr', 'override', 'final']
const C_TY = ['int', 'char', 'short', 'long', 'float', 'double', 'void', 'unsigned', 'signed', 'bool', 'size_t', 'string', 'vector', 'map', 'auto_ptr', 'shared_ptr', 'unique_ptr']
const RB_KW = ['def', 'end', 'class', 'module', 'if', 'elsif', 'else', 'unless', 'while', 'until', 'for', 'in', 'do', 'then', 'begin', 'rescue', 'ensure', 'raise', 'return', 'yield', 'require', 'require_relative', 'attr_accessor', 'attr_reader', 'attr_writer', 'self', 'nil', 'true', 'false', 'and', 'or', 'not', 'case', 'when', 'lambda', 'proc']
const PHP_KW = ['function', 'return', 'if', 'else', 'elseif', 'foreach', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'class', 'interface', 'trait', 'extends', 'implements', 'public', 'private', 'protected', 'static', 'final', 'abstract', 'new', 'echo', 'print', 'require', 'require_once', 'include', 'include_once', 'namespace', 'use', 'try', 'catch', 'finally', 'throw', 'null', 'true', 'false', 'array', 'const', 'global', 'fn', 'match']
const SWIFT_KW = ['func', 'let', 'var', 'class', 'struct', 'enum', 'protocol', 'extension', 'if', 'else', 'guard', 'for', 'in', 'while', 'repeat', 'switch', 'case', 'default', 'return', 'import', 'init', 'deinit', 'self', 'super', 'nil', 'true', 'false', 'try', 'catch', 'throw', 'throws', 'defer', 'where', 'private', 'public', 'internal', 'fileprivate', 'open', 'static', 'lazy', 'weak', 'unowned', 'async', 'await']
const KT_KW = ['fun', 'val', 'var', 'class', 'object', 'interface', 'data', 'sealed', 'enum', 'if', 'else', 'when', 'for', 'while', 'do', 'return', 'import', 'package', 'private', 'public', 'internal', 'protected', 'override', 'open', 'abstract', 'suspend', 'companion', 'init', 'this', 'super', 'null', 'true', 'false', 'try', 'catch', 'finally', 'throw', 'is', 'as', 'in', 'by', 'lateinit']
const DOCKER_KW = ['from', 'run', 'cmd', 'label', 'expose', 'env', 'add', 'copy', 'entrypoint', 'volume', 'user', 'workdir', 'arg', 'onbuild', 'stopsignal', 'healthcheck', 'shell', 'as']

const s = (a: string[]): Set<string> => new Set(a)

const LANGS: Record<string, LangCfg> = {
  js: { keywords: s(JS_KW), types: s(JS_TY), lineComment: ['//'], block: ['/*', '*/'], quotes: ['"', "'", '`'], capIsType: true },
  ts: { keywords: s(JS_KW), types: s(JS_TY), lineComment: ['//'], block: ['/*', '*/'], quotes: ['"', "'", '`'], capIsType: true },
  tsx: { keywords: s(JS_KW), types: s(JS_TY), lineComment: ['//'], block: ['/*', '*/'], quotes: ['"', "'", '`'], capIsType: true },
  jsx: { keywords: s(JS_KW), types: s(JS_TY), lineComment: ['//'], block: ['/*', '*/'], quotes: ['"', "'", '`'], capIsType: true },
  vue: { keywords: s(JS_KW), types: s(JS_TY), lineComment: ['//'], block: ['/*', '*/'], quotes: ['"', "'", '`'], capIsType: true },
  go: { keywords: s(GO_KW), types: s(GO_TY), lineComment: ['//'], block: ['/*', '*/'], quotes: ['"', "'", '`'], capIsType: true },
  rs: { keywords: s(RUST_KW), types: s(RUST_TY), lineComment: ['//'], block: ['/*', '*/'], capIsType: true },
  java: { keywords: s(JAVA_KW), types: s(JAVA_TY), lineComment: ['//'], block: ['/*', '*/'], capIsType: true },
  kt: { keywords: s(KT_KW), types: s(JAVA_TY), lineComment: ['//'], block: ['/*', '*/'], quotes: ['"', "'"], capIsType: true },
  swift: { keywords: s(SWIFT_KW), types: s(JS_TY), lineComment: ['//'], block: ['/*', '*/'], capIsType: true },
  cs: { keywords: s([...C_KW, 'async', 'await', 'var', 'string', 'foreach', 'in', 'get', 'set']), types: s(JAVA_TY), lineComment: ['//'], block: ['/*', '*/'], capIsType: true },
  c: { keywords: s(C_KW), types: s(C_TY), lineComment: ['//'], block: ['/*', '*/'], capIsType: true },
  cpp: { keywords: s(C_KW), types: s(C_TY), lineComment: ['//'], block: ['/*', '*/'], capIsType: true },
  php: { keywords: s(PHP_KW), types: s(JS_TY), lineComment: ['//', '#'], block: ['/*', '*/'], dollarVar: true },
  rb: { keywords: s(RB_KW), types: s(PY_TY), lineComment: ['#'], quotes: ['"', "'"], capIsType: true },
  json: { keywords: s(['true', 'false', 'null']), lineComment: [], keyColon: true },
  css: { keywords: s(CSS_KW), lineComment: [], block: ['/*', '*/'], keyColon: true, hyphenIdent: true },
  py: { keywords: s(PY_KW), types: s(PY_TY), lineComment: ['#'], quotes: ['"', "'"], tripleQuote: true, capIsType: true },
  sh: { keywords: s(SH_KW), lineComment: ['#'], quotes: ['"', "'"], dollarVar: true },
  sql: { keywords: s(SQL_KW), types: s(SQL_TY), lineComment: ['--'], block: ['/*', '*/'], quotes: ["'", '"'], ci: true },
  yaml: { keywords: s(YAML_KW), lineComment: ['#'], quotes: ['"', "'"], keyColon: true, hyphenIdent: true },
  toml: { keywords: s(['true', 'false']), lineComment: ['#'], quotes: ['"', "'"], keyColon: true, hyphenIdent: true },
  ini: { keywords: s(['true', 'false']), lineComment: ['#', ';'], quotes: ['"', "'"], keyColon: true, hyphenIdent: true },
  dockerfile: { keywords: s(DOCKER_KW), lineComment: ['#'], quotes: ['"', "'"], ci: true, dollarVar: true },
  html: { keywords: s([]), lineComment: [], markup: true },
  xml: { keywords: s([]), lineComment: [], markup: true },
  md: { keywords: s([]), lineComment: [] },
}

// 未登记的语言:仍然认字符串 / 数字 / C 系与 # 注释,总比整块一色好看。只有【完全没写语言】的围栏才不着色
// —— 那种块经常是日志 / 纯文本输出,乱上色反而干扰。
const GENERIC: LangCfg = { keywords: s([]), lineComment: ['//', '#'], block: ['/*', '*/'], quotes: ['"', "'", '`'] }

// Aliases: gitFile/diff hands us a normalized lang, but callers (and CLI tools)
// may pass full names. Map them to the canonical key in LANGS.
const ALIAS: Record<string, string> = {
  golang: 'go',
  javascript: 'js', mjs: 'js', cjs: 'js', node: 'js',
  typescript: 'ts',
  markdown: 'md',
  python: 'py', py3: 'py', python3: 'py',
  bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', terminal: 'sh',
  yml: 'yaml',
  htm: 'html', svg: 'xml',
  rust: 'rs',
  kotlin: 'kt',
  'c++': 'cpp', cxx: 'cpp', cc: 'cpp', h: 'c', hpp: 'cpp',
  csharp: 'cs', 'c#': 'cs',
  ruby: 'rb',
  scss: 'css', less: 'css', sass: 'css',
  postgres: 'sql', postgresql: 'sql', mysql: 'sql', sqlite: 'sql', plsql: 'sql',
  docker: 'dockerfile',
  jsonc: 'json', json5: 'json',
  conf: 'ini', cfg: 'ini', properties: 'ini', env: 'ini',
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
  const pushCode = (str: string) => {
    if (!str) return
    let buf = ''
    const flush = () => { if (buf) { out.push({ cls: null, text: buf }); buf = '' } }
    str.replace(/(\w+|\W+)/g, (tok) => {
      if (/^\w+$/.test(tok)) {
        // 逐行模式只有 .kw/.st/.cm/.nu 四个色位(见 inspector.css 的 .code-line),所以内置类型也算 kw ——
        // 拆出 types 是为了整块模式能单独上色,不该让 diff 视图里的 `int` / `string` 反而掉色。
        const w = cfg.ci ? tok.toLowerCase() : tok
        const isKw = cfg.keywords.has(w) || !!cfg.types?.has(w)
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

/** 逐行着色(文件预览 / diff)。行内看不到跨行结构,所以只认关键字 / 字符串 / 行注释 / 数字。 */
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

// ---------------------------------------------------------------------------
// 整块着色(对话区代码块)
// ---------------------------------------------------------------------------

/** 超过这个长度就不着色 —— 一个几万字符的块切成上万个 <span> 不值当,直接给纯文本。 */
export const HIGHLIGHT_MAX = 60_000

const IDENT_START = /[A-Za-z_$@]/
const OPERATOR = /[=+\-*/%<>!&|^~?:]/

/** 从 `from` 起跳过空白,返回下一个非空白字符(到头了返回 '')。 */
function peekNonSpace(code: string, from: number): string {
  let i = from
  while (i < code.length && (code[i] === ' ' || code[i] === '\t')) i++
  return code[i] ?? ''
}

/**
 * 整块着色。返回的 token 首尾拼起来必须与入参逐字符相等(测试守这条不变量)——
 * 渲染方直接把每个 token 包成 <span class="t-xx">,少一个字符就是丢代码。
 */
export function highlightBlock(code: string, lang?: string): Token[] {
  if (!lang || !lang.trim()) return [{ cls: null, text: code }]
  if (code.length > HIGHLIGHT_MAX) return [{ cls: null, text: code }]
  const cfg = LANGS[resolveLang(lang)] ?? GENERIC
  if (cfg.markup) return tokenizeMarkup(code)

  const out: Token[] = []
  let buf = ''
  const flush = (): void => { if (buf) { out.push({ cls: null, text: buf }); buf = '' } }
  const push = (cls: TokenClass, text: string): void => { flush(); out.push({ cls, text }) }
  const quotes = cfg.quotes ?? ['"', "'"]
  const n = code.length
  let i = 0
  // 行首标记:YAML / INI / TOML 的键只在行首那一段成立,行中间的 `a: b` 不该当键。
  let atLineStart = true

  while (i < n) {
    const ch = code[i]

    // 块注释(跨行)。未闭合就吃到结尾 —— 流式输出里半截的 /* 很常见。
    if (cfg.block && code.startsWith(cfg.block[0], i)) {
      const end = code.indexOf(cfg.block[1], i + cfg.block[0].length)
      const stop = end < 0 ? n : end + cfg.block[1].length
      push('cm', code.slice(i, stop)); i = stop; atLineStart = false; continue
    }
    // 行注释。SQL 的 `--` 要排在运算符之前,否则先被 `-` 吃掉。
    const lc = cfg.lineComment.find(c => code.startsWith(c, i))
    if (lc) {
      const nl = code.indexOf('\n', i)
      const stop = nl < 0 ? n : nl
      push('cm', code.slice(i, stop)); i = stop; atLineStart = false; continue
    }
    // Python 三引号字符串(docstring)——必须排在普通引号之前。
    if (cfg.tripleQuote && (code.startsWith('"""', i) || code.startsWith("'''", i))) {
      const q = code.slice(i, i + 3)
      const end = code.indexOf(q, i + 3)
      const stop = end < 0 ? n : end + 3
      push('st', code.slice(i, stop)); i = stop; atLineStart = false; continue
    }
    // 字符串。反引号(模板串)允许跨行,其余遇换行即收 —— 单个未配对的引号不该把后面整段代码染成字符串。
    if (quotes.includes(ch)) {
      let j = i + 1
      while (j < n) {
        if (code[j] === '\\') { j += 2; continue }
        if (code[j] === ch) { j++; break }
        if (code[j] === '\n' && ch !== '`') break
        j++
      }
      const text = code.slice(i, j)
      push(cfg.keyColon && peekNonSpace(code, j) === ':' ? 'pr' : 'st', text)
      i = j; atLineStart = false; continue
    }
    // shell / PHP 变量
    if (cfg.dollarVar && ch === '$') {
      const m = /^\$\{[^}]*\}|^\$[A-Za-z_][\w]*|^\$[@*#?!$0-9]/.exec(code.slice(i))
      if (m) { push('va', m[0]); i += m[0].length; atLineStart = false; continue }
    }
    // CSS 自定义属性 / 变量:--accent
    if (cfg.hyphenIdent && ch === '-' && code[i + 1] === '-') {
      const m = /^--[\w-]+/.exec(code.slice(i))
      if (m) { push('va', m[0]); i += m[0].length; atLineStart = false; continue }
    }
    // 数字(含 CSS 单位 12px / 1.5rem / #hex 颜色)
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(code[i + 1] ?? ''))) {
      const m = /^(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)[A-Za-z%]*/.exec(code.slice(i))
      if (m) { push('nu', m[0]); i += m[0].length; atLineStart = false; continue }
    }
    if (ch === '#' && cfg.hyphenIdent) {
      const m = /^#[0-9a-fA-F]{3,8}\b/.exec(code.slice(i))
      if (m) { push('nu', m[0]); i += m[0].length; atLineStart = false; continue }
    }
    // 标识符
    if (IDENT_START.test(ch)) {
      const identRe = cfg.hyphenIdent ? /^[@]?[A-Za-z_$][\w$-]*/ : /^[@]?[A-Za-z_$][\w$]*/
      const m = identRe.exec(code.slice(i))
      if (m) {
        const w = m[0]
        const next = peekNonSpace(code, i + w.length)
        let cls: TokenClass | null
        if (cfg.keywords.has(cfg.ci ? w.toLowerCase() : w)) cls = 'kw'
        else if (w.startsWith('@')) cls = 'at'                       // 装饰器 / CSS at-rule
        else if (cfg.types?.has(cfg.ci ? w.toLowerCase() : w)) cls = 'ty'
        else if (next === '(') cls = 'fn'
        else if (cfg.keyColon && next === ':') cls = 'pr'
        else if (cfg.capIsType && /^[A-Z]/.test(w)) cls = 'ty'
        else cls = null
        if (cls) push(cls, w); else buf += w
        i += w.length; atLineStart = false; continue
      }
    }
    // 运算符
    if (OPERATOR.test(ch)) {
      let j = i
      while (j < n && OPERATOR.test(code[j])) j++
      push('op', code.slice(i, j)); i = j; atLineStart = false; continue
    }
    if (ch === '\n') atLineStart = true
    else if (ch !== ' ' && ch !== '\t') atLineStart = false
    buf += ch
    i++
  }
  flush()
  return out
}

/** HTML / XML:标签名 / 属性名 / 属性值 / 注释。正文原样。 */
function tokenizeMarkup(code: string): Token[] {
  const out: Token[] = []
  let buf = ''
  const flush = (): void => { if (buf) { out.push({ cls: null, text: buf }); buf = '' } }
  const push = (cls: TokenClass, text: string): void => { flush(); out.push({ cls, text }) }
  const n = code.length
  let i = 0
  while (i < n) {
    if (code.startsWith('<!--', i)) {
      const end = code.indexOf('-->', i)
      const stop = end < 0 ? n : end + 3
      push('cm', code.slice(i, stop)); i = stop; continue
    }
    const open = /^<\/?[A-Za-z][\w:-]*/.exec(code.slice(i))
    if (open) {
      // `<` / `</` 当普通字符,标签名单独上色
      const lead = open[0].startsWith('</') ? 2 : 1
      buf += open[0].slice(0, lead)
      push('tg', open[0].slice(lead))
      i += open[0].length
      // 标签内部:属性名 = 属性值
      while (i < n && code[i] !== '>') {
        const attr = /^[\s]*([A-Za-z_:@#][\w:.-]*)/.exec(code.slice(i))
        if (attr) {
          buf += attr[0].slice(0, attr[0].length - attr[1].length)
          push('at', attr[1])
          i += attr[0].length
          continue
        }
        const q = code[i]
        if (q === '"' || q === "'") {
          let j = i + 1
          while (j < n && code[j] !== q) j++
          push('st', code.slice(i, Math.min(j + 1, n)))
          i = Math.min(j + 1, n)
          continue
        }
        buf += code[i]; i++
      }
      continue
    }
    buf += code[i]; i++
  }
  flush()
  return out
}
