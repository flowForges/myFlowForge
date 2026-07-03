import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator } from './orchestrator'
import { EventBus } from './eventBus'
import type { AgentProvider } from '../agents/types'
import type { EngineEvent } from '@shared/types'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'wsgate-')) })
afterEach(() => rmSync(ws, { recursive: true, force: true }))

// A provider that records which stages were started, and always succeeds.
function recordingProvider(started: string[]): AgentProvider {
  return {
    id: 'rec', displayName: 'Rec',
    capabilities: { structuredOutput: false, permissionHook: false, pty: false },
    async detect() { return true }, async listModels() { return [] },
    run(task, cb) {
      started.push(task.stageKey)
      cb.onState('run')
      const done = (async () => { cb.onState('ok'); const r = { ok: true, summary: 'ok' }; cb.onDone(r); return r })()
      return { id: task.agentId, cancel() {}, done }
    }
  }
}

describe('Orchestrator inter-stage review gate (design)', () => {
  it('pauses after design (ok) with a confirm card for stage:design; develop has NOT started yet', async () => {
    const bus = new EventBus()
    const events: EngineEvent[] = []
    bus.subscribe(e => events.push(e))
    const started: string[] = []
    const orch = new Orchestrator({ bus, providers: { rec: recordingProvider(started) }, proxy: () => '' })

    // Do NOT auto-resolve: let the run hang on the gate so we can inspect mid-run state.
    const runP = orch.startRun({
      runId: 'g1', workspaceName: 'ws', workspacePath: ws,
      stages: [
        { key: 'design', name: '技术方案设计', provider: 'rec', model: 'm' },
        { key: 'develop', name: '代码开发', provider: 'rec', model: 'm' },
      ],
      developProjects: []
    })

    // Wait for the gate's pending:add to appear.
    const gateAdd = await new Promise<Extract<EngineEvent, { type: 'pending:add' }>>((resolve) => {
      bus.subscribe(e => {
        if (e.type === 'pending:add' && e.action.kind === 'confirm' && e.action.agentId === 'stage:design') resolve(e)
      })
    })

    expect(gateAdd.action.agentId).toBe('stage:design')
    expect(gateAdd.action.kind).toBe('confirm')
    // design ran; develop must not have started while the gate is pending
    expect(started).toContain('design')
    expect(started).not.toContain('develop')

    // unblock the run so the test ends cleanly
    orch.resolve({ id: gateAdd.action.id, decision: 'allow' })
    await runP
  })

  it('approve (allow) → develop runs and the run completes ok', async () => {
    const bus = new EventBus()
    const started: string[] = []
    const orch = new Orchestrator({ bus, providers: { rec: recordingProvider(started) }, proxy: () => '' })
    bus.subscribe(e => { if (e.type === 'pending:add') setTimeout(() => orch.resolve({ id: e.action.id, decision: 'allow' }), 0) })

    const run = await orch.startRun({
      runId: 'g2', workspaceName: 'ws', workspacePath: ws,
      stages: [
        { key: 'design', name: '技术方案设计', provider: 'rec', model: 'm' },
        { key: 'develop', name: '代码开发', provider: 'rec', model: 'm' },
      ],
      developProjects: []
    })

    expect(run.status).toBe('ok')
    expect(started).toEqual(['design', 'develop'])
    expect(run.stages.map(s => s.key)).toEqual(['design', 'develop'])
    expect(run.stages.every(s => s.state === 'ok')).toBe(true)
  })

  it('reject (deny) → run finalizes err and develop never runs', async () => {
    const bus = new EventBus()
    const started: string[] = []
    const orch = new Orchestrator({ bus, providers: { rec: recordingProvider(started) }, proxy: () => '' })
    bus.subscribe(e => { if (e.type === 'pending:add') setTimeout(() => orch.resolve({ id: e.action.id, decision: 'deny' }), 0) })

    const run = await orch.startRun({
      runId: 'g3', workspaceName: 'ws', workspacePath: ws,
      stages: [
        { key: 'design', name: '技术方案设计', provider: 'rec', model: 'm' },
        { key: 'develop', name: '代码开发', provider: 'rec', model: 'm' },
      ],
      developProjects: []
    })

    expect(run.status).toBe('err')
    expect(started).toEqual(['design'])
    expect(started).not.toContain('develop')
    // develop stage was never created
    expect(run.stages.map(s => s.key)).toEqual(['design'])
  })

  it('does NOT gate when there is no design stage (requirement → develop runs straight through)', async () => {
    const bus = new EventBus()
    const events: EngineEvent[] = []
    bus.subscribe(e => events.push(e))
    const started: string[] = []
    const orch = new Orchestrator({ bus, providers: { rec: recordingProvider(started) }, proxy: () => '' })
    // No auto-resolver: if a gate fired, the run would hang and the test would time out.

    const run = await orch.startRun({
      runId: 'g4', workspaceName: 'ws', workspacePath: ws,
      stages: [
        { key: 'requirement', name: '需求评估', provider: 'rec', model: 'm' },
        { key: 'develop', name: '代码开发', provider: 'rec', model: 'm' },
      ],
      developProjects: []
    })

    expect(run.status).toBe('ok')
    expect(started).toEqual(['requirement', 'develop'])
    expect(events.some(e => e.type === 'pending:add')).toBe(false)
  })

  it('does NOT gate when design is the last stage', async () => {
    const bus = new EventBus()
    const events: EngineEvent[] = []
    bus.subscribe(e => events.push(e))
    const started: string[] = []
    const orch = new Orchestrator({ bus, providers: { rec: recordingProvider(started) }, proxy: () => '' })

    const run = await orch.startRun({
      runId: 'g5', workspaceName: 'ws', workspacePath: ws,
      stages: [{ key: 'design', name: '技术方案设计', provider: 'rec', model: 'm' }],
      developProjects: []
    })

    expect(run.status).toBe('ok')
    expect(started).toEqual(['design'])
    expect(events.some(e => e.type === 'pending:add')).toBe(false)
  })
})
