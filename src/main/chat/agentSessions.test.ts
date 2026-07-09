import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(),'forge-')); process.env.HOME = home; vi.resetModules() })
afterEach(() => rmSync(home, { recursive: true, force: true }))

it('chat session → one row per agent with provider label', async () => {
  const { writeSession } = await import('./chatStore')
  const { composeAgentSessions } = await import('./agentSessions')
  const ws = join(home, 'ws')
  writeSession(ws, 's1', 'claude', 'claude-abc')
  const rows = composeAgentSessions(ws, { id: 's1', title: 't', mode: 'chat', createdAt: 0 })
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ provider: 'claude', providerLabel: 'Claude Code', sessionId: 'claude-abc' })
})

it('workflow session → rows from run agents that captured a session id', async () => {
  const { RunStore } = await import('../orchestrator/runStore')
  const { composeAgentSessions } = await import('./agentSessions')
  const ws = join(home, 'ws')
  const store = new RunStore(ws, 'run1')
  store.saveState({ id: 'run1', workspaceName: 'w', workspacePath: ws, status: 'run', projects: [],
    stages: [{ key: 'develop', name: '代码开发', state: 'run', agents: [
      { id: 'a1', name: 'Refactor 子 Agent', role: '代码开发', provider: 'claude', model: 'sonnet', state: 'run', logs: [] },
    ] }], pending: [] })
  store.setAgentSession('a1', 'claude', 'claude-sid-1')
  const rows = composeAgentSessions(ws, { id: 's1', title: 't', mode: 'workflow', createdAt: 0, runId: 'run1' })
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ provider: 'claude', agentName: 'Refactor 子 Agent', sessionId: 'claude-sid-1', status: 'run' })
})

it('union: a session with BOTH a workflow run and chat mains lists all agents (either mode)', async () => {
  const { RunStore } = await import('../orchestrator/runStore')
  const { writeSession } = await import('./chatStore')
  const { composeAgentSessions } = await import('./agentSessions')
  const ws = join(home, 'ws')
  const store = new RunStore(ws, 'run1')
  store.saveState({ id: 'run1', workspaceName: 'w', workspacePath: ws, status: 'ok', projects: [],
    stages: [{ key: 'develop', name: '代码开发', state: 'ok', agents: [
      { id: 'a1', name: 'Dev 子 Agent', role: '代码开发', provider: 'codex', model: 'default', state: 'ok', logs: [] },
    ] }], pending: [] })
  store.setAgentSession('a1', 'codex', 'codex-wf-1')
  // Plain-chat mains for the SAME session id — a different codex session + a claude one.
  writeSession(ws, 's1', 'codex', 'codex-chat-9')
  writeSession(ws, 's1', 'claude', 'claude-abc')
  // mode is 'chat' (returned to chat) yet runId persists → old either/or dropped the workflow agent.
  const rows = composeAgentSessions(ws, { id: 's1', title: 't', mode: 'chat', createdAt: 0, runId: 'run1' })
  const ids = rows.map(r => r.sessionId).sort()
  expect(ids).toEqual(['claude-abc', 'codex-chat-9', 'codex-wf-1'])   // all three, workflow + both chat mains
})

it('agentSessionsForId finds the session then composes', async () => {
  const { writeSession } = await import('./chatStore')
  const { newSession } = await import('./sessionStore')
  const { agentSessionsForId } = await import('./agentSessions')
  const ws = join(home, 'ws')
  const file = newSession(ws)
  const sid = file.activeSessionId
  writeSession(ws, sid, 'claude', 'claude-abc')
  const rows = agentSessionsForId(ws, sid)
  expect(rows[0]?.sessionId).toBe('claude-abc')
  expect(agentSessionsForId(ws, 'missing')).toEqual([])
})
