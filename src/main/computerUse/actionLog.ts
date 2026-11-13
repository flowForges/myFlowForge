// Action log (spec §10.5, V11): <root>/<sha8(workspace)>/<sessionId>/{actions.jsonl, thumbs/NNNNNNNN.jpg}.
// - The typed text never reaches disk: only whitelisted fields are written, and `textPreview` is not one of them.
//   The preview lives in memory for the live session's list() and is gone after a restart.
// - Thumbnails are a ring of 300 per session; the entries stay when their picture is dropped.
// - Everything is owner-only (0700 dirs, 0600 files). A session id that isn't a plain id is refused.
import { createHash } from 'node:crypto'
import * as nodeFs from 'node:fs/promises'
import { join } from 'node:path'
import type { ActionLog, CuLogEntry, CuSessionKey } from './types'
import { isCuOp } from './types'

export interface FsLike {
  mkdir(p: string, o: { recursive: true; mode?: number }): Promise<unknown>
  appendFile(p: string, data: string, o?: { mode?: number }): Promise<void>
  readFile(p: string): Promise<Buffer>
  writeFile(p: string, data: Buffer | string, o?: { mode?: number }): Promise<void>
  readdir(p: string): Promise<string[]>
  rm(p: string, o: { recursive?: boolean; force?: boolean }): Promise<void>
  chmod(p: string, mode: number): Promise<void>
}

export interface ActionLogOpts { maxEntries?: number; maxPreviews?: number; maxPreviewSessions?: number }

export const THUMB_RING = 300
export const ENTRY_RING = 2000
export const PREVIEW_RING = 300
export const PREVIEW_SESSIONS = 8
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/
const THUMB_NAME = /^\d{8}\.jpg$/
const sha8 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8)

/** Only these fields are ever written. `textPreview` is deliberately absent (V11). */
function toDisk(e: CuLogEntry): Record<string, unknown> {
  const o: Record<string, unknown> = { ts: e.ts, turn: e.turn, op: e.op, result: e.result }
  if (e.app !== undefined) o.app = e.app
  if (e.bundleId !== undefined) o.bundleId = e.bundleId
  if (e.at !== undefined) o.at = { x: e.at.x, y: e.at.y }
  if (e.textLen !== undefined) o.textLen = e.textLen
  if (e.combo !== undefined) o.combo = e.combo
  if (e.code !== undefined) o.code = e.code
  if (e.thumb !== undefined) o.thumb = e.thumb
  return o
}

function fromDisk(line: string): CuLogEntry | null {
  let v: unknown
  try { v = JSON.parse(line) } catch { return null }
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  if (typeof r.ts !== 'number' || typeof r.turn !== 'number' || !isCuOp(r.op) || typeof r.result !== 'string') return null
  const e = toDisk(r as unknown as CuLogEntry) as unknown as CuLogEntry
  return e
}

const previewKey = (e: CuLogEntry) => `${e.ts}|${e.turn}|${e.op}|${e.textLen ?? ''}`

export function createActionLog(root: string, fs: FsLike = nodeFs as unknown as FsLike, opts: ActionLogOpts = {}): ActionLog {
  const maxEntries = opts.maxEntries ?? ENTRY_RING
  const maxPreviews = opts.maxPreviews ?? PREVIEW_RING
  const maxPreviewSessions = opts.maxPreviewSessions ?? PREVIEW_SESSIONS
  const slack = Math.floor(maxEntries / 10)
  const counts = new Map<string, number>()
  const previews = new Map<string, { byKey: Map<string, string[]>; order: string[] }>()
  const rings = new Map<string, { names: string[]; next: number }>()
  const chains = new Map<string, Promise<unknown>>()

  const ok = (k: CuSessionKey) => SAFE_ID.test(k.sessionId) && typeof k.workspacePath === 'string'
  const refuse = (k: CuSessionKey) => { if (!ok(k)) throw new Error('bad session id') }
  const dirOf = (k: CuSessionKey) => join(root, sha8(k.workspacePath), k.sessionId)
  const idOf = (k: CuSessionKey) => `${sha8(k.workspacePath)}/${k.sessionId}`
  const serial = <T>(k: CuSessionKey, fn: () => Promise<T>): Promise<T> => {
    const id = idOf(k)
    const next = (chains.get(id) ?? Promise.resolve()).then(fn, fn)
    chains.set(id, next.catch(() => undefined))
    return next
  }

  function remember(id: string, pk: string, text: string) {
    let p = previews.get(id)
    if (!p) {
      p = { byKey: new Map(), order: [] }
      previews.set(id, p)
      while (previews.size > maxPreviewSessions) previews.delete(previews.keys().next().value as string)
    }
    p.byKey.set(pk, [...(p.byKey.get(pk) ?? []), text])
    p.order.push(pk)
    while (p.order.length > maxPreviews) {
      const old = p.order.shift()!
      const l = p.byKey.get(old)
      l?.shift()
      if (l && l.length === 0) p.byKey.delete(old)
    }
  }

  async function ring(k: CuSessionKey) {
    const id = idOf(k)
    let r = rings.get(id)
    if (!r) {
      let names: string[] = []
      try { names = (await fs.readdir(join(dirOf(k), 'thumbs'))).filter((n) => THUMB_NAME.test(n)).sort() } catch { /* none yet */ }
      let last = names.length ? parseInt(names[names.length - 1], 10) : 0
      // the thumbs may have been wiped while the entries still name them: never reuse those numbers
      try {
        for (const line of (await fs.readFile(join(dirOf(k), 'actions.jsonl'))).toString('utf8').split('\n')) {
          const m = /"thumb":"(\d{8})\.jpg"/.exec(line)
          if (m) last = Math.max(last, parseInt(m[1], 10))
        }
      } catch { /* no log yet */ }
      r = { names, next: last + 1 }
      rings.set(id, r)
    }
    return r
  }

  return {
    async append(key, e, thumbJpeg) {
      refuse(key)
      return serial(key, async () => {
        const dir = dirOf(key)
        await fs.mkdir(join(dir, 'thumbs'), { recursive: true, mode: 0o700 })
        for (const p of [root, join(root, sha8(key.workspacePath)), dir, join(dir, 'thumbs')]) await fs.chmod(p, 0o700).catch(() => undefined)
        const out: CuLogEntry = { ...e }
        delete out.thumb
        if (thumbJpeg) {
          const r = await ring(key)
          const name = `${String(r.next++).padStart(8, '0')}.jpg`
          await fs.writeFile(join(dir, 'thumbs', name), Buffer.from(thumbJpeg, 'base64'), { mode: 0o600 })
          r.names.push(name)
          while (r.names.length > THUMB_RING) {
            const old = r.names.shift()!
            await fs.rm(join(dir, 'thumbs', old), { force: true })
          }
          out.thumb = name
        }
        const file = join(dir, 'actions.jsonl')
        await fs.appendFile(file, JSON.stringify(toDisk(out)) + '\n', { mode: 0o600 })
        const id = idOf(key)
        let n = counts.get(id)
        if (n === undefined) {
          try { n = (await fs.readFile(file)).toString('utf8').split('\n').filter(Boolean).length } catch { n = 1 }
        } else n++
        if (n > maxEntries + slack) {
          const lines = (await fs.readFile(file)).toString('utf8').split('\n').filter(Boolean).slice(-maxEntries)
          await fs.writeFile(file, lines.join('\n') + '\n', { mode: 0o600 })
          n = lines.length
        }
        counts.set(id, n)
        if (e.textPreview !== undefined) remember(id, previewKey(out), e.textPreview)
        return out
      })
    },

    async list(key) {
      if (!ok(key)) return []
      return serial(key, async () => {
        let raw = ''
        try { raw = (await fs.readFile(join(dirOf(key), 'actions.jsonl'))).toString('utf8') } catch { return [] }
        const entries: CuLogEntry[] = []
        for (const line of raw.split('\n')) {
          if (!line) continue
          const e = fromDisk(line)
          if (e) entries.push(e)
        }
        const out = entries.slice(-maxEntries)
        // previews line up with the newest occurrences of each key
        const p = previews.get(idOf(key))
        if (p) {
          const total = new Map<string, number>()
          for (const e of out) total.set(previewKey(e), (total.get(previewKey(e)) ?? 0) + 1)
          const seen = new Map<string, number>()
          for (const e of out) {
            const pk = previewKey(e)
            const j = seen.get(pk) ?? 0
            seen.set(pk, j + 1)
            const l = p.byKey.get(pk)
            if (!l) continue
            const t = l[j - (total.get(pk)! - l.length)]
            if (j - (total.get(pk)! - l.length) >= 0 && t !== undefined) e.textPreview = t
          }
        }
        return out
      })
    },

    async thumb(key, file) {
      if (!ok(key) || !THUMB_NAME.test(file)) return null
      try { return (await fs.readFile(join(dirOf(key), 'thumbs', file))).toString('base64') } catch { return null }
    },

    async remove(key) {
      refuse(key)
      return serial(key, async () => {
        previews.delete(idOf(key))
        rings.delete(idOf(key))
        counts.delete(idOf(key))
        await fs.rm(dirOf(key), { recursive: true, force: true })
      })
    },
  }
}
