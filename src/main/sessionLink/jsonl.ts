import { open, type FileHandle } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { ExtCursor, ExtRead, ExtTurn, LineParser } from './types'

// 外部 JSONL 记录的增量读取:从游标处按块流式读(不整文件读进内存),只消费以 `\n` 结尾的整行,
// 写到一半的末行留到下次。游标对不上(截断/改写)→ 从头重读并 reset:true。

/** offsets: also return the byte offset of the line each turn came from (ExtRead.offsets, parallel to turns). */
export interface ReadOpts { chunkSize?: number; offsets?: boolean }
const DEFAULT_CHUNK = 1 << 20
const TAIL_SCAN_CAP = 16 << 20   // 往回找结束标记最多看这么多字节,找不到就当"没结束"
const NL = 0x0a

const fingerprint = (line: Buffer): string => `${line.length}:${createHash('sha1').update(line).digest('hex').slice(0, 16)}`

async function readAt(fh: FileHandle, pos: number, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(len)
  let got = 0
  while (got < len) {
    const { bytesRead } = await fh.read(buf, got, len - got, pos + got)
    if (!bytesRead) break
    got += bytesRead
  }
  return got === len ? buf : buf.subarray(0, got)
}

/** 游标仍指向同一份内容的行尾?有 lastId 就核对上一行指纹,否则至少要落在行边界上。 */
async function cursorValid(fh: FileHandle, size: number, from: ExtCursor): Promise<boolean> {
  const off = from.offset
  if (!Number.isInteger(off) || off < 0 || off > size) return false
  if (off === 0) return true
  const m = from.lastId ? /^(\d+):([0-9a-f]+)$/.exec(from.lastId) : null
  if (!m) return (await readAt(fh, off - 1, 1))[0] === NL
  const len = Number(m[1])
  const lineStart = off - 1 - len
  if (lineStart < 0) return false
  const pre = lineStart > 0 ? 1 : 0
  const buf = await readAt(fh, lineStart - pre, len + 1 + pre)
  if (buf.length !== len + 1 + pre || buf[buf.length - 1] !== NL || (pre && buf[0] !== NL)) return false
  return fingerprint(buf.subarray(pre, pre + len)) === from.lastId
}

function parseLine(buf: Buffer): unknown {
  if (!buf.length) return undefined
  try { return JSON.parse(buf.toString('utf8')) } catch { return undefined }
}

/** 从 end(行边界,end-1 处是 `\n`)往回找最后一条与轮次状态有关的记录。 */
async function tailEnd(fh: FileHandle, end: number, parse: LineParser, chunk: number): Promise<boolean | undefined> {
  const judge = (line: Buffer): boolean | undefined => {
    const o = parseLine(line)
    return o && typeof o === 'object' ? safeParse(parse, o, 0).end : undefined
  }
  let pos = end
  let carry: Buffer = Buffer.alloc(0)   // 上一块最前面那段不完整的行(含其结尾 `\n`)
  while (pos > 0 && end - pos < TAIL_SCAN_CAP) {
    const n = Math.min(chunk, pos)
    pos -= n
    const buf = Buffer.concat([await readAt(fh, pos, n), carry])   // 总以 `\n` 结尾
    let stop = buf.length - 1
    // 注意 lastIndexOf 的负 offset 是从尾部算,stop 为 0 时必须停
    for (let i = stop > 0 ? buf.lastIndexOf(NL, stop - 1) : -1; i >= 0; i = stop > 0 ? buf.lastIndexOf(NL, stop - 1) : -1) {
      const e = judge(buf.subarray(i + 1, stop))
      if (e !== undefined) return e
      stop = i
    }
    carry = buf.subarray(0, stop + 1)
  }
  return pos === 0 && carry.length > 1 ? judge(carry.subarray(0, carry.length - 1)) : undefined
}

function safeParse(parse: LineParser, o: unknown, off: number) {
  try { return parse(o, off) } catch { return { turns: [] as ExtTurn[] } }
}

export async function readJsonl(file: string, from: ExtCursor, parse: LineParser, opts: ReadOpts = {}): Promise<ExtRead> {
  const chunk = Math.max(1, opts.chunkSize ?? DEFAULT_CHUNK)
  let fh: FileHandle
  try { fh = await open(file, 'r') } catch {
    return { turns: [], next: { offset: 0 }, reset: from.offset > 0, endedCleanly: false, exists: false }
  }
  try {
    const size = (await fh.stat()).size
    const reset = !(await cursorValid(fh, size, from))
    const start = reset ? 0 : from.offset
    const turns: ExtTurn[] = []
    const offsets: number[] | undefined = opts.offsets ? [] : undefined
    let cwd: string | undefined
    let end: boolean | undefined
    let consumed = start
    let lastId = reset ? undefined : (start > 0 ? from.lastId : undefined)
    let pending: Buffer[] = []        // 当前行已读到、还没遇到 `\n` 的部分
    let pendingLen = 0
    let pos = start
    while (pos < size) {
      const buf = await readAt(fh, pos, Math.min(chunk, size - pos))
      if (!buf.length) break
      let s = 0
      for (let i = buf.indexOf(NL); i >= 0; i = buf.indexOf(NL, s)) {
        const piece = buf.subarray(s, i)
        const line = pendingLen ? Buffer.concat([...pending, piece]) : piece
        const lineOff = consumed
        pending = []; pendingLen = 0
        consumed = lineOff + line.length + 1
        lastId = fingerprint(line)
        s = i + 1
        const o = parseLine(line)
        if (!o || typeof o !== 'object') continue
        const info = safeParse(parse, o, lineOff)
        turns.push(...info.turns)
        if (offsets) for (let k = 0; k < info.turns.length; k++) offsets.push(lineOff)
        if (info.cwd) cwd = info.cwd
        if (info.end !== undefined) end = info.end
      }
      if (s < buf.length) { const rest = buf.subarray(s); pending.push(Buffer.from(rest)); pendingLen += rest.length }
      pos += buf.length
    }
    const partial = pendingLen > 0
    if (end === undefined && !partial && consumed > 0) end = await tailEnd(fh, start, parse, chunk)
    const endedCleanly = !partial && end === true
    return { turns, next: lastId ? { offset: consumed, lastId } : { offset: consumed }, reset, endedCleanly, cwd, exists: true, ...(offsets ? { offsets } : {}) }
  } finally {
    await fh.close().catch(() => {})
  }
}
