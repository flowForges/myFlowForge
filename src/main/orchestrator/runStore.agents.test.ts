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

describe('RunStore agent sessions', () => {
  it('persists + reads per-agent CLI session ids for a run', async () => {
    const { RunStore, readRunAgentSessions } = await import('./runStore')
    const ws = join(home, 'ws')
    const store = new RunStore(ws, 'run1')
    store.setAgentSession('a1', 'claude', 'claude-sid-1')
    store.setAgentSession('a2', 'codex', 'codex-sid-2')
    expect(readRunAgentSessions(ws, 'run1')).toEqual({
      a1: { provider: 'claude', sessionId: 'claude-sid-1' },
      a2: { provider: 'codex', sessionId: 'codex-sid-2' },
    })
    expect(readRunAgentSessions(ws, 'nope')).toEqual({})
  })
})
