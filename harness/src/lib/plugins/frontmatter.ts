// 只认 `---` 包住的 `键: 值`、带引号的值、行内列表、`|` 和 `>` 块(09 spec §5.2)。不是 YAML。
// 解析不了就当没有,正文照用。结果放 Map,键 `__proto__` 也只是个键
export interface Frontmatter {
  fields: Map<string, string | string[]>
  body: string
  ok: boolean
}

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*:(?:[ \t]+(.*))?$/
const BLOCK = /^([|>])([+-]?)[0-9]?([+-]?)$/
const MAX_FIELDS = 200

export function parseFrontmatter(text: string): Frontmatter {
  try {
    return parse(text)
  } catch {
    return { fields: new Map(), body: text, ok: false }
  }
}

function parse(input: string): Frontmatter {
  const src = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  const none: Frontmatter = { fields: new Map(), body: input, ok: false }
  if (!src.startsWith('---')) return none
  // 只扫到第一个结束行为止:没有结束行的大文件不会把每一行都切出来
  const lines: { text: string; end: number }[] = []
  let close = -1
  let at = 0
  while (at < src.length) {
    const nl = src.indexOf('\n', at)
    const end = nl === -1 ? src.length : nl
    const raw = src.slice(at, end)
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    lines.push({ text, end: nl === -1 ? src.length : nl + 1 })
    if (lines.length > 1 && text.trimEnd() === '---') {
      close = lines.length - 1
      break
    }
    if (nl === -1) break
    at = nl + 1
  }
  if (lines[0].text.trimEnd() !== '---' || close === -1) return none
  const header = lines.slice(1, close).map(l => l.text)
  return { fields: parseHeader(header), body: src.slice(lines[close].end), ok: true }
}

function parseHeader(h: string[]): Map<string, string | string[]> {
  const fields = new Map<string, string | string[]>()
  let i = 0
  while (i < h.length && fields.size < MAX_FIELDS) {
    const line = h[i]
    i++
    if (line.trim() === '' || line.startsWith('#')) continue
    const m = KEY_LINE.exec(line)
    if (!m) continue
    const key = m[1]
    const rest = (m[2] ?? '').trim()
    const block = BLOCK.exec(rest)
    if (block) {
      const lines: string[] = []
      while (i < h.length && (h[i].trim() === '' || /^[ \t]/.test(h[i]))) lines.push(h[i++])
      fields.set(key, blockText(block[1] === '>', block[2] || block[3], lines))
    } else if (rest === '') {
      const items: string[] = []
      while (i < h.length) {
        const im = /^[ \t]*-[ \t]+(.*)$/.exec(h[i])
        if (!im) break
        items.push(scalar(im[1].trim()))
        i++
      }
      fields.set(key, items.length > 0 ? items : '')
    } else if (rest.startsWith('[')) {
      const list = inlineList(rest)
      fields.set(key, list ?? plain(rest))
    } else {
      fields.set(key, scalar(rest))
    }
  }
  return fields
}

function blockText(folded: boolean, chomp: string, raw: string[]): string {
  const first = raw.find(l => l.trim() !== '')
  if (first === undefined) return ''
  const indent = /^[ \t]*/.exec(first)![0].length
  const lines = raw.map(l => (l.trim() === '' ? '' : l.slice(Math.min(indent, /^[ \t]*/.exec(l)![0].length))))
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  let text: string
  if (!folded) text = lines.join('\n')
  else {
    text = ''
    for (let k = 0; k < lines.length; k++) {
      if (k > 0) text += lines[k] === '' || lines[k - 1] === '' ? '\n' : ' '
      text += lines[k]
    }
    text = text.replace(/\n{2,}/g, m => m.slice(1))
  }
  return chomp === '-' ? text : text + '\n'
}

function plain(s: string): string {
  return s.replace(/(?:^|[ \t])#.*$/, '').trim()
}

function scalar(s: string): string {
  if (s.startsWith('"')) return unquoteDouble(s) ?? plain(s)
  if (s.startsWith("'")) return unquoteSingle(s) ?? plain(s)
  return plain(s)
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '0': '\0', '"': '"', '\\': '\\', '/': '/' }

function unquoteDouble(s: string): string | null {
  let out = ''
  for (let i = 1; i < s.length; i++) {
    const c = s[i]
    if (c === '"') return out
    if (c !== '\\') {
      out += c
      continue
    }
    const n = s[++i]
    if (n === undefined) return null
    if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 1, i + 5))) {
      out += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16))
      i += 4
    } else out += ESCAPES[n] ?? n
  }
  return null
}

function unquoteSingle(s: string): string | null {
  let out = ''
  for (let i = 1; i < s.length; i++) {
    if (s[i] !== "'") out += s[i]
    else if (s[i + 1] === "'") {
      out += "'"
      i++
    } else return out
  }
  return null
}

function inlineList(s: string): string[] | null {
  const items: string[] = []
  let i = 1
  while (i < s.length) {
    while (s[i] === ' ' || s[i] === '\t') i++
    if (s[i] === ']') return items
    let item: string
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i]
      let j = i + 1
      while (j < s.length && s[j] !== q) j += s[j] === '\\' && q === '"' ? 2 : q === "'" && s[j + 1] === "'" && s[j] === "'" ? 2 : 1
      const un = q === '"' ? unquoteDouble(s.slice(i, j + 1)) : unquoteSingle(s.slice(i, j + 1))
      if (un === null || j >= s.length) return null
      item = un
      i = j + 1
      while (s[i] === ' ' || s[i] === '\t') i++
    } else {
      let j = i
      while (j < s.length && s[j] !== ',' && s[j] !== ']') j++
      if (j >= s.length) return null
      item = s.slice(i, j).trim()
      i = j
    }
    items.push(item)
    if (s[i] === ',') i++
    else if (s[i] !== ']') return null
  }
  return null
}
