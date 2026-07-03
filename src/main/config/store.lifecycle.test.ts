// src/main/config/store.lifecycle.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'forge-')); process.env.HOME = home; vi.resetModules?.() })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe('workspace lifecycle store', () => {
  it('register sets createdAt and preserves it + archive flags on re-register', async () => {
    const { registerWorkspace, setWorkspaceLifecycle, readWorkspaceRegistry, unregisterWorkspace } = await import('./store')
    registerWorkspace('a', '/tmp/a')
    const created = readWorkspaceRegistry()[0].createdAt
    expect(created).toBeGreaterThan(0)
    setWorkspaceLifecycle('/tmp/a', { archived: true, archivedAt: 123, description: 'core' })
    registerWorkspace('a-renamed', '/tmp/a')   // re-register (edit)
    const e = readWorkspaceRegistry().find(w => w.path === '/tmp/a')!
    expect(e.name).toBe('a-renamed')
    expect(e.createdAt).toBe(created)           // preserved
    expect(e.archived).toBe(true)               // preserved
    expect(e.description).toBe('core')
    unregisterWorkspace('/tmp/a')
    expect(readWorkspaceRegistry().find(w => w.path === '/tmp/a')).toBeUndefined()
  })
})
