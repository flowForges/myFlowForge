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
}

export const THUMB_RING = 300
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

export function createActionLog(root: string, fs: FsLike = nodeFs as unknown as FsLike): ActionLog {
  const previews = new Map<string, Map<string, string[]>>()
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

  async function ring(k: CuSessionKey) {
    const id = idOf(k)
    let r = rings.get(id)
    if (!r) {
      let names: string[] = []
      try { names = (await fs.readdir(join(dirOf(k), 'thumbs'))).filter((n) => THUMB_NAME.test(n)).sort() } catch { /* none yet */ }
      const last = names.length ? parseInt(names[names.length - 1], 10) : 0
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
        await fs.appendFile(join(dir, 'actions.jsonl'), JSON.stringify(toDisk(out)) + '\n', { mode: 0o600 })
        if (e.textPreview !== undefined) {
          const m = previews.get(idOf(key)) ?? new Map<string, string[]>()
          previews.set(idOf(key), m)
          const pk = previewKey(out)
          m.set(pk, [...(m.get(pk) ?? []), e.textPreview])
        }
        return out
      })
    },

    async list(key) {
      if (!ok(key)) return []
      return serial(key, async () => {
        let raw = ''
        try { raw = (await fs.readFile(join(dirOf(key), 'actions.jsonl'))).toString('utf8') } catch { return [] }
        const seen = new Map<string, number>()
        const out: CuLogEntry[] = []
        for (const line of raw.split('\n')) {
          if (!line) continue
          const e = fromDisk(line)
          if (!e) continue
          const pk = previewKey(e)
          const i = seen.get(pk) ?? 0
          seen.set(pk, i + 1)
          const p = previews.get(idOf(key))?.get(pk)?.[i]
          if (p !== undefined) e.textPreview = p
          out.push(e)
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
        await fs.rm(dirOf(key), { recursive: true, force: true })
      })
    },
  }
}
