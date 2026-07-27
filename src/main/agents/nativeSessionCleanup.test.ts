import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { removeNativeSession } from './nativeSessionCleanup'

let home: string
const touch = (p: string) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, 'x') }

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'nsc-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe('removeNativeSession', () => {
  it('deletes the codex rollout carrying the id, keeps others', async () => {
    const day = join(home, '.codex', 'sessions', '2026', '06', '08')
    const mine = join(day, 'rollout-2026-06-08T22-39-19-ABC123.jsonl')
    const other = join(day, 'rollout-2026-06-08T10-00-00-ZZZ999.jsonl')
    touch(mine); touch(other)
    await removeNativeSession('codex', 'ABC123', home)
    expect(existsSync(mine)).toBe(false)
    expect(existsSync(other)).toBe(true)
  })

  it('deletes the claude project jsonl named after the id', async () => {
    const proj = join(home, '.claude', 'projects', '-Users-me-proj')
    const mine = join(proj, 'sess-uuid-1.jsonl')
    const other = join(proj, 'sess-uuid-2.jsonl')
    touch(mine); touch(other)
    await removeNativeSession('claude', 'sess-uuid-1', home)
    expect(existsSync(mine)).toBe(false)
    expect(existsSync(other)).toBe(true)
  })

  it('deletes the qoder project entry (no extension)', async () => {
    const proj = join(home, '.qoder', 'projects', '-Users-me-proj')
    const mine = join(proj, 'qses-1')
    touch(mine)
    await removeNativeSession('qoder', 'qses-1', home)
    expect(existsSync(mine)).toBe(false)
  })

  it('deletes opencode storage shards for the session id', async () => {
    const storage = join(home, '.local', 'share', 'opencode', 'storage')
    const diff = join(storage, 'session_diff', 'ses_abc.json')
    const msg = join(storage, 'message', 'ses_abc', 'part-1.json')
    const keep = join(storage, 'session_diff', 'ses_other.json')
    touch(diff); touch(msg); touch(keep)
    await removeNativeSession('opencode', 'ses_abc', home)
    expect(existsSync(diff)).toBe(false)
    expect(existsSync(join(storage, 'message', 'ses_abc'))).toBe(false)
    expect(existsSync(keep)).toBe(true)
  })

  it('is a silent no-op for empty id, unknown provider, and missing store', async () => {
    await expect(removeNativeSession('codex', '', home)).resolves.toBeUndefined()
    await expect(removeNativeSession('cursor', 'anything', home)).resolves.toBeUndefined()
    await expect(removeNativeSession('codex', 'nope', home)).resolves.toBeUndefined()
  })
})
