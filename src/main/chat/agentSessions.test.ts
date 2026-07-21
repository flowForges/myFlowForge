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

it('chat main Agent shows 运行中(run) only for the provider with an in-flight turn', async () => {
  const { writeSession } = await import('./chatStore')
  const { composeAgentSessions } = await import('./agentSessions')
  const ws = join(home, 'ws')
  writeSession(ws, 's1', 'claude', 'claude-abc')
  writeSession(ws, 's1', 'codex', 'codex-xyz')
  // No running provider → both finished (the old hardcoded 'ok').
  const idle = composeAgentSessions(ws, { id: 's1', title: 't', mode: 'chat', createdAt: 0 })
  expect(idle.map(r => r.status)).toEqual(['ok', 'ok'])
  // claude's turn is in flight → its row is 'run', codex stays 'ok'.
  const rows = composeAgentSessions(ws, { id: 's1', title: 't', mode: 'chat', createdAt: 0 }, 'claude')
  expect(rows.find(r => r.provider === 'claude')?.status).toBe('run')
  expect(rows.find(r => r.provider === 'codex')?.status).toBe('ok')
})

it('workflow session → rows from run agents that captured a session id', async () => {
  const { RunStore } = await import('../run/runStore')
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
  const { RunStore } = await import('../run/runStore')
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

// run2 stage agents (RunControllerState.laneSessions, run/controller.ts) — unlike the legacy
// orchestrator branch above, a run2 launch never sets ChatSession.runId (findRun2RunForSession's
// doc), so the fixture session below deliberately omits `runId` and relies on matching
// state.sessionId instead — that IS the bug this fix closes.
it('run2 session → a captured lane shows its session id, an uncaptured running lane gets a placeholder row', async () => {
  const { RunStore } = await import('../run/runStore')
  const { saveControllerState } = await import('./../run/persist')
  const { composeAgentSessions } = await import('./agentSessions')
  const ws = join(home, 'ws')
  const plan = { runId: 'run2-1', stages: [{ key: 'develop', name: '代码开发', provider: 'x', model: 'm', scope: 'per-project' as const, gate: false }] }
  const machine = { plan, stages: [{ key: 'develop', status: 'running' as const, round: 0 }], currentIndex: 0 }
  const state = {
    machine, inbox: [], feedback: [], outcomes: {}, status: 'running' as const, pendingDirective: {},
    liveLanes: {}, stageTimings: {}, laneTimings: {}, paused: false,
    sessionId: 's1',
    projects: [{ name: 'a', cwd: '/ws/a' }, { name: 'b', cwd: '/ws/b' }],
    laneSessions: { 'develop:a': { provider: 'claude', sessionId: 'claude-run2-1' } },
  }
  saveControllerState(new RunStore(ws, 'run2-1'), state as any)

  // No `runId` on the session — mirrors real run2 launches (see doc above).
  const rows = composeAgentSessions(ws, { id: 's1', title: 't', mode: 'chat', createdAt: 0 })
  const captured = rows.find((r) => r.agentName === 'a')
  expect(captured).toMatchObject({ provider: 'claude', providerLabel: 'Claude Code', role: '代码开发', sessionId: 'claude-run2-1', status: 'run' })

  const uncaptured = rows.find((r) => r.agentName === 'b')
  expect(uncaptured).toMatchObject({ provider: '', providerLabel: '—', role: '代码开发', sessionId: '会话未捕获', status: 'run' })
})

it('run2 session → composeAgentSessions returns nothing run2-related for a session that owns no run2 run', async () => {
  const { composeAgentSessions } = await import('./agentSessions')
  const ws = join(home, 'ws')
  const rows = composeAgentSessions(ws, { id: 'no-run-here', title: 't', mode: 'chat', createdAt: 0 })
  expect(rows).toEqual([])
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
