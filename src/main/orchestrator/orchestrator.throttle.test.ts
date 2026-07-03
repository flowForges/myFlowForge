import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator } from './orchestrator'
import { EventBus } from './eventBus'
import type { AgentProvider, AgentCallbacks } from '../agents/types'
import type { EngineEvent } from '@shared/types'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'ws-thr-')) })
afterEach(() => rmSync(ws, { recursive: true, force: true }))

// A provider that captures its callbacks and blocks (stays in 'run') until released,
// so the test can drive onLog/onState while the run is active and observe throttling.
function blockingCaptureProvider(): { provider: AgentProvider; cbs: () => AgentCallbacks | null; release: () => void } {
  let captured: AgentCallbacks | null = null
  let release: () => void = () => {}
  const provider: AgentProvider = {
    id: 'cap', displayName: 'Cap',
    capabilities: { structuredOutput: false, permissionHook: false, pty: false },
    async detect() { return true }, async listModels() { return [] },
    run(task, cb) {
      captured = cb
      cb.onState('run')
      const done = new Promise<{ ok: boolean }>(res => {
        release = () => { cb.onState('ok'); res({ ok: true }) }
      })
      return { id: task.agentId, cancel() { release() }, done }
    }
  }
  return { provider, cbs: () => captured, release: () => release() }
}

describe('Orchestrator run:update throttle + logs cap', () => {
  it('A: coalesces rapid onLog-driven run:update during an active run, then trailing-flushes', async () => {
    vi.useFakeTimers()
    try {
      const bus = new EventBus()
      const updates: EngineEvent[] = []
      bus.subscribe(e => { if (e.type === 'run:update') updates.push(e) })

      const { provider, cbs } = blockingCaptureProvider()
      const orch = new Orchestrator({ bus, providers: { cap: provider }, proxy: () => '' })
      const runPromise = orch.startRun({
        runId: 'r-thr', workspaceName: 'ws', workspacePath: ws,
        stages: [{ key: 'design', name: '设计', provider: 'cap', model: 'm' }],
        developProjects: [],
      })

      // Let the bridge resolve and the provider.run() fire (captures callbacks).
      await vi.waitFor(() => { if (!cbs()) throw new Error('not yet') })
      const cb = cbs()!

      const before = updates.length
      // 10 rapid log lines, all within the throttle window (no timers advanced).
      for (let i = 0; i < 10; i++) cb.onLog({ ts: '00:00:00', text: `line ${i}`, level: 'info' })
      // Coalesced: far fewer than 10 emissions (the trailing one hasn't fired yet).
      const duringWindow = updates.length - before
      expect(duringWindow).toBeLessThan(3)

      // Advance past the 100ms throttle → exactly one trailing emit flushes.
      vi.advanceTimersByTime(100)
      expect(updates.length - before).toBe(1)

      // Cleanly finish the run: cancel releases the blocking session.
      orch.cancel()
      await vi.runAllTimersAsync()
      await runPromise.catch(() => {})
    } finally {
      vi.useRealTimers()
    }
  })

  it('B: onState change emits run:update immediately (no timer advance needed)', async () => {
    vi.useFakeTimers()
    try {
      const bus = new EventBus()
      const updates: EngineEvent[] = []
      bus.subscribe(e => { if (e.type === 'run:update') updates.push(e) })

      const { provider, cbs } = blockingCaptureProvider()
      const orch = new Orchestrator({ bus, providers: { cap: provider }, proxy: () => '' })
      const runPromise = orch.startRun({
        runId: 'r-thr-b', workspaceName: 'ws', workspacePath: ws,
        stages: [{ key: 'design', name: '设计', provider: 'cap', model: 'm' }],
        developProjects: [],
      })
      await vi.waitFor(() => { if (!cbs()) throw new Error('not yet') })
      const cb = cbs()!

      const before = updates.length
      cb.onState('wait')   // a state change mid-run
      expect(updates.length - before).toBe(1)   // immediate, no timer advance

      orch.cancel()
      await vi.runAllTimersAsync()
      await runPromise.catch(() => {})
    } finally {
      vi.useRealTimers()
    }
  })

  it('C: caps agent.logs to the most recent 200 lines, preserving the tail', async () => {
    vi.useFakeTimers()
    try {
      const bus = new EventBus()
      const { provider, cbs } = blockingCaptureProvider()
      const orch = new Orchestrator({ bus, providers: { cap: provider }, proxy: () => '' })
      const runPromise = orch.startRun({
        runId: 'r-thr-c', workspaceName: 'ws', workspacePath: ws,
        stages: [{ key: 'design', name: '设计', provider: 'cap', model: 'm' }],
        developProjects: [],
      })
      await vi.waitFor(() => { if (!cbs()) throw new Error('not yet') })
      const cb = cbs()!

      const total = 250
      for (let i = 0; i < total; i++) cb.onLog({ ts: '00:00:00', text: `L${i}`, level: 'info' })

      const agent = orch.getRun()!.stages[0].agents[0]
      expect(agent.logs.length).toBe(200)
      expect(agent.logs[agent.logs.length - 1].text).toBe(`L${total - 1}`)

      orch.cancel()
      await vi.runAllTimersAsync()
      await runPromise.catch(() => {})
    } finally {
      vi.useRealTimers()
    }
  })
})
