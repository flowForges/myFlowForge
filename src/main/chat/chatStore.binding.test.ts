import { it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-'))
  process.env.HOME = home
  vi.resetModules()
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const file = (ws: string) => join(ws, '.forge', 'chat-session.json')

it('a session we started is a forge-origin binding; metadata round-trips', async () => {
  const { writeSession, readBinding, writeBinding, markOwnWrite } = await import('./chatStore')
  const ws = join(home, 'ws')
  expect(readBinding(ws, 's1', 'claude')).toBeUndefined()
  writeSession(ws, 's1', 'claude', 'ext-1')
  expect(readBinding(ws, 's1', 'claude')).toEqual({ resumeId: 'ext-1', origin: 'forge' })
  writeBinding(ws, 's1', 'claude', { syncedTo: { offset: 120, lastId: '10:abc' }, cwd: '/p', extFile: '/x/ext-1.jsonl' })
  markOwnWrite(ws, 's1', 'claude', 1234)
  expect(readBinding(ws, 's1', 'claude')).toEqual({ resumeId: 'ext-1', origin: 'forge', syncedTo: { offset: 120, lastId: '10:abc' }, cwd: '/p', extFile: '/x/ext-1.jsonl', ownLastWriteAt: 1234 })
  // cwd undefined in a patch keeps the earlier value (readers only report cwd when the range contains it)
  writeBinding(ws, 's1', 'claude', { syncedTo: { offset: 200 }, cwd: undefined })
  expect(readBinding(ws, 's1', 'claude')?.cwd).toBe('/p')
  expect(readBinding(ws, 's1', 'claude')?.syncedTo).toEqual({ offset: 200 })
})

it('an imported binding keeps origin=imported when the provider re-reports the same id', async () => {
  const { writeSession, readBinding, writeBinding } = await import('./chatStore')
  const ws = join(home, 'ws')
  writeBinding(ws, 's2', 'codex', { resumeId: 'th-1', origin: 'imported', syncedTo: { offset: 50, lastId: '3:aa' }, cwd: '/c' })
  writeSession(ws, 's2', 'codex', 'th-1')
  expect(readBinding(ws, 's2', 'codex')).toEqual({ resumeId: 'th-1', origin: 'imported', syncedTo: { offset: 50, lastId: '3:aa' }, cwd: '/c' })
})

it('a new resume id drops the stale external position (different transcript)', async () => {
  const { writeSession, readBinding, writeBinding, markOwnWrite } = await import('./chatStore')
  const ws = join(home, 'ws')
  writeSession(ws, 's3', 'claude', 'old')
  writeBinding(ws, 's3', 'claude', { syncedTo: { offset: 9 }, extFile: '/x/old.jsonl', cwd: '/p' })
  markOwnWrite(ws, 's3', 'claude', 5)
  writeSession(ws, 's3', 'claude', 'new')
  expect(readBinding(ws, 's3', 'claude')).toEqual({ resumeId: 'new', origin: 'forge', cwd: '/p', ownLastWriteAt: 5 })
})

it('reads legacy files (bare string / no origin) and keeps watermark + other agents intact', async () => {
  const ws = join(home, 'ws')
  mkdirSync(join(ws, '.forge'), { recursive: true })
  writeFileSync(file(ws), JSON.stringify({ s: { claude: 'legacy-id', codex: { resumeId: 'th', watermark: 4 } } }))
  const { readBinding, readSession, readWatermark, writeBinding, readSessionAgents } = await import('./chatStore')
  expect(readBinding(ws, 's', 'claude')).toEqual({ resumeId: 'legacy-id', origin: 'forge' })
  expect(readBinding(ws, 's', 'codex')).toEqual({ resumeId: 'th', origin: 'forge', watermark: 4 })
  writeBinding(ws, 's', 'codex', { syncedTo: { offset: 1 } })
  expect(readWatermark(ws, 's', 'codex')).toBe(4)
  expect(readSession(ws, 's', 'claude')).toBe('legacy-id')
  expect(readSessionAgents(ws, 's')).toEqual({ claude: 'legacy-id', codex: 'th' })
  const raw = JSON.parse(readFileSync(file(ws), 'utf8'))
  expect(raw.s.codex).toEqual({ resumeId: 'th', watermark: 4, syncedTo: { offset: 1 } })
})

it('watermark-only entries without a resume id are not bindings', async () => {
  const { writeWatermark, readBinding } = await import('./chatStore')
  const ws = join(home, 'ws')
  writeWatermark(ws, 's4', 'claude', 3)
  expect(readBinding(ws, 's4', 'claude')).toBeUndefined()
})

it('writeBinding with a different resumeId drops the old transcript position unless the patch sets it', async () => {
  const { writeSession, writeBinding, readBinding } = await import('./chatStore')
  const ws = join(home, 'ws')
  writeSession(ws, 's5', 'claude', 'old')
  writeBinding(ws, 's5', 'claude', { syncedTo: { offset: 9 }, extFile: '/x/old.jsonl', ownEnd: { offset: 9, mtimeMs: 1 }, cwd: '/p' })
  writeBinding(ws, 's5', 'claude', { resumeId: 'new', origin: 'imported' })
  expect(readBinding(ws, 's5', 'claude')).toEqual({ resumeId: 'new', origin: 'imported', cwd: '/p' })
  writeBinding(ws, 's5', 'claude', { resumeId: 'newer', syncedTo: { offset: 3 }, extFile: '/x/newer.jsonl' })
  expect(readBinding(ws, 's5', 'claude')).toEqual({ resumeId: 'newer', origin: 'imported', cwd: '/p', syncedTo: { offset: 3 }, extFile: '/x/newer.jsonl' })
  writeBinding(ws, 's5', 'claude', { resumeId: 'newer', ownEnd: { offset: 3, mtimeMs: 2 } })
  expect(readBinding(ws, 's5', 'claude')?.syncedTo).toEqual({ offset: 3 })
})

it('writeSession with a new id also clears ownEnd', async () => {
  const { writeSession, writeBinding, readBinding } = await import('./chatStore')
  const ws = join(home, 'ws')
  writeSession(ws, 's6', 'codex', 'a')
  writeBinding(ws, 's6', 'codex', { ownEnd: { offset: 1, mtimeMs: 1 } })
  writeSession(ws, 's6', 'codex', 'a')
  expect(readBinding(ws, 's6', 'codex')?.ownEnd).toEqual({ offset: 1, mtimeMs: 1 })
  writeSession(ws, 's6', 'codex', 'b')
  expect(readBinding(ws, 's6', 'codex')?.ownEnd).toBeUndefined()
})
