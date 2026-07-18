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

  it('a rejecting controller.start() routes to onError and frees the lock (no unhandled rejection)', async () => {
    const errors: Array<{ ws: string; msg: string }> = []
    const mgr = new Run2Manager({
      providers: { x: gatedProvider() }, env: {},
      makeStore: (w, r) => new RunStore(w, r),
      emit: { event: () => {}, update: () => {} },
      onError: (w, err) => errors.push({ ws: w, msg: err.message }),
    })
    // a per-project stage with an EMPTY projects array makes RunController.start() throw (zero work orders)
    const perProjectStages: StageSpec[] = [{ key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: false }]
    const plan = planFromStages('run-err', perProjectStages)
    mgr.start({ workspacePath: ws, runId: 'run-err', plan, projects: [] })
    await new Promise((r) => setTimeout(r, 50))
    expect(errors.length).toBe(1)
    expect(errors[0].msg).toMatch(/no work orders/)
    expect(mgr.isActive(ws)).toBe(false) // lock freed despite the rejection
  })

  it('a rejecting controller.start() still emits a terminal update so the renderer never hangs on "running"', async () => {
    const updates: Array<{ ws: string; status: string }> = []
    const mgr = new Run2Manager({
      providers: { x: gatedProvider() }, env: {},
      makeStore: (w, r) => new RunStore(w, r),
      emit: { event: () => {}, update: (w, s) => updates.push({ ws: w, status: s.status }) },
    })
    // same zero-work-orders throw as above, but this time we assert on the emitted update, not onError
    const perProjectStages: StageSpec[] = [{ key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: false }]
    const plan = planFromStages('run-err2', perProjectStages)
    mgr.start({ workspacePath: ws, runId: 'run-err2', plan, projects: [] })
    await new Promise((r) => setTimeout(r, 50))
    expect(updates.some((u) => u.ws === ws && u.status === 'failed')).toBe(true)
  })

  it('retains the finished run\'s terminal state after completion, clearing it when a new run starts', async () => {
    // an ungated stage completes on its own — no gate to resolve — so the run reaches a terminal status
    // ('ok') without any manual intervention.
    const okStages: StageSpec[] = [{ key: 'design', name: '方案', provider: 'x', model: 'm', scope: 'root', gate: false }]
    const mgr = new Run2Manager({
      providers: { x: gatedProvider() }, env: {},
      makeStore: (w, r) => new RunStore(w, r),
      emit: { event: () => {}, update: () => {} },
    })
    const plan = planFromStages('run-done', okStages)
    mgr.start({ workspacePath: ws, runId: 'run-done', plan, projects: [{ name: 'a', cwd: join(ws, 'a') }] })
    // before the run settles, there is no retained last state yet (still active)
    expect(mgr.lastStateFor(ws)).toBeNull()
    await new Promise((r) => setTimeout(r, 50))
    // lock freed...
    expect(mgr.isActive(ws)).toBe(false)
    // ...but the finished run's terminal state is still retrievable
    const last = mgr.lastStateFor(ws)
    expect(last).not.toBeNull()
    expect(last!.status).toBe('ok')

    // starting a new run in the same workspace supersedes (clears) the old retained state
    const plan2 = planFromStages('run-done-2', okStages)
    const init2 = mgr.start({ workspacePath: ws, runId: 'run-done-2', plan: plan2, projects: [{ name: 'a', cwd: join(ws, 'a') }] })
    expect(init2.status).toBe('running')
    expect(mgr.lastStateFor(ws)).toBeNull()
  })
})
