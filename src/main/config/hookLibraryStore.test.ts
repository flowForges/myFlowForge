import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let tmp: string
vi.mock('./paths', async (orig) => {
  const actual = await orig<typeof import('./paths')>()
  return { ...actual, sysFile: (n: string) => join((globalThis as any).__SYS__, n) }
})
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'hk-')); (globalThis as any).__SYS__ = tmp })
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('hook library store', () => {
  it('defaults to an empty library when the file is absent', async () => {
    const { readHookLibrary } = await import('./store')
    expect(readHookLibrary().hooks).toEqual([])
  })

  it('writes and reads back slot-agnostic hooks (no after field)', async () => {
    const { writeHookLibrary, readHookLibrary } = await import('./store')
    writeHookLibrary({ hooks: [{ id: 'hk1', name: '拉主干', prompt: 'git fetch', skills: ['code-review'], tools: ['git'] }] })
    const hooks = readHookLibrary().hooks
    expect(hooks).toHaveLength(1)
    expect(hooks[0]).toMatchObject({ id: 'hk1', name: '拉主干', prompt: 'git fetch', skills: ['code-review'], tools: ['git'] })
    expect(hooks[0]).not.toHaveProperty('after')
  })

  it('fills skills/tools defaults for a minimal hook', async () => {
    const { writeHookLibrary, readHookLibrary } = await import('./store')
    // Cast: exercise the schema defaulting the same way a hand-edited file / partial import would.
    writeHookLibrary({ hooks: [{ id: 'hk2', name: 'min', prompt: '' } as any] })
    expect(readHookLibrary().hooks[0]).toMatchObject({ id: 'hk2', skills: [], tools: [] })
  })
})
