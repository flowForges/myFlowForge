import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RunStore } from '../run/runStore'
import { Run2Manager } from './manager'
import { planFromStages } from './planFromStages'
import { saveControllerState } from './persist'
import type { StageSpec, DevelopProject } from '../run/runTypes'
import type { RunEvent } from './events'
import type { AgentProvider, AgentTask, AgentCallbacks } from '../agents/types'
import type { RunControllerState, RunLogLine } from './controller'
import type { MachineState, RunPlan } from './machine'
import type { GateDecision } from './decisions'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'mgr-')) })
afterEach(() => { rmSync(ws, { recursive: true, force: true }) })

function gatedProvider(): AgentProvider {
  return {
    id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
    async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
    run(task: AgentTask, cb: AgentCallbacks) {
      const done = (async () => { cb.onHandoff?.({ summary: 'done', artifacts: [{ path: 'design.md', kind: 'md' }] }); const r = { ok: true, summary: '' }; cb.onDone(r); return r })()
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
        resolveFn = () => { cb.onHandoff?.({ summary: 'done', artifacts: [{ path: 'design.md', kind: 'md' }] }); const r = { ok: true, summary: '' }; cb.onDone(r); resolve(r) }
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
        const done = (async () => { cb.onHandoff?.({ summary: 'done', artifacts: [{ path: 'design.md', kind: 'md' }] }); const r = { ok: true, summary: '' }; cb.onDone(r); return r })()
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
        const done = (async () => { cb.onHandoff?.({ summary: 'done', artifacts: [{ path: 'design.md', kind: 'md' }] }); const r = { ok: true, summary: '' }; cb.onDone(r); return r })()
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
        const done = (async () => { cb.onHandoff?.({ summary: 'done', artifacts: [{ path: 'design.md', kind: 'md' }] }); const r = { ok: true, summary: '' }; cb.onDone(r); return r })()
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

  // Prior review gap: Run2Manager threads mergeTempBranch/discardTempBranch/parkTempBranch (Run2StartOpts)
  // through to the RunController it constructs (startNow), but that wiring had no DEDICATED coverage —
  // only exercised incidentally by other tests that never actually configure projectTargets. These two
  // tests reuse the exact fake-git injection pattern controller.test.ts uses for its own P4-3 (finalize
  // merge/discard) and Finding 4 (abort-parks) coverage, but drive it through manager.start() instead of
  // `new RunController` directly, proving the manager — not just the controller — wires them correctly.
  describe('git-op deps passthrough: manager.start() wires mergeTempBranch/parkTempBranch through to the controller', () => {
    it('finalize gate 合并并完成 calls the mergeTempBranch injected via Run2StartOpts, for every participating project', async () => {
      const mergeCalls: Array<{ cwd: string; target: string; runId: string }> = []
      const mgr = new Run2Manager({
        providers: { x: gatedProvider() }, env: {},
        makeStore: (w, r) => new RunStore(w, r),
        emit: {
          event: (_ws, e) => { if (e.kind === 'gate') mgr.resolveGate(_ws, e.id, (e as any).finalize ? { type: 'merge' } : { type: 'advance' }) },
          update: () => {},
        },
      })
      const gitStages: StageSpec[] = [
        { key: 'design', name: '方案', provider: 'x', model: 'm', scope: 'root', gate: true },
        { key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: false },
      ]
      const plan = planFromStages('run-git-merge', gitStages)
      const projects = [{ name: 'a', cwd: join(ws, 'a') }, { name: 'b', cwd: join(ws, 'b') }]
      mgr.start({
        workspacePath: ws, runId: 'run-git-merge', plan, projects,
        projectTargets: { a: 'main', b: 'main' },
        mergeTempBranch: async (cwd, target, runId) => { mergeCalls.push({ cwd, target, runId }) },
      })
      await new Promise((r) => setTimeout(r, 50))
      expect(mgr.lastStateFor(ws)?.status).toBe('ok')
      expect(mergeCalls).toEqual([
        { cwd: join(ws, 'a'), target: 'main', runId: 'run-git-merge' },
        { cwd: join(ws, 'b'), target: 'main', runId: 'run-git-merge' },
      ])
    })

    it('a mid-run abort calls the parkTempBranch injected via Run2StartOpts, for every participating project (Finding 4: abort parks, never merges/discards)', async () => {
      const parkCalls: Array<{ cwd: string; target: string; runId: string }> = []
      const authIds: string[] = []
      const askingProvider: AgentProvider = {
        id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
        async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
        run(task: AgentTask, cb: AgentCallbacks) {
          const done = (async () => {
            const ok = await cb.onConfirm({ title: 'overwrite' })
            cb.onHandoff?.({ summary: `confirm=${ok}` }); const r = { ok: true, summary: '' }; cb.onDone(r); return r
          })()
          return { id: task.agentId, cancel() {}, done }
        },
      }
      const perProjectStages: StageSpec[] = [{ key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: false }]
      const mgr = new Run2Manager({
        providers: { x: askingProvider }, env: {},
        makeStore: (w, r) => new RunStore(w, r),
        emit: {
          event: (_ws, e) => {
            if (e.kind !== 'auth') return
            authIds.push(e.id)
            if (authIds.length === 2) mgr.resolveLane(_ws, authIds[0], { type: 'abort' })
          },
          update: () => {},
        },
      })
      const plan = planFromStages('run-git-park', perProjectStages)
      const projects = [{ name: 'a', cwd: join(ws, 'a') }, { name: 'b', cwd: join(ws, 'b') }]
      mgr.start({
        workspacePath: ws, runId: 'run-git-park', plan, projects,
        projectTargets: { a: 'main', b: 'main' },
        parkTempBranch: async (cwd, target, runId) => { parkCalls.push({ cwd, target, runId }) },
      })
      await new Promise((r) => setTimeout(r, 50))
      expect(mgr.lastStateFor(ws)?.status).toBe('failed')
      expect(parkCalls).toEqual([
        { cwd: join(ws, 'a'), target: 'main', runId: 'run-git-park' },
        { cwd: join(ws, 'b'), target: 'main', runId: 'run-git-park' },
      ])
    })
  })

  describe('disk-resume (P-C2/T2): resumable()/resumeFromDisk() for an interrupted run', () => {
    // Mirrors exactly what saveControllerState (persist.ts) writes on every emitUpdate() — a
    // 3-stage plan with s1 already `done` (the app died sometime after s1 finished, before s2/s3).
    function fixtureState(status: RunControllerState['status']): RunControllerState {
      const plan: RunPlan = { runId: 'run-x', stages: [
        { key: 's1', name: 'S1', provider: 'x', model: 'm', scope: 'root', gate: false },
        { key: 's2', name: 'S2', provider: 'x', model: 'm', scope: 'root', gate: false },
        { key: 's3', name: 'S3', provider: 'x', model: 'm', scope: 'root', gate: false },
      ] }
      const machine: MachineState = {
        plan,
        stages: [
          { key: 's1', status: 'done', round: 0 },
          { key: 's2', status: 'pending', round: 0 },
          { key: 's3', status: 'pending', round: 0 },
        ],
        currentIndex: 1,
      }
      return { machine, inbox: [], feedback: [], outcomes: {}, status, pendingDirective: {}, liveLanes: {}, stageTimings: {}, laneTimings: {}, laneSessions: {}, paused: false }
    }
    function seed(runId: string, status: RunControllerState['status']) {
      saveControllerState(new RunStore(ws, runId), fixtureState(status))
    }


    // 真实事故(2026-08-12):所有阶段跑完、合并临时分支失败,用户却被问「上次有工作流未完成,从**代码CR**
    // 继续?」——代码CR 早跑完了,该重来的是收尾。恢复其实是对的(所有阶段 done 时 controller 直接跳到
    // 收尾门),错的是这句话:它按「第一个没完成的阶段」找,找不到就回落到最后一个阶段,于是指着代码CR。
    describe('收尾失败:提示要说"重新收尾",不能指着已经跑完的最后一个阶段', () => {
      function finishedButUnmerged(): RunControllerState {
        const st = fixtureState('failed')
        return {
          ...st,
          machine: { ...st.machine, stages: st.machine.stages.map((x) => ({ ...x, status: 'done' as const })), currentIndex: 2 },
          error: '合并临时分支失败 — a: CONFLICT (content): Merge conflict in src/x.ts',
          finalized: false,
        }
      }

      it('仍然可恢复(不然用户没有重试合并的路,只能自己去 git 里收拾)', () => {
        const mgr = new Run2Manager({ providers: {}, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
        saveControllerState(new RunStore(ws, 'run-fin'), finishedButUnmerged())
        expect(mgr.resumable(ws)).not.toBeNull()
      })

      it('提示指向收尾,而不是最后一个阶段', () => {
        const mgr = new Run2Manager({ providers: {}, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
        saveControllerState(new RunStore(ws, 'run-fin'), finishedButUnmerged())
        const r = mgr.resumable(ws)!
        expect(r.finalizeOnly).toBe(true)
        expect(r.resumeStageName).toContain('收尾')
        expect(r.resumeStageKey).not.toBe('s3')
      })

      it('带上失败原因,让提示能说清为什么要重来', () => {
        const mgr = new Run2Manager({ providers: {}, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
        saveControllerState(new RunStore(ws, 'run-fin'), finishedButUnmerged())
        expect(mgr.resumable(ws)!.error).toContain('Merge conflict')
      })

      it('点「继续」能真的重新收尾:resumeFromDisk 不再把它当作"没有可恢复的运行"拒掉', async () => {
        const mgr = new Run2Manager({ providers: {}, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
        saveControllerState(new RunStore(ws, 'run-fin'), finishedButUnmerged())
        expect(() => mgr.resumeFromDisk(ws, { projects: [{ name: 'a', cwd: join(ws, 'a') }] })).not.toThrow()
      })

      it('阶段全 done 且已收尾的运行不再提供恢复(它是真的完事了)', () => {
        const mgr = new Run2Manager({ providers: {}, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
        saveControllerState(new RunStore(ws, 'run-done'), { ...finishedButUnmerged(), status: 'ok', finalized: true, error: undefined })
        expect(mgr.resumable(ws)).toBeNull()
      })

      it('普通的阶段中断仍按老规矩报「从某阶段继续」,不受影响', () => {
        const mgr = new Run2Manager({ providers: {}, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
        seed('run-mid', 'running')
        const r = mgr.resumable(ws)!
        expect(r.finalizeOnly).toBeFalsy()
        expect(r.resumeStageKey).toBe('s2')
      })
    })

    it('resumable() summarizes a non-terminal saved run2-state (resume stage = first non-done, doneCount counts `done` stages)', () => {
      const mgr = new Run2Manager({ providers: {}, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
      seed('run-x', 'running')
      expect(mgr.resumable(ws)).toEqual({
        runId: 'run-x', resumeStageKey: 's2', resumeStageName: 'S2', totalStages: 3, doneCount: 1,
      })
    })

    it('resumable() folds leadStages into the count so it reads in FULL-workflow numbering (2/4, not 1/3)', () => {
      // Conversational tail run: 技术方案设计 already ran in chat → a leadStage; the tail plan is the
      // 3 stages below with s1(develop) done. The banner must count the design leadStage too so it
      // reads "已完成 2/4，从 S2 继续" and lines up with the ribbon's 4-stage numbering (not 1/3).
      const mgr = new Run2Manager({ providers: {}, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
      const st = fixtureState('running')
      st.machine.plan.leadStages = [{ key: 'design', name: '技术方案设计', provider: 'x', model: 'm' }]
      saveControllerState(new RunStore(ws, 'run-lead'), st)
      expect(mgr.resumable(ws)).toMatchObject({ resumeStageKey: 's2', resumeStageName: 'S2', totalStages: 4, doneCount: 2 })
    })

    it('resumable() also recognizes an `awaiting` (parked at a gate) saved status as non-terminal', () => {
      const mgr = new Run2Manager({ providers: {}, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
      seed('run-x', 'awaiting')
      expect(mgr.resumable(ws)?.resumeStageKey).toBe('s2')
    })

    it('resumable() carries the owning sessionId through from the saved state (N1: banner must be scoped to the owning session)', () => {
      const mgr = new Run2Manager({ providers: {}, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
      saveControllerState(new RunStore(ws, 'run-x'), { ...fixtureState('running'), sessionId: 's1' })
      expect(mgr.resumable(ws)?.sessionId).toBe('s1')
    })

    it('resumable() returns null for a TERMINAL (ok/failed) saved run2-state — a finished run is not resumable', () => {
      const mgr = new Run2Manager({ providers: {}, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
      seed('run-ok', 'ok')
      expect(mgr.resumable(ws)).toBeNull()
      seed('run-failed', 'failed')
      expect(mgr.resumable(ws)).toBeNull()
    })

    it('resumable() returns null when there is no saved run2-state at all', () => {
      const mgr = new Run2Manager({ providers: {}, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
      expect(mgr.resumable(ws)).toBeNull()
    })

    it('resumable() returns null when the workspace already has a LIVE in-memory controller (disk-resume is only for a run nothing is driving)', () => {
      const mgr = new Run2Manager({ providers: { x: gatedProvider() }, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
      // a non-terminal saved state also happens to be sitting on disk for this workspace...
      seed('run-x', 'running')
      // ...but a DIFFERENT run is live in memory right now — not resumable while that's the case.
      const plan = planFromStages('run-live', stages)
      mgr.start({ workspacePath: ws, runId: 'run-live', plan, projects: [{ name: 'a', cwd: join(ws, 'a') }] })
      expect(mgr.isActive(ws)).toBe(true)
      expect(mgr.resumable(ws)).toBeNull()
    })

    it('resumeFromDisk() rebuilds a controller via rehydrate and resumes from the first non-done stage (the `done` stage\'s provider is never re-invoked)', async () => {
      const calls: string[] = []
      const provider: AgentProvider = {
        id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
        async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
        run(task: AgentTask, cb: AgentCallbacks) {
          calls.push(task.stageKey)
          const done = (async () => { cb.onHandoff?.({ summary: 'ok' }); const r = { ok: true, summary: '' }; cb.onDone(r); return r })()
          return { id: task.agentId, cancel() {}, done }
        },
      }
      const mgr = new Run2Manager({ providers: { x: provider }, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
      seed('run-x', 'running')

      const state = mgr.resumeFromDisk(ws, { projects: [{ name: 'a', cwd: join(ws, 'a') }] })
      expect(state.status).toBe('running')
      expect(mgr.isActive(ws)).toBe(true)

      await new Promise((r) => setTimeout(r, 50))
      expect(calls).toEqual(['s2', 's3']) // s1 was already `done` on disk — never re-invoked
      expect(mgr.isActive(ws)).toBe(false)
      expect(mgr.lastStateFor(ws)?.status).toBe('ok')
    })

    // P-C2/T3 review Finding 1 (CRITICAL): the resumed controller must fan out per-project work
    // ONLY against the run's ORIGINAL gate-selected subset (persisted via saveControllerState's
    // `projects` field — see persist.ts), never against whatever "every project on the workspace"
    // list a resume caller happens to supply. Getting this wrong let a resumed per-project stage run
    // an agent against a project the original run never selected and never checked out onto the
    // run's temp branch — corrupting that project's REAL branch at the finalize gate.
    it('resumeFromDisk() prefers the PERSISTED projects subset over the caller-supplied opts.projects', async () => {
      const calls: string[] = []
      const provider: AgentProvider = {
        id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
        async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
        run(task: AgentTask, cb: AgentCallbacks) {
          calls.push(task.cwd)
          const done = (async () => { cb.onHandoff?.({ summary: 'ok' }); const r = { ok: true, summary: '' }; cb.onDone(r); return r })()
          return { id: task.agentId, cancel() {}, done }
        },
      }
      const plan: RunPlan = { runId: 'run-subset', stages: [
        { key: 's1', name: 'S1', provider: 'x', model: 'm', scope: 'root', gate: false },
        { key: 's2', name: 'S2', provider: 'x', model: 'm', scope: 'per-project', gate: false },
      ] }
      const machine: MachineState = {
        plan,
        stages: [
          { key: 's1', status: 'done', round: 0 },
          { key: 's2', status: 'pending', round: 0 },
        ],
        currentIndex: 1,
      }
      // The ORIGINAL run only ever selected ONE project ('go-blog') — persisted verbatim.
      const persistedProjects = [{ name: 'go-blog', cwd: join(ws, 'go-blog') }]
      const state: RunControllerState = {
        machine, inbox: [], feedback: [], outcomes: {}, status: 'running', pendingDirective: {},
        liveLanes: {}, stageTimings: {}, laneTimings: {}, laneSessions: {}, paused: false, projects: persistedProjects,
      }
      saveControllerState(new RunStore(ws, 'run-subset'), state)

      const mgr = new Run2Manager({ providers: { x: provider }, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
      // Caller supplies THREE projects (mirrors the IPC handler's legacy "every project on the
      // workspace" reconstruction) — the fix must ignore the extras in favor of the persisted subset.
      mgr.resumeFromDisk(ws, { projects: [
        { name: 'api', cwd: join(ws, 'api') },
        { name: 'go-blog', cwd: join(ws, 'go-blog') },
        { name: 'web', cwd: join(ws, 'web') },
      ] })

      await new Promise((r) => setTimeout(r, 50))
      expect(calls).toEqual([join(ws, 'go-blog')]) // only the persisted project ran — never api/web
      expect(mgr.lastStateFor(ws)?.status).toBe('ok')
    })

    it('resumeFromDisk() registers under the serial lock: rejects a second resumeFromDisk while active, and start() queues instead of stealing the lock', async () => {
      const { provider, calls } = controllableProvider()
      const mgr = new Run2Manager({ providers: { x: provider }, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
      seed('run-x', 'running')

      mgr.resumeFromDisk(ws, { projects: [{ name: 'a', cwd: join(ws, 'a') }] })
      expect(mgr.isActive(ws)).toBe(true)
      expect(calls.length).toBe(1) // s2 started

      // a second resumeFromDisk while the workspace is already active must not spin up a
      // competing controller for the same workspace.
      expect(() => mgr.resumeFromDisk(ws, { projects: [{ name: 'a', cwd: join(ws, 'a') }] })).toThrow()

      // a plain start() while active queues (existing serial-lock behavior, unchanged by this task).
      const planOther = planFromStages('run-other', ungatedStages)
      const initOther = mgr.start({ workspacePath: ws, runId: 'run-other', plan: planOther, projects: [{ name: 'a', cwd: join(ws, 'a') }] })
      expect(initOther).toEqual({ status: 'queued', position: 1 })
      expect(calls.length).toBe(1) // still just the resumed run's lane — nothing else started
    })

    it('resumeFromDisk() throws when there is nothing resumable (no saved state, or a terminal one)', () => {
      const mgr = new Run2Manager({ providers: {}, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
      expect(() => mgr.resumeFromDisk(ws, { projects: [] })).toThrow()
      seed('run-x', 'failed')
      expect(() => mgr.resumeFromDisk(ws, { projects: [] })).toThrow()
    })

    // P-C2/T4: the capstone end-to-end test — unlike every test above (which hand-builds a
    // RunControllerState fixture via saveControllerState), this one drives a REAL RunController
    // through manager.start(), lets it persist mid-flight PURELY via its own automatic
    // emitUpdate()→saveControllerState() wiring (P2 Task 7), abandons that controller mid-run
    // (simulating the app process disappearing), then hands the SAME on-disk workspace to a
    // brand-new Run2Manager (simulating a fresh process after restart) and resumes it to completion.
    it('end-to-end: a run started via manager.start(), persisted automatically mid-flight (no hand-built fixture), resumes on a brand-new Run2Manager and completes — done stage never re-invoked, only the persisted project subset participates, sessionId recovered', async () => {
      const wsA = join(ws, 'a')
      const wsB = join(ws, 'b')
      const callsBeforeCrash: string[] = []
      // The process running BEFORE the crash: s1 (root) completes normally; s2 (per-project) starts
      // BOTH lanes, but project 'b's agent never resolves `done` — exactly what a real crash leaves
      // behind (an in-flight lane with nothing left to await it). s3 is never reached.
      const providerBeforeCrash: AgentProvider = {
        id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
        async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
        run(task: AgentTask, cb: AgentCallbacks) {
          callsBeforeCrash.push(`${task.stageKey}:${task.cwd}`)
          if (task.stageKey === 's2' && task.cwd === wsB) {
            return { id: task.agentId, cancel() {}, done: new Promise(() => {}) } // the "process died" lane
          }
          const done = (async () => { cb.onHandoff?.({ summary: 'ok' }); const r = { ok: true, summary: '' }; cb.onDone(r); return r })()
          return { id: task.agentId, cancel() {}, done }
        },
      }
      const mgr1 = new Run2Manager({ providers: { x: providerBeforeCrash }, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
      const plan: RunPlan = {
        runId: 'run-e2e', stages: [
          { key: 's1', name: 'S1', provider: 'x', model: 'm', scope: 'root', gate: false },
          { key: 's2', name: 'S2', provider: 'x', model: 'm', scope: 'per-project', gate: false },
          { key: 's3', name: 'S3', provider: 'x', model: 'm', scope: 'root', gate: false },
        ],
      }
      // The run only ever selects TWO projects — a THIRD ('c') will be in the resume caller's
      // opts.projects below (mirroring run2Handlers' legacy "every project on the workspace"
      // fallback), proving the persisted subset — not the caller's list — wins.
      const selectedProjects = [{ name: 'a', cwd: wsA }, { name: 'b', cwd: wsB }]
      mgr1.start({ workspacePath: ws, runId: 'run-e2e', plan, projects: selectedProjects, sessionId: 'sess-e2e' })

      // Let s1 finish and s2's lanes start (one hangs on project 'b'). By now the REAL controller's
      // emitUpdate() has already written s1:'done'/s2:'running' to disk (saveControllerState) —
      // exactly the on-disk snapshot a real crash would leave at this instant.
      await new Promise((r) => setTimeout(r, 50))
      expect(callsBeforeCrash.sort()).toEqual([`s1:${ws}`, `s2:${wsA}`, `s2:${wsB}`].sort())
      // mgr1's controller.start() promise never settles (project 'b' hangs forever) — deliberately
      // abandoned here and never referenced again, mirroring the app process disappearing.

      // --- "app restart": a BRAND-NEW Run2Manager wired to brand-new provider objects, sharing
      // nothing in memory with mgr1 — only the on-disk workspace path connects them.
      const callsAfterRestart: string[] = []
      const providerAfterRestart: AgentProvider = {
        id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
        async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
        run(task: AgentTask, cb: AgentCallbacks) {
          callsAfterRestart.push(`${task.stageKey}:${task.cwd}`)
          const done = (async () => { cb.onHandoff?.({ summary: 'ok' }); const r = { ok: true, summary: '' }; cb.onDone(r); return r })()
          return { id: task.agentId, cancel() {}, done }
        },
      }
      const mgr2 = new Run2Manager({ providers: { x: providerAfterRestart }, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })

      const summary = mgr2.resumable(ws)
      expect(summary).toMatchObject({ runId: 'run-e2e', resumeStageKey: 's2', resumeStageName: 'S2', totalStages: 3, doneCount: 1 })

      const resumedState = mgr2.resumeFromDisk(ws, { projects: [
        { name: 'a', cwd: wsA }, { name: 'b', cwd: wsB }, { name: 'c', cwd: join(ws, 'c') },
      ] })
      expect(resumedState.status).toBe('running')
      expect(mgr2.isActive(ws)).toBe(true)

      await new Promise((r) => setTimeout(r, 50))

      // (a) s1's provider is NEVER re-invoked in the resumed process — it had already reached `done`.
      expect(callsAfterRestart.some((c) => c.startsWith('s1:'))).toBe(false)
      // (b) the run reaches completion (s2's remaining work + s3 both run, to a terminal 'ok').
      expect(mgr2.lastStateFor(ws)?.status).toBe('ok')
      // (c) only the persisted subset (a, b) ever ran — project 'c' from the caller's opts never did.
      expect(callsAfterRestart).toEqual([`s2:${wsA}`, `s2:${wsB}`, `s3:${ws}`])
      // (d) sessionId recovered from disk — the resumed run stays scoped to the ORIGINAL session that
      // launched it (spec §8: interaction cards scope to the owning session).
      expect(mgr2.lastStateFor(ws)?.sessionId).toBe('sess-e2e')
    })
  })
})

// Task 5: the on-disk run2-state now carries its OWN projectTargets/snapshots (the branch/SHA
// createRunTempBranches actually measured at launch — see controller.ts's RunControllerState doc).
// resumeFromDisk must prefer THOSE over whatever the resume caller (run2Handlers.ts) re-derives from
// ws.projects[].branch — otherwise a resumed run's merge target flips back to the stale config value,
// letting the 2026-08-17 bug back in through the resume entrance. Mirrors the `projects` subset fix
// (P-C2/T3 review Finding 1) above — same precedence, same reasoning, one field over.
describe('resumeFromDisk 目标分支来源', () => {
  // A single already-`done` root stage: sanitizeForResume finds nothing left to run, so start()'s
  // main loop breaks immediately and goes straight to runFinalizeGate() — exactly what these tests
  // want to observe (which projectTargets/snapshots the finalize gate acts on), without needing to
  // drive any lane/provider through the resumed stage first.
  function makeSavedState(overrides: Partial<RunControllerState> & { projects: DevelopProject[] }): RunControllerState {
    const plan: RunPlan = { runId: 'r1', stages: [
      { key: 's1', name: 'S1', provider: 'x', model: 'm', scope: 'root', gate: false },
    ] }
    const machine: MachineState = { plan, stages: [{ key: 's1', status: 'done', round: 0 }], currentIndex: 0 }
    return {
      machine, inbox: [], feedback: [], outcomes: {}, status: 'failed', pendingDirective: {},
      liveLanes: {}, stageTimings: {}, laneTimings: {}, laneSessions: {}, paused: false,
      finalized: false,
      ...overrides,
    }
  }
  function writeSavedState(wsPath: string, runId: string, state: RunControllerState) {
    saveControllerState(new RunStore(wsPath, runId), state)
  }
  // Captures every finalize-gate event this manager's controller(s) raise, keyed by nothing more
  // than emission order — these tests only ever have one live run at a time, so "the next one
  // raised" is unambiguous. Reset per-test via the closure below (a fresh array each makeManager()).
  function makeManager(): { mgr: Run2Manager; finalizeGates: Array<{ wsPath: string; eventId: string }> } {
    const finalizeGates: Array<{ wsPath: string; eventId: string }> = []
    const mgr = new Run2Manager({
      providers: {}, env: {}, makeStore: (w, r) => new RunStore(w, r),
      emit: {
        event: (wsPath, e) => { if (e.kind === 'gate' && (e as { finalize?: boolean }).finalize) finalizeGates.push({ wsPath, eventId: e.id }) },
        update: () => {},
      },
    })
    return { mgr, finalizeGates }
  }
  // Waits for the finalize gate raised by a resumed (all-stages-done) run, then resolves it with
  // `decision` and lets the resulting merge/discard settle — the gate fires asynchronously, inside
  // start()'s fire-and-forget promise chain kicked off by resumeFromDisk(), so there's nothing to
  // directly await; polling `finalizeGates` (populated by makeManager()'s event hook) is the only way in.
  async function settleFinalizeGate(mgr: Run2Manager, finalizeGates: Array<{ wsPath: string; eventId: string }>, wsPath: string, decision: GateDecision): Promise<void> {
    for (let i = 0; i < 40 && finalizeGates.length === 0; i++) await new Promise((r) => setTimeout(r, 5))
    const gate = finalizeGates.find((g) => g.wsPath === wsPath)
    if (!gate) throw new Error('settleFinalizeGate: no finalize gate event was raised')
    mgr.resolveGate(gate.wsPath, gate.eventId, decision)
    await new Promise((r) => setTimeout(r, 20))
  }

  it('盘上存的 projectTargets 优先于调用方推导的', async () => {
    // 盘上这个 run 当初跑在 branch1；调用方（run2Handlers）按 ws.projects[].branch 推导出 main。
    // 必须用 branch1 —— 否则恢复一次就把改动合到错误的分支上。
    const saved = makeSavedState({
      status: 'failed',
      projects: [{ name: 'web', cwd: join(ws, 'web') }],
      projectTargets: { web: 'branch1' },
      snapshots: { web: 'sha-web' },
    })
    writeSavedState(ws, 'r1', saved)

    const merged: Array<[string, string]> = []
    const { mgr, finalizeGates } = makeManager()
    const state = mgr.resumeFromDisk(ws, {
      projects: [{ name: 'web', cwd: join(ws, 'web') }],
      projectTargets: { web: 'main' },          // 调用方的推导，必须被忽略
      mergeTempBranch: async (cwd, target) => { merged.push([cwd, target]) },
    })

    await settleFinalizeGate(mgr, finalizeGates, ws, { type: 'merge' })
    expect(merged).toEqual([[join(ws, 'web'), 'branch1']])
    expect(state).toBeTruthy()
  })

  it('旧盘上状态没有 projectTargets → 回落到调用方推导（向后兼容）', async () => {
    const saved = makeSavedState({ status: 'failed', projects: [{ name: 'web', cwd: join(ws, 'web') }] })
    // makeSavedState never sets projectTargets unless an override supplies it, so this is already
    // absent — the delete is defensive documentation of intent (mirrors the brief's literal test),
    // not load-bearing. Cast through `unknown` since RunControllerState has no index signature.
    delete (saved as unknown as Record<string, unknown>).projectTargets
    writeSavedState(ws, 'r1', saved)

    const merged: Array<[string, string]> = []
    const { mgr, finalizeGates } = makeManager()
    mgr.resumeFromDisk(ws, {
      projects: [{ name: 'web', cwd: join(ws, 'web') }],
      projectTargets: { web: 'main' },
      mergeTempBranch: async (cwd, target) => { merged.push([cwd, target]) },
    })

    await settleFinalizeGate(mgr, finalizeGates, ws, { type: 'merge' })
    expect(merged).toEqual([[join(ws, 'web'), 'main']])
  })
})
