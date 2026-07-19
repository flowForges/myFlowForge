import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RunStore } from '../orchestrator/runStore'
import { Run2Manager } from './manager'
import { planFromStages } from './planFromStages'
import type { StageSpec } from '../orchestrator/orchestrator'
import type { RunEvent } from './events'
import type { AgentProvider, AgentTask, AgentCallbacks } from '../agents/types'
import type { RunLogLine } from './controller'

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
// ungated (no gate) single-stage plan — needed for queue tests: with gate:false the run reaches a
// terminal status (and frees the manager's per-workspace lock) as soon as the provider's `done` promise
// resolves, so `controllableProvider` below can drive exactly when a queued run's turn comes.
const ungatedStages: StageSpec[] = [{ key: 'design', name: '方案', provider: 'x', model: 'm', scope: 'root', gate: false }]

// A provider whose `done` promise does NOT resolve until the test explicitly calls `calls[i].resolve()`
// — lets a test hold a run "in flight" to exercise the manager's serial-lock/queue behavior deterministically
// (vs. gatedProvider/okProvider, which resolve `done` immediately and rely on a *gate* to stay "active").
function controllableProvider(): { provider: AgentProvider; calls: Array<{ task: AgentTask; resolve: () => void }> } {
  const calls: Array<{ task: AgentTask; resolve: () => void }> = []
  const provider: AgentProvider = {
    id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
    async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
    run(task: AgentTask, cb: AgentCallbacks) {
      let resolveFn: () => void = () => {}
      const done = new Promise<{ ok: boolean; summary: string }>((resolve) => {
        resolveFn = () => { cb.onHandoff?.({ summary: 'done' }); const r = { ok: true, summary: '' }; cb.onDone(r); resolve(r) }
      })
      calls.push({ task, resolve: resolveFn })
      return { id: task.agentId, cancel() {}, done }
    },
  }
  return { provider, calls }
}

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
    expect(init.status).toBe('started')
    if (init.status === 'started') expect(init.state.status).toBe('running')
    // let the async controller settle
    await new Promise((r) => setTimeout(r, 50))
    expect(events.some((e) => e.kind === 'gate')).toBe(true)
    expect(mgr.isActive(ws)).toBe(false) // cleared after completion
  })

  it('a run2:start on an idle workspace returns {status:"started", state}', () => {
    const mgr = new Run2Manager({ providers: { x: gatedProvider() }, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
    const plan = planFromStages('run-1', stages)
    const result = mgr.start({ workspacePath: ws, runId: 'run-1', plan, projects: [{ name: 'a', cwd: join(ws, 'a') }] })
    expect(result.status).toBe('started')
    if (result.status === 'started') expect(result.state.status).toBe('running')
  })

  it('queues a second run2:start on a busy workspace instead of throwing (does not start its provider yet)', () => {
    const { provider, calls } = controllableProvider()
    const mgr = new Run2Manager({ providers: { x: provider }, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
    const planA = planFromStages('run-a', ungatedStages)
    mgr.start({ workspacePath: ws, runId: 'run-a', plan: planA, projects: [{ name: 'a', cwd: join(ws, 'a') }] })
    expect(calls.length).toBe(1) // run A's provider started immediately

    const planB = planFromStages('run-b', ungatedStages)
    const initB = mgr.start({ workspacePath: ws, runId: 'run-b', plan: planB, projects: [{ name: 'a', cwd: join(ws, 'a') }] })
    expect(initB).toEqual({ status: 'queued', position: 1 })
    expect(calls.length).toBe(1) // run B's provider NOT started — it's only queued
  })

  it('auto-starts the next queued run once the active run in that workspace finishes', async () => {
    const { provider, calls } = controllableProvider()
    const mgr = new Run2Manager({ providers: { x: provider }, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
    const planA = planFromStages('run-a', ungatedStages)
    mgr.start({ workspacePath: ws, runId: 'run-a', plan: planA, projects: [{ name: 'a', cwd: join(ws, 'a') }] })

    const planB = planFromStages('run-b', ungatedStages)
    const initB = mgr.start({ workspacePath: ws, runId: 'run-b', plan: planB, projects: [{ name: 'a', cwd: join(ws, 'a') }] })
    expect(initB).toEqual({ status: 'queued', position: 1 })
    expect(calls.length).toBe(1)

    // finish run A — its `.finally` should free the lock and dequeue+start run B
    calls[0].resolve()
    await new Promise((r) => setTimeout(r, 50))

    expect(calls.length).toBe(2) // run B's provider was started
    expect(mgr.isActive(ws)).toBe(true) // run B is now the active (not-yet-finished) controller
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
    expect(init2.status).toBe('started')
    if (init2.status === 'started') expect(init2.state.status).toBe('running')
    expect(mgr.lastStateFor(ws)).toBeNull()
  })

  it('bridges controller.onLog to emit.log with the workspace path', async () => {
    const logs: Array<{ workspacePath: string; log: RunLogLine }> = []
    const provider: AgentProvider = {
      id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
      async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
      run(task: AgentTask, cb: AgentCallbacks) {
        cb.onLog({ ts: '', text: 'x', level: 'run', kind: 'output' })
        const done = (async () => { cb.onHandoff?.({ summary: 'done' }); const r = { ok: true, summary: '' }; cb.onDone(r); return r })()
        return { id: task.agentId, cancel() {}, done }
      },
    }
    const mgr = new Run2Manager({
      providers: { x: provider }, env: {},
      makeStore: (w, r) => new RunStore(w, r),
      emit: {
        event: () => {}, update: () => {},
        log: (workspacePath, log) => logs.push({ workspacePath, log }),
      },
    })
    const plan = planFromStages('run-log', stages)
    mgr.start({ workspacePath: ws, runId: 'run-log', plan, projects: [{ name: 'a', cwd: join(ws, 'a') }] })
    await new Promise((r) => setTimeout(r, 50))
    expect(logs.length).toBeGreaterThan(0)
    expect(logs[0].workspacePath).toBe(ws)
    expect(logs[0].log).toMatchObject({
      laneId: expect.any(String),
      agentName: expect.any(String),
      line: { kind: 'output', text: 'x' },
    })
  })

  it('threads Run2StartOpts.permissionMode through the controller into the work order task', async () => {
    const seenModes: Array<string | undefined> = []
    const provider: AgentProvider = {
      id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
      async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
      run(task: AgentTask, cb: AgentCallbacks) {
        seenModes.push(task.permissionMode)
        const done = (async () => { cb.onHandoff?.({ summary: 'done' }); const r = { ok: true, summary: '' }; cb.onDone(r); return r })()
        return { id: task.agentId, cancel() {}, done }
      },
    }
    const mgr = new Run2Manager({
      providers: { x: provider }, env: {},
      makeStore: (w, r) => new RunStore(w, r),
      emit: { event: () => {}, update: () => {} },
    })
    const plan = planFromStages('run-perm', stages)
    mgr.start({ workspacePath: ws, runId: 'run-perm', plan, projects: [{ name: 'a', cwd: join(ws, 'a') }], permissionMode: 'readonly' })
    await new Promise((r) => setTimeout(r, 50))
    expect(seenModes).toEqual(['readonly'])
  })

  it('defaults permissionMode to \'full\' when Run2StartOpts omits it', async () => {
    const seenModes: Array<string | undefined> = []
    const provider: AgentProvider = {
      id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
      async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
      run(task: AgentTask, cb: AgentCallbacks) {
        seenModes.push(task.permissionMode)
        const done = (async () => { cb.onHandoff?.({ summary: 'done' }); const r = { ok: true, summary: '' }; cb.onDone(r); return r })()
        return { id: task.agentId, cancel() {}, done }
      },
    }
    const mgr = new Run2Manager({
      providers: { x: provider }, env: {},
      makeStore: (w, r) => new RunStore(w, r),
      emit: { event: () => {}, update: () => {} },
    })
    const plan = planFromStages('run-perm-default', stages)
    mgr.start({ workspacePath: ws, runId: 'run-perm-default', plan, projects: [{ name: 'a', cwd: join(ws, 'a') }] })
    await new Promise((r) => setTimeout(r, 50))
    expect(seenModes).toEqual(['full'])
  })

  it('threads Run2StartOpts.sessionId through to the controller\'s exposed state (spec §8 run-owning-session)', () => {
    const mgr = new Run2Manager({
      providers: { x: gatedProvider() }, env: {},
      makeStore: (w, r) => new RunStore(w, r),
      emit: { event: () => {}, update: () => {} },
    })
    const plan = planFromStages('run-sid', stages)
    const result = mgr.start({ workspacePath: ws, runId: 'run-sid', plan, projects: [{ name: 'a', cwd: join(ws, 'a') }], sessionId: 'sess-owner' })
    expect(result.status).toBe('started')
    expect(result.status === 'started' && result.state.sessionId).toBe('sess-owner')
    expect(mgr.get(ws)?.state.sessionId).toBe('sess-owner')
  })

  it('leaves sessionId undefined when Run2StartOpts omits it (legacy/direct-start callers)', () => {
    const mgr = new Run2Manager({
      providers: { x: gatedProvider() }, env: {},
      makeStore: (w, r) => new RunStore(w, r),
      emit: { event: () => {}, update: () => {} },
    })
    const plan = planFromStages('run-nosid', stages)
    const result = mgr.start({ workspacePath: ws, runId: 'run-nosid', plan, projects: [{ name: 'a', cwd: join(ws, 'a') }] })
    expect(result.status === 'started' && result.state.sessionId).toBeUndefined()
  })

  it('pause/resume/requestJumpBack route to the active workspace\'s controller', async () => {
    const mgr = new Run2Manager({
      providers: { x: gatedProvider() }, env: {},
      makeStore: (w, r) => new RunStore(w, r),
      emit: { event: () => {}, update: () => {} },
    })
    const plan = planFromStages('run-ctl', stages)
    mgr.start({ workspacePath: ws, runId: 'run-ctl', plan, projects: [{ name: 'a', cwd: join(ws, 'a') }] })
    const ctl = mgr.get(ws)
    expect(ctl).toBeDefined()
    const pauseSpy = vi.spyOn(ctl!, 'pause')
    const resumeSpy = vi.spyOn(ctl!, 'resume')
    const jumpSpy = vi.spyOn(ctl!, 'requestJumpBack')

    mgr.pause(ws)
    expect(pauseSpy).toHaveBeenCalledTimes(1)

    mgr.resume(ws)
    expect(resumeSpy).toHaveBeenCalledTimes(1)

    mgr.requestJumpBack(ws, 'design')
    expect(jumpSpy).toHaveBeenCalledTimes(1)
    expect(jumpSpy).toHaveBeenCalledWith('design')
  })

  it('pause/resume/requestJumpBack on an unknown workspace are safe no-ops', () => {
    const mgr = new Run2Manager({ providers: {}, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
    expect(() => mgr.pause('/nope')).not.toThrow()
    expect(() => mgr.resume('/nope')).not.toThrow()
    expect(() => mgr.requestJumpBack('/nope', 'design')).not.toThrow()
  })
})
