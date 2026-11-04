// 模型的 Markdown → Telegram 的 text + entities(07 spec §9.1)。
// 只产出 pre、code、bold 三种,其余逐字;链接不变成 text_link。偏移是 UTF-16 码元,等于 JS 字符串下标。

export interface Entity {
  type: 'pre' | 'code' | 'bold'
  offset: number
  length: number
  language?: string
}

const LANGUAGE = /^[a-z0-9+#-]{1,20}$/
const HEADING = /^#{1,6}[ \t]+(\S.*)$/
const CODE_SPAN = /`([^`\n]+)`/g
// 内容不含 `**`,首尾不是空白:`**a **b** c**` 里外层记号逐字,只有 b 加粗
const BOLD = /\*\*(?!\s)((?:[^*\n]|\*(?!\*))*?[^\s*])\*\*/g

/** 一行里的行内记号;返回去掉记号后的文字和相对偏移的 entity */
function inline(line: string, base: number, out: Entity[]): string {
  let text = ''
  let last = 0
  const emit = (segment: string) => {
    let from = 0
    for (const m of segment.matchAll(BOLD)) {
      text += segment.slice(from, m.index)
      out.push({ type: 'bold', offset: base + text.length, length: m[1]!.length })
      text += m[1]
      from = m.index + m[0].length
    }
    text += segment.slice(from)
  }
  for (const m of line.matchAll(CODE_SPAN)) {
    emit(line.slice(last, m.index))
    out.push({ type: 'code', offset: base + text.length, length: m[1]!.length })
    text += m[1]
    last = m.index + m[0].length
  }
  emit(line.slice(last))
  return text
}

export function toEntities(md: string): { text: string; entities: Entity[] } {
  const entities: Entity[] = []
  let text = ''
  let fence: { start: number; nl: boolean; started: boolean; language?: string } | undefined
  const closeFence = () => {
    if (!fence) return
    const end = text.length
    if (end > fence.start) entities.push({ type: 'pre', offset: fence.start, length: end - fence.start, ...(fence.language && { language: fence.language }) })
    else if (fence.nl) text = text.slice(0, -1) // 空围栏不留空行
    fence = undefined
  }
  const lines = md.split('\n')
  let firstOut = true
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (fence) {
      if (/^```[ \t]*$/.test(line)) {
        closeFence()
        continue
      }
      if (fence.started) text += '\n'
      fence.started = true
      text += line
      continue
    }
    if (line.startsWith('```')) {
      const word = line.slice(3).trim().split(/\s+/)[0] ?? ''
      const nl = !firstOut
      if (nl) text += '\n'
      firstOut = false
      fence = { start: text.length, nl, started: false, ...(LANGUAGE.test(word) && { language: word }) }
      continue
    }
    if (!firstOut) text += '\n'
    firstOut = false
    const h = HEADING.exec(line)
    if (h) {
      const start = text.length
      const piece = inline(h[1]!, start, entities)
      text += piece
      if (piece.length > 0) entities.push({ type: 'bold', offset: start, length: piece.length })
    } else {
      text += inline(line, text.length, entities)
    }
  }
  closeFence()
  entities.sort((a, b) => a.offset - b.offset || b.length - a.length)
  return { text, entities }
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff

/** 在 limit 以内找切点:优先换行之后,不切开代理对 */
function cutAt(text: string, pos: number, limit: number): number {
  let cut = pos + limit
  const nl = text.lastIndexOf('\n', cut - 1)
  if (nl >= pos + (limit >> 1)) return nl + 1
  if (isHigh(text.charCodeAt(cut - 1)) && isLow(text.charCodeAt(cut))) cut--
  return cut
}

/** 切成不超过 max 的块;跨切点的 entity 两边都带,偏移相对各自的块 */
export function splitChunks(text: string, entities: Entity[], max: number): Array<{ text: string; entities: Entity[] }> {
  const out: Array<{ text: string; entities: Entity[] }> = []
  let pos = 0
  while (pos < text.length) {
    const end = text.length - pos <= max ? text.length : cutAt(text, pos, max)
    const part: Entity[] = []
    for (const e of entities) {
      const a = Math.max(e.offset, pos)
      const b = Math.min(e.offset + e.length, end)
      if (b > a) part.push({ ...e, offset: a - pos, length: b - a })
    }
    out.push({ text: text.slice(pos, end), entities: part })
    pos = end
  }
  return out
}

export const MAX_ENTITIES = 100

/** 每条 100 个:先丢 bold,再丢 code,最后才丢 pre */
export function capEntities(entities: Entity[]): Entity[] {
  if (entities.length <= MAX_ENTITIES) return entities
  let kept = entities.filter(e => e.type !== 'bold')
  if (kept.length > MAX_ENTITIES) kept = kept.filter(e => e.type !== 'code')
  return kept.slice(0, MAX_ENTITIES)
}
