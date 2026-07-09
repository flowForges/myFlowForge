import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProvider, AgentTask, AgentCallbacks, AgentSession } from '../agents/types'
import type { SetupEvent } from './workspaceSetup'

let root: string
vi.mock('../config/paths', async (orig) => {
  const actual = await orig<typeof import('../config/paths')>()
  return {
    ...actual,
    mirrorPath: (id: string) => join((globalThis as any).__REPOS__, `${id}.git`),
    sysFile: (n: string) => join((globalThis as any).__SYS__, n),
  }
})

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'setup-')); (globalThis as any).__REPOS__ = join(root, 'repos'); (globalThis as any).__SYS__ = join(root, 'sys') })
afterEach(() => rmSync(root, { recursive: true, force: true }))

// A fake provider whose run() records the task it was given, optionally drives onState('err'),
// then resolves the session via onDone — exercising executeHook without spawning a real CLI.
function fakeProvider(opts?: { errOn?: (task: AgentTask) => boolean }): { provider: AgentProvider; tasks: AgentTask[] } {
  const tasks: AgentTask[] = []
  const provider: AgentProvider = {
    id: 'claude', displayName: 'Claude', capabilities: { structuredOutput: false, permissionHook: false, pty: false },
    detect: async () => true, listModels: async () => [],
    run(task: AgentTask, cb: AgentCallbacks): AgentSession {
      tasks.push(task)
      const done = Promise.resolve().then(() => {
        cb.onLog({ ts: '0', text: 'hello', level: 'ok' })
        if (opts?.errOn?.(task)) cb.onState('err')
        const result = { ok: !opts?.errOn?.(task) }
        cb.onDone(result)
        return result
      })
      return { id: 'sess-' + task.agentId, cancel() {}, done }
    },
  }
  return { provider, tasks }
}

const SRC_PROJECTS = () => [{ id: 'proj', name: 'proj', repoUrl: '', defaultBranch: 'main' }]

describe('runWorkspaceSetup', () => {
  it('runs __basic BEFORE provision and __proj AFTER, emitting an ordered event stream', async () => {
    const { runWorkspaceSetup } = await import('./workspaceSetup')
    const { provider } = fakeProvider()
    const events: SetupEvent[] = []
    const provisioned: string[] = []
    const wsPath = join(root, 'ws-order')

    const res = await runWorkspaceSetup({
      opts: {
        name: 'order', path: wsPath, workflowId: 'standard',
        stages: [{ key: 'develop', provider: 'claude', model: 'sonnet' }],
        projects: [{ repoId: 'proj', branch: 'forge/x' }],
        stepPlugins: [
          { id: 'b1', name: 'Basic1', prompt: 'p', after: '__basic', skills: [], tools: ['read'] },
          { id: 'p1', name: 'Proj1', prompt: 'p', after: '__proj', skills: [], tools: ['edit'] },
        ],
      },
      knownProjects: SRC_PROJECTS(),
      proxy: '',
      providers: { claude: provider },
      emit: (e) => events.push(e),
      provision: async (proj) => { provisioned.push(proj.name); return join(wsPath, proj.name) },
    })

    const order = events.map(e => {
      if (e.type === 'hook:start') return `hook:start:${e.phase}`
      if (e.type === 'provision') return 'provision'
      return e.type
    })
    expect(order[0]).toBe('setup:start')
    expect(order[order.length - 1]).toBe('setup:done')
    const iBasic = order.indexOf('hook:start:__basic')
    const iProv = order.indexOf('provision')
    const iProj = order.indexOf('hook:start:__proj')
    expect(iBasic).toBeGreaterThanOrEqual(0)
    expect(iProv).toBeGreaterThan(iBasic)
    expect(iProj).toBeGreaterThan(iProv)
    expect(provisioned).toEqual(['proj'])

    // setup:start announces the hook counts
    const start = events.find(e => e.type === 'setup:start') as Extract<SetupEvent, { type: 'setup:start' }>
    expect(start.hooks).toEqual({ basic: 1, proj: 1 })

    // result shape mirrors createWorkspace
    expect(res.workspace.name).toBe('order')
    expect(res.startRunOpts.developProjects.map(p => p.name)).toEqual(['proj'])
  })

  it('hook cwd is the workspace root and allowedTools come from plugin.tools', async () => {
    const { runWorkspaceSetup } = await import('./workspaceSetup')
    const { provider, tasks } = fakeProvider()
    const wsPath = join(root, 'ws-cwd')
    await runWorkspaceSetup({
      opts: {
        name: 'cwd', path: wsPath, workflowId: 'standard',
        stages: [{ key: 'develop', provider: 'claude', model: 'sonnet' }],
        projects: [{ repoId: 'proj', branch: 'forge/x' }],
        stepPlugins: [{ id: 'b1', name: 'Basic1', prompt: 'p', after: '__basic', skills: [], tools: ['read'] }],
      },
      knownProjects: SRC_PROJECTS(), proxy: '', providers: { claude: provider },
      emit: () => {}, provision: async () => join(wsPath, 'proj'),
    })
    expect(tasks).toHaveLength(1)
    expect(tasks[0].cwd).toBe(wsPath)
    expect(tasks[0].allowedTools).toEqual(['Read'])
  })

  it('a hook that errors does NOT block provision or later hooks; setup:done still fires', async () => {
    const { runWorkspaceSetup } = await import('./workspaceSetup')
    const { provider } = fakeProvider({ errOn: (t) => t.agentId === 'setup:b1' })
    const events: SetupEvent[] = []
    const provisioned: string[] = []
    const wsPath = join(root, 'ws-err')
    await runWorkspaceSetup({
      opts: {
        name: 'err', path: wsPath, workflowId: 'standard',
        stages: [{ key: 'develop', provider: 'claude', model: 'sonnet' }],
        projects: [{ repoId: 'proj', branch: 'forge/x' }],
        stepPlugins: [
          { id: 'b1', name: 'Basic1', prompt: 'p', after: '__basic', skills: [], tools: ['read'] },
          { id: 'p1', name: 'Proj1', prompt: 'p', after: '__proj', skills: [], tools: ['edit'] },
        ],
      },
      knownProjects: SRC_PROJECTS(), proxy: '', providers: { claude: provider },
      emit: (e) => events.push(e), provision: async (proj) => { provisioned.push(proj.name); return join(wsPath, proj.name) },
    })
    // the erroring hook surfaces hook:state err
    expect(events.find(e => e.type === 'hook:state' && (e as any).pluginId === 'b1')).toMatchObject({ state: 'err' })
    // but provision and the __proj hook still ran
    expect(provisioned).toEqual(['proj'])
    expect(events.find(e => e.type === 'hook:start' && (e as any).phase === '__proj')).toBeTruthy()
    expect(events.some(e => e.type === 'setup:done')).toBe(true)
  })

  it('persists stepPlugins into the returned workspace record', async () => {
    const { runWorkspaceSetup } = await import('./workspaceSetup')
    const { readWorkspace } = await import('../config/store')
    const { provider } = fakeProvider()
    const wsPath = join(root, 'ws-persist')
    const stepPlugins = [
      { id: 'b1', name: 'Basic1', prompt: 'p', after: '__basic', skills: [], tools: ['read'] },
      { id: 'p1', name: 'Proj1', prompt: 'p', after: '__proj', skills: [], tools: ['edit'] },
    ]
    const res = await runWorkspaceSetup({
      opts: {
        name: 'persist', path: wsPath, workflowId: 'standard',
        stages: [{ key: 'develop', provider: 'claude', model: 'sonnet' }],
        projects: [{ repoId: 'proj', branch: 'forge/x' }],
        stepPlugins,
      },
      knownProjects: SRC_PROJECTS(), proxy: '', providers: { claude: provider },
      emit: () => {}, provision: async () => join(wsPath, 'proj'),
    })
    expect(res.workspace.stepPlugins).toEqual(stepPlugins)
    const ws = readWorkspace(wsPath)!
    expect(ws.stepPlugins).toEqual(stepPlugins)
  })

  it('emits provision:start before each project and provision after, in order', async () => {
    const { runWorkspaceSetup } = await import('./workspaceSetup')
    const events: SetupEvent[] = []
    const wsPath = join(root, 'ws-prov-order')
    const provision = vi.fn(async (proj: { name: string }) => join(wsPath, proj.name))

    await runWorkspaceSetup({
      opts: {
        name: 'prov-order', path: wsPath, workflowId: 'standard',
        stages: [{ key: 'develop', provider: 'claude', model: 'sonnet' }],
        projects: [
          { repoId: 'r1', branch: 'main' },
          { repoId: 'r2', branch: 'main' },
        ],
      },
      knownProjects: [
        { id: 'r1', name: 'alpha', repoUrl: 'u1', defaultBranch: 'main' } as any,
        { id: 'r2', name: 'beta', repoUrl: 'u2', defaultBranch: 'main' } as any,
      ],
      proxy: '', providers: {}, provision,
      emit: (e) => events.push(e),
    })

    const prov = events.filter(e => e.type.startsWith('provision'))
    expect(prov).toEqual([
      { type: 'provision:start', project: 'alpha', index: 0, total: 2 },
      { type: 'provision', project: 'alpha', index: 0, total: 2 },
      { type: 'provision:start', project: 'beta', index: 1, total: 2 },
      { type: 'provision', project: 'beta', index: 1, total: 2 },
    ])
  })

  it('emits provision:error and rethrows when a project fails to provision', async () => {
    const { runWorkspaceSetup } = await import('./workspaceSetup')
    const events: SetupEvent[] = []
    const wsPath = join(root, 'ws-prov-err')
    const provision = vi.fn(async () => { throw new Error('clone failed') })

    await expect(runWorkspaceSetup({
      opts: {
        name: 'prov-err', path: wsPath, workflowId: 'standard',
        stages: [{ key: 'develop', provider: 'claude', model: 'sonnet' }],
        projects: [{ repoId: 'r1', branch: 'main' }],
      },
      knownProjects: [{ id: 'r1', name: 'alpha', repoUrl: 'u1', defaultBranch: 'main' } as any],
      proxy: '', providers: {}, provision,
      emit: (e) => events.push(e),
    })).rejects.toThrow('clone failed')

    expect(events).toContainEqual({ type: 'provision:start', project: 'alpha', index: 0, total: 1 })
    expect(events).toContainEqual({ type: 'provision:error', project: 'alpha', index: 0, total: 1, message: 'clone failed' })
    expect(events.some(e => e.type === 'provision')).toBe(false)
  })

  it('an aborted signal stops the flow with SetupCancelledError and never provisions', async () => {
    const { runWorkspaceSetup, SetupCancelledError } = await import('./workspaceSetup')
    const { provider } = fakeProvider()
    const provisioned: string[] = []
    const ctrl = new AbortController()
    ctrl.abort()   // user hit 取消 before/while creating
    await expect(runWorkspaceSetup({
      opts: {
        name: 'cancel', path: join(root, 'ws-cancel'), workflowId: 'standard',
        stages: [{ key: 'develop', provider: 'claude', model: 'sonnet' }],
        projects: [{ repoId: 'proj', branch: 'forge/x' }],
      },
      knownProjects: SRC_PROJECTS(), proxy: '', providers: { claude: provider },
      emit: () => {}, provision: async (p) => { provisioned.push(p.name); return join(root, p.name) },
      signal: ctrl.signal,
    })).rejects.toBeInstanceOf(SetupCancelledError)
    expect(provisioned).toEqual([])   // never reached the git pull
  })

  it('cancelling mid-hook cancels the running hook session and aborts with SetupCancelledError', async () => {
    const { runWorkspaceSetup, SetupCancelledError } = await import('./workspaceSetup')
    const ctrl = new AbortController()
    let cancelled = false
    // A hook whose session stays pending until cancel() is called — models a long-running command.
    const provider: AgentProvider = {
      id: 'claude', displayName: 'Claude', capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      detect: async () => true, listModels: async () => [],
      run(_task: AgentTask, _cb: AgentCallbacks): AgentSession {
        let resolveDone!: (r: { ok: boolean }) => void
        const done = new Promise<{ ok: boolean }>(res => { resolveDone = res })
        return { id: 'sess', cancel() { cancelled = true; resolveDone({ ok: false }) }, done }
      },
    }
    const provisioned: string[] = []
    const p = runWorkspaceSetup({
      opts: {
        name: 'cancel-hook', path: join(root, 'ws-cancel-hook'), workflowId: 'standard',
        stages: [{ key: 'develop', provider: 'claude', model: 'sonnet' }],
        projects: [{ repoId: 'proj', branch: 'forge/x' }],
        stepPlugins: [{ id: 'b1', name: 'Basic1', prompt: 'p', after: '__basic', skills: [], tools: ['read'] }],
      },
      knownProjects: SRC_PROJECTS(), proxy: '', providers: { claude: provider },
      emit: () => {}, provision: async (proj) => { provisioned.push(proj.name); return join(root, proj.name) },
      signal: ctrl.signal,
    })
    // The __basic hook is now parked at `await session.done`; cancel mid-flight.
    await new Promise(r => setTimeout(r, 0))
    ctrl.abort()
    await expect(p).rejects.toBeInstanceOf(SetupCancelledError)
    expect(cancelled).toBe(true)       // the hook subprocess was actually cancelled
    expect(provisioned).toEqual([])    // aborted before provisioning
  })
})
