import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator, gateApprovedKey } from './orchestrator'
import { EventBus } from './eventBus'
import { RunStore } from './runStore'
import type { AgentProvider } from '../agents/types'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'ws-gate-')) })
afterEach(() => rmSync(ws, { recursive: true, force: true }))

// Minimal provider: every agent immediately finishes ok.
function okProvider(): AgentProvider {
  return {
    id: 'okp', displayName: 'OK',
    capabilities: { structuredOutput: false, permissionHook: false, pty: false, mcpTools: true } as any,
    async detect() { return true },
    async listModels() { return [] },
    run(task, cb) {
      const done = (async () => { cb.onState('ok'); const r = { ok: true, summary: 'ok' }; cb.onDone(r); return r })()
      return { id: task.agentId, cancel() {}, done }
    },
  }
}

const TWO_STAGE = {
  runId: 'r-gate',
  workspaceName: 'ws',
  workspacePath: '',
  stages: [
    { key: 'design', name: '技术方案', provider: 'okp', model: 'm' },
    { key: 'develop', name: '代码开发', provider: 'okp', model: 'm' },
  ],
  developProjects: [],
}

describe('design review gate persistence', () => {
  it('persists gate-approval when the design gate is APPROVED, so resume treats design as done', async () => {
    const bus = new EventBus()
    bus.subscribe(e => { if (e.type === 'pending:add') setTimeout(() => orch.resolve({ id: e.action.id, decision: 'allow' }), 0) })
    const orch = new Orchestrator({ bus, providers: { okp: okProvider() }, proxy: () => '' })
    const run = await orch.startRun({ ...TWO_STAGE, workspacePath: ws })
    expect(run.status).toBe('ok')
    const store = new RunStore(ws, 'r-gate')
    expect(store.getContext(gateApprovedKey('design'))).toBe(true)
  })

  it('does NOT persist gate-approval when the design gate is DENIED (cancelled at confirm)', async () => {
    const bus = new EventBus()
    bus.subscribe(e => { if (e.type === 'pending:add') setTimeout(() => orch.resolve({ id: e.action.id, decision: 'deny' }), 0) })
    const orch = new Orchestrator({ bus, providers: { okp: okProvider() }, proxy: () => '' })
    const run = await orch.startRun({ ...TWO_STAGE, workspacePath: ws })
    // Denied gate stops the run; design never becomes an approved, resumable-past stage.
    expect(run.status).toBe('err')
    const store = new RunStore(ws, 'r-gate')
    expect(store.getContext(gateApprovedKey('design'))).not.toBe(true)
  })
})
