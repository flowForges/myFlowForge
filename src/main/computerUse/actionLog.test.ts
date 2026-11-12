import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActionLog } from './actionLog'
import type { CuLogEntry, CuSessionKey } from './types'

const K: CuSessionKey = { workspacePath: '/w/a', sessionId: 's-1' }
const roots: string[] = []
const mk = () => {
  const root = mkdtempSync(join(tmpdir(), 'cu-log-'))
  roots.push(root)
  return root
}
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })

const entry = (o: Partial<CuLogEntry> = {}): CuLogEntry => ({ ts: 1000, turn: 1, op: 'click', result: 'auto', ...o })
const allFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? allFiles(join(dir, d.name)) : [join(dir, d.name)]))

describe('actionLog', () => {
  it('entries survive a reload, without textPreview', async () => {
    const root = mk()
    const a = createActionLog(root)
    await a.append(K, entry({ op: 'type', textPreview: 'hunter2-SECRET', textLen: 14, result: 'allowed' }))
    await a.append(K, entry({ ts: 2000, op: 'key', combo: '⌘T' }))
    const b = createActionLog(root)
    const list = await b.list(K)
    expect(list.map((e) => e.op)).toEqual(['type', 'key'])
    expect(list[0].textLen).toBe(14)
    expect(list[0].textPreview).toBeUndefined()
    expect(list[1].combo).toBe('⌘T')
  })

  it('the typed text is on no disk file, only its length', async () => {
    const root = mk()
    const log = createActionLog(root)
    await log.append(K, entry({ op: 'type', textPreview: 'MARKER-hunter2', textLen: 14 }))
    for (const f of allFiles(root)) expect(readFileSync(f).toString('utf8')).not.toContain('MARKER')
    expect(readFileSync(allFiles(root).find((f) => f.endsWith('actions.jsonl'))!, 'utf8')).toContain('"textLen":14')
  })

  it('keeps the preview in memory for the live session (V11)', async () => {
    const log = createActionLog(mk())
    await log.append(K, entry({ op: 'type', textPreview: 'hello', textLen: 5 }))
    expect((await log.list(K))[0].textPreview).toBe('hello')
  })

  it('append returns the entry with the thumb file name and writes a private file', async () => {
    const root = mk()
    const log = createActionLog(root)
    const e = await log.append(K, entry(), Buffer.from('jpeg-bytes').toString('base64'))
    expect(e.thumb).toMatch(/^\d{8}\.jpg$/)
    expect(await log.thumb(K, e.thumb!)).toBe(Buffer.from('jpeg-bytes').toString('base64'))
    const f = allFiles(root).find((x) => x.endsWith(e.thumb!))!
    expect(statSync(f).mode & 0o077).toBe(0)
    expect((await log.list(K))[0].thumb).toBe(e.thumb)
  })

  it('the thumb ring drops the oldest past 300', async () => {
    const root = mk()
    const log = createActionLog(root)
    const names: string[] = []
    for (let i = 0; i < 303; i++) names.push((await log.append(K, entry({ ts: i }), 'AAAA')).thumb!)
    const thumbs = allFiles(root).filter((f) => f.endsWith('.jpg'))
    expect(thumbs).toHaveLength(300)
    expect(await log.thumb(K, names[0])).toBeNull()
    expect(await log.thumb(K, names[2])).toBeNull()
    expect(await log.thumb(K, names[3])).toBe('AAAA')
    expect(await log.thumb(K, names[302])).toBe('AAAA')
    // the entries stay, only the pictures go
    expect(await log.list(K)).toHaveLength(303)
  }, 20_000)

  it('the ring survives a reload and keeps counting', async () => {
    const root = mk()
    const a = createActionLog(root)
    const first = (await a.append(K, entry(), 'AAAA')).thumb!
    const b = createActionLog(root)
    const second = (await b.append(K, entry(), 'BBBB')).thumb!
    expect(second > first).toBe(true)
    expect(await b.thumb(K, first)).toBe('AAAA')
  })

  it('remove deletes the session dir and forgets the memory', async () => {
    const root = mk()
    const log = createActionLog(root)
    await log.append(K, entry({ op: 'type', textPreview: 'x', textLen: 1 }), 'AAAA')
    await log.remove(K)
    expect(allFiles(root).filter((f) => f.endsWith('.jpg') || f.endsWith('.jsonl'))).toEqual([])
    expect(await log.list(K)).toEqual([])
  })

  it('refuses a session id that could leave its directory', async () => {
    const root = mk()
    const log = createActionLog(root)
    const bad = { workspacePath: '/w/a', sessionId: '../x' }
    await expect(log.append(bad, entry())).rejects.toThrow()
    await expect(log.remove(bad)).rejects.toThrow()
    expect(await log.list(bad)).toEqual([])
    expect(await log.thumb(bad, '00000001.jpg')).toBeNull()
    expect(existsSync(join(root, '..', 'x'))).toBe(false)
  })

  it('refuses thumb names that are not ours', async () => {
    const log = createActionLog(mk())
    expect(await log.thumb(K, '../../actions.jsonl')).toBeNull()
    expect(await log.thumb(K, 'x.jpg')).toBeNull()
  })

  it('separates sessions and workspaces', async () => {
    const log = createActionLog(mk())
    await log.append(K, entry({ op: 'click' }))
    await log.append({ ...K, sessionId: 's-2' }, entry({ op: 'key' }))
    await log.append({ workspacePath: '/w/b', sessionId: 's-1' }, entry({ op: 'move' }))
    expect((await log.list(K)).map((e) => e.op)).toEqual(['click'])
    expect((await log.list({ ...K, sessionId: 's-2' })).map((e) => e.op)).toEqual(['key'])
  })

  it('a corrupt line is skipped', async () => {
    const root = mk()
    const log = createActionLog(root)
    await log.append(K, entry({ op: 'click' }))
    const f = allFiles(root).find((x) => x.endsWith('actions.jsonl'))!
    const { appendFileSync } = await import('node:fs')
    appendFileSync(f, 'not json\n{"nope":1}\n')
    await log.append(K, entry({ op: 'key' }))
    expect((await createActionLog(root).list(K)).map((e) => e.op)).toEqual(['click', 'key'])
  })
})
