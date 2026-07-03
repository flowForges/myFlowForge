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

it('readSessionAgents returns the per-agent resume map for a session', async () => {
  const { writeSession, readSessionAgents } = await import('./chatStore')
  const ws = join(home, 'ws')
  writeSession(ws, 's1', 'claude', 'claude-abc')
  writeSession(ws, 's1', 'codex', 'codex-xyz')
  expect(readSessionAgents(ws, 's1')).toEqual({ claude: 'claude-abc', codex: 'codex-xyz' })
  expect(readSessionAgents(ws, 'missing')).toEqual({})
})
