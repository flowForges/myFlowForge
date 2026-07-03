/**
 * TDD: orchestrator captures sub-agent CLI session_id into the run sidecar.
 * A fake provider's run() calls cb.onSession('sid-x'); after the run completes,
 * readRunAgentSessions should contain the agent's entry.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus } from './eventBus'
import { Orchestrator } from './orchestrator'
import { readRunAgentSessions } from './runStore'
import type { AgentProvider, AgentCallbacks, AgentSession } from '../agents/types'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'orch-session-')) })
afterEach(() => rmSync(ws, { recursive: true, force: true }))

/** Fake provider: calls cb.onSession('sid-x') then completes ok */
function makeSessionProvider(provider = 'fake'): AgentProvider {
  return {
    id: provider,
    displayName: 'Session Fake',
    capabilities: { structuredOutput: true, permissionHook: false, pty: false },
    async detect() { return true },
    async listModels() { return [] },
    run(task, cb): AgentSession {
      cb.onState('run')
      const done = (async () => {
        cb.onSession?.('sid-x')
        cb.onState('ok')
        const result = { ok: true, summary: 'done' }
        cb.onDone(result)
        return result
      })()
      return { id: task.agentId, cancel() {}, done }
    },
  }
}

describe('orchestrator captures sub-agent session id into run sidecar', () => {
  it('captures sub-agent session id into the run sidecar', async () => {
    const runId = 'session-test-run'
    const bus = new EventBus()
    const orch = new Orchestrator({ bus, providers: { fake: makeSessionProvider('fake') }, proxy: () => '' })

    const run = await orch.startRun({
      runId,
      workspaceName: 'test-ws',
      workspacePath: ws,
      stages: [{ key: 'develop', name: '开发', provider: 'fake', model: 'test-model', scope: 'root' }],
      developProjects: [],
    })

    expect(run.status).toBe('ok')

    const agentId = run.stages[0].agents[0].id
    const sessions = readRunAgentSessions(ws, runId)
    expect(sessions).toMatchObject({
      [agentId]: { provider: 'fake', sessionId: 'sid-x' },
    })
  })
})
