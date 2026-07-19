import { describe, it, expect } from 'vitest'
import { registerRun2 } from './run2Handlers'
import { Run2Manager } from '../run/manager'
import { RunStore } from '../orchestrator/runStore'
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
      const manager = new Run2Manager({ providers: { codex: capturingProvider(seen), x: okProvider() }, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
      const wsConfig: Workspace = {
        name: 'pay', path: ws, workflowId: '', stages: [],
        workflows: [{ id: 'wf1', name: '标准五段', stages: [
          { key: 'design', provider: 'x', model: 'm', scope: 'root', gate: false },
          { key: 'develop', provider: 'x', model: 'm', scope: 'per-project', gate: false },
        ] }],
        projects: [{ repoId: 'api', name: 'api', branch: 'main' }, { repoId: 'web', name: 'web', branch: 'main' }] as any,
        status: 'idle', plugins: [], stepPlugins: [],
      } as any
      registerRun2({ manager, onInvoke: (ch, h) => handlers.set(ch, h), readWorkspace: () => wsConfig, readWorkflows: () => [], readCustomStages: () => [] })
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
    } finally { rmSync(ws, { recursive: true, force: true }) }
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
})
