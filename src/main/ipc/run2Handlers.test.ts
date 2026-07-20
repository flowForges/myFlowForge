import { describe, it, expect } from 'vitest'
import { registerRun2 } from './run2Handlers'
import { Run2Manager } from '../run/manager'
import { RunStore } from '../orchestrator/runStore'
import { saveControllerState } from '../run/persist'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as CH from './channels'
import type { Workspace } from '../config/schema'
import type { AgentProvider, AgentTask, AgentCallbacks } from '../agents/types'

function okProvider(): AgentProvider {
  return {
    id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
    async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
    run(task: AgentTask, cb: AgentCallbacks) {
      const done = (async () => { cb.onHandoff?.({ summary: 'ok' }); const r = { ok: true, summary: '' }; cb.onDone(r); return r })()
      return { id: task.agentId, cancel() {}, done }
    },
  }
}
// Captures task.permissionMode instead of just completing — used by the run2:start-workflow tests
// below to verify the default/passthrough reaches the actual AgentTask handed to the provider.
function capturingProvider(seen: Array<string | undefined>): AgentProvider {
  return {
    id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
    async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
    run(task: AgentTask, cb: AgentCallbacks) {
      seen.push(task.permissionMode)
      const done = (async () => { cb.onHandoff?.({ summary: 'ok' }); const r = { ok: true, summary: '' }; cb.onDone(r); return r })()
      return { id: task.agentId, cancel() {}, done }
    },
  }
}

describe('registerRun2', () => {
  it('wires run2:start through planFromStages + manager.start', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'r2h-'))
    try {
      const handlers = new Map<string, (...a: any[]) => any>()
      const manager = new Run2Manager({ providers: { x: okProvider() }, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
      registerRun2({ manager, onInvoke: (ch, h) => handlers.set(ch, h) })
      expect(handlers.has(CH.run2Start)).toBe(true)
      const start = handlers.get(CH.run2Start)!
      const result = await start({}, { workspacePath: ws, runId: 'r1', stages: [{ key: 'design', name: '方案', provider: 'x', model: 'm', scope: 'root', gate: false }], projects: [{ name: 'a', cwd: join(ws, 'a') }] })
      expect(result.status).toBe('started')
      expect(result.state.status).toBe('running')
      // abort handler exists and is safe
      const abort = handlers.get(CH.run2Abort)!
      expect(() => abort({}, { workspacePath: ws })).not.toThrow()
    } finally { rmSync(ws, { recursive: true, force: true }) }
  })

  it('wires run2:pause/resume/jump-back through to manager, no-throw on an unknown workspace', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'r2h-'))
    try {
      const handlers = new Map<string, (...a: any[]) => any>()
      const manager = new Run2Manager({ providers: { x: okProvider() }, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
      registerRun2({ manager, onInvoke: (ch, h) => handlers.set(ch, h) })
      expect(handlers.has(CH.run2Pause)).toBe(true)
      expect(handlers.has(CH.run2Resume)).toBe(true)
      expect(handlers.has(CH.run2JumpBack)).toBe(true)
      const pause = handlers.get(CH.run2Pause)!
      const resume = handlers.get(CH.run2Resume)!
      const jumpBack = handlers.get(CH.run2JumpBack)!
      // unknown workspace → safe no-ops (mirrors abort's contract above)
      expect(() => pause({}, { workspacePath: ws })).not.toThrow()
      expect(() => resume({}, { workspacePath: ws })).not.toThrow()
      expect(() => jumpBack({}, { workspacePath: ws, targetKey: 'design' })).not.toThrow()
    } finally { rmSync(ws, { recursive: true, force: true }) }
  })

  it('wires run2:get-state for mount/reload recovery', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'r2h-'))
    try {
      const handlers = new Map<string, (...a: any[]) => any>()
      const manager = new Run2Manager({ providers: { x: okProvider() }, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
      registerRun2({ manager, onInvoke: (ch, h) => handlers.set(ch, h) })
      expect(handlers.has(CH.run2GetState)).toBe(true)
      const getState = handlers.get(CH.run2GetState)!
      // unknown workspace → null
      expect(await getState({}, { workspacePath: ws })).toBeNull()
      // after starting a run, the handler returns the live controller state
      const start = handlers.get(CH.run2Start)!
      await start({}, { workspacePath: ws, runId: 'r1', stages: [{ key: 'design', name: '方案', provider: 'x', model: 'm', scope: 'root', gate: false }], projects: [{ name: 'a', cwd: join(ws, 'a') }] })
      const state = await getState({}, { workspacePath: ws })
      expect(state).not.toBeNull()
      expect(typeof state.status).toBe('string')
    } finally { rmSync(ws, { recursive: true, force: true }) }
  })

  it('run2:get-state falls back to the retained last-run state once a run has finished', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'r2h-'))
    try {
      const handlers = new Map<string, (...a: any[]) => any>()
      const manager = new Run2Manager({ providers: { x: okProvider() }, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
      registerRun2({ manager, onInvoke: (ch, h) => handlers.set(ch, h) })
      const start = handlers.get(CH.run2Start)!
      const getState = handlers.get(CH.run2GetState)!
      await start({}, { workspacePath: ws, runId: 'r1', stages: [{ key: 'design', name: '方案', provider: 'x', model: 'm', scope: 'root', gate: false }], projects: [{ name: 'a', cwd: join(ws, 'a') }] })
      // let the run settle to a terminal status and drop out of the manager's active-controllers map
      await new Promise((r) => setTimeout(r, 50))
      expect(manager.isActive(ws)).toBe(false)
      // the handler still returns the finished run's terminal state instead of null
      const state = await getState({}, { workspacePath: ws })
      expect(state).not.toBeNull()
      expect(state.status).toBe('ok')
    } finally { rmSync(ws, { recursive: true, force: true }) }
  })

  it('run2:start-workflow defaults permissionMode to \'full\' when the caller omits it (codex needs full to write files)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'r2h-'))
    try {
      const seen: Array<string | undefined> = []
      const handlers = new Map<string, (...a: any[]) => any>()
      const manager = new Run2Manager({ providers: { x: capturingProvider(seen) }, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
      const wsConfig: Workspace = {
        name: 'pay', path: ws, workflowId: '', stages: [],
        workflows: [{ id: 'wf1', name: '标准五段', stages: [{ key: 'develop', provider: 'x', model: 'm', scope: 'per-project', gate: false }] }],
        projects: [{ repoId: 'a', name: 'a', branch: 'main' }] as any,
        status: 'idle', plugins: [], stepPlugins: [],
      } as any
      registerRun2({ manager, onInvoke: (ch, h) => handlers.set(ch, h), readWorkspace: () => wsConfig, readWorkflows: () => [], readCustomStages: () => [] })
      const startWorkflow = handlers.get(CH.run2StartWorkflow)!
      await startWorkflow({}, { workspacePath: ws, workflowId: 'wf1', projectNames: ['a'], runId: 'r1' })
      await new Promise((r) => setTimeout(r, 50))
      expect(seen).toEqual(['full'])
    } finally { rmSync(ws, { recursive: true, force: true }) }
  })

  it('run2:start-workflow forwards an explicit permissionMode instead of the default', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'r2h-'))
    try {
      const seen: Array<string | undefined> = []
      const handlers = new Map<string, (...a: any[]) => any>()
      const manager = new Run2Manager({ providers: { x: capturingProvider(seen) }, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
      const wsConfig: Workspace = {
        name: 'pay', path: ws, workflowId: '', stages: [],
        workflows: [{ id: 'wf1', name: '标准五段', stages: [{ key: 'develop', provider: 'x', model: 'm', scope: 'per-project', gate: false }] }],
        projects: [{ repoId: 'a', name: 'a', branch: 'main' }] as any,
        status: 'idle', plugins: [], stepPlugins: [],
      } as any
      registerRun2({ manager, onInvoke: (ch, h) => handlers.set(ch, h), readWorkspace: () => wsConfig, readWorkflows: () => [], readCustomStages: () => [] })
      const startWorkflow = handlers.get(CH.run2StartWorkflow)!
      await startWorkflow({}, { workspacePath: ws, workflowId: 'wf1', projectNames: ['a'], runId: 'r1', permissionMode: 'readonly' })
      await new Promise((r) => setTimeout(r, 50))
      expect(seen).toEqual(['readonly'])
    } finally { rmSync(ws, { recursive: true, force: true }) }
  })

  it('run2:launch-start resolves the gate config (per-project provider/model) into a plan+projects and starts the run', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'r2h-'))
    try {
      const seen: Array<string | undefined> = []
      const handlers = new Map<string, (...a: any[]) => any>()
      const mergeCalls: Array<{ cwd: string; target: string }> = []
      const manager = new Run2Manager({
        providers: { codex: capturingProvider(seen), x: okProvider() }, env: {}, makeStore: (w, r) => new RunStore(w, r),
        emit: {
          event: (wp, e) => {
            // P4-3: this run's project DOES have a target branch (wsConfig.projects[].branch below),
            // so it now stops at a finalize gate after both stages complete — resolve it here (merge)
            // so this test keeps exercising the full run-to-'ok' path, same as before P4-3 existed.
            if (e.kind === 'gate' && (e as any).finalize) manager.resolveGate(wp, e.id, { type: 'merge' })
          },
          update: () => {},
        },
      })
      const wsConfig: Workspace = {
        name: 'pay', path: ws, workflowId: '', stages: [],
        workflows: [{ id: 'wf1', name: '标准五段', stages: [
          { key: 'design', provider: 'x', model: 'm', scope: 'root', gate: false },
          { key: 'develop', provider: 'x', model: 'm', scope: 'per-project', gate: false },
        ] }],
        projects: [{ repoId: 'api', name: 'api', branch: 'main' }, { repoId: 'web', name: 'web', branch: 'main' }] as any,
        status: 'idle', plugins: [], stepPlugins: [],
      } as any
      // P4-2: run2:launch-start now creates a real temp-branch checkout per participating project
      // before starting — stub it out here (no real git repo backs this tmpdir) so this test still
      // only exercises plan/project resolution + manager wiring, not git. Same for the P4-3 finalize
      // gate's merge action below (mergeTempBranch) — stubbed for the same reason. Finding 3: the
      // clean-tree precondition also runs real git by default — stub it too (this tmpdir isn't a repo).
      registerRun2({
        manager, onInvoke: (ch, h) => handlers.set(ch, h), readWorkspace: () => wsConfig, readWorkflows: () => [], readCustomStages: () => [],
        createTempBranch: async () => 'forge/run-stub',
        mergeTempBranch: async (cwd, target) => { mergeCalls.push({ cwd, target }) },
        checkClean: async () => true,
      })
      expect(handlers.has(CH.run2LaunchStart)).toBe(true)
      const launchStart = handlers.get(CH.run2LaunchStart)!
      const result = await launchStart({}, {
        workspacePath: ws, workflowId: 'wf1',
        projects: [{ name: 'api', provider: 'codex', model: 'g2' }], // 'web' NOT selected
        supplement: '补充说明文本', seed: '用户原话文本',
      })
      expect(result.status).toBe('started')
      await new Promise((r) => setTimeout(r, 50))
      // only the selected project's agent ran (captured by capturingProvider, wired to the 'codex'
      // provider id) — 'web' never ran because it wasn't in cfg.projects
      expect(seen).toEqual(['full'])
      const getState = handlers.get(CH.run2GetState)!
      const state = await getState({}, { workspacePath: ws })
      expect(state.status).toBe('ok')
      // only 'api' participated in the run (per cfg.projects above) — the finalize gate merges just
      // that one project's temp branch back onto its own configured target ('main').
      expect(mergeCalls).toEqual([{ cwd: join(ws, 'api'), target: 'main' }])
    } finally { rmSync(ws, { recursive: true, force: true }) }
  })

  describe('run2:launch-start temp-branch wiring (P4-2)', () => {
    function makeWsConfig(ws: string, branches: Record<string, string>): Workspace {
      return {
        name: 'pay', path: ws, workflowId: '', stages: [],
        workflows: [{ id: 'wf1', name: '标准五段', stages: [
          { key: 'design', provider: 'x', model: 'm', scope: 'root', gate: false },
          { key: 'develop', provider: 'x', model: 'm', scope: 'per-project', gate: false },
        ] }],
        projects: Object.entries(branches).map(([name, branch]) => ({ repoId: name, name, branch })) as any,
        status: 'idle', plugins: [], stepPlugins: [],
      } as any
    }

    it('creates a temp branch for EACH participating project off its own target branch, before the run starts, and stamps plan.tempBranch', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'r2h-'))
      try {
        const calls: Array<{ cwd: string; base: string; runId: string }> = []
        const stubCreate = async (cwd: string, base: string, runId: string) => {
          calls.push({ cwd, base, runId })
          return `forge/run-${runId}`
        }
        const handlers = new Map<string, (...a: any[]) => any>()
        const manager = new Run2Manager({ providers: { x: okProvider() }, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
        const wsConfig = makeWsConfig(ws, { api: 'feat/for-new-flow', web: 'main' })
        registerRun2({ manager, onInvoke: (ch, h) => handlers.set(ch, h), readWorkspace: () => wsConfig, readWorkflows: () => [], readCustomStages: () => [], createTempBranch: stubCreate, checkClean: async () => true })
        const launchStart = handlers.get(CH.run2LaunchStart)!
        const result = await launchStart({}, {
          workspacePath: ws, workflowId: 'wf1',
          projects: [{ name: 'api', provider: 'x', model: 'm' }, { name: 'web', provider: 'x', model: 'm' }],
          supplement: '', seed: '',
        })
        expect(result.status).toBe('started')
        const runId = result.state.machine.plan.runId
        expect(calls).toEqual([
          { cwd: join(ws, 'api'), base: 'feat/for-new-flow', runId },
          { cwd: join(ws, 'web'), base: 'main', runId },
        ])
        expect(result.state.machine.plan.tempBranch).toBe(`forge/run-${runId}`)
      } finally { rmSync(ws, { recursive: true, force: true }) }
    })

    it('Finding 3: a dirty project rejects run2:launch-start before any branch is created — checkClean wired through', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'r2h-'))
      try {
        const createCalls: string[] = []
        const stubCreate = async (cwd: string, _base: string, runId: string) => { createCalls.push(cwd); return `forge/run-${runId}` }
        const handlers = new Map<string, (...a: any[]) => any>()
        const manager = new Run2Manager({ providers: { x: okProvider() }, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
        const wsConfig = makeWsConfig(ws, { api: 'main', web: 'main' })
        registerRun2({
          manager, onInvoke: (ch, h) => handlers.set(ch, h), readWorkspace: () => wsConfig, readWorkflows: () => [], readCustomStages: () => [],
          createTempBranch: stubCreate,
          checkClean: async (cwd) => !cwd.endsWith('web'),
        })
        const launchStart = handlers.get(CH.run2LaunchStart)!
        await expect(launchStart({}, {
          workspacePath: ws, workflowId: 'wf1',
          projects: [{ name: 'api', provider: 'x', model: 'm' }, { name: 'web', provider: 'x', model: 'm' }],
          supplement: '', seed: '',
        })).rejects.toThrow(/web/)
        expect(createCalls).toEqual([]) // no branch created for EITHER project
        expect(manager.isActive(ws)).toBe(false)
      } finally { rmSync(ws, { recursive: true, force: true }) }
    })

    it('P4-3: threads each participating project\'s target branch through to the controller\'s finalize gate (合并/丢弃 hit the right branch per project)', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'r2h-'))
      try {
        const discardCalls: Array<{ cwd: string; target: string }> = []
        const handlers = new Map<string, (...a: any[]) => any>()
        const manager = new Run2Manager({
          providers: { x: okProvider() }, env: {}, makeStore: (w, r) => new RunStore(w, r),
          emit: {
            event: (wp, e) => { if (e.kind === 'gate' && (e as any).finalize) manager.resolveGate(wp, e.id, { type: 'discard' }) },
            update: () => {},
          },
        })
        const wsConfig = makeWsConfig(ws, { api: 'feat/for-new-flow', web: 'main' })
        registerRun2({
          manager, onInvoke: (ch, h) => handlers.set(ch, h), readWorkspace: () => wsConfig, readWorkflows: () => [], readCustomStages: () => [],
          createTempBranch: async (cwd, _base, runId) => `forge/run-${runId}`,
          discardTempBranch: async (cwd, target) => { discardCalls.push({ cwd, target }) },
          checkClean: async () => true,
        })
        const launchStart = handlers.get(CH.run2LaunchStart)!
        const result = await launchStart({}, {
          workspacePath: ws, workflowId: 'wf1',
          projects: [{ name: 'api', provider: 'x', model: 'm' }, { name: 'web', provider: 'x', model: 'm' }],
          supplement: '', seed: '',
        })
        expect(result.status).toBe('started')
        await new Promise((r) => setTimeout(r, 50))
        const getState = handlers.get(CH.run2GetState)!
        const state = await getState({}, { workspacePath: ws })
        expect(state.status).toBe('ok')
        expect(discardCalls).toEqual([
          { cwd: join(ws, 'api'), target: 'feat/for-new-flow' },
          { cwd: join(ws, 'web'), target: 'main' },
        ])
      } finally { rmSync(ws, { recursive: true, force: true }) }
    })

    it('aborts the start (never calls manager.start) and rolls back already-created branches when one project fails to check out', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'r2h-'))
      try {
        const createCalls: string[] = []
        const rollbackCalls: Array<{ cwd: string; target: string }> = []
        const failingCreate = async (cwd: string, base: string, runId: string) => {
          createCalls.push(cwd)
          if (cwd.endsWith('web')) throw new Error('本地更改未提交')
          return `forge/run-${runId}`
        }
        const stubRollback = async (cwd: string, target: string) => { rollbackCalls.push({ cwd, target }) }
        const handlers = new Map<string, (...a: any[]) => any>()
        const manager = new Run2Manager({ providers: { x: okProvider() }, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
        const wsConfig = makeWsConfig(ws, { api: 'main', web: 'main' })
        registerRun2({ manager, onInvoke: (ch, h) => handlers.set(ch, h), readWorkspace: () => wsConfig, readWorkflows: () => [], readCustomStages: () => [], createTempBranch: failingCreate, discardTempBranch: stubRollback, checkClean: async () => true })
        const launchStart = handlers.get(CH.run2LaunchStart)!
        await expect(launchStart({}, {
          workspacePath: ws, workflowId: 'wf1',
          projects: [{ name: 'api', provider: 'x', model: 'm' }, { name: 'web', provider: 'x', model: 'm' }],
          supplement: '', seed: '',
        })).rejects.toThrow(/web/)
        expect(createCalls).toEqual([join(ws, 'api'), join(ws, 'web')])
        expect(rollbackCalls).toEqual([{ cwd: join(ws, 'api'), target: 'main' }])
        // the run must never have started on the half-created state
        expect(manager.isActive(ws)).toBe(false)
      } finally { rmSync(ws, { recursive: true, force: true }) }
    })
  })

  describe('run2:launch-start rejects a second start while the workspace has a live run (P4-2 review fix)', () => {
    it('does not call createTempBranch or manager.start, and surfaces a readable error', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'r2h-'))
      try {
        const createCalls: string[] = []
        const stubCreate = async (cwd: string, _base: string, runId: string) => {
          createCalls.push(cwd)
          return `forge/run-${runId}`
        }
        const handlers = new Map<string, (...a: any[]) => any>()
        // A provider whose run() never resolves `done` — keeps the controller "active" (still in
        // manager.controllers) for the duration of this test, simulating a live in-flight run.
        const neverDoneProvider: AgentProvider = {
          id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
          async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
          run(task: AgentTask, _cb: AgentCallbacks) {
            return { id: task.agentId, cancel() {}, done: new Promise(() => {}) }
          },
        }
        const manager = new Run2Manager({ providers: { x: neverDoneProvider }, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
        const wsConfig: Workspace = {
          name: 'pay', path: ws, workflowId: '', stages: [],
          workflows: [{ id: 'wf1', name: '标准五段', stages: [
            { key: 'design', provider: 'x', model: 'm', scope: 'root', gate: false },
            { key: 'develop', provider: 'x', model: 'm', scope: 'per-project', gate: false },
          ] }],
          projects: [{ repoId: 'api', name: 'api', branch: 'main' }] as any,
          status: 'idle', plugins: [], stepPlugins: [],
        } as any
        registerRun2({ manager, onInvoke: (ch, h) => handlers.set(ch, h), readWorkspace: () => wsConfig, readWorkflows: () => [], readCustomStages: () => [], createTempBranch: stubCreate, checkClean: async () => true })
        const launchStart = handlers.get(CH.run2LaunchStart)!
        // First launch-start: goes through (run #1 becomes active and never finishes, per neverDoneProvider).
        const first = await launchStart({}, {
          workspacePath: ws, workflowId: 'wf1',
          projects: [{ name: 'api', provider: 'x', model: 'm' }],
          supplement: '', seed: '',
        })
        expect(first.status).toBe('started')
        expect(manager.isActive(ws)).toBe(true)
        createCalls.length = 0 // only count calls made by the SECOND (rejected) attempt below

        // Second launch-start for the SAME workspace while run #1 is still live: must reject before
        // touching git or the manager — no temp branch, no manager.start/enqueue.
        await expect(launchStart({}, {
          workspacePath: ws, workflowId: 'wf1',
          projects: [{ name: 'api', provider: 'x', model: 'm' }],
          supplement: '', seed: '',
        })).rejects.toThrow(/当前工作区有工作流在执行/)
        expect(createCalls).toEqual([])
        manager.abort(ws) // tidy up the never-resolving run so the process can exit cleanly
      } finally { rmSync(ws, { recursive: true, force: true }) }
    })
  })

  describe('run2:launch-start rejects when an interrupted run is resumable (Finding 2, Important)', () => {
    it('rejects before touching git or the manager when a disk-resumable interrupted run exists for the workspace', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'r2h-'))
      try {
        const createCalls: string[] = []
        const stubCreate = async (cwd: string, _base: string, runId: string) => {
          createCalls.push(cwd)
          return `forge/run-${runId}`
        }
        const handlers = new Map<string, (...a: any[]) => any>()
        const manager = new Run2Manager({ providers: { x: okProvider() }, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
        const wsConfig: Workspace = {
          name: 'pay', path: ws, workflowId: '', stages: [],
          workflows: [{ id: 'wf1', name: '标准五段', stages: [
            { key: 'design', provider: 'x', model: 'm', scope: 'root', gate: false },
            { key: 'develop', provider: 'x', model: 'm', scope: 'per-project', gate: false },
          ] }],
          projects: [{ repoId: 'api', name: 'api', branch: 'main' }] as any,
          status: 'idle', plugins: [], stepPlugins: [],
        } as any
        registerRun2({ manager, onInvoke: (ch, h) => handlers.set(ch, h), readWorkspace: () => wsConfig, readWorkflows: () => [], readCustomStages: () => [], createTempBranch: stubCreate, checkClean: async () => true })

        // Seed an INTERRUPTED (non-terminal) run2-state for this workspace — no live controller (the
        // process that ran it died), so manager.isActive() is false but manager.resumable() must be
        // non-null. Before Finding 2's fix, isActive()-only gating let launch-start sail right past
        // this and start a brand-new run/temp-branch while the old one's work was still parked.
        const plan = { runId: 'run-old', stages: [
          { key: 'design', name: 'D', provider: 'x', model: 'm', scope: 'root' as const, gate: false },
          { key: 'develop', name: 'Dev', provider: 'x', model: 'm', scope: 'per-project' as const, gate: false },
        ] }
        const machine = {
          plan,
          stages: [
            { key: 'design', status: 'done' as const, round: 0 },
            { key: 'develop', status: 'pending' as const, round: 0 },
          ],
          currentIndex: 1,
        }
        const state = { machine, inbox: [], feedback: [], outcomes: {}, status: 'running' as const, pendingDirective: {}, liveLanes: {}, stageTimings: {}, paused: false }
        saveControllerState(new RunStore(ws, 'run-old'), state as any)
        expect(manager.isActive(ws)).toBe(false)
        expect(manager.resumable(ws)).not.toBeNull()

        const launchStart = handlers.get(CH.run2LaunchStart)!
        await expect(launchStart({}, {
          workspacePath: ws, workflowId: 'wf1',
          projects: [{ name: 'api', provider: 'x', model: 'm' }],
          supplement: '', seed: '',
        })).rejects.toThrow(/未完成的工作流/)
        expect(createCalls).toEqual([])
        expect(manager.isActive(ws)).toBe(false)
        // the interrupted run must still be sitting there to resume/discard — launch-start must not
        // have clobbered or consumed it.
        expect(manager.resumable(ws)).not.toBeNull()
      } finally { rmSync(ws, { recursive: true, force: true }) }
    })
  })

  describe('run2:resumable / run2:resume-from-disk / run2:discard-resumable (P-C2/T3)', () => {
    // Mirrors manager.test.ts's disk-resume fixture: a 2-stage plan with 'design' already `done` (the
    // app died sometime after it finished, before 'develop' started).
    function seedInterrupted(wsPath: string, runId: string) {
      const plan = {
        runId,
        stages: [
          { key: 'design', name: 'D', provider: 'x', model: 'm', scope: 'root' as const, gate: false },
          { key: 'develop', name: 'Dev', provider: 'x', model: 'm', scope: 'per-project' as const, gate: false },
        ],
      }
      const machine = {
        plan,
        stages: [
          { key: 'design', status: 'done' as const, round: 0 },
          { key: 'develop', status: 'pending' as const, round: 0 },
        ],
        currentIndex: 1,
      }
      const state = { machine, inbox: [], feedback: [], outcomes: {}, status: 'running' as const, pendingDirective: {}, liveLanes: {}, stageTimings: {}, paused: false }
      saveControllerState(new RunStore(wsPath, runId), state as any)
    }

    function makeWsConfig(wsPath: string): Workspace {
      return {
        name: 'pay', path: wsPath, workflowId: '', stages: [],
        workflows: [{ id: 'wf1', name: '标准五段', stages: [
          { key: 'design', provider: 'x', model: 'm', scope: 'root', gate: false },
          { key: 'develop', provider: 'x', model: 'm', scope: 'per-project', gate: false },
        ] }],
        projects: [{ repoId: 'api', name: 'api', branch: 'main' }] as any,
        status: 'idle', plugins: [], stepPlugins: [],
      } as any
    }

    it('run2:resumable returns a summary for an interrupted (non-terminal) run', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'r2h-res-'))
      try {
        const handlers = new Map<string, (...a: any[]) => any>()
        const manager = new Run2Manager({ providers: { x: okProvider() }, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
        registerRun2({ manager, onInvoke: (ch, h) => handlers.set(ch, h) })
        seedInterrupted(ws, 'run-x')
        const resumable = handlers.get(CH.run2Resumable)!
        const summary = await resumable({}, { workspacePath: ws })
        expect(summary).toEqual({ runId: 'run-x', resumeStageKey: 'develop', resumeStageName: 'Dev', totalStages: 2, doneCount: 1 })
      } finally { rmSync(ws, { recursive: true, force: true }) }
    })

    it('run2:resumable returns null for a fresh workspace with no interrupted run', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'r2h-res-'))
      try {
        const handlers = new Map<string, (...a: any[]) => any>()
        const manager = new Run2Manager({ providers: { x: okProvider() }, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
        registerRun2({ manager, onInvoke: (ch, h) => handlers.set(ch, h) })
        const resumable = handlers.get(CH.run2Resumable)!
        expect(await resumable({}, { workspacePath: ws })).toBeNull()
      } finally { rmSync(ws, { recursive: true, force: true }) }
    })

    it('run2:resume-from-disk builds the workspace\'s projects/target-branches and resumes the controller from the first non-done stage', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'r2h-res-'))
      try {
        const calls: string[] = []
        const discardCalls: Array<{ cwd: string; target: string }> = []
        const capturing: AgentProvider = {
          id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
          async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
          run(task: AgentTask, cb: AgentCallbacks) {
            calls.push(task.stageKey)
            const done = (async () => { cb.onHandoff?.({ summary: 'ok' }); const r = { ok: true, summary: '' }; cb.onDone(r); return r })()
            return { id: task.agentId, cancel() {}, done }
          },
        }
        const handlers = new Map<string, (...a: any[]) => any>()
        const manager = new Run2Manager({
          providers: { x: capturing }, env: {}, makeStore: (w, r) => new RunStore(w, r),
          emit: {
            // The workspace's project HAS a target branch (makeWsConfig below), so — same as
            // run2:launch-start — resume-from-disk's rebuilt projectTargets turns the finalize gate
            // ON; resolve it (discard) here so the run reaches a terminal 'ok', same pattern the
            // existing run2:launch-start tests above use.
            event: (wp, e) => { if (e.kind === 'gate' && (e as any).finalize) manager.resolveGate(wp, e.id, { type: 'discard' }) },
            update: () => {},
          },
        })
        const wsConfig = makeWsConfig(ws)
        registerRun2({
          manager, onInvoke: (ch, h) => handlers.set(ch, h), readWorkspace: () => wsConfig, readWorkflows: () => [], readCustomStages: () => [],
          discardTempBranch: async (cwd, target) => { discardCalls.push({ cwd, target }) },
        })
        seedInterrupted(ws, 'run-x')

        const resumeFromDisk = handlers.get(CH.run2ResumeFromDisk)!
        const state = await resumeFromDisk({}, { workspacePath: ws })
        expect(state.machine.plan.runId).toBe('run-x')
        expect(manager.isActive(ws)).toBe(true)

        await new Promise((r) => setTimeout(r, 50))
        // 'design' was already `done` on disk — never re-invoked; only 'develop' (the first
        // non-done stage) runs, for the workspace's configured project ('api', not persisted anywhere
        // — rebuilt from readWorkspace, same as run2:launch-start would for a fresh start).
        expect(calls).toEqual(['develop'])
        expect(manager.lastStateFor(ws)?.status).toBe('ok')
        // the finalize gate's discard action hit the workspace's configured target branch ('main').
        expect(discardCalls).toEqual([{ cwd: join(ws, 'api'), target: 'main' }])
      } finally { rmSync(ws, { recursive: true, force: true }) }
    })

    // P-C2/T3 review Finding 1 (CRITICAL): the persisted `projects` subset must win over the
    // handler's own "every project on the workspace" reconstruction (buildLaunchInfo) — otherwise a
    // resumed per-project stage fans out against (and the finalize gate later merges/discards real
    // git on) a project the original run never selected.
    it('run2:resume-from-disk honors the PERSISTED project subset — fan-out and finalize touch ONLY that project, never the workspace\'s other projects', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'r2h-res-'))
      try {
        const calls: string[] = []
        const mergeCalls: Array<{ cwd: string; target: string }> = []
        const capturing: AgentProvider = {
          id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
          async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
          run(task: AgentTask, cb: AgentCallbacks) {
            calls.push(task.cwd)
            const done = (async () => { cb.onHandoff?.({ summary: 'ok' }); const r = { ok: true, summary: '' }; cb.onDone(r); return r })()
            return { id: task.agentId, cancel() {}, done }
          },
        }
        const handlers = new Map<string, (...a: any[]) => any>()
        const manager = new Run2Manager({
          providers: { x: capturing }, env: {}, makeStore: (w, r) => new RunStore(w, r),
          emit: {
            event: (wp, e) => { if (e.kind === 'gate' && (e as any).finalize) manager.resolveGate(wp, e.id, { type: 'merge' }) },
            update: () => {},
          },
        })
        // 3-project workspace — the ORIGINAL (now-interrupted) run only ever selected 'go-blog'.
        const wsConfig: Workspace = {
          name: 'multi', path: ws, workflowId: '', stages: [],
          workflows: [{ id: 'wf1', name: '标准五段', stages: [
            { key: 'design', provider: 'x', model: 'm', scope: 'root', gate: false },
            { key: 'develop', provider: 'x', model: 'm', scope: 'per-project', gate: false },
          ] }],
          projects: [
            { repoId: 'api', name: 'api', branch: 'main' },
            { repoId: 'go-blog', name: 'go-blog', branch: 'main' },
            { repoId: 'web', name: 'web', branch: 'main' },
          ] as any,
          status: 'idle', plugins: [], stepPlugins: [],
        } as any
        registerRun2({
          manager, onInvoke: (ch, h) => handlers.set(ch, h), readWorkspace: () => wsConfig, readWorkflows: () => [], readCustomStages: () => [],
          mergeTempBranch: async (cwd, target) => { mergeCalls.push({ cwd, target }) },
        })

        // Seed the interrupted run's saved state WITH a persisted `projects` subset of just go-blog.
        const plan = {
          runId: 'run-x', stages: [
            { key: 'design', name: 'D', provider: 'x', model: 'm', scope: 'root' as const, gate: false },
            { key: 'develop', name: 'Dev', provider: 'x', model: 'm', scope: 'per-project' as const, gate: false },
          ],
        }
        const machine = {
          plan,
          stages: [
            { key: 'design', status: 'done' as const, round: 0 },
            { key: 'develop', status: 'pending' as const, round: 0 },
          ],
          currentIndex: 1,
        }
        const persistedProjects = [{ name: 'go-blog', cwd: join(ws, 'go-blog'), provider: 'x', model: 'm' }]
        const state = {
          machine, inbox: [], feedback: [], outcomes: {}, status: 'running' as const, pendingDirective: {},
          liveLanes: {}, stageTimings: {}, paused: false, projects: persistedProjects,
        }
        saveControllerState(new RunStore(ws, 'run-x'), state as any)

        const resumeFromDisk = handlers.get(CH.run2ResumeFromDisk)!
        const result = await resumeFromDisk({}, { workspacePath: ws })
        expect(result.machine.plan.runId).toBe('run-x')
        expect(manager.isActive(ws)).toBe(true)

        await new Promise((r) => setTimeout(r, 50))
        // fan-out: only go-blog's cwd ran the develop stage — api/web NEVER touched.
        expect(calls).toEqual([join(ws, 'go-blog')])
        expect(manager.lastStateFor(ws)?.status).toBe('ok')
        // finalize: only go-blog's real branch got merged — api/web's real branches untouched.
        expect(mergeCalls).toEqual([{ cwd: join(ws, 'go-blog'), target: 'main' }])
      } finally { rmSync(ws, { recursive: true, force: true }) }
    })

    it('run2:resume-from-disk throws SYNCHRONOUSLY when the readWorkspace dep is missing', () => {
      const ws = mkdtempSync(join(tmpdir(), 'r2h-res-'))
      try {
        const handlers = new Map<string, (...a: any[]) => any>()
        const manager = new Run2Manager({ providers: { x: okProvider() }, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
        registerRun2({ manager, onInvoke: (ch, h) => handlers.set(ch, h) })
        seedInterrupted(ws, 'run-x')
        const resumeFromDisk = handlers.get(CH.run2ResumeFromDisk)!
        expect(() => resumeFromDisk({}, { workspacePath: ws })).toThrow(/readWorkspace/)
      } finally { rmSync(ws, { recursive: true, force: true }) }
    })

    it('run2:discard-resumable clears the saved state so run2:resumable stops offering it', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'r2h-res-'))
      try {
        const handlers = new Map<string, (...a: any[]) => any>()
        const manager = new Run2Manager({ providers: { x: okProvider() }, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
        registerRun2({ manager, onInvoke: (ch, h) => handlers.set(ch, h) })
        seedInterrupted(ws, 'run-x')
        const resumable = handlers.get(CH.run2Resumable)!
        expect(await resumable({}, { workspacePath: ws })).not.toBeNull()

        const discard = handlers.get(CH.run2DiscardResumable)!
        expect(await discard({}, { workspacePath: ws })).toBe(true)
        expect(await resumable({}, { workspacePath: ws })).toBeNull()
      } finally { rmSync(ws, { recursive: true, force: true }) }
    })

    it('run2:discard-resumable returns false (no-op) when there is nothing resumable', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'r2h-res-'))
      try {
        const handlers = new Map<string, (...a: any[]) => any>()
        const manager = new Run2Manager({ providers: { x: okProvider() }, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
        registerRun2({ manager, onInvoke: (ch, h) => handlers.set(ch, h) })
        const discard = handlers.get(CH.run2DiscardResumable)!
        expect(await discard({}, { workspacePath: ws })).toBe(false)
      } finally { rmSync(ws, { recursive: true, force: true }) }
    })
  })

  describe('run2:read-file (P5-UI Task 2)', () => {
    function makeHandlers() {
      const handlers = new Map<string, (...a: any[]) => any>()
      const manager = new Run2Manager({ providers: { x: okProvider() }, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
      registerRun2({ manager, onInvoke: (ch, h) => handlers.set(ch, h) })
      return handlers
    }

    it('reads a real file\'s content given cwd + relative path', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'r2h-rf-'))
      try {
        writeFileSync(join(ws, 'hello.md'), '# Hello World')
        const handlers = makeHandlers()
        const readFile = handlers.get(CH.run2ReadFile)!
        const res = await readFile({}, { path: 'hello.md', cwd: ws })
        expect(res).toEqual({ content: '# Hello World' })
      } finally { rmSync(ws, { recursive: true, force: true }) }
    })

    it('reads a file given an absolute path with no cwd', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'r2h-rf-'))
      try {
        const abs = join(ws, 'note.txt')
        writeFileSync(abs, 'plain text')
        const handlers = makeHandlers()
        const readFile = handlers.get(CH.run2ReadFile)!
        const res = await readFile({}, { path: abs })
        expect(res).toEqual({ content: 'plain text' })
      } finally { rmSync(ws, { recursive: true, force: true }) }
    })

    it('returns an error for a nonexistent path', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'r2h-rf-'))
      try {
        const handlers = makeHandlers()
        const readFile = handlers.get(CH.run2ReadFile)!
        const res = await readFile({}, { path: 'nope.txt', cwd: ws })
        expect(res).toHaveProperty('error')
      } finally { rmSync(ws, { recursive: true, force: true }) }
    })

    it('rejects a path that traverses outside cwd', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'r2h-rf-'))
      try {
        const handlers = makeHandlers()
        const readFile = handlers.get(CH.run2ReadFile)!
        const res = await readFile({}, { path: '../../../etc/passwd', cwd: ws })
        expect(res).toEqual({ error: '路径越界' })
      } finally { rmSync(ws, { recursive: true, force: true }) }
    })

    it('truncates a file larger than 512KB and flags truncated', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'r2h-rf-'))
      try {
        const big = 'x'.repeat(600 * 1024)
        writeFileSync(join(ws, 'big.txt'), big)
        const handlers = makeHandlers()
        const readFile = handlers.get(CH.run2ReadFile)!
        const res = await readFile({}, { path: 'big.txt', cwd: ws })
        expect('content' in res).toBe(true)
        expect((res as any).content.length).toBeLessThanOrEqual(512 * 1024)
        expect((res as any).truncated).toBe(true)
      } finally { rmSync(ws, { recursive: true, force: true }) }
    })

    it('returns an error for a directory path', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'r2h-rf-'))
      try {
        const dir = join(ws, 'subdir')
        mkdirSync(dir)
        const handlers = makeHandlers()
        const readFile = handlers.get(CH.run2ReadFile)!
        const res = await readFile({}, { path: 'subdir', cwd: ws })
        expect(res).toHaveProperty('error')
      } finally { rmSync(ws, { recursive: true, force: true }) }
    })
  })

  describe('run2:list-runs / run2:load-run (Spec §12.7, run-history)', () => {
    function makeHandlers() {
      const handlers = new Map<string, (...a: any[]) => any>()
      const manager = new Run2Manager({ providers: { x: okProvider() }, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
      registerRun2({ manager, onInvoke: (ch, h) => handlers.set(ch, h) })
      return handlers
    }
    function seedRun(wsPath: string, runId: string, status: 'ok' | 'failed' | 'running' | 'awaiting') {
      const machine = { plan: { runId, stages: [{ key: 'design', name: 'D', provider: 'x', model: 'm', scope: 'root' as const, gate: false }] }, stages: [{ key: 'design', status: 'done' as const, round: 0 }], currentIndex: 0 }
      const state = { machine, inbox: [], feedback: [], outcomes: {}, status, pendingDirective: {}, liveLanes: {}, stageTimings: {}, paused: false, task: `task-${runId}` }
      saveControllerState(new RunStore(wsPath, runId), state as any)
    }

    it('run2:list-runs returns every saved run for the workspace', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'r2h-hist-'))
      try {
        seedRun(ws, 'run-1', 'ok')
        seedRun(ws, 'run-2', 'failed')
        const handlers = makeHandlers()
        const listRuns = handlers.get(CH.run2ListRuns)!
        const list = await listRuns({}, { workspacePath: ws })
        expect(list.map((e: any) => e.runId).sort()).toEqual(['run-1', 'run-2'])
        expect(list.every((e: any) => e.totalStages === 1 && e.doneCount === 1)).toBe(true)
      } finally { rmSync(ws, { recursive: true, force: true }) }
    })

    it('run2:list-runs returns an empty array for a workspace with no runs', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'r2h-hist-'))
      try {
        const handlers = makeHandlers()
        const listRuns = handlers.get(CH.run2ListRuns)!
        expect(await listRuns({}, { workspacePath: ws })).toEqual([])
      } finally { rmSync(ws, { recursive: true, force: true }) }
    })

    it('run2:load-run returns the full saved state for read-only replay', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'r2h-hist-'))
      try {
        seedRun(ws, 'run-1', 'ok')
        const handlers = makeHandlers()
        const loadRun = handlers.get(CH.run2LoadRun)!
        const saved = await loadRun({}, { workspacePath: ws, runId: 'run-1' })
        expect(saved.status).toBe('ok')
        expect(saved.task).toBe('task-run-1')
      } finally { rmSync(ws, { recursive: true, force: true }) }
    })

    it('run2:load-run returns null for an unknown runId', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'r2h-hist-'))
      try {
        const handlers = makeHandlers()
        const loadRun = handlers.get(CH.run2LoadRun)!
        expect(await loadRun({}, { workspacePath: ws, runId: 'nope' })).toBeNull()
      } finally { rmSync(ws, { recursive: true, force: true }) }
    })

    // Run-state UX fix: run-history delete.
    it('run2:delete-run clears a saved (non-live) run so it no longer loads or lists', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'r2h-hist-'))
      try {
        seedRun(ws, 'run-1', 'ok')
        const handlers = makeHandlers()
        const deleteRun = handlers.get(CH.run2DeleteRun)!
        const listRuns = handlers.get(CH.run2ListRuns)!
        const loadRun = handlers.get(CH.run2LoadRun)!

        expect(await deleteRun({}, { workspacePath: ws, runId: 'run-1' })).toBe(true)
        expect(await loadRun({}, { workspacePath: ws, runId: 'run-1' })).toBeNull()
        expect(await listRuns({}, { workspacePath: ws })).toEqual([])
      } finally { rmSync(ws, { recursive: true, force: true }) }
    })

    it('run2:delete-run refuses to delete the workspace\'s currently-live run', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'r2h-hist-'))
      try {
        const handlers = new Map<string, (...a: any[]) => any>()
        // A provider whose run() never resolves — keeps the controller live in manager.controllers
        // for the duration of the test (same pattern as the launch-start "live run" test above).
        const neverDoneProvider: AgentProvider = {
          id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
          async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
          run(task: AgentTask, _cb: AgentCallbacks) {
            return { id: task.agentId, cancel() {}, done: new Promise(() => {}) }
          },
        }
        const manager = new Run2Manager({ providers: { x: neverDoneProvider }, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
        registerRun2({ manager, onInvoke: (ch, h) => handlers.set(ch, h) })
        const start = handlers.get(CH.run2Start)!
        const deleteRun = handlers.get(CH.run2DeleteRun)!

        await start({}, {
          workspacePath: ws, runId: 'run-live',
          stages: [{ key: 'design', name: 'D', provider: 'x', model: 'm', scope: 'root', gate: false, prompt: '' }],
          projects: [],
        })
        expect(manager.isActive(ws)).toBe(true)

        await expect(deleteRun({}, { workspacePath: ws, runId: 'run-live' })).rejects.toThrow(/无法删除/)

        manager.abort(ws) // tidy up the never-resolving run so the process can exit cleanly
      } finally { rmSync(ws, { recursive: true, force: true }) }
    })

    it('run2:delete-run returns false for an unknown runId', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'r2h-hist-'))
      try {
        const handlers = makeHandlers()
        const deleteRun = handlers.get(CH.run2DeleteRun)!
        expect(await deleteRun({}, { workspacePath: ws, runId: 'nope' })).toBe(false)
      } finally { rmSync(ws, { recursive: true, force: true }) }
    })
  })
})
