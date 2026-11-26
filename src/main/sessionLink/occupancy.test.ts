import { describe, it, expect } from 'vitest'
import { utimesSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isOccupied, appName, BUSY_WINDOW_MS } from './occupancy'
import { jsonl, tempFile, claudeTurnRows, claudeUser, claudeAssistant, codexMeta, codexMsg, codexEvent } from './testFixtures'

const T0 = Date.parse('2026-11-26T10:00:00.000Z')
const touch = (f: string, at: number) => utimesSync(f, at / 1000, at / 1000)

const ended = { claude: jsonl(claudeTurnRows()), codex: jsonl([codexMeta(), codexMsg('user', 'hi'), codexMsg('assistant', 'yo'), codexEvent('task_complete')]) }
const running = {
  claude: jsonl([claudeUser('u1', '改一下'), claudeAssistant('a1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }], 'tool_use')]),
  codex: jsonl([codexMeta(), codexMsg('user', 'hi'), codexEvent('task_started')]),
}

describe('appName', () => {
  it('maps providers to the official app names', () => {
    expect(appName('codex')).toBe('Codex')
    expect(appName('claude')).toBe('Claude')
    expect(appName('qoder')).toBe('Qoder')
  })
})

describe('isOccupied — mtime × end marker × own-write matrix', () => {
  for (const p of ['claude', 'codex'] as const) {
    it(`${p}: fresh mtime + unfinished turn → busy with app name`, async () => {
      const f = tempFile('x.jsonl', running[p]); touch(f, T0 - 2_000)
      expect(await isOccupied(p, f, T0)).toEqual({ busy: true, app: appName(p), exists: true })
    })
    it(`${p}: fresh mtime + ended turn → not busy`, async () => {
      const f = tempFile('x.jsonl', ended[p]); touch(f, T0 - 2_000)
      expect(await isOccupied(p, f, T0)).toEqual({ busy: false, exists: true })
    })
    it(`${p}: stale mtime (> 15 s) + unfinished turn → not busy (crashed / abandoned)`, async () => {
      const f = tempFile('x.jsonl', running[p]); touch(f, T0 - BUSY_WINDOW_MS - 1)
      expect((await isOccupied(p, f, T0)).busy).toBe(false)
    })
    it(`${p}: fresh mtime + unfinished, but caused by our own just-finished write → not busy`, async () => {
      const f = tempFile('x.jsonl', running[p]); touch(f, T0 - 1_000)
      expect((await isOccupied(p, f, T0, { ownLastWriteAt: T0 - 3_000 })).busy).toBe(false)
    })
    it(`${p}: a change more than 15 s after our own write still counts as the other side`, async () => {
      const f = tempFile('x.jsonl', running[p]); touch(f, T0 - 1_000)
      expect(await isOccupied(p, f, T0, { ownLastWriteAt: T0 - 1_000 - BUSY_WINDOW_MS - 1 })).toEqual({ busy: true, app: appName(p), exists: true })
    })
  }

  it('half-written trailing line with fresh mtime → busy', async () => {
    const f = tempFile('x.jsonl', ended.claude + '{"type":"assistant","mess'); touch(f, T0 - 500)
    expect((await isOccupied('claude', f, T0)).busy).toBe(true)
  })

  it('qoder (unknown format → no end marker) relies on mtime only', async () => {
    const body = jsonl([{ id: 'q1', message: { role: 'user', content: 'hi' } }, { id: 'q2', message: { role: 'assistant', content: 'ok' } }])
    const fresh = tempFile('q.jsonl', body); touch(fresh, T0 - 1_000)
    expect(await isOccupied('qoder', fresh, T0)).toEqual({ busy: true, app: 'Qoder', exists: true })
    const stale = tempFile('q.jsonl', body); touch(stale, T0 - 60_000)
    expect((await isOccupied('qoder', stale, T0)).busy).toBe(false)
  })

  it('missing file → not busy, exists:false, never throws', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-'))
    expect(await isOccupied('claude', join(dir, 'nope.jsonl'), T0)).toEqual({ busy: false, exists: false })
    expect(await isOccupied('qoder', join(dir, 'no', 'root', 'x.jsonl'), T0)).toEqual({ busy: false, exists: false })
  })

  it('uses injected stat / reader and skips reading when mtime is old or own', async () => {
    let reads = 0
    const deps = {
      stat: async () => ({ mtimeMs: T0 - 100_000 }),
      read: async () => { reads++; return { turns: [], next: { offset: 0 }, reset: false, endedCleanly: false, exists: true } },
      lastByte: async () => 0x0a,
    }
    expect((await isOccupied('codex', '/fake', T0, undefined, deps)).busy).toBe(false)
    const own = { ...deps, stat: async () => ({ mtimeMs: T0 - 1_000, size: 10 }) }
    expect((await isOccupied('codex', '/fake', T0, { ownLastWriteAt: T0 - 2_000 }, own)).busy).toBe(false)
    expect(reads).toBe(0)
    expect(await isOccupied('codex', '/fake', T0, undefined, own)).toEqual({ busy: true, app: 'Codex', exists: true })
    expect(reads).toBe(1)
  })

  it('stat failure / reader reporting a vanished file → not busy', async () => {
    expect(await isOccupied('claude', '/fake', T0, undefined, { stat: async () => { throw new Error('EACCES') } })).toEqual({ busy: false, exists: false })
    const gone = { stat: async () => ({ mtimeMs: T0, size: 5 }), lastByte: async () => 0x0a, read: async () => ({ turns: [], next: { offset: 0 }, reset: false, endedCleanly: false, exists: false }) }
    expect(await isOccupied('claude', '/fake', T0, undefined, gone)).toEqual({ busy: false, exists: false })
  })

  it('empty file with a fresh mtime → busy (being created)', async () => {
    const f = tempFile('e.jsonl', ''); touch(f, T0 - 500)
    expect(await isOccupied('claude', f, T0)).toEqual({ busy: true, app: 'Claude', exists: true })
  })

  it('half-written last line → busy from a 1-byte check, without reading the transcript', async () => {
    let reads = 0
    const deps = { stat: async () => ({ mtimeMs: T0 - 500, size: 99 }), lastByte: async () => 0x7d, read: async () => { reads++; throw new Error('no') } }
    expect(await isOccupied('codex', '/fake', T0, undefined, deps)).toEqual({ busy: true, app: 'Codex', exists: true })
    expect(reads).toBe(0)
  })
})

describe('isOccupied — own writer state (ownLive / ownEnd)', () => {
  it('ownLive (our process still holds the binding) → not busy, without touching the file', async () => {
    let touched = 0
    const deps = { stat: async () => { touched++; return { mtimeMs: T0, size: 1 } } }
    expect(await isOccupied('claude', '/fake', T0, { ownLive: true }, deps)).toEqual({ busy: false, exists: true })
    expect(touched).toBe(0)
  })
  for (const p of ['claude', 'codex'] as const) {
    it(`${p}: file exactly as our writer left it (size + mtime) → not busy even though fresh and unfinished`, async () => {
      const f = tempFile('x.jsonl', running[p]); touch(f, T0 - 1_000)
      const ownEnd = { offset: Buffer.byteLength(running[p]), mtimeMs: T0 - 1_000 }
      expect((await isOccupied(p, f, T0, { ownEnd })).busy).toBe(false)
    })
    it(`${p}: grown since our writer went quiet, fresh and unfinished → busy, even within 15 s of our write`, async () => {
      const f = tempFile('x.jsonl', running[p]); touch(f, T0 - 1_000)
      const ownEnd = { offset: 10, mtimeMs: T0 - 4_000 }
      expect(await isOccupied(p, f, T0, { ownEnd, ownLastWriteAt: T0 - 4_000 })).toEqual({ busy: true, app: appName(p), exists: true })
    })
    it(`${p}: same size but touched again (mtime differs) → judged normally`, async () => {
      const f = tempFile('x.jsonl', running[p]); touch(f, T0 - 1_000)
      const ownEnd = { offset: Buffer.byteLength(running[p]), mtimeMs: T0 - 3_000 }
      expect((await isOccupied(p, f, T0, { ownEnd })).busy).toBe(true)
    })
  }
  it('grown since ownEnd but stale (> 15 s) → not busy', async () => {
    const f = tempFile('x.jsonl', running.claude); touch(f, T0 - 60_000)
    expect((await isOccupied('claude', f, T0, { ownEnd: { offset: 1, mtimeMs: 0 } })).busy).toBe(false)
  })
})
