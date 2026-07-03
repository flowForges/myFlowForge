import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let tmp: string
vi.mock('./paths', async (orig) => {
  const actual = await orig<typeof import('./paths')>()
  return { ...actual, sysFile: (n: string) => join((globalThis as any).__SYS__, n) }
})
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'reg-')); (globalThis as any).__SYS__ = tmp })
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('workspace registry', () => {
  it('registers + reads back, deduping by path', async () => {
    const { registerWorkspace, readWorkspaceRegistry } = await import('./store')
    registerWorkspace('A', '/ws/a')
    registerWorkspace('A again', '/ws/a')
    registerWorkspace('B', '/ws/b')
    const list = readWorkspaceRegistry()
    expect(list.map(w => w.path)).toEqual(['/ws/a', '/ws/b'])
  })
  it('returns [] when the registry file is absent', async () => {
    const { readWorkspaceRegistry } = await import('./store')
    expect(readWorkspaceRegistry()).toEqual([])
  })
})
