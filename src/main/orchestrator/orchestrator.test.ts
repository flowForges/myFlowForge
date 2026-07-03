import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as net from 'node:net'
import { Orchestrator, STAGE_FORGE_TOOLS } from './orchestrator'
import { EventBus } from './eventBus'
import { buildStagePrompt } from './brief'
import type { AgentProvider, AgentCallbacks } from '../agents/types'
import type { EngineEvent, RunState } from '@shared/types'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'ws-')) })
afterEach(() => rmSync(ws, { recursive: true, force: true }))

function fakeProvider(): AgentProvider {
  return {
    id: 'fake', displayName: 'Fake', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
    async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
    run(task, cb) {
      cb.onState('run'); cb.onLog({ ts: '00:00:00', text: `run ${task.name}`, level: 'info' })
      const done = (async () => {
        if (task.stageKey === 'design') { await cb.onConfirm({ title: '覆盖 theme.ts', where: 'theme.ts' }) }
        cb.onState('ok'); const r = { ok: true, summary: 'ok' }; cb.onDone(r); return r
      })()
      return { id: task.agentId, cancel() {}, done }
    }
  }
}

describe('STAGE_FORGE_TOOLS', () => {
  it('is the execution toolset and excludes forge_propose_plan (stage agents must not propose)', () => {
    const names = STAGE_FORGE_TOOLS.split(',')
    expect(names).toEqual(['forge_read_context', 'forge_write_artifact', 'forge_ask', 'forge_handoff', 'forge_heartbeat'])
    expect(STAGE_FORGE_TOOLS).not.toContain('forge_propose_plan')
  })
})

describe('buildStagePrompt lens injection', () => {
  it('injects the lens directive when a review lens is provided', () => {
    const p = buildStagePrompt('代码 CR', [], { textFallback: false, lens: 'security' })
    expect(p).toContain('安全')
    expect(p).toContain('代码 CR')
  })

  it('no lens directive when lens is absent', () => {
    const p = buildStagePrompt('代码 CR', [], { textFallback: false })
    expect(p).not.toContain('【审查视角】')
  })
})

describe('Orchestrator review fan-out', () => {
  it('single review -> one root-scope reviewer (id "review")', async () => {
    const bus = new EventBus()
    const orch = new Orchestrator({ bus, providers: { fake: fakeProvider() }, proxy: () => '' })
    const run = await orch.startRun({
      runId: 'rv1', workspaceName: 'ws', workspacePath: ws,
      stages: [{ key: 'review', name: '代码 CR', provider: 'fake', model: 'm', review: { mode: 'single' } }],
      developProjects: [{ name: 'web', cwd: join(ws, 'web') }, { name: 'api', cwd: join(ws, 'api') }],
    })
    const review = run.stages.find(s => s.key === 'review')!
    expect(review.agents.map(a => a.id)).toEqual(['review'])
  })

  it('parallel per-project review -> one reviewer per project (ids review:<project>)', async () => {
    const bus = new EventBus()
    const orch = new Orchestrator({ bus, providers: { fake: fakeProvider() }, proxy: () => '' })
    const run = await orch.startRun({
      runId: 'rv2', workspaceName: 'ws', workspacePath: ws,
      stages: [{ key: 'review', name: '代码 CR', provider: 'fake', model: 'm', review: { mode: 'parallel', scope: 'per-project' } }],
      developProjects: [{ name: 'web', cwd: join(ws, 'web') }, { name: 'api', cwd: join(ws, 'api') }],
    })
    const review = run.stages.find(s => s.key === 'review')!
    expect(review.agents.map(a => a.id)).toEqual(['review:web', 'review:api'])
    expect(review.agents.map(a => a.name)).toEqual(['web', 'api'])
  })

  it('parallel multi-lens review -> one reviewer per lens (ids review:workspace:<lens>)', async () => {
    const bus = new EventBus()
    const orch = new Orchestrator({ bus, providers: { fake: fakeProvider() }, proxy: () => '' })
    const run = await orch.startRun({
      runId: 'rv3', workspaceName: 'ws', workspacePath: ws,
      stages: [{ key: 'review', name: '代码 CR', provider: 'fake', model: 'm', review: { mode: 'parallel', scope: 'workspace', reviewers: ['correctness', 'security'] } }],
      developProjects: [{ name: 'web', cwd: join(ws, 'web') }],
    })
    const review = run.stages.find(s => s.key === 'review')!
    expect(review.agents.map(a => a.id)).toEqual(['review:workspace:correctness', 'review:workspace:security'])
  })
})

describe('Orchestrator resume seeding', () => {
  it('replays completed stages and seeds prior briefs into the resumed stage prompt', async () => {
    const prompts: Record<string, string> = {}
    const capturing: AgentProvider = {
      id: 'fake', displayName: 'Fake', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
      async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
      run(task, cb) {
        prompts[task.stageKey] = task.prompt
        cb.onState('run')
        const done = (async () => { cb.onState('ok'); const r = { ok: true, summary: 'ok' }; cb.onDone(r); return r })()
        return { id: task.agentId, cancel() {}, done }
      },
    }
    const bus = new EventBus()
    const orch = new Orchestrator({ bus, providers: { fake: capturing }, proxy: () => '' })
    const run = await orch.startRun({
      runId: 'rs1', workspaceName: 'ws', workspacePath: ws,
      stages: [{ key: 'design', name: '技术方案设计', provider: 'fake', model: 'm' }],
      developProjects: [],
      resume: {
        completedStages: [{ key: 'requirement', name: '需求评估', state: 'ok', agents: [{ id: 'req', name: '需求评估', role: 'requirement', provider: 'fake', model: 'm', state: 'ok', logs: [] }] }],
        priorBriefs: [{ agentName: '需求评估', summary: '需求已澄清:实现登录', artifacts: [] }],
      },
    })
    // completed stage is replayed first (UI shows it done), then the resumed stage runs
    expect(run.stages.map(s => s.key)).toEqual(['requirement', 'design'])
    expect(run.stages[0].state).toBe('ok')
    // the resumed design stage's prompt carries the prior stage's handoff summary (cross-model handoff)
    expect(prompts['design']).toContain('需求已澄清:实现登录')
  })
})

describe('Orchestrator', () => {
  it('runs stages in order, fans out develop per project, bubbles confirm and resumes on resolve', async () => {
    const bus = new EventBus()
    const events: EngineEvent[] = []
    bus.subscribe(e => events.push(e))

    const orch = new Orchestrator({ bus, providers: { fake: fakeProvider() }, proxy: () => '' })

    bus.subscribe(e => { if (e.type === 'pending:add') setTimeout(() => orch.resolve({ id: e.action.id, decision: 'allow' }), 0) })

    const run = await orch.startRun({
      runId: 'r1',
      workspaceName: 'design-system',
      workspacePath: ws,
      stages: [
        { key: 'design', name: '技术方案设计', provider: 'fake', model: 'm' },
        { key: 'develop', name: '代码开发', provider: 'fake', model: 'm' }
      ],
      developProjects: [
        { name: 'proj1', cwd: join(ws, 'proj1') },
        { name: 'proj2', cwd: join(ws, 'proj2') }
      ]
    })

    expect(run.status).toBe('ok')
    const develop = run.stages.find(s => s.key === 'develop')!
    expect(develop.agents.map(a => a.name)).toEqual(['proj1', 'proj2'])
    // Per-project agents: name = the project (prominent card title), role = the stage (subtitle).
    expect(develop.agents.map(a => a.id)).toEqual(['develop:proj1', 'develop:proj2'])
    expect(develop.agents.map(a => a.role)).toEqual(['代码开发', '代码开发'])
    // names are non-empty and unique (one per project)
    expect(develop.agents.every(a => a.name.length > 0)).toBe(true)
    // design now also fans out per project by default (so each agent loads that project's skills/rules)
    expect(run.stages.find(s => s.key === 'design')!.agents.map(a => a.name)).toEqual(['proj1', 'proj2', '主代理'])
    expect(run.stages.find(s => s.key === 'design')!.agents.map(a => a.role)).toEqual(['技术方案设计', '技术方案设计', '技术方案设计 · 汇总设计'])
    expect(events.some(e => e.type === 'pending:add')).toBe(true)
    expect(events.some(e => e.type === 'pending:resolve')).toBe(true)
  })

  it('honors an explicit scope:root on design (single agent in the workspace root)', async () => {
    const bus = new EventBus()
    const orch = new Orchestrator({ bus, providers: { fake: fakeProvider() }, proxy: () => '' })
    bus.subscribe(e => { if (e.type === 'pending:add') setTimeout(() => orch.resolve({ id: e.action.id, decision: 'allow' }), 0) })
    const run = await orch.startRun({
      runId: 'r-scope', workspaceName: 'ws', workspacePath: ws,
      stages: [{ key: 'design', name: '技术方案设计', provider: 'fake', model: 'm', scope: 'root' }],
      developProjects: [{ name: 'proj1', cwd: join(ws, 'proj1') }, { name: 'proj2', cwd: join(ws, 'proj2') }]
    })
    expect(run.stages.find(s => s.key === 'design')!.agents).toHaveLength(1)
  })

  it('runs per-project design agents first, then a main design summary agent with their handoffs', async () => {
    const bus = new EventBus()
    const order: string[] = []
    const prompts: Record<string, string> = {}
    const provider: AgentProvider = {
      id: 'design-cap', displayName: 'DesignCap',
      capabilities: { structuredOutput: false, permissionHook: false, pty: false, mcpTools: false },
      async detect() { return true }, async listModels() { return [] },
      run(task, cb) {
        order.push(task.agentId)
        prompts[task.agentId] = task.prompt
        cb.onState('run')
        const done = (async () => {
          if (task.agentId !== 'design:summary') cb.onHandoff?.({ summary: `${task.name} 项目技术方案`, artifacts: [{ path: `${task.name}-design.md`, kind: 'md' }] })
          cb.onState('ok')
          const r = { ok: true, summary: 'ok' }
          cb.onDone(r)
          return r
        })()
        return { id: task.agentId, cancel() {}, done }
      },
    }
    const orch = new Orchestrator({ bus, providers: { 'design-cap': provider }, proxy: () => '' })
    const run = await orch.startRun({
      runId: 'r-design-summary', workspaceName: 'ws', workspacePath: ws,
      stages: [{ key: 'design', name: '技术方案设计', provider: 'design-cap', model: 'm' }],
      developProjects: [{ name: 'go-blog', cwd: join(ws, 'go-blog') }, { name: 'zgh', cwd: join(ws, 'zgh') }],
    })

    expect(run.stages[0].agents.map(a => a.id)).toEqual(['design:go-blog', 'design:zgh', 'design:summary'])
    expect(order).toEqual(['design:go-blog', 'design:zgh', 'design:summary'])
    expect(prompts['design:summary']).toContain('[go-blog] go-blog 项目技术方案')
    expect(prompts['design:summary']).toContain('[zgh] zgh 项目技术方案')
    expect(prompts['design:summary']).toContain('汇总')
  })

  it('marks the run err when an agent fails, and stops after the failing stage', async () => {
    const failing: AgentProvider = {
      id: 'fail', displayName: 'Fail', capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      async detect() { return true }, async listModels() { return [] },
      run(task, cb) {
        cb.onState('run')
        const done = (async () => { cb.onState('err'); const r = { ok: false, summary: 'boom' }; cb.onDone(r); return r })()
        return { id: task.agentId, cancel() {}, done }
      }
    }
    const bus = new EventBus()
    const orch = new Orchestrator({ bus, providers: { fail: failing }, proxy: () => '' })
    const run = await orch.startRun({
      runId: 'r2', workspaceName: 'ws', workspacePath: ws,
      stages: [
        { key: 'design', name: '技术方案设计', provider: 'fail', model: 'm' },
        { key: 'develop', name: '代码开发', provider: 'fail', model: 'm' }
      ],
      developProjects: []
    })
    expect(run.status).toBe('err')
    expect(run.stages).toHaveLength(1) // stopped after the failing design stage; develop never started
  })

  it('records the agent error message as a log when a provider errors', async () => {
    const bus = new EventBus()
    const erroring: AgentProvider = {
      id: 'e',
      displayName: 'E',
      capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      detect: async () => true,
      listModels: async () => [],
      run(_task, cb) {
        cb.onState('run')
        cb.onError(new Error('boom'))
        cb.onState('err')
        return { id: 'x', cancel() {}, done: Promise.resolve({ ok: false }) }
      },
    }
    const orch = new Orchestrator({ bus, providers: { e: erroring }, proxy: () => '' })
    const run = await orch.startRun({
      runId: 'rE',
      workspaceName: 'ws',
      workspacePath: ws,
      stages: [{ key: 'requirement', name: '需求评估', provider: 'e', model: 'opus-4.8' }],
      developProjects: [],
    })
    const agent = run.stages[0].agents[0]
    expect(run.status).toBe('err')
    expect(run.stages[0].state).toBe('err')
    expect(agent.logs.some(l => l.text.includes('boom'))).toBe(true)
  })

  it('does not hang or throw when a stage references an unknown provider', async () => {
    const bus = new EventBus()
    const orch = new Orchestrator({ bus, providers: {}, proxy: () => '' }) // empty registry
    const run = await orch.startRun({
      runId: 'r3', workspaceName: 'ws', workspacePath: ws,
      stages: [{ key: 'design', name: '技术方案设计', provider: 'nope', model: 'm' }],
      developProjects: []
    })
    expect(run.status).toBe('err')
    expect(run.stages[0].state).toBe('err')
    expect(run.stages[0].agents[0].logs.some(l => l.text.includes('未找到代理'))).toBe(true)
  })

  it('persists state.json on terminal status and exposes getRun()', async () => {
    const bus = new EventBus()
    const orch = new Orchestrator({ bus, providers: { fake: fakeProvider() }, proxy: () => '' })

    bus.subscribe(e => { if (e.type === 'pending:add') setTimeout(() => orch.resolve({ id: e.action.id, decision: 'allow' }), 0) })

    const opts = {
      runId: 'r-persist',
      workspaceName: 'ws',
      workspacePath: ws,
      stages: [{ key: 'design', name: '技术方案设计', provider: 'fake', model: 'm' }],
      developProjects: []
    }

    const run = await orch.startRun(opts)
    expect(orch.getRun()).toBe(run)
    const file = join(opts.workspacePath, '.forge/runs', opts.runId, 'state.json')
    expect(existsSync(file)).toBe(true)
    const persisted = JSON.parse(readFileSync(file, 'utf8'))
    expect(persisted.id).toBe(opts.runId)
    expect(['ok', 'err']).toContain(persisted.status)
  })

  it('getRun() returns null before startRun is called', () => {
    const bus = new EventBus()
    expect(new Orchestrator({ bus, providers: {}, proxy: () => '' }).getRun()).toBe(null)
  })

  it('rejects a second concurrent startRun instead of clobbering the live run', async () => {
    const bus = new EventBus()
    let release: () => void = () => {}
    // providerRunning resolves once the blocker's run() has been invoked (bridge is up by then).
    let notifyRunning!: () => void
    const providerRunning = new Promise<void>(res => { notifyRunning = res })
    const blocker: AgentProvider = {
      id: 'block', displayName: 'Block', capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      async detect() { return true }, async listModels() { return [] },
      run(task, cb) {
        cb.onState('run')
        notifyRunning()
        const done = new Promise<{ ok: boolean }>(res => { release = () => { cb.onState('ok'); res({ ok: true }) } })
        return { id: task.agentId, cancel() {}, done }
      }
    }
    const orch = new Orchestrator({ bus, providers: { block: blocker }, proxy: () => '' })
    const first = orch.startRun({ runId: 'r4', workspaceName: 'ws', workspacePath: ws, stages: [{ key: 'design', name: 'D', provider: 'block', model: 'm' }], developProjects: [] })
    await expect(
      orch.startRun({ runId: 'r5', workspaceName: 'ws', workspacePath: ws, stages: [{ key: 'design', name: 'D', provider: 'block', model: 'm' }], developProjects: [] })
    ).rejects.toThrow('已有运行进行中')
    // Wait until the blocker's run() has been called (after the bridge resolves) before releasing.
    await providerRunning
    release()
    await first
  })

  it('injects FORGE_SOCKET into agent env and gives each develop agent a distinct FORGE_AGENT_ID', async () => {
    const bus = new EventBus()
    const capturedEnvs: Record<string, NodeJS.ProcessEnv> = {}

    const envCapturingProvider: AgentProvider = {
      id: 'env-cap', displayName: 'EnvCapture',
      capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      async detect() { return true }, async listModels() { return [] },
      run(task, cb, env) {
        capturedEnvs[task.agentId] = { ...env }
        cb.onState('run')
        const done = (async () => { cb.onState('ok'); const r = { ok: true, summary: 'ok' }; cb.onDone(r); return r })()
        return { id: task.agentId, cancel() {}, done }
      }
    }

    const orch = new Orchestrator({ bus, providers: { 'env-cap': envCapturingProvider }, proxy: () => '' })

    await orch.startRun({
      runId: 'r-bridge',
      workspaceName: 'ws',
      workspacePath: ws,
      stages: [{ key: 'develop', name: '代码开发', provider: 'env-cap', model: 'm' }],
      developProjects: [
        { name: 'projA', cwd: join(ws, 'projA') },
        { name: 'projB', cwd: join(ws, 'projB') },
      ]
    })

    const envA = capturedEnvs['develop:projA']
    const envB = capturedEnvs['develop:projB']
    expect(envA).toBeDefined()
    expect(envB).toBeDefined()

    // Both agents should have FORGE_SOCKET set to a non-empty value
    expect(envA.FORGE_SOCKET).toBeTruthy()
    expect(envB.FORGE_SOCKET).toBeTruthy()
    expect(envA.FORGE_SOCKET).toBe(envB.FORGE_SOCKET) // same socket for the run

    // Each agent should have its own FORGE_AGENT_ID
    expect(envA.FORGE_AGENT_ID).toBe('develop:projA')
    expect(envB.FORGE_AGENT_ID).toBe('develop:projB')
    expect(envA.FORGE_AGENT_ID).not.toBe(envB.FORGE_AGENT_ID)
  })

  it('FORGE_MCP_ENTRY is set when mcpEntry is provided', async () => {
    const bus = new EventBus()
    let capturedEnv: NodeJS.ProcessEnv = {}

    const envCapturingProvider: AgentProvider = {
      id: 'env-cap2', displayName: 'EnvCapture2',
      capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      async detect() { return true }, async listModels() { return [] },
      run(task, cb, env) {
        capturedEnv = { ...env }
        cb.onState('run')
        const done = (async () => { cb.onState('ok'); const r = { ok: true, summary: 'ok' }; cb.onDone(r); return r })()
        return { id: task.agentId, cancel() {}, done }
      }
    }

    const orch = new Orchestrator({ bus, providers: { 'env-cap2': envCapturingProvider }, proxy: () => '', mcpEntry: '/app/forgeMcp.js' })

    await orch.startRun({
      runId: 'r-mcpentry',
      workspaceName: 'ws',
      workspacePath: ws,
      stages: [{ key: 'design', name: '设计', provider: 'env-cap2', model: 'm' }],
      developProjects: []
    })

    expect(capturedEnv.FORGE_MCP_ENTRY).toBe('/app/forgeMcp.js')
  })

  it('bridge socket file is cleaned up after the run finishes', async () => {
    const bus = new EventBus()
    let socketPath: string | undefined

    const socketCapturingProvider: AgentProvider = {
      id: 'sock-cap', displayName: 'SockCapture',
      capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      async detect() { return true }, async listModels() { return [] },
      run(task, cb, env) {
        socketPath = env.FORGE_SOCKET
        cb.onState('run')
        const done = (async () => { cb.onState('ok'); const r = { ok: true, summary: 'ok' }; cb.onDone(r); return r })()
        return { id: task.agentId, cancel() {}, done }
      }
    }

    const orch = new Orchestrator({ bus, providers: { 'sock-cap': socketCapturingProvider }, proxy: () => '' })

    await orch.startRun({
      runId: 'r-sockclean',
      workspaceName: 'ws',
      workspacePath: ws,
      stages: [{ key: 'design', name: '设计', provider: 'sock-cap', model: 'm' }],
      developProjects: []
    })

    expect(socketPath).toBeTruthy()
    // After the run, the socket file should be gone
    expect(existsSync(socketPath!)).toBe(false)
  })

  it('cancel() during a live run marks run/stages/agents err and calls session.cancel', async () => {
    const bus = new EventBus()
    let cancelCalled = false
    let releaseSession!: () => void

    const blockingProvider: AgentProvider = {
      id: 'block-cancel', displayName: 'BlockCancel',
      capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      async detect() { return true }, async listModels() { return [] },
      run(task, cb) {
        cb.onState('run')
        const done = new Promise<{ ok: boolean }>(res => {
          releaseSession = () => { cb.onState('err'); res({ ok: false }) }
        })
        return {
          id: task.agentId,
          cancel() { cancelCalled = true; releaseSession() },
          done,
        }
      }
    }

    const orch = new Orchestrator({ bus, providers: { 'block-cancel': blockingProvider }, proxy: () => '' })

    const runPromise = orch.startRun({
      runId: 'r-cancel',
      workspaceName: 'ws',
      workspacePath: ws,
      stages: [{ key: 'design', name: '技术方案设计', provider: 'block-cancel', model: 'm' }],
      developProjects: [],
    })

    // Wait until the agent is running before cancelling
    await new Promise<void>(resolve => {
      bus.subscribe(e => { if (e.type === 'agent:state' && e.state === 'run') resolve() })
    })

    orch.cancel()
    const run = await runPromise

    expect(run.status).toBe('err')
    expect(run.stages[0].state).toBe('err')
    expect(run.stages[0].agents[0].state).toBe('err')
    expect(run.stages[0].agents[0].logs.some(l => l.text === '已取消')).toBe(true)
    expect(cancelCalled).toBe(true)
  })

  it('cancel() is a no-op when no run is active', () => {
    const bus = new EventBus()
    const orch = new Orchestrator({ bus, providers: {}, proxy: () => '' })
    expect(() => orch.cancel()).not.toThrow()
  })

  it('cancel() is a no-op when the run has already terminated', async () => {
    const bus = new EventBus()
    const orch = new Orchestrator({ bus, providers: { fake: fakeProvider() }, proxy: () => '' })
    bus.subscribe(e => { if (e.type === 'pending:add') setTimeout(() => orch.resolve({ id: e.action.id, decision: 'allow' }), 0) })
    const run = await orch.startRun({
      runId: 'r-cancel-noop',
      workspaceName: 'ws',
      workspacePath: ws,
      stages: [{ key: 'design', name: '技术方案设计', provider: 'fake', model: 'm' }],
      developProjects: [],
    })
    expect(run.status).toBe('ok')
    // Calling cancel after completion should not change the status
    orch.cancel()
    expect(orch.getRun()!.status).toBe('ok')
  })

  it('uses per-project provider and model for develop stage; project without override falls back to stage spec', async () => {
    const bus = new EventBus()
    // Track which provider ran each task with which model
    const p1Tasks: { name: string; model: string }[] = []
    const p2Tasks: { name: string; model: string }[] = []

    const makeRecordingProvider = (id: string, log: typeof p1Tasks): AgentProvider => ({
      id, displayName: id, capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      async detect() { return true }, async listModels() { return [] },
      run(task, cb) {
        log.push({ name: task.name, model: task.model })
        cb.onState('run')
        const done = (async () => { cb.onState('ok'); const r = { ok: true, summary: 'ok' }; cb.onDone(r); return r })()
        return { id: task.agentId, cancel() {}, done }
      }
    })

    const orch = new Orchestrator({
      bus,
      providers: { p1: makeRecordingProvider('p1', p1Tasks), p2: makeRecordingProvider('p2', p2Tasks) },
      proxy: () => ''
    })

    const run = await orch.startRun({
      runId: 'r-perproj',
      workspaceName: 'ws',
      workspacePath: ws,
      stages: [{ key: 'develop', name: '代码开发', provider: 'p1', model: 'm1' }],
      developProjects: [
        { name: 'projA', cwd: join(ws, 'projA') },                              // no override → use stage spec
        { name: 'projB', cwd: join(ws, 'projB'), provider: 'p2', model: 'm2' }, // per-project override
      ]
    })

    expect(run.status).toBe('ok')

    // projA: no override → ran via p1 with m1
    expect(p1Tasks.find(t => t.name === 'projA')).toMatchObject({ model: 'm1' })
    expect(p2Tasks.find(t => t.name === 'projA')).toBeUndefined()

    // projB: override → ran via p2 with m2
    expect(p2Tasks.find(t => t.name === 'projB')).toMatchObject({ model: 'm2' })
    expect(p1Tasks.find(t => t.name === 'projB')).toBeUndefined()

    // AgentRuntime records reflect per-project values
    const develop = run.stages.find(s => s.key === 'develop')!
    expect(develop.agents.find(a => a.name === 'projA')).toMatchObject({ provider: 'p1', model: 'm1' })
    expect(develop.agents.find(a => a.name === 'projB')).toMatchObject({ provider: 'p2', model: 'm2' })
  })
})

// ─── Handoff Brief Integration Tests ─────────────────────────────────────────

describe('Orchestrator handoff briefs', () => {
  // (a) stage1 onHandoff → stage2 prompt contains summary + 上游交接
  it('stage2 prompt contains upstream handoff summary from stage1', async () => {
    const bus = new EventBus()
    const capturedPrompts: Record<string, string> = {}

    let stage1Cbs: AgentCallbacks | null = null

    const handoffProvider: AgentProvider = {
      id: 'handoff-prov', displayName: 'HandoffProv',
      capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      async detect() { return true },
      async listModels() { return [] },
      run(task, cb) {
        capturedPrompts[task.stageKey] = task.prompt
        cb.onState('run')
        const done = (async () => {
          if (task.stageKey === 'design') {
            // Call onHandoff in stage1
            cb.onHandoff?.({ summary: '设计完成', artifacts: [{ path: 'a.md', kind: 'md' }] })
          }
          cb.onState('ok')
          const r = { ok: true, summary: 'ok' }
          cb.onDone(r)
          return r
        })()
        return { id: task.agentId, cancel() {}, done }
      }
    }

    const orch = new Orchestrator({ bus, providers: { 'handoff-prov': handoffProvider }, proxy: () => '' })
    // Approve the inter-stage design review gate so develop runs (gate added in feat/render-evidence-stage-gate).
    bus.subscribe(e => { if (e.type === 'pending:add') setTimeout(() => orch.resolve({ id: e.action.id, decision: 'allow' }), 0) })
    const run = await orch.startRun({
      runId: 'r-brief1',
      workspaceName: 'ws',
      workspacePath: ws,
      stages: [
        { key: 'design', name: '技术方案', provider: 'handoff-prov', model: 'm' },
        { key: 'develop', name: '代码开发', provider: 'handoff-prov', model: 'm' },
      ],
      developProjects: []
    })

    expect(run.status).toBe('ok')
    // stage1 prompt leads with the execute-now directive then the stage name (no briefs yet)
    expect(capturedPrompts['design']).toMatch(/^【执行指令】/)
    expect(capturedPrompts['design']).toContain('技术方案')
    // stage2 prompt contains upstream brief
    expect(capturedPrompts['develop']).toContain('设计完成')
    expect(capturedPrompts['develop']).toContain('上游交接')
  })

  // (b) provider WITHOUT mcpTools → textFallback in prompt; WITH mcpTools:true → no textFallback
  it('provider without mcpTools gets forge:handoff instruction; provider with mcpTools:true does not', async () => {
    const bus = new EventBus()
    const capturedPrompts: Record<string, string> = {}

    // Build two-stage run: stage1 with mcpTools provider, stage2 without
    const withMcpTools: AgentProvider = {
      id: 'with-mcp', displayName: 'WithMcp',
      capabilities: { structuredOutput: true, permissionHook: true, pty: false, mcpTools: true } as any,
      async detect() { return true },
      async listModels() { return [] },
      run(task, cb) {
        capturedPrompts[task.stageKey + ':mcp'] = task.prompt
        cb.onState('run')
        const done = (async () => { cb.onState('ok'); const r = { ok: true, summary: 'ok' }; cb.onDone(r); return r })()
        return { id: task.agentId, cancel() {}, done }
      }
    }

    const withoutMcpTools: AgentProvider = {
      id: 'no-mcp', displayName: 'NoMcp',
      capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      async detect() { return true },
      async listModels() { return [] },
      run(task, cb) {
        capturedPrompts[task.stageKey + ':nomcp'] = task.prompt
        cb.onState('run')
        const done = (async () => { cb.onState('ok'); const r = { ok: true, summary: 'ok' }; cb.onDone(r); return r })()
        return { id: task.agentId, cancel() {}, done }
      }
    }

    const orch = new Orchestrator({ bus, providers: { 'with-mcp': withMcpTools, 'no-mcp': withoutMcpTools }, proxy: () => '' })
    // Approve the inter-stage design review gate so develop runs.
    bus.subscribe(e => { if (e.type === 'pending:add') setTimeout(() => orch.resolve({ id: e.action.id, decision: 'allow' }), 0) })
    await orch.startRun({
      runId: 'r-brief2',
      workspaceName: 'ws',
      workspacePath: ws,
      stages: [
        { key: 'design', name: '技术方案', provider: 'with-mcp', model: 'm' },
        { key: 'develop', name: '代码开发', provider: 'no-mcp', model: 'm' },
      ],
      developProjects: []
    })

    // MCP provider (with mcpTools:true) should NOT get forge:handoff instruction
    expect(capturedPrompts['design:mcp']).not.toContain('forge:handoff')

    // Non-MCP provider should get forge:handoff instruction (textFallback)
    expect(capturedPrompts['develop:nomcp']).toContain('forge:handoff')
  })

  // (c) bridge-path brief: fake provider sends handoff via socket → next stage prompt contains it
  it('bridge setContext handoff path: socket handoff lands in next stage prompt', async () => {
    const bus = new EventBus()
    const capturedPrompts: Record<string, string> = {}

    const socketProvider: AgentProvider = {
      id: 'sock-prov', displayName: 'SockProv',
      capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      async detect() { return true },
      async listModels() { return [] },
      run(task, cb, env) {
        capturedPrompts[task.stageKey] = task.prompt
        cb.onState('run')
        const done = (async () => {
          if (task.stageKey === 'design' && env.FORGE_SOCKET) {
            // Send a handoff via socket (bridge path)
            const agentId = env.FORGE_AGENT_ID ?? task.agentId
            await sendHandoffViaBridge(env.FORGE_SOCKET as string, agentId, 'X 摘要')
          }
          cb.onState('ok')
          const r = { ok: true, summary: 'ok' }
          cb.onDone(r)
          return r
        })()
        return { id: task.agentId, cancel() {}, done }
      }
    }

    const orch = new Orchestrator({ bus, providers: { 'sock-prov': socketProvider }, proxy: () => '' })
    // Approve the inter-stage design review gate so develop runs.
    bus.subscribe(e => { if (e.type === 'pending:add') setTimeout(() => orch.resolve({ id: e.action.id, decision: 'allow' }), 0) })
    await orch.startRun({
      runId: 'r-brief3',
      workspaceName: 'ws',
      workspacePath: ws,
      stages: [
        { key: 'design', name: '设计', provider: 'sock-prov', model: 'm' },
        { key: 'develop', name: '开发', provider: 'sock-prov', model: 'm' },
      ],
      developProjects: []
    })

    expect(capturedPrompts['develop']).toContain('X 摘要')
    expect(capturedPrompts['develop']).toContain('上游交接')
  })

  // (d) messages.jsonl contains type:'handoff' envelope after onHandoff
  it('messages.jsonl contains a handoff-type message after agent calls onHandoff', async () => {
    const bus = new EventBus()

    const handoffProvider: AgentProvider = {
      id: 'hoff-audit', displayName: 'HoffAudit',
      capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      async detect() { return true },
      async listModels() { return [] },
      run(task, cb) {
        cb.onState('run')
        const done = (async () => {
          cb.onHandoff?.({ summary: '审计摘要', artifacts: [{ path: 'doc.md', kind: 'md' }] })
          cb.onState('ok')
          const r = { ok: true, summary: 'ok' }
          cb.onDone(r)
          return r
        })()
        return { id: task.agentId, cancel() {}, done }
      }
    }

    const orch = new Orchestrator({ bus, providers: { 'hoff-audit': handoffProvider }, proxy: () => '' })
    await orch.startRun({
      runId: 'r-brief4',
      workspaceName: 'ws',
      workspacePath: ws,
      stages: [{ key: 'design', name: '设计', provider: 'hoff-audit', model: 'm' }],
      developProjects: []
    })

    const messagesFile = join(ws, '.forge/runs/r-brief4/messages.jsonl')
    expect(existsSync(messagesFile)).toBe(true)
    const lines = readFileSync(messagesFile, 'utf8').trim().split('\n').filter(Boolean)
    const handoffMsg = lines.map(l => JSON.parse(l)).find((m: any) => m.type === 'handoff')
    expect(handoffMsg).toBeDefined()
    expect(handoffMsg.payload.summary).toBe('审计摘要')
    expect(handoffMsg.artifacts).toEqual([{ path: 'doc.md', kind: 'md' }])
  })
})

// ─── task seeding ─────────────────────────────────────────────────────────────

describe('Orchestrator task seeding', () => {
  it('seeds the first-stage prompt with StartRunOpts.task as a goal header', async () => {
    const bus = new EventBus()
    const capturedPrompts: Record<string, string> = {}
    const promptProvider: AgentProvider = {
      id: 'prompt-cap', displayName: 'PromptCap',
      capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      async detect() { return true }, async listModels() { return [] },
      run(task, cb) {
        capturedPrompts[task.stageKey] = task.prompt
        cb.onState('run')
        const done = (async () => { cb.onState('ok'); const r = { ok: true, summary: 'ok' }; cb.onDone(r); return r })()
        return { id: task.agentId, cancel() {}, done }
      }
    }
    const orch = new Orchestrator({ bus, providers: { 'prompt-cap': promptProvider }, proxy: () => '' })
    await orch.startRun({
      runId: 'r-task', workspaceName: 'ws', workspacePath: ws,
      stages: [{ key: 'requirement', name: '需求评估', provider: 'prompt-cap', model: 'm' }],
      developProjects: [],
      task: '给blog加评论系统',
    })
    expect(capturedPrompts['requirement']).toContain('任务: 给blog加评论系统\n\n当前阶段: 需求评估')
    expect(capturedPrompts['requirement']).toContain('【执行指令】')
  })

  it('omits the task header when no task is provided (prompt is just the stage name)', async () => {
    const bus = new EventBus()
    const capturedPrompts: Record<string, string> = {}
    const promptProvider: AgentProvider = {
      id: 'prompt-cap2', displayName: 'PromptCap2',
      capabilities: { structuredOutput: false, permissionHook: false, pty: false, mcpTools: true } as any,
      async detect() { return true }, async listModels() { return [] },
      run(task, cb) {
        capturedPrompts[task.stageKey] = task.prompt
        cb.onState('run')
        const done = (async () => { cb.onState('ok'); const r = { ok: true, summary: 'ok' }; cb.onDone(r); return r })()
        return { id: task.agentId, cancel() {}, done }
      }
    }
    const orch = new Orchestrator({ bus, providers: { 'prompt-cap2': promptProvider }, proxy: () => '' })
    await orch.startRun({
      runId: 'r-notask', workspaceName: 'ws', workspacePath: ws,
      stages: [{ key: 'requirement', name: '需求评估', provider: 'prompt-cap2', model: 'm' }],
      developProjects: [],
    })
    expect(capturedPrompts['requirement']).toContain('需求评估')
    expect(capturedPrompts['requirement']).toContain('【执行指令】')
  })

  it('exposes FORGE_TOOLS (execution toolset, no propose_plan) to stage sub-agents', async () => {
    const bus = new EventBus()
    let capturedEnv: NodeJS.ProcessEnv | undefined
    const envProvider: AgentProvider = {
      id: 'env-cap', displayName: 'EnvCap',
      capabilities: { structuredOutput: false, permissionHook: false, pty: false, mcpTools: true } as any,
      async detect() { return true }, async listModels() { return [] },
      run(task, cb, env) {
        capturedEnv = env
        cb.onState('run')
        const done = (async () => { cb.onState('ok'); const r = { ok: true, summary: 'ok' }; cb.onDone(r); return r })()
        return { id: task.agentId, cancel() {}, done }
      }
    }
    const orch = new Orchestrator({ bus, providers: { 'env-cap': envProvider }, proxy: () => '', mcpEntry: '/x/m.js' })
    await orch.startRun({
      runId: 'r-env', workspaceName: 'ws', workspacePath: ws,
      stages: [{ key: 'develop', name: '代码开发', provider: 'env-cap', model: 'm' }],
      developProjects: [],
    })
    // The bridge must have started for FORGE_* to be injected; in CI it always does here.
    expect(capturedEnv?.FORGE_TOOLS).toBe(STAGE_FORGE_TOOLS)
    expect(capturedEnv?.FORGE_TOOLS).not.toContain('forge_propose_plan')
    expect(orch.getRun()?.stages[0].agents[0].context?.mcps?.map(m => m.name)).toEqual(['forge'])
  })
})

// ─── forge_ask options → select pending ──────────────────────────────────────

describe('Orchestrator forge_ask select', () => {
  it('forge ask with options raises a select pending (with provider/role); resolve choice returns options[i].t', async () => {
    const bus = new EventBus()
    const events: EngineEvent[] = []
    bus.subscribe(e => events.push(e))

    let askAnswer: string | null = '__unset__'
    const askProvider: AgentProvider = {
      id: 'ask-prov', displayName: 'AskProv',
      capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      async detect() { return true }, async listModels() { return [] },
      run(task, cb, env) {
        cb.onState('run')
        const done = (async () => {
          if (env.FORGE_SOCKET) {
            const agentId = env.FORGE_AGENT_ID ?? task.agentId
            askAnswer = await sendAskViaBridge(env.FORGE_SOCKET as string, agentId, '选择迁移策略', [
              { t: '逐文件迁移', d: '分批' }, { t: '全量正则替换', d: '最快' },
            ])
          }
          cb.onState('ok'); const r = { ok: true, summary: 'ok' }; cb.onDone(r); return r
        })()
        return { id: task.agentId, cancel() {}, done }
      }
    }

    const orch = new Orchestrator({ bus, providers: { 'ask-prov': askProvider }, proxy: () => '' })
    // Resolve any select pending by picking option index 1.
    bus.subscribe(e => {
      if (e.type === 'pending:add' && e.action.kind === 'select') {
        setTimeout(() => orch.resolve({ id: e.action.id, decision: 'allow', choice: 1 }), 0)
      }
    })

    await orch.startRun({
      runId: 'r-ask-sel', workspaceName: 'ws', workspacePath: ws,
      stages: [{ key: 'design', name: '设计', provider: 'ask-prov', model: 'opus-4.8' }],
      developProjects: [],
    })

    const sel = events.find(e => e.type === 'pending:add' && e.action.kind === 'select')
    expect(sel).toBeDefined()
    const action = (sel as Extract<EngineEvent, { type: 'pending:add' }>).action
    expect(action.kind).toBe('select')
    if (action.kind === 'select') {
      expect(action.options).toEqual([{ t: '逐文件迁移', d: '分批' }, { t: '全量正则替换', d: '最快' }])
    }
    expect(action.provider).toBe('ask-prov')
    expect(action.role).toBe('设计')
    expect(askAnswer).toBe('全量正则替换')
  })

  it('forge ask select resolved with deny returns null', async () => {
    const bus = new EventBus()
    let askAnswer: string | null = '__unset__'
    const askProvider: AgentProvider = {
      id: 'ask-deny', displayName: 'AskDeny',
      capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      async detect() { return true }, async listModels() { return [] },
      run(task, cb, env) {
        cb.onState('run')
        const done = (async () => {
          if (env.FORGE_SOCKET) {
            const agentId = env.FORGE_AGENT_ID ?? task.agentId
            askAnswer = await sendAskViaBridge(env.FORGE_SOCKET as string, agentId, '选?', [{ t: 'A', d: 'a' }])
          }
          cb.onState('ok'); const r = { ok: true, summary: 'ok' }; cb.onDone(r); return r
        })()
        return { id: task.agentId, cancel() {}, done }
      }
    }

    const orch = new Orchestrator({ bus, providers: { 'ask-deny': askProvider }, proxy: () => '' })
    bus.subscribe(e => { if (e.type === 'pending:add') setTimeout(() => orch.resolve({ id: e.action.id, decision: 'deny' }), 0) })

    await orch.startRun({
      runId: 'r-ask-deny', workspaceName: 'ws', workspacePath: ws,
      stages: [{ key: 'design', name: '设计', provider: 'ask-deny', model: 'm' }],
      developProjects: [],
    })

    expect(askAnswer).toBe(null)
  })
})

// ─── Bridge helper ────────────────────────────────────────────────────────────

function sendAskViaBridge(socketPath: string, agentId: string, question: string, options?: { t: string; d: string }[]): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath)
    s.once('connect', () => {
      const req = JSON.stringify({ id: 'ask-bridge-1', tool: 'ask', agentId, args: { question, options } })
      let buf = ''
      s.on('data', (chunk: Buffer) => {
        buf += chunk.toString()
        const idx = buf.indexOf('\n')
        if (idx !== -1) {
          s.destroy()
          try {
            const resp = JSON.parse(buf.slice(0, idx))
            if (Object.prototype.hasOwnProperty.call(resp, 'error')) reject(new Error(resp.error))
            else resolve(resp.result?.answer ?? null)
          } catch (e) { reject(e) }
        }
      })
      s.write(req + '\n')
    })
    s.once('error', reject)
  })
}


function sendHandoffViaBridge(socketPath: string, agentId: string, summary: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath)
    s.once('connect', () => {
      const req = JSON.stringify({ id: 'hoff-bridge-1', tool: 'handoff', agentId, args: { summary } })
      let buf = ''
      s.on('data', (chunk: Buffer) => {
        buf += chunk.toString()
        const idx = buf.indexOf('\n')
        if (idx !== -1) {
          s.destroy()
          try {
            const resp = JSON.parse(buf.slice(0, idx))
            if (resp.result?.ok) resolve()
            else reject(new Error(resp.error ?? 'handoff failed'))
          } catch (e) { reject(e) }
        }
      })
      s.write(req + '\n')
    })
    s.once('error', reject)
  })
}
