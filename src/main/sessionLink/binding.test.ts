import { it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jsonl, claudeTurnRows } from './testFixtures'

let home: string, roots: Record<'codex' | 'claude' | 'qoder', string>
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-'))
  process.env.HOME = home
  roots = { codex: join(home, 'x', 'codex'), claude: join(home, 'x', 'claude'), qoder: join(home, 'x', 'qoder') }
  vi.resetModules()
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const ws = () => join(home, 'ws')
function claudeTranscript(id: string, body: string) {
  const f = join(roots.claude, '-p', `${id}.jsonl`)
  mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, body)
  return f
}

it('asExtProvider: only codex / claude / qoder link to an official app', async () => {
  const { asExtProvider } = await import('./binding')
  expect(asExtProvider('claude')).toBe('claude')
  expect(asExtProvider('codex')).toBe('codex')
  expect(asExtProvider('qoder')).toBe('qoder')
  expect(asExtProvider('gemini')).toBeUndefined()
})

it('ensureSyncedTo: a forge binding without a position starts at the current end of file — no catch-up of our own history', async () => {
  const { writeSession, readBinding } = await import('../chat/chatStore')
  const { ensureSyncedTo } = await import('./binding')
  const { readExternal } = await import('./index')
  const body = jsonl(claudeTurnRows())
  const f = claudeTranscript('c1', body + '{"type":"assistant","half')   // trailing half line stays unconsumed
  writeSession(ws(), 's', 'claude', 'c1')
  const cur = await ensureSyncedTo(ws(), 's', 'claude', { roots })
  expect(cur).toEqual({ offset: Buffer.byteLength(body) })
  expect(readBinding(ws(), 's', 'claude')).toMatchObject({ syncedTo: cur, extFile: f })
  const r = await readExternal('claude', f, cur!)
  expect(r.reset).toBe(false); expect(r.turns).toEqual([])
  // already positioned → unchanged
  appendFileSync(f, '\n')
  expect(await ensureSyncedTo(ws(), 's', 'claude', { roots })).toEqual(cur)
})

it('ensureSyncedTo leaves imported bindings / non-linking agents / missing transcripts alone', async () => {
  const { writeBinding, writeSession, readBinding } = await import('../chat/chatStore')
  const { ensureSyncedTo } = await import('./binding')
  writeBinding(ws(), 's', 'claude', { resumeId: 'c2', origin: 'imported' })
  claudeTranscript('c2', jsonl(claudeTurnRows()))
  expect(await ensureSyncedTo(ws(), 's', 'claude', { roots })).toBeUndefined()
  writeSession(ws(), 's', 'gemini', 'g')
  expect(await ensureSyncedTo(ws(), 's', 'gemini', { roots })).toBeUndefined()
  writeSession(ws(), 's', 'qoder', 'q-none')   // qoder root absent
  expect(await ensureSyncedTo(ws(), 's', 'qoder', { roots })).toBeUndefined()
  expect(readBinding(ws(), 's', 'qoder')).toEqual({ resumeId: 'q-none', origin: 'forge' })
})

it('recordOwnEnd stores the size + mtime our writer left, and moves syncedTo past our own turn', async () => {
  const { writeSession, readBinding, writeBinding } = await import('../chat/chatStore')
  const { recordOwnEnd } = await import('./binding')
  const { isOccupied } = await import('./occupancy')
  const body = jsonl(claudeTurnRows().slice(0, 4))     // unfinished-looking tail (tool_use)
  const f = claudeTranscript('c3', body)
  writeSession(ws(), 's', 'claude', 'c3')
  writeBinding(ws(), 's', 'claude', { syncedTo: { offset: 0 } })
  await recordOwnEnd(ws(), 's', 'claude', { roots, now: () => 42 })
  const b = readBinding(ws(), 's', 'claude')!
  expect(b.ownEnd).toEqual({ offset: Buffer.byteLength(body), mtimeMs: statSync(f).mtimeMs })
  expect(b.ownLastWriteAt).toBe(42)
  expect(b.syncedTo).toEqual({ offset: Buffer.byteLength(body) })
  expect(b.extFile).toBe(f)
  expect((await isOccupied('claude', f, statSync(f).mtimeMs + 1_000, { ownEnd: b.ownEnd })).busy).toBe(false)
})

it('recordOwnEnd / ownLiveFor are no-ops without a linkable binding, and never throw', async () => {
  const { recordOwnEnd, ownLiveFor } = await import('./binding')
  await expect(recordOwnEnd(join(home, 'nope'), 's', 'claude', { roots })).resolves.toBeUndefined()
  await expect(recordOwnEnd(ws(), 's', 'gemini', { roots })).resolves.toBeUndefined()
  expect(ownLiveFor('claude', ws(), 'never-started')).toBe(false)
  expect(ownLiveFor('codex', ws(), 'x')).toBe(false)
})
