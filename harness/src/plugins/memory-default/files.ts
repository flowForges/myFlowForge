// Markdown 是记忆的准绳(06 spec §5):条目一行,来源放行尾注释;notes 只是它的索引,可重建。
// 文件里的原文和索引、注入看到的打码版可以不同:用户手写的不改,但不让它往外走
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Logger } from '../../kernel/log'
import { RpcError } from '../../kernel/rpcError'
import { scanInjection } from '../../lib/memory/scan'
import { scrub } from '../../lib/memory/scrub'
import { sanitizeLine } from '../../lib/memory/wrap'
import { cleanText } from '../../lib/tools/diagnostics'
import type { KernelEvent } from '../../protocol/events'
import { ERR_BUSY, MemoryFileSchema } from '../../protocol/rpc'
import type { Store } from './store'

export const CAPS = { 'USER.md': 2000, 'MEMORY.md': 6000, topic: 8000 } as const

const INVALID_PARAMS = -32602
const CORE = ['USER.md', 'MEMORY.md']
const DIARY_NAME = /^\d{4}-\d{2}-\d{2}\.md$/
const ARCHIVE_NAME = /^(?:USER|MEMORY|[a-z0-9-]{1,40})\.md$/
const ID = /^[A-Za-z0-9_-]{1,64}$/
const SRC = /^[a-z_]{1,32}$/
const EVIDENCE = /^[A-Za-z0-9_.:-]{1,64}$/
const HEADING = /^\s{0,3}#{1,6}(?:\s|$)/
const BULLET = /^\s*[-*+]\s+/
const SUBDIRS = ['topics', 'diary', 'archive']
/** 用户确认过的、自己写的:超上限时最后才截 */
const CONFIRMED = new Set(['user', 'confirmed'])
/** stat 的占位:符号链接之类,按没有这个文件处理 */
const REFUSED = 'refused'
const CUT_NAMED = 3
const CUT_WORDS = 24

export interface Entry {
  id: string
  text: string
  src: string
  ts?: number
  evidence: string[]
  turn?: string
  /** 夜间候选:同一候选的日记行跟着一起删 */
  candidate?: string
  /** 进了 archive 才有:被谁取代 */
  by?: string
  line: number
}

export interface EntryMeta {
  id?: string
  src: string
  ts?: number
  evidence?: string[]
  turnId?: string
  candidate?: string
}

type Provenance = Omit<Entry, 'text' | 'line'>

export interface MemoryFilesOpts {
  now(): number
  log: Pick<Logger, 'warn'>
  append(e: Omit<KernelEvent, 'seq' | 'ts'>): unknown
  /** 测试用:临时文件写好之后、改名之前 */
  beforeRename?(from: string, to: string): void
}

/** 和 memory_write 的 text 一样 */
const SESSION_NOTE_MAX = 2000
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const chars = (s: string) => [...s].length

function decode(v: string): string | undefined {
  try {
    return decodeURIComponent(v)
  } catch {
    return undefined
  }
}

/** 只认行尾那一个注释,手工切开而不用正则:一行再长也是线性的 */
function trailingComment(line: string): { at: number; provenance: Provenance } | undefined {
  const at = line.lastIndexOf('<!--')
  if (at < 0) return undefined
  const tail = line.slice(at).trimEnd()
  if (!tail.endsWith('-->')) return undefined
  const [tag, ...attrs] = tail.slice(4, -3).trim().split(/\s+/)
  if (tag !== 'mff') return undefined
  const kv = new Map(attrs.filter(a => a.includes('=')).map(a => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]))
  const id = kv.get('id')
  const src = kv.get('src')
  if (!id || !src || !ID.test(id) || !SRC.test(src)) return undefined
  const ts = Number(kv.get('ts'))
  const candidate = kv.get('cand')
  const by = kv.get('by')
  const turn = decode(kv.get('turn') ?? '')
  return {
    at,
    provenance: {
      id,
      src,
      ...(Number.isSafeInteger(ts) && ts > 0 && { ts }),
      evidence: (kv.get('ev') ?? '').split(',').filter(e => EVIDENCE.test(e)),
      ...(turn && { turn }),
      ...(candidate && ID.test(candidate) && { candidate }),
      ...(by && ID.test(by) && { by }),
    },
  }
}

/** 手写行的 id 取打码后文本的哈希:不从密钥派生,打码前后 id 也不变 */
const handId = (text: string) => `h_${sha256(scrub(text).text).slice(0, 12)}`

export function parseEntries(md: string): Entry[] {
  const entries: Entry[] = []
  md.split('\n').forEach((raw, line) => {
    if (raw.trim() === '' || HEADING.test(raw)) return
    const comment = trailingComment(raw)
    const text = (comment ? raw.slice(0, comment.at) : raw).replace(BULLET, '').trim()
    if (text === '') return
    entries.push({ ...(comment?.provenance ?? { id: handId(text), src: 'user', evidence: [] }), text, line })
  })
  return entries
}

function stripComment(line: string): string {
  const comment = trailingComment(line)
  return (comment ? line.slice(0, comment.at) : line).trimEnd()
}

/** 去掉来源注释的内容:版本和上限都按这个算 */
const visible = (md: string) => md.split('\n').map(stripComment).join('\n').trim()

/**
 * 手改超上限时的注入内容:整行地留,先留用户确认的和手写的,再按文件顺序放别的,放不下的跳过。
 * 留下的仍按文件顺序。标题和空行没有来源,算在后一批
 */
function fitBlock(scrubbed: string, cap: number): { text: string; cut: string[] } {
  const text = visible(scrubbed)
  if (chars(text) <= cap) return { text, cut: [] }
  const srcs = new Map(parseEntries(scrubbed).map(e => [e.line, e.src]))
  const all = scrubbed.split('\n').map((raw, i) => ({ i, line: stripComment(raw), first: CONFIRMED.has(srcs.get(i) ?? '') }))
  const kept = new Set<number>()
  let room = cap + 1 // 每行连换行算,最后一行不用换行
  for (const { i, line } of [...all.filter(l => l.first), ...all.filter(l => !l.first)]) {
    const n = chars(line) + 1
    if (n > room) continue
    kept.add(i)
    room -= n
  }
  return {
    text: all.filter(l => kept.has(l.i)).map(l => l.line).join('\n').trim(),
    cut: all.filter(l => !kept.has(l.i) && l.line.trim() !== '').map(l => l.line),
  }
}

/** 给 memory.health:截了几行、各是什么开头。文本已打码,单行,有界 */
function describeCut(cut: string[]): string {
  const named = cut.slice(0, CUT_NAMED).map(line => {
    const words = line.replace(BULLET, '').trim()
    return `"${[...words].slice(0, CUT_WORDS).join('')}${chars(words) > CUT_WORDS ? '…' : ''}"`
  })
  if (cut.length > CUT_NAMED) named.push(`+${cut.length - CUT_NAMED} more`)
  return `(${cut.length} lines cut: ${named.join(', ')})`
}

/** 先打码再压成一行:多行的 PEM 压完就认不出了。去掉注释记号可能把密钥拼回来,所以再打一遍 */
export function cleanEntry(text: string): { text: string; masked: number } {
  const first = scrub(text)
  const second = scrub(sanitizeLine(first.text))
  return { text: second.text, masked: first.masked + second.masked }
}

function formatComment(p: Provenance): string {
  const attrs = [`id=${p.id}`, `src=${p.src}`]
  if (p.ts !== undefined) attrs.push(`ts=${p.ts}`)
  const evidence = p.evidence.filter(e => EVIDENCE.test(e))
  if (evidence.length > 0) attrs.push(`ev=${evidence.join(',')}`)
  if (p.turn) attrs.push(`turn=${encodeURIComponent(p.turn)}`)
  if (p.candidate) attrs.push(`cand=${p.candidate}`)
  if (p.by) attrs.push(`by=${p.by}`)
  return `<!-- mff ${attrs.join(' ')} -->`
}

const formatLine = (text: string, p: Provenance) => `- ${text} ${formatComment(p)}`

/**
 * 整篇打码(PEM 跨行),但注释不进去:`x password: <!-- mff … -->` 里的注释会被当成值打掉,
 * 这一行就成了 src=user 的手写行。注释换成独占一行的占位,打码的模式都过不了换行;
 * 接回去的是重新拼的,行尾注释里夹带的别的内容不留
 */
function scrubDoc(doc: string): { text: string; masked: number } {
  const comments: string[] = []
  const held = doc
    .split('\n')
    .map(line => {
      const comment = trailingComment(line)
      if (!comment) return line
      comments.push(formatComment(comment.provenance))
      return `${line.slice(0, comment.at).trimEnd()}\n@@mff:${comments.length - 1}@@`
    })
    .join('\n')
  const { text, masked } = scrub(held)
  return { text: text.replace(/\n@@mff:(\d+)@@/g, (m, i: string) => (comments[Number(i)] === undefined ? m : ` ${comments[Number(i)]}`)), masked }
}

/**
 * memory.file.set 的调用算用户确认了文本,不算确认来源:这份文件里本来就有的注释原样留下,别的都去掉,
 * 这一行就成了用户手写的(h_ id、src=user、没有证据)。所以 id 冒不了别的笔记,ev= 牵连不到别的行
 */
function keepKnownComments(text: string, before: string): string {
  const commentOf = (line: string) => {
    const c = trailingComment(line)
    return c && line.slice(c.at).trimEnd()
  }
  const known = new Set(before.split('\n').map(commentOf))
  return text.split('\n').map(line => {
    const comment = commentOf(line)
    return comment && !known.has(comment) ? stripComment(line) : line
  }).join('\n')
}

const withLine = (doc: string, line: string) => `${doc}${doc === '' || doc.endsWith('\n') ? '' : '\n'}${line}\n`
const withoutLines = (doc: string, gone: Set<number>) => doc.split('\n').filter((_, i) => !gone.has(i)).join('\n')

function capOf(file: string): number | undefined {
  if (file === 'USER.md' || file === 'MEMORY.md') return CAPS[file]
  return file.startsWith('topics/') ? CAPS.topic : undefined
}

function layerOf(file: string): string {
  if (file.startsWith('diary/')) return 'diary'
  if (file.startsWith('topics/')) return 'topic'
  const name = basename(file)
  return name === 'USER.md' ? 'user' : name === 'MEMORY.md' ? 'memory' : 'topic'
}

const full = () => new RpcError(INVALID_PARAMS, 'full')
const notFound = () => new RpcError(INVALID_PARAMS, 'not found')
const badEntry = () => new RpcError(INVALID_PARAMS, 'bad entry')

function assertRoom(file: string, doc: string): void {
  const cap = capOf(file)
  if (cap !== undefined && chars(visible(scrubDoc(doc).text)) > cap) throw full()
}

/** 比较用:同一句话换个标点、大小写、空格还是同一句 */
export function normalize(text: string): string {
  const lowered = cleanText(text).toLowerCase()
  const bare = lowered.replace(/[\s\p{P}]+/gu, '')
  return bare === '' ? lowered.trim() : bare
}

export function localDate(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export class MemoryFiles {
  private dir: string
  /** 文件 → 上次索引时的 stat。没文件是 '',被拒绝的是 REFUSED */
  private known = new Map<string, string>()
  private views = new Map<string, string>()

  constructor(
    private root: string,
    private store: Store,
    private o: MemoryFilesOpts,
  ) {
    this.dir = join(root, 'files')
    mkdirSync(root, { recursive: true, mode: 0o700 })
    this.tighten(root, 0o700)
    for (const dir of [this.dir, ...SUBDIRS.map(sub => join(this.dir, sub))]) {
      if (!this.realDir(dir) || !this.realDir(this.dir)) continue // 不穿过符号链接建目录、改权限
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      this.tighten(dir, 0o700)
    }
  }

  /** 只有 stat 变了才碰文件和库:每轮都调,闲着的轮不拿写锁 */
  reconcile(scope: 'core' | 'all'): void {
    if (scope === 'all') this.sweepTemps()
    this.checkDirs()
    const names = new Set([...this.listed(scope), ...this.known.keys(), ...this.indexedFiles()])
    const changed = [...names].filter(f => (scope === 'all' || !/^(?:diary|archive)\//.test(f)) && this.stamp(f) !== this.known.get(f))
    if (changed.length > 0) this.reindex(changed)
  }

  /**
   * content 是打码版:带 token 的 RPC 结果里不放密钥;原样读出再 write 也一样会打码,所以用户保存时没有差别。
   * hash 按磁盘字节算,冲突检测才认得出编辑器里的改动
   */
  read(file: string): { content: string; hash: string; cap: number } {
    const name = this.checked(file)
    this.reconcile('core')
    const raw = this.load(name)
    return { content: scrubDoc(raw).text, hash: sha256(raw), cap: capOf(name) as number }
  }

  /**
   * 写之前要知道的:冲突和超限在这里报。removed 给 memory.file.set 按删除处理,证据只在行尾注释里,写完就没了。
   * 文本还在、只是 id 变了(注释被编辑掉)的不算删除。
   * 文件已经就是这份内容 = 上次写成了只是后面失败,同一个 commandId 重试要能过这一关
   */
  planWrite(file: string, content: string, expectedHash: string): { removed: { id: string; text: string; evidence: string[] }[] } {
    const name = this.checked(file)
    const raw = this.load(name)
    const text = this.incoming(raw, content)
    if (sha256(raw) !== expectedHash) {
      if (sha256(raw) === sha256(text)) return { removed: [] }
      throw new RpcError(ERR_BUSY, 'file changed')
    }
    assertRoom(name, text)
    const after = parseEntries(text)
    const ids = new Set(after.map(e => e.id))
    const texts = new Set(after.map(e => e.text))
    const moved = this.textsElsewhere(name)
    const gone = parseEntries(scrubDoc(raw).text).filter(e => !ids.has(e.id) && !texts.has(e.text) && !moved.has(e.text))
    return { removed: gone.map(e => ({ id: e.id, text: e.text, evidence: e.evidence })) }
  }

  write(file: string, content: string, expectedHash: string, source: string): { hash: string; masked: number; removed: { id: string; text: string; evidence: string[] }[] } {
    const name = this.checked(file)
    const raw = this.load(name)
    const { removed } = this.planWrite(name, content, expectedHash)
    const { masked } = scrubDoc(content)
    const text = this.incoming(raw, content)
    if (sha256(raw) === sha256(text)) return { hash: sha256(text), masked, removed: [] }
    const before = new Map(parseEntries(scrubDoc(raw).text).map(e => [e.id, e]))
    const after = new Map(parseEntries(text).map(e => [e.id, e.text]))
    this.save(name, text)
    // 同一个 id 还在别的文件里(编辑器复制的):这个文件的索引行没了,那边要重新认领
    const others = this.list('core').filter(f => f !== name && parseEntries(scrubDoc(this.load(f)).text).some(e => before.has(e.id) && !after.has(e.id)))
    this.reindex([name, ...others], () => {
      for (const [id, now] of after) {
        const was = before.get(id)
        if (!was) this.change(id, name, 'add', null, now, source)
        else if (was.text !== now) this.change(id, name, 'update', was.text, now, source)
      }
      for (const [id, was] of before) if (!after.has(id)) this.change(id, name, 'remove', was.text, null, source)
    })
    this.updated({ file: name, op: 'set', source })
    return { hash: sha256(text), masked, removed }
  }

  /** 这段文本还在哪个核心或主题文件里 */
  holdsText(text: string): boolean {
    return this.textsElsewhere('').has(text)
  }

  private incoming(raw: string, content: string): string {
    return keepKnownComments(scrubDoc(content).text, scrubDoc(raw).text)
  }

  /** 别的核心和主题文件里还有的文本:从这里去掉只是挪走。日记和归档不算,它们是副本,删除时一起清 */
  private textsElsewhere(name: string): Set<string> {
    return new Set(this.list('core').filter(f => f !== name).flatMap(f => parseEntries(scrubDoc(this.load(f)).text).map(e => e.text)))
  }

  addEntry(file: string, text: string, meta: EntryMeta): { id: string; masked: number } {
    const name = this.checked(file)
    this.reconcile('core')
    return this.addLine(name, text, meta, true)
  }

  appendDiary(text: string, meta: EntryMeta): { id: string; masked: number } {
    return this.addLine(`diary/${localDate(meta.ts ?? this.o.now())}.md`, text, meta, false)
  }

  updateEntry(id: string, text: string, source: string): { id: string; masked: number } {
    if (!SRC.test(source)) throw badEntry()
    this.reconcile('all')
    const note = this.store.getNote(id)
    if (!note || note.status !== 'active') throw notFound()
    const clean = cleanEntry(text)
    if (clean.text === '') throw new RpcError(INVALID_PARAMS, 'empty')
    if (!note.file) {
      if (chars(clean.text) > SESSION_NOTE_MAX) throw full() // 只在 SQLite,没有文件上限管它
      this.store.transaction(() => {
        this.store.upsertNote({ ...note, text: clean.text, source, flags: scanInjection(clean.text) })
        this.change(id, null, 'update', note.text, clean.text, source)
      })
      this.updated({ id, op: 'update', source })
      return { id, masked: clean.masked }
    }
    const file = note.file
    const { doc, hits } = this.locate(file, e => e.id === id)
    if (hits.length === 0) throw notFound()
    const lines = doc.split('\n')
    for (const e of hits) lines[e.line] = formatLine(clean.text, { ...e, ts: e.ts ?? this.o.now(), src: source })
    const next = lines.join('\n')
    assertRoom(file, next)
    this.save(file, next)
    this.reindex([file], () => this.change(id, file, 'update', hits[0].text, clean.text, source))
    this.updated({ id, file, op: 'update', source })
    return { id, masked: clean.masked }
  }

  /** 删除开始之前:先把文本记下来,否则删到一半失败,重试就找不到要清的东西了 */
  findEntry(id: string): { text: string; scope: string; evidence: string[] } | undefined {
    this.reconcile('all')
    const note = this.store.getNote(id)
    if (note && !note.file) return { text: note.text, scope: note.scope, evidence: [] }
    const named = this.list('all').flatMap(f => this.locate(f, e => e.id === id).hits)
    const text = note?.text ?? named[0]?.text ?? this.lastChangeText(id)
    return text === undefined ? undefined : { text, scope: note?.scope ?? 'owner', evidence: [...new Set(named.flatMap(e => e.evidence))] }
  }

  evidenceOf(file: string, id: string): string[] {
    return [...new Set(this.locate(file, e => e.id === id).hits.flatMap(e => e.evidence))]
  }

  /**
   * spec §16 第一步。原始层和事件日志归调用方;这里给它们文本和证据。
   * 整行相同的文本一起删:同一条记忆的日记、归档副本。短文本也一样,比的是整行。
   * 行已经不在了(memory.file.set 去掉的、编辑器里删的)时文本从 changes 找;再删一次就什么都没有了。
   * removedIds:连带删掉的都在里面,界面要能告诉用户。
   * knownText:上次删到一半失败时记下的文本。行和索引都没了也要清同文本的提议、候选和变更记录
   */
  deleteEntry(id: string, knownText?: string): { text?: string; evidence: string[]; removedIds: string[] } {
    this.reconcile('all')
    const note = this.store.getNote(id)
    if (note && !note.file) return this.deleteSessionNote(id, note.text)
    const all = this.list('all')
    const named = all.flatMap(f => this.locate(f, e => e.id === id).hits)
    const text = note?.text ?? named[0]?.text ?? knownText ?? this.lastChangeText(id)
    if (text === undefined) {
      this.removeBadCopies()
      return { evidence: [], removedIds: [] }
    }
    const { db } = this.store
    const candidates = new Set(named.flatMap(e => (e.candidate ? [e.candidate] : [])))
    for (const r of db.prepare('SELECT id FROM candidates WHERE text = ? OR replaces = ? OR norm = ?').all(text, id, normalize(text)) as { id: string }[]) candidates.add(r.id)
    const evidence = new Set(named.flatMap(e => e.evidence))
    const addEvidence = (rows: unknown[]) => {
      for (const r of rows as { evidence: string }[]) for (const e of JSON.parse(r.evidence) as string[]) evidence.add(e)
    }
    addEvidence(db.prepare(`SELECT evidence FROM candidates WHERE id IN (${[...candidates].map(() => '?').join(', ') || 'NULL'})`).all(...candidates))
    addEvidence(db.prepare('SELECT evidence FROM proposals WHERE text = ? OR replaces = ?').all(text, id))

    const gone = new Set([id])
    const touched: string[] = []
    for (const file of all) {
      const { doc, hits } = this.locate(file, e => e.id === id || e.text === text || (e.candidate !== undefined && candidates.has(e.candidate)))
      if (hits.length === 0) continue
      for (const e of hits) gone.add(e.id)
      this.save(file, withoutLines(doc, new Set(hits.map(e => e.line))))
      touched.push(file)
    }
    this.reindex(touched, () => {
      this.store.deleteNote(id)
      db.prepare('DELETE FROM proposals WHERE text = ? OR replaces = ?').run(text, id)
      const del = db.prepare('DELETE FROM candidates WHERE id = ?')
      for (const c of candidates) del.run(c)
      this.blankChanges(gone, text)
      this.change(id, note?.file ?? touched[0] ?? null, 'delete', null, null, 'user')
    })
    this.removeBadCopies()
    this.updated({ id, op: 'delete', source: 'user' })
    return { text, evidence: [...evidence], removedIds: [...gone] }
  }

  /** 回滚的轮不留记忆(spec §5)。接入会重放,崩溃也可能让文件先于索引,所以只看现状 */
  removeByTurn(turnId: string): void {
    const { db } = this.store
    const rows = db.prepare('SELECT id, file FROM notes WHERE turn_id = ?').all(turnId) as { id: string; file: string | null }[]
    const files = [...new Set(rows.flatMap(r => (r.file ? [r.file] : [])))]
    for (const file of files) {
      const { doc, hits } = this.locate(file, e => e.turn === turnId)
      if (hits.length > 0) this.save(file, withoutLines(doc, new Set(hits.map(e => e.line))))
    }
    let proposals = 0
    this.reindex(files, () => {
      for (const r of rows) if (!r.file) this.store.deleteNote(r.id)
      proposals = Number(db.prepare("DELETE FROM proposals WHERE turn_id = ? AND status = 'pending'").run(turnId).changes)
    })
    if (rows.length > 0 || proposals > 0) this.updated({ op: 'rollback', source: 'rollback' })
  }

  /** 先写归档再去原行:中间崩溃两边都有,重做时认得出 */
  supersede(id: string, byId: string): void {
    if (!ID.test(byId)) throw badEntry()
    this.reconcile('all')
    const note = this.store.getNote(id)
    if (!note?.file || note.status !== 'active') return
    const file = note.file
    const { doc, hits } = this.locate(file, e => e.id === id)
    if (hits.length === 0) return
    const archive = `archive/${basename(file)}`
    const archived = this.load(archive)
    if (!parseEntries(archived).some(e => e.id === id)) {
      this.save(archive, withLine(archived, formatLine(hits[0].text, { ...hits[0], ts: hits[0].ts ?? this.o.now(), by: byId })))
    }
    this.save(file, withoutLines(doc, new Set(hits.map(e => e.line))))
    this.reindex([file, archive], () => this.change(id, file, 'supersede', hits[0].text, null, byId))
    this.updated({ id, file, op: 'supersede', source: byId })
  }

  /** 现在写得下吗。replacing:这一行会先被挪走,它占的地方算数 */
  assertFits(file: string, text: string, replacing?: string): void {
    const name = this.checked(file)
    this.reconcile('core')
    const { doc, hits } = this.locate(name, e => e.id === replacing)
    assertRoom(name, withLine(withoutLines(doc, new Set(hits.map(e => e.line))), `- ${cleanEntry(text).text}`))
  }

  /** 这些候选的草稿行。核心文件里升级过的那行不动:它是用户能看到、能删的记忆 */
  removeCandidateLines(candidates: string[]): void {
    if (candidates.length === 0) return
    const ids = new Set(candidates)
    const touched: string[] = []
    for (const file of this.list('all').filter(f => f.startsWith('diary/'))) {
      const { doc, hits } = this.locate(file, e => e.candidate !== undefined && ids.has(e.candidate))
      if (hits.length === 0) continue
      this.save(file, withoutLines(doc, new Set(hits.map(e => e.line))))
      touched.push(file)
    }
    if (touched.length === 0) return
    this.reindex(touched)
    this.updated({ op: 'remove', source: 'extract' })
  }

  coreText(): { user: string; memory: string; topics: string[]; version: string } {
    this.reconcile('core')
    const user = this.views.get('USER.md') ?? ''
    const memory = this.views.get('MEMORY.md') ?? ''
    const topics = this.list('core')
      .filter(f => f.startsWith('topics/'))
      .map(f => basename(f, '.md'))
      .sort()
    return { user, memory, topics, version: sha256(`${user}\0${memory}`).slice(0, 12) }
  }

  private addLine(file: string, text: string, meta: EntryMeta, track: boolean): { id: string; masked: number } {
    const id = meta.id ?? `n_${randomBytes(6).toString('hex')}`
    if (!ID.test(id) || !SRC.test(meta.src) || (meta.candidate !== undefined && !ID.test(meta.candidate))) throw badEntry()
    const raw = this.load(file)
    // 崩溃重做:可能已经写了文件没进索引,也可能已经被挪进归档
    if (parseEntries(raw).some(e => e.id === id) || this.store.getNote(id)) return { id, masked: 0 }
    const clean = cleanEntry(text)
    if (clean.text === '') throw new RpcError(INVALID_PARAMS, 'empty')
    const next = withLine(raw, formatLine(clean.text, {
      id,
      src: meta.src,
      ts: meta.ts ?? this.o.now(),
      evidence: meta.evidence ?? [],
      ...(meta.turnId !== undefined && { turn: meta.turnId }),
      ...(meta.candidate !== undefined && { candidate: meta.candidate }),
    }))
    assertRoom(file, next)
    this.save(file, next)
    this.reindex([file], track ? () => this.change(id, file, 'add', null, clean.text, meta.src) : undefined)
    this.updated({ id, file, op: 'add', source: meta.src })
    return { id, masked: clean.masked }
  }

  private deleteSessionNote(id: string, text: string): { text: string; evidence: string[]; removedIds: string[] } {
    this.store.transaction(() => {
      this.store.deleteNote(id)
      this.blankChanges(new Set([id]))
      this.change(id, null, 'delete', null, null, 'user')
    })
    this.removeBadCopies()
    this.updated({ id, op: 'delete', source: 'user' })
    return { text, evidence: [], removedIds: [id] }
  }

  /** RPC 的 file 参数:schema 已经挡过一次,这里不信任调用方再挡一次 */
  private checked(file: string): string {
    if (!MemoryFileSchema.safeParse(file).success) throw new RpcError(INVALID_PARAMS, 'bad file')
    return file
  }

  /**
   * 和索引看到的是同一份:整篇打码后再分行,e.text 和手写行的 id 才对得上。
   * 行号对得上就改原文,用户别的行不动;多行的 PEM 打码后并成一行,只能在打码版上改
   */
  private locate(file: string, match: (e: Entry) => boolean): { doc: string; hits: Entry[] } {
    const raw = this.load(file)
    const scrubbed = scrubDoc(raw).text
    const aligned = scrubbed.split('\n').length === raw.split('\n').length
    return { doc: aligned ? raw : scrubbed, hits: parseEntries(scrubbed).filter(match) }
  }

  /** 这些文件的 notes 换成文件现在的样子。文件读在事务外;事务成功才记 stat,失败下次重来 */
  private reindex(files: string[], extra?: () => void): void {
    // 归档放最后:同一个 id 还在原文件里时,在用的那行优先
    const order = [...files].sort((a, b) => Number(a.startsWith('archive/')) - Number(b.startsWith('archive/')))
    const plans = order.map(file => {
      // 改模式会动 ctime,要在记 stat 之前
      if (this.refusedAt(file) === undefined) this.tighten(this.path(file), 0o600)
      const stamp = this.stamp(file)
      const scrubbed = scrubDoc(this.load(file)).text
      const absent = stamp === '' || stamp === REFUSED
      return { file, stamp, scrubbed, mtime: absent ? this.o.now() : Math.floor(lstatSync(this.path(file)).mtimeMs) }
    })
    this.store.transaction(() => {
      for (const p of plans) this.indexRows(p.file, p.scrubbed, p.mtime)
      extra?.()
    })
    for (const p of plans) {
      this.known.set(p.file, p.stamp)
      this.setProblem(`file_refused:${p.file}`, this.refusedAt(p.file) === p.file)
      this.noteView(p.file, p.scrubbed)
    }
  }

  private indexRows(file: string, scrubbed: string, mtime: number): void {
    const { store } = this
    store.db.prepare('DELETE FROM notes WHERE file = ?').run(file)
    const archived = file.startsWith('archive/')
    const seen = new Set<string>()
    // 每行都查,文件大了每次写都要重建索引:只准备一次
    const owner = store.db.prepare('SELECT file, text, status FROM notes WHERE id = ?')
    for (const e of parseEntries(scrubbed)) {
      if (seen.has(e.id)) continue
      seen.add(e.id)
      const current = owner.get(e.id) as { file: string | null; text: string; status: string } | undefined
      if (archived && current?.status === 'active') continue
      // 这个 id 已经是别的笔记了(编辑器里写的注释):不能盖掉它。群聊笔记只在 SQLite,盖掉就没了
      if (current && current.file !== file && (!current.file || current.text !== e.text) && !current.file?.startsWith('archive/')) continue
      store.upsertNote({
        id: e.id,
        layer: layerOf(file),
        file,
        scope: 'owner',
        source: e.src,
        text: e.text,
        ts: e.ts ?? mtime,
        flags: scanInjection(e.text),
        status: archived ? 'superseded' : 'active',
        ...(e.turn !== undefined && { turnId: e.turn }),
      })
    }
  }

  private noteView(file: string, scrubbed: string): void {
    const cap = capOf(file)
    if (cap === undefined) return
    const code = `file_over_cap:${file}`
    if (CORE.includes(file)) {
      const { text, cut } = fitBlock(scrubbed, cap)
      this.views.set(file, text)
      this.setProblem(code, cut.length > 0, cut.length > 0 ? `${code} ${describeCut(cut)}` : undefined)
    } else {
      this.setProblem(code, chars(visible(scrubbed)) > cap)
    }
  }

  /** 同一个代码只留一条;detail 变了就换掉,不堆积 */
  private setProblem(code: string, on: boolean, detail = code): void {
    const { problems } = this.store
    const at = problems.findIndex(p => p === code || p.startsWith(`${code} `))
    if (on && at >= 0) problems[at] = detail
    else if (on) problems.push(detail)
    else if (at >= 0) problems.splice(at, 1)
  }

  private change(id: string, file: string | null, op: string, before: string | null, after: string | null, source: string): void {
    this.store.db
      .prepare('INSERT INTO changes(ts, entry_id, file, op, before, after, source) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(this.o.now(), id, file, op, before, after, source)
  }

  private lastChangeText(id: string): string | undefined {
    const row = this.store.db.prepare('SELECT COALESCE(before, after) AS text FROM changes WHERE entry_id = ? AND COALESCE(before, after) IS NOT NULL ORDER BY n DESC LIMIT 1').get(id) as { text: string } | undefined
    return row?.text
  }

  private blankChanges(ids: Set<string>, text?: string): void {
    const { db } = this.store
    const byId = db.prepare('UPDATE changes SET before = NULL, after = NULL WHERE entry_id = ?')
    for (const id of ids) byId.run(id)
    if (text !== undefined) db.prepare('UPDATE changes SET before = NULL, after = NULL WHERE before = ? OR after = ?').run(text, text)
  }

  private updated(payload: { id?: string; file?: string; op: string; source: string }): void {
    this.o.append({ type: 'memory.updated', payload })
  }

  private path(file: string): string {
    return join(this.dir, file)
  }

  /** 没有这个路径,或者它是个真目录 */
  private realDir(path: string): boolean {
    const s = this.lstat(path)
    return s === undefined || (!s.isSymbolicLink() && s.isDirectory())
  }

  private lstat(path: string) {
    try {
      return lstatSync(path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw err
    }
  }

  /**
   * 路径上第一个不能用的地方。符号链接会把数据目录外的内容读进索引和模型,或者把写入带到外面;
   * 文件位置上不是普通文件的(FIFO 读起来会卡死)同样不碰
   */
  private refusedAt(file: string): string | undefined {
    if (!this.realDir(this.dir)) return 'files'
    const parts = file.split('/')
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      if (!this.realDir(this.path(dir))) return dir
    }
    const s = this.lstat(this.path(file))
    return s === undefined || s.isFile() ? undefined : file
  }

  private checkDirs(): void {
    const top = this.realDir(this.dir)
    this.setProblem('file_refused:files', !top)
    for (const sub of SUBDIRS) this.setProblem(`file_refused:${sub}`, top && !this.realDir(this.path(sub)))
  }

  private load(file: string): string {
    if (this.refusedAt(file) !== undefined) return ''
    try {
      return readFileSync(this.path(file), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw err
    }
  }

  private stamp(file: string): string {
    if (this.refusedAt(file) !== undefined) return REFUSED
    const s = this.lstat(this.path(file))
    return s ? `${s.size}:${s.mtimeMs}:${s.ctimeMs}` : ''
  }

  /** 不穿过符号链接列目录 */
  private names(sub: string, ok: (name: string) => boolean): string[] {
    if (!this.realDir(this.dir) || !this.realDir(this.path(sub))) return []
    try {
      return readdirSync(this.path(sub)).filter(ok).map(n => `${sub}/${n}`)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
  }

  /** 目录里看到的名字,包括要拒绝的:对账才报得出来 */
  private listed(scope: 'core' | 'all'): string[] {
    const core = [...CORE, ...this.names('topics', n => MemoryFileSchema.safeParse(`topics/${n}`).success)]
    if (scope === 'core') return core
    return [...core, ...this.names('diary', n => DIARY_NAME.test(n)), ...this.names('archive', n => ARCHIVE_NAME.test(n))]
  }

  /** 真的在、能用的文件 */
  private list(scope: 'core' | 'all'): string[] {
    return this.listed(scope).filter(f => !['', REFUSED].includes(this.stamp(f)))
  }

  /** 索引里有、磁盘上没有的文件:关着插件时被删的 */
  private indexedFiles(): string[] {
    const rows = this.store.db.prepare('SELECT DISTINCT file FROM notes WHERE file IS NOT NULL').all() as { file: string }[]
    return rows.map(r => r.file)
  }

  /** 临时文件 + fsync + 改名。崩溃留下的只会是临时文件,对账时清掉 */
  private save(file: string, content: string): void {
    if (this.refusedAt(file) !== undefined) throw new RpcError(INVALID_PARAMS, 'refused')
    const target = this.path(file)
    const tmp = join(target, '..', `.${basename(file)}.${randomBytes(4).toString('hex')}.tmp`)
    try {
      const fd = openSync(tmp, 'wx', 0o600)
      try {
        writeSync(fd, content)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      this.o.beforeRename?.(tmp, target)
      renameSync(tmp, target)
    } catch (err) {
      rmSync(tmp, { force: true })
      throw err
    }
  }

  /** 崩溃留下的临时文件里可能有已删的文本 */
  private sweepTemps(): void {
    if (!this.realDir(this.dir)) return
    const walk = (dir: string) => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        if (d.isDirectory()) walk(join(dir, d.name))
        else if (d.name.startsWith('.') && d.name.endsWith('.tmp')) rmSync(join(dir, d.name), { force: true })
      }
    }
    walk(this.dir)
  }

  /** 被挪开的坏库里可能有这段文本 */
  removeBadCopies(): void {
    for (const name of readdirSync(this.root)) {
      if (name.startsWith('memory.sqlite.bad-')) rmSync(join(this.root, name), { force: true })
    }
  }

  private tighten(path: string, mode: number): void {
    try {
      const s = this.lstat(path) // 还没有这个文件不是失败:新数据目录每次启动都会走到
      if (s && !s.isSymbolicLink() && (s.mode & 0o777) !== mode) chmodSync(path, mode)
    } catch (err) {
      this.o.log.warn('memory files chmod failed', { path: basename(path), error: err instanceof Error ? err.name : 'unknown' })
    }
  }
}
