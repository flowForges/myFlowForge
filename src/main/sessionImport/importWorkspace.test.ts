import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const registered: { name: string; path: string }[] = []
vi.mock('../config/store', () => ({
  registerWorkspace: (name: string, path: string) => registered.push({ name, path }),
}))

describe('importWorkspace', () => {
  beforeEach(() => { registered.length = 0 })
  it('registers central entry only, never writes .forge into the real dir', async () => {
    const { importWorkspace } = await import('./importWorkspace')
    const dir = mkdtempSync(join(tmpdir(), 'iw-'))
    importWorkspace(dir)
    expect(registered).toEqual([{ name: dir.split('/').pop(), path: dir }])
    expect(existsSync(join(dir, '.forge', 'workspace.json'))).toBe(false)
  })
})
