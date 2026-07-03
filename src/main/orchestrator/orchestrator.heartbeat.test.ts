import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator } from './orchestrator'
import { EventBus } from './eventBus'
import type { EngineEvent } from '@shared/types'
import type { AgentCallbacks, AgentProvider, AgentSession } from '../agents/types'
import type { StartRunOpts } from './orchestrator'

function hangingProvider() {
  let resolveDone!: (r: { ok: boolean }) => void
  const cbs: AgentCallbacks[] = []
  const cancel = vi.fn(() => resolveDone({ ok: false }))
  const provider: AgentProvider = {
    id: 'claude',
    displayName: 'Claude',
    capabilities: { structuredOutput: false, permissionHook: false, pty: false, mcpTools: true },
    detect: async () => true,
    listModels: async () => [],
    run: (_task, cb) => {
      cbs.push(cb)
      cb.onState('run')
      return { id: _task.agentId, cancel, done: new Promise<{ ok: boolean }>(r => { resolveDone = r }) } as AgentSession
    },
  }
  return { cbs, cancel, finish: () => resolveDone({ ok: true }), provider }
}

const optsFor = (workspacePath: string): StartRunOpts => ({
  runId: 'r',
  workspaceName: 'ws',
  workspacePath,
  stages: [{ key: 'develop', name: '开发', provider: 'claude', model: 'opus-4.8', scope: 'root' }],
  developProjects: [],
})

describe('orchestrator heartbeat wiring', () => {
  it('marks an agent stalled + broadcasts agent:stalled after stallMs of silence, then kills after grace', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'orch-hb-'))
    let t = 0
    let tick: () => void = () => {}
    const events: EngineEvent[] = []
    const bus = new EventBus()
    bus.subscribe(e => events.push(e))
    const hp = hangingProvider()
    const orch = new Orchestrator({
      bus,
      providers: { claude: hp.provider },
      proxy: () => '',
      heartbeat: { stallMs: 90_000, killGraceMs: 60_000, pingMs: 15_000 },
      now: () => t,
      makeInterval: (fn) => { tick = fn; return { clear() {} } },
    })

    const runP = orch.startRun(optsFor(ws))
    await vi.waitFor(() => expect(hp.cbs.length).toBe(1))
    const agentId = orch.getRun()!.stages[0].agents[0].id

    t += 90_001
    tick()
    const stalled = events.find(e => e.type === 'agent:stalled') as Extract<EngineEvent, { type: 'agent:stalled' }>
    expect(stalled).toMatchObject({ agentId, agentName: '开发', wsName: 'ws' })
    expect(stalled.silentMs).toBeGreaterThanOrEqual(90_000)
    expect(orch.getRun()!.stages[0].agents[0].state).toBe('stalled')

    t += 60_000
    tick()
    expect(hp.cancel).toHaveBeenCalledTimes(1)
    await runP
    rmSync(ws, { recursive: true, force: true })
  })

  it('onActivity refreshes the heartbeat so a long silent-but-alive stream never stalls', async () => {
    // Reproduces the killed-mid-Write bug: the agent produces no onLog (a long tool-input stream),
    // but run() reports onActivity on raw stream traffic. That must reset lastBeat like a real beat.
    const ws = mkdtempSync(join(tmpdir(), 'orch-hb-'))
    let t = 0
    let tick: () => void = () => {}
    const events: EngineEvent[] = []
    const bus = new EventBus()
    bus.subscribe(e => events.push(e))
    const hp = hangingProvider()
    const orch = new Orchestrator({
      bus,
      providers: { claude: hp.provider },
      proxy: () => '',
      heartbeat: { stallMs: 90_000, killGraceMs: 60_000, pingMs: 15_000 },
      now: () => t,
      makeInterval: (fn) => { tick = fn; return { clear() {} } },
    })

    const runP = orch.startRun(optsFor(ws))
    await vi.waitFor(() => expect(hp.cbs.length).toBe(1))
    const agentId = orch.getRun()!.stages[0].agents[0].id

    // 80s of silence — not yet stalled — then a single activity ping resets the clock.
    t += 80_000
    tick()
    expect(events.some(e => e.type === 'agent:stalled')).toBe(false)
    hp.cbs[0].onActivity?.()
    expect(orch.getRun()!.stages[0].agents[0].lastBeat).toBe(80_000)

    // Another 80s passes — only 80s since the activity beat, so still under stallMs: no stall.
    t += 80_000
    tick()
    expect(events.some(e => e.type === 'agent:stalled')).toBe(false)

    hp.finish()
    await runP
    rmSync(ws, { recursive: true, force: true })
  })

  it('does not stall while awaiting a confirm; resolve clears awaiting and refreshes lastBeat', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'orch-hb-'))
    let t = 0
    let tick: () => void = () => {}
    const events: EngineEvent[] = []
    const bus = new EventBus()
    bus.subscribe(e => events.push(e))
    const hp = hangingProvider()
    const orch = new Orchestrator({
      bus,
      providers: { claude: hp.provider },
      proxy: () => '',
      heartbeat: { stallMs: 90_000, killGraceMs: 60_000, pingMs: 15_000 },
      now: () => t,
      makeInterval: (fn) => { tick = fn; return { clear() {} } },
    })

    const runP = orch.startRun(optsFor(ws))
    await vi.waitFor(() => expect(hp.cbs.length).toBe(1))
    const agentId = orch.getRun()!.stages[0].agents[0].id
    const confirmP = hp.cbs[0].onConfirm({ title: '继续?' })
    await vi.waitFor(() => expect(events.some(e => e.type === 'pending:add')).toBe(true))
    expect(orch.getRun()!.stages[0].agents[0].state).toBe('awaiting')

    t += 1_000_000
    tick()
    expect(events.some(e => e.type === 'agent:stalled' && e.agentId === agentId)).toBe(false)

    const pending = events.find(e => e.type === 'pending:add') as Extract<EngineEvent, { type: 'pending:add' }>
    orch.resolve({ id: pending.action.id, decision: 'allow' })
    await expect(confirmP).resolves.toBe('allow')
    expect(orch.getRun()!.stages[0].agents[0].state).toBe('run')
    expect(orch.getRun()!.stages[0].agents[0].lastBeat).toBe(1_000_000)
    t += 10_000
    tick()
    expect(events.some(e => e.type === 'agent:stalled' && e.agentId === agentId)).toBe(false)

    hp.finish()
    await runP
    rmSync(ws, { recursive: true, force: true })
  })
})
