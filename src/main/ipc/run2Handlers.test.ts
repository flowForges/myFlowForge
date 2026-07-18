import { describe, it, expect } from 'vitest'
import { registerRun2 } from './run2Handlers'
import { Run2Manager } from '../run/manager'
import { RunStore } from '../orchestrator/runStore'
import { mkdtempSync, rmSync } from 'node:fs'
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
      const state = await start({}, { workspacePath: ws, runId: 'r1', stages: [{ key: 'design', name: '方案', provider: 'x', model: 'm', scope: 'root', gate: false }], projects: [{ name: 'a', cwd: join(ws, 'a') }] })
      expect(state.status).toBe('running')
      // abort handler exists and is safe
      const abort = handlers.get(CH.run2Abort)!
      expect(() => abort({}, { workspacePath: ws })).not.toThrow()
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
})
