// Codex `*** Begin Patch` 格式(spec §7 apply_patch):解析 + 纯函数地算出每个文件的新内容。
// 不碰文件系统;读文件由调用方传入,落盘由调用方做

export interface HunkLine {
  op: ' ' | '-' | '+'
  text: string
}

export interface Hunk {
  /** `@@ xxx` 的 xxx:先在文件里找到这一行,再从它后面找本 hunk */
  context?: string
  lines: HunkLine[]
  /** `*** End of File`:本 hunk 贴着文件末尾 */
  eof?: boolean
}

export type PatchOp =
  | { kind: 'add'; path: string; content: string }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo?: string; hunks: Hunk[] }

const BEGIN = '*** Begin Patch'
const END = '*** End Patch'
const ADD = '*** Add File:'
const DELETE = '*** Delete File:'
const UPDATE = '*** Update File:'
const MOVE = '*** Move to:'
const EOF_MARK = '*** End of File'
const HEREDOC = /^(?:apply_patch\s+)?<<\s*(['"]?)(\w+)\1\s*$/

type Fail = { error: string }

/** 补丁里每个涉及的路径(含 Move 目标),按出现顺序 */
export function patchPaths(ops: PatchOp[]): string[] {
  return ops.flatMap(op => (op.kind === 'update' && op.moveTo !== undefined ? [op.path, op.moveTo] : [op.path]))
}

/** 去掉 CRLF、外层 heredoc(`<<'EOF'` … `EOF`)与首尾空行 → 行数组 */
function unwrap(text: string): string[] {
  let lines = text.replace(/\r\n?/g, '\n').split('\n')
  const trim = () => {
    while (lines.length && lines[0].trim() === '') lines.shift()
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
  }
  trim()
  const m = lines.length ? HEREDOC.exec(lines[0].trim()) : null
  if (m && lines.length >= 2 && lines[lines.length - 1].trim() === m[2]) {
    lines = lines.slice(1, -1)
    trim()
  }
  return lines
}

export function parsePatch(text: string): PatchOp[] | Fail {
  const lines = unwrap(text)
  if (lines[0]?.trim() !== BEGIN) return { error: `补丁必须以 "${BEGIN}" 开头` }
  if (lines.length < 2 || lines[lines.length - 1].trim() !== END) return { error: `补丁必须以 "${END}" 结尾` }
  const ops: PatchOp[] = []
  const at = (i: number) => `第 ${i + 1} 行`
  const pathOf = (line: string, head: string, i: number): string | Fail => {
    const p = line.slice(head.length).trim()
    return p === '' ? { error: `${at(i)}:缺少文件路径` } : p
  }
  const last = lines.length - 1
  let i = 1
  while (i < last) {
    const line = lines[i]
    if (line.startsWith(ADD)) {
      const path = pathOf(line, ADD, i)
      if (typeof path !== 'string') return path
      const body: string[] = []
      for (i++; i < last && !lines[i].startsWith('*** '); i++) {
        if (!lines[i].startsWith('+')) return { error: `${at(i)}:Add File 的内容行必须以 + 开头` }
        body.push(lines[i].slice(1))
      }
      ops.push({ kind: 'add', path, content: body.map(l => l + '\n').join('') })
    } else if (line.startsWith(DELETE)) {
      const path = pathOf(line, DELETE, i)
      if (typeof path !== 'string') return path
      ops.push({ kind: 'delete', path })
      i++
    } else if (line.startsWith(UPDATE)) {
      const path = pathOf(line, UPDATE, i)
      if (typeof path !== 'string') return path
      const op: PatchOp & { kind: 'update' } = { kind: 'update', path, hunks: [] }
      i++
      if (i < last && lines[i].startsWith(MOVE)) {
        const to = pathOf(lines[i], MOVE, i)
        if (typeof to !== 'string') return to
        op.moveTo = to
        i++
      }
      let hunk: Hunk | undefined
      const close = (where: number): Fail | undefined => {
        if (!hunk) return undefined
        if (!hunk.lines.length) return { error: `${at(where)}:${path} 有空的 hunk` }
        op.hunks.push(hunk)
        hunk = undefined
        return undefined
      }
      for (; i < last; i++) {
        const l = lines[i]
        if (l.startsWith('@@')) {
          const bad = close(i)
          if (bad) return bad
          const ctx = l.slice(2).trim()
          hunk = { lines: [], ...(ctx !== '' && { context: ctx }) }
        } else if (l.trim() === EOF_MARK) {
          if (!hunk) return { error: `${at(i)}:${EOF_MARK} 前没有 hunk` }
          hunk.eof = true
          const bad = close(i)
          if (bad) return bad
        } else if (l.startsWith('*** ')) break
        else if (l.trim() === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          hunk ??= { lines: [] } // 第一个 hunk 可以省略 @@
          // 空行、只有空白的行(模型去掉了行尾空白)= 空的上下文行
          const blank = l === '' || (l[0] !== ' ' && l.trim() === '')
          hunk.lines.push(blank ? { op: ' ', text: '' } : { op: l[0] as HunkLine['op'], text: l.slice(1) })
        } else return { error: `${at(i)}:hunk 行必须以空格、-、+ 或 @@ 开头` }
      }
      const bad = close(i)
      if (bad) return bad
      if (!op.hunks.length && op.moveTo === undefined) return { error: `${path}:Update File 没有 hunk` }
      ops.push(op)
    } else return { error: `${at(i)}:不认识的行 "${line.slice(0, 80)}"` }
  }
  if (!ops.length) return { error: '补丁里没有任何文件操作' }
  // 同一路径只能出现一次;唯一的例外:先 Delete 再 Add 同一路径(整体重写)
  const seen = new Map<string, number>()
  ops.forEach(op => patchPaths([op]).forEach(p => seen.set(p, (seen.get(p) ?? 0) + 1)))
  for (const [p, n] of seen) {
    if (n === 1) continue
    const kinds = ops.filter(op => patchPaths([op]).includes(p)).map(op => op.kind)
    if (n !== 2 || kinds[0] !== 'delete' || kinds[1] !== 'add') return { error: `${p} 在补丁里出现了多次;同一文件的改动合并到一个 Update File` }
  }
  return ops
}

/** 依次放宽:精确 → 忽略行尾空白 → 忽略首尾空白 */
const LOOSE: ((s: string) => string)[] = [s => s, s => s.trimEnd(), s => s.trim()]

/** 找到的位置;-1 = 没有;ambiguous = 宽松档有多处候选(猜不出是哪一处) */
type Seek = number | { ambiguous: number }

/**
 * pattern 在 lines 里从 from 起的位置,三档依次试。精确档取第一处;宽松档必须唯一。
 * eof → 只认贴着文件末尾的那一处
 */
function seek(lines: string[], pattern: string[], from: number, eof: boolean): Seek {
  const fits = (at: number, norm: (s: string) => string) => pattern.every((p, k) => norm(lines[at + k]) === norm(p))
  const tail = lines.length - pattern.length
  for (const [tier, norm] of LOOSE.entries()) {
    if (eof) {
      if (tail >= from && fits(tail, norm)) return tail
      continue
    }
    if (tier === 0) {
      for (let at = from; at <= tail; at++) if (fits(at, norm)) return at
      continue
    }
    const hits: number[] = []
    for (let at = from; at <= tail; at++) if (fits(at, norm)) hits.push(at)
    if (hits.length > 1) return { ambiguous: hits.length }
    if (hits.length === 1) return hits[0]
  }
  return -1
}

const ambiguous = (where: string, n: number): Fail => ({ error: `${where}:忽略空白后有 ${n} 处同样匹配,无法确定改哪一处;加 @@ 上下文行或更多上下文使其唯一` })

/** 按 hunk 改一个文件的内容;保留原换行风格与末尾换行状态 */
function applyHunks(path: string, text: string, hunks: Hunk[]): string | Fail {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n'
  const finalNewline = text === '' || text.endsWith('\n')
  const lines = text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/)
  const out: string[] = []
  let cursor = 0
  for (const [n, h] of hunks.entries()) {
    const where = `${path} 的第 ${n + 1} 个 hunk`
    let from = cursor
    if (h.context !== undefined) {
      const c = seek(lines, [h.context], from, false)
      if (typeof c !== 'number') return ambiguous(`${where} 的 @@ 上下文行`, c.ambiguous)
      if (c === -1) return { error: `${where}:找不到 @@ 上下文行 "${h.context}"` }
      from = c + 1
    }
    let hl = h.lines
    const oldOf = () => hl.filter(l => l.op !== '+').map(l => l.text)
    let old = oldOf()
    // 纯新增:跟在 @@ 上下文后面,否则追加到末尾
    const insertAt = h.context !== undefined ? from : lines.length
    let at: Seek = insertAt
    if (old.length) {
      at = seek(lines, old, from, !!h.eof)
      let j = hl.length - 1
      while (hl[j].op === '+') j--
      if (at === -1 && hl[j].text === '') {
        // 旧内容最后一行是空行(多半对应文件末尾的换行,文件里并没有这一行)→ 去掉它再试
        hl = hl.filter((_, k) => k !== j)
        old = oldOf()
        at = old.length ? seek(lines, old, from, !!h.eof) : insertAt
      }
      if (typeof at !== 'number') return ambiguous(where, at.ambiguous)
      if (at === -1) return { error: `${where}:找不到要替换的行(从 "${old[0]}" 开始的 ${old.length} 行${h.eof ? ',且须在文件末尾' : ''})` }
    }
    out.push(...lines.slice(cursor, at))
    // 上下文行保留文件里的原样(宽松匹配时行尾空白不被补丁改掉)
    let k = at
    for (const l of hl) {
      if (l.op === ' ') out.push(lines[k++])
      else if (l.op === '-') k++
      else out.push(l.text)
    }
    cursor = at + old.length
  }
  out.push(...lines.slice(cursor))
  if (!out.length) return ''
  return out.join(eol) + (finalNewline ? eol : '')
}

/**
 * 算出补丁落盘后每个文件的内容(null = 删除)。read 返回 undefined = 文件不存在。
 * 任何一处出错 → { error },调用方什么都不写
 */
export function planPatch(ops: PatchOp[], read: (path: string) => string | undefined): { writes: { path: string; content: string | null }[] } | Fail {
  const writes: { path: string; content: string | null }[] = []
  for (const op of ops) {
    const cur = read(op.path)
    if (op.kind === 'add') {
      // 前面 Delete 过同一路径 → 整体重写:把那条删除换成写入
      const deleted = writes.findIndex(w => w.path === op.path && w.content === null)
      if (deleted !== -1) writes[deleted] = { path: op.path, content: op.content }
      else if (cur !== undefined) return { error: `${op.path} 已存在;改已有文件用 Update File` }
      else writes.push({ path: op.path, content: op.content })
    } else if (cur === undefined) return { error: `${op.path} 不存在` }
    else if (op.kind === 'delete') writes.push({ path: op.path, content: null })
    else {
      const next = applyHunks(op.path, cur, op.hunks)
      if (typeof next !== 'string') return next
      if (op.moveTo !== undefined) {
        if (read(op.moveTo) !== undefined) return { error: `Move 的目标 ${op.moveTo} 已存在` }
        writes.push({ path: op.moveTo, content: next }, { path: op.path, content: null })
      } else writes.push({ path: op.path, content: next })
    }
  }
  return { writes }
}
