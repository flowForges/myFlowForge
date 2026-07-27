import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The store reads/writes sysFile('settings.json'); point it at a temp dir via the paths module.
let dir: string
vi.mock('./paths', async (orig) => {
  const real = await orig<typeof import('./paths')>()
  return { ...real, sysFile: (name: string) => join(process.env.__FA_DIR!, name) }
})
import { isFullAccessAcked, ackFullAccess } from './store'

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fa-')); process.env.__FA_DIR = dir })
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.__FA_DIR })

describe('fullAccessAck store', () => {
  it('is false before any ack', () => {
    expect(isFullAccessAcked('/ws/a', 'cursor')).toBe(false)
  })
  it('remembers an ack per (workspace, provider)', () => {
    ackFullAccess('/ws/a', 'cursor')
    expect(isFullAccessAcked('/ws/a', 'cursor')).toBe(true)
    expect(isFullAccessAcked('/ws/a', 'gemini')).toBe(false)   // different provider
    expect(isFullAccessAcked('/ws/b', 'cursor')).toBe(false)   // different workspace
  })
  it('is idempotent (no duplicate entries, second ack is a no-op)', () => {
    ackFullAccess('/ws/a', 'cursor'); ackFullAccess('/ws/a', 'cursor')
    expect(isFullAccessAcked('/ws/a', 'cursor')).toBe(true)
  })
})
