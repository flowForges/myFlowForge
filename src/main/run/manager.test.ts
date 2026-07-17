import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RunStore } from '../orchestrator/runStore'
import { Run2Manager } from './manager'
import { planFromStages } from './planFromStages'
import type { StageSpec } from '../orchestrator/orchestrator'
import type { RunEvent } from './events'
import type { AgentProvider, AgentTask, AgentCallbacks } from '../agents/types'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'mgr-')) })
afterEach(() => { rmSync(ws, { recursive: true, force: true }) })

function gatedProvider(): AgentProvider {
  return {
    id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
    async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
    run(task: AgentTask, cb: AgentCallbacks) {
      const done = (async () => { cb.onHandoff?.({ summary: 'done' }); const r = { ok: true, summary: '' }; cb.onDone(r); return r })()
      return { id: task.agentId, cancel() {}, done }
    },
  }
}
const stages: StageSpec[] = [{ key: 'design', name: '方案', provider: 'x', model: 'm', scope: 'root', gate: true }]

describe('Run2Manager', () => {
  it('starts a run, bridges events, resolves the gate, completes', async () => {
    const events: RunEvent[] = []
    let lastStatus = ''
    const mgr = new Run2Manager({
      providers: { x: gatedProvider() }, env: {},
      makeStore: (wsPath, runId) => new RunStore(wsPath, runId),
      emit: {
        event: (_ws, e) => { events.push(e); if (e.kind === 'gate') setTimeout(() => mgr.resolveGate(_ws, e.id, { type: 'advance' }), 0) },
        update: (_ws, s) => { lastStatus = s.status },
      },
    })
    const plan = planFromStages('run-1', stages)
    const init = mgr.start({ workspacePath: ws, runId: 'run-1', plan, projects: [{ name: 'a', cwd: join(ws, 'a') }] })
    expect(init.status).toBe('running')
    // let the async controller settle
    await new Promise((r) => setTimeout(r, 50))
    expect(events.some((e) => e.kind === 'gate')).toBe(true)
    expect(mgr.isActive(ws)).toBe(false) // cleared after completion
  })

  it('rejects a second concurrent run in the same workspace', () => {
    const mgr = new Run2Manager({ providers: { x: gatedProvider() }, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
    const plan = planFromStages('run-1', stages)
    mgr.start({ workspacePath: ws, runId: 'run-1', plan, projects: [{ name: 'a', cwd: join(ws, 'a') }] })
    expect(() => mgr.start({ workspacePath: ws, runId: 'run-2', plan, projects: [] })).toThrow(/已有工作流/)
  })

  it('resolve/feedback/abort on an unknown workspace are safe no-ops', () => {
    const mgr = new Run2Manager({ providers: {}, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
    expect(mgr.resolveGate('/nope', 'x', { type: 'advance' })).toBe(false)
    expect(() => mgr.abort('/nope')).not.toThrow()
  })
})
