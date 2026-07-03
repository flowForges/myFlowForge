import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-'))
  process.env.HOME = home
  vi.resetModules()
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('archivedGuard', () => {
  it('reports archived state from registry', async () => {
    const { registerWorkspace, setWorkspaceLifecycle } = await import(
      '../config/store'
    )
    const { isArchivedWorkspace } = await import('./archivedGuard')
    registerWorkspace('a', '/tmp/a')
    expect(isArchivedWorkspace('/tmp/a')).toBe(false)
    setWorkspaceLifecycle('/tmp/a', { archived: true, archivedAt: 1 })
    expect(isArchivedWorkspace('/tmp/a')).toBe(true)
  })
})
