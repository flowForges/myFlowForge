// src/main/run/controller.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RunStore } from '../orchestrator/runStore'
import { RunController, type RunControllerState, type RunLogLine } from './controller'
import type { RunPlan, MachineState } from './machine'
import type { RunEvent } from './events'
import type { AgentProvider, AgentTask, AgentCallbacks } from '../agents/types'
import type { BridgeRunCtx, ForgeBridge } from '../mcp/forgeBridge'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'ctl-')) })
afterEach(() => { rmSync(ws, { recursive: true, force: true }) })

function okProvider(): AgentProvider {
  return {
    id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
    async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
    run(task: AgentTask, cb: AgentCallbacks) {
      const done = (async () => { cb.onHandoff?.({ summary: `out ${task.agentId}` }); const r = { ok: true, summary: '' }; cb.onDone(r); return r })()
      return { id: task.agentId, cancel() {}, done }
    },
  }
}
function askingProvider(): AgentProvider {
  return {
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
}
// Provider that awaits TWO interaction calls in sequence: onConfirm, THEN onInput. Used to
// reproduce Finding 1 — an abort delivered while blocked on the FIRST call must not leave the
// SECOND call (started only after settleAll already ran) with an orphaned, never-settled resolver.
function askThenInputProvider(): AgentProvider {
  return {
    id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
    async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
    run(task: AgentTask, cb: AgentCallbacks) {
      const done = (async () => {
        await cb.onConfirm({ title: 'auth' })
        await cb.onInput({ title: 'question' })
        cb.onHandoff?.({ summary: 'out' }); const r = { ok: true, summary: '' }; cb.onDone(r); return r
      })()
      return { id: task.agentId, cancel() {}, done }
    },
  }
}
// Provider that emits a CLI-native session id (cb.onSession) before completing — used to prove the
// controller captures it into state.laneSessions (see RunControllerState.laneSessions doc).
function sessionProvider(sessionId: string): AgentProvider {
  return {
    id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
    async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
    run(task: AgentTask, cb: AgentCallbacks) {
      const done = (async () => {
        cb.onSession?.(sessionId)
        cb.onHandoff?.({ summary: `out ${task.agentId}` }); const r = { ok: true, summary: '' }; cb.onDone(r); return r
      })()
      return { id: task.agentId, cancel() {}, done }
    },
  }
}
// Provider that surfaces live progress (onState + onLog) before completing — used to capture a
// mid-run snapshot with liveLanes populated, then confirm it's gone once the lane settles.
function progressProvider(): AgentProvider {
  return {
    id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
    async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
    run(task: AgentTask, cb: AgentCallbacks) {
      const done = (async () => {
        cb.onState('run')
        cb.onLog({ ts: '0', text: 'working on it', level: 'info' })
        cb.onHandoff?.({ summary: `out ${task.agentId}` }); const r = { ok: true, summary: '' }; cb.onDone(r); return r
      })()
      return { id: task.agentId, cancel() {}, done }
    },
  }
}
// Provider that emits a single tool-kind log line before completing — used to prove onLog
// broadcasts the raw LogLine to subscribers without it ever landing in persisted state.
function toolLogProvider(): AgentProvider {
  return {
    id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
    async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
    run(task: AgentTask, cb: AgentCallbacks) {
      const done = (async () => {
        cb.onLog({ ts: '', text: '调用 Bash', level: 'run', kind: 'tool' })
        cb.onHandoff?.({ summary: `out ${task.agentId}` }); const r = { ok: true, summary: '' }; cb.onDone(r); return r
      })()
      return { id: task.agentId, cancel() {}, done }
    },
  }
}
function failingProvider(stage: string): AgentProvider {
  return {
    id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
    async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
    run(task: AgentTask, cb: AgentCallbacks) {
      const done = (async () => {
        if (task.stageKey === stage) { cb.onState('err'); cb.onError(new Error('boom')); return { ok: false } }
        cb.onHandoff?.({ summary: 'out' }); const r = { ok: true, summary: '' }; cb.onDone(r); return r
      })()
      return { id: task.agentId, cancel() {}, done }
    },
  }
}

// Provider that raises exactly one "doubt" (via the forge-result fence's `doubts` field) the
// first time it runs the named stage, and behaves like okProvider() otherwise — used to test
// that a doubt event holds the stage from advancing until a human resolves it.
function doubtProvider(note: string, forStage: string): AgentProvider {
  return {
    id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
    async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
    run(task: AgentTask, cb: AgentCallbacks) {
      const done = (async () => {
        if (task.stageKey === forStage) {
          const block = `\`\`\`forge-result\n${JSON.stringify({ summary: 'done', filesChanged: [], testsRun: { passed: true }, blockers: [], doubts: [note] })}\n\`\`\``
          cb.onHandoff?.({ summary: block })
        } else {
          cb.onHandoff?.({ summary: 'out' })
        }
        const r = { ok: true, summary: '' }; cb.onDone(r); return r
      })()
      return { id: task.agentId, cancel() {}, done }
    },
  }
}

const idFactory = () => { let n = 0; return (p: string) => `${p}-${n++}` }

const plan: RunPlan = {
  runId: 'r1', stages: [
    { key: 'design', name: '方案', provider: 'x', model: 'm', scope: 'root', gate: true },
    { key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: false },
  ],
}
const projects = [{ name: 'a', cwd: '/ws/a' }, { name: 'b', cwd: '/ws/b' }]

describe('RunController', () => {
  it('raises a gate at a gated stage and advances on approval', async () => {
    const store = new RunStore(ws, 'r1')
    const c = new RunController(plan, { providers: { x: okProvider() }, store, env: {}, projects, sleep: async () => {}, now: () => 0, makeId: idFactory() })
    const events: RunEvent[] = []
    c.onEvent((e) => {
      events.push(e)
      if (e.kind === 'gate') c.resolveGate(e.id, { type: 'advance' })
    })
    const final = await c.start()
    expect(final.status).toBe('ok')
    expect(final.machine.stages.map((s) => s.status)).toEqual(['done', 'done'])
    expect(events.filter((e) => e.kind === 'gate').map((e) => (e as any).stageKey)).toEqual(['design'])
  })

  it('jumpBack from the develop-less flow: gate redo re-runs the stage', async () => {
    const store = new RunStore(ws, 'r1')
    const c = new RunController(plan, { providers: { x: okProvider() }, store, env: {}, projects, sleep: async () => {}, now: () => 0, makeId: idFactory() })
    let gateCount = 0
    c.onEvent((e) => {
      if (e.kind === 'gate') { gateCount++; c.resolveGate(e.id, gateCount === 1 ? { type: 'redo', feedback: 'tighten' } : { type: 'advance' }) }
    })
    const final = await c.start()
    expect(final.status).toBe('ok')
    expect(gateCount).toBe(2) // design gate hit twice (redo then advance)
    expect(final.machine.stages[0].round).toBe(1)
  })

  it('a lane onConfirm raises an auth event; authorize resumes it', async () => {
    const store = new RunStore(ws, 'r1')
    const plan2: RunPlan = { runId: 'r1', stages: [{ key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: false }] }
    const c = new RunController(plan2, { providers: { x: askingProvider() }, store, env: {}, projects, sleep: async () => {}, now: () => 0, makeId: idFactory() })
    const auths: string[] = []
    c.onEvent((e) => { if (e.kind === 'auth') { auths.push(e.laneId); c.resolveLane(e.id, { type: 'authorize' }) } })
    const final = await c.start()
    expect(final.status).toBe('ok')
    expect(auths.sort()).toEqual(['develop:a', 'develop:b'])
  })

  it('an abort on one lane force-unblocks concurrently blocked sibling lanes (no deadlock)', async () => {
    const store = new RunStore(ws, 'r1')
    const plan2: RunPlan = { runId: 'r1', stages: [{ key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: false }] }
    const c = new RunController(plan2, { providers: { x: askingProvider() }, store, env: {}, projects, sleep: async () => {}, now: () => 0, makeId: idFactory() })
    const authIds: string[] = []
    c.onEvent((e) => {
      if (e.kind !== 'auth') return
      authIds.push(e.id)
      // Only once BOTH lanes are concurrently blocked on their auth event do we abort the
      // first one. The second lane's auth event is deliberately never resolved explicitly —
      // the abort's settleAll fallback must force-unblock it, or start() would hang forever.
      if (authIds.length === 2) c.resolveLane(authIds[0], { type: 'abort' })
    })
    const final = await Promise.race([
      c.start(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('deadlock: start() did not settle')), 2000)),
    ])
    expect(final.status).toBe('failed')
    expect(final.inbox).toEqual([]) // no orphaned events left behind by the abort path
    // ^ this also exercises Finding 1(b): two projects both blocked on onConfirm, abort the
    // first auth event, never resolve the second — settleAll must force-unblock it too.
  })

  it('Finding 1(a): abort on onConfirm does not deadlock when the provider later calls onInput', async () => {
    const store = new RunStore(ws, 'r1')
    const plan2: RunPlan = { runId: 'r1', stages: [{ key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: false }] }
    const c = new RunController(plan2, { providers: { x: askThenInputProvider() }, store, env: {}, projects: [{ name: 'a', cwd: '/ws/a' }], sleep: async () => {}, now: () => 0, makeId: idFactory() })
    let questionSeen = false
    c.onEvent((e) => {
      if (e.kind === 'auth') c.resolveLane(e.id, { type: 'abort' })
      // The question event must never fire: by the time the provider gets around to calling
      // onInput, `aborted` is already true and onInput should short-circuit before emitting.
      if (e.kind === 'question') questionSeen = true
    })
    const final = await Promise.race([
      c.start(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('deadlock: start() did not settle')), 2000)),
    ])
    expect(final.status).toBe('failed')
    expect(questionSeen).toBe(false)
    expect(final.inbox).toEqual([])
  })

  it('Finding 2: abort() force-cancels a run parked at a gate with no live lane event', async () => {
    const store = new RunStore(ws, 'r1')
    const c = new RunController(plan, { providers: { x: okProvider() }, store, env: {}, projects, sleep: async () => {}, now: () => 0, makeId: idFactory() })
    c.onEvent((e) => {
      // Never resolveGate — the gate is deliberately left hanging; abort() is the only thing
      // that can unblock a run parked here (there is no lane event to call resolveLane on).
      if (e.kind === 'gate') c.abort()
    })
    const final = await Promise.race([
      c.start(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('deadlock: start() did not settle')), 2000)),
    ])
    expect(final.status).toBe('failed')
    // The gate's force-settled { type: 'advance' } must NOT spuriously advance the machine.
    expect(final.machine.stages.map((s) => s.status)).not.toEqual(['done', 'done'])
  })

  it('a failed lane raises a failure event; skipLane lets siblings finish', async () => {
    const store = new RunStore(ws, 'r1')
    const plan2: RunPlan = { runId: 'r1', stages: [{ key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: false }] }
    const c = new RunController(plan2, { providers: { x: failingProvider('develop') }, store, env: {}, projects: [{ name: 'a', cwd: '/ws/a' }], retries: 0, sleep: async () => {}, now: () => 0, makeId: idFactory() })
    const kinds: string[] = []
    c.onEvent((e) => { kinds.push(e.kind); if (e.kind === 'failure') c.resolveLane(e.id, { type: 'skipLane' }) })
    const final = await c.start()
    expect(kinds).toContain('failure')
    // after skipping the only failed lane, the stage is treated as resolved and advances to completion
    expect(final.machine.stages[0].status).toBe('done')
  })

  it('injects the run-level task seed into stage prompts', async () => {
    const prompts: Record<string, string> = {}
    const provider: AgentProvider = {
      id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
      async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
      run(task, cb) { prompts[task.agentId] = task.prompt; const done = (async () => { cb.onHandoff?.({ summary: 'ok' }); const r = { ok: true, summary: '' }; cb.onDone(r); return r })(); return { id: task.agentId, cancel() {}, done } },
    }
    const store = new RunStore(ws, 'r1')
    const plan: RunPlan = { runId: 'r1', stages: [{ key: 'requirement', name: '需求', provider: 'x', model: 'm', scope: 'root', gate: false }] }
    const c = new RunController(plan, { providers: { x: provider }, store, env: {}, projects: [], sleep: async () => {}, makeId: (p) => `${p}-0`, task: '实现支付幂等' })
    await c.start()
    expect(prompts['requirement:root']).toContain('实现支付幂等')
  })

  it('buildPrompt composes stage instructions + task seed + forge-result fence', async () => {
    const prompts: Record<string, string> = {}
    const provider: AgentProvider = {
      id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
      async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
      run(task, cb) { prompts[task.agentId] = task.prompt; const done = (async () => { cb.onHandoff?.({ summary: 'ok' }); const r = { ok: true, summary: '' }; cb.onDone(r); return r })(); return { id: task.agentId, cancel() {}, done } },
    }
    const store = new RunStore(ws, 'r1')
    const planWithPrompt: RunPlan = { runId: 'r1', stages: [{ key: 'design', name: '方案', provider: 'x', model: 'm', scope: 'root', gate: false, prompt: '产出技术方案文档' }] }
    const c = new RunController(planWithPrompt, { providers: { x: provider }, store, env: {}, projects: [], sleep: async () => {}, makeId: (p) => `${p}-0`, task: '实现支付幂等' })
    await c.start()
    const p = prompts['design:root']
    expect(p).toContain('产出技术方案文档') // stage instructions (StagePlan.prompt) present
    expect(p).toContain('forge-result') // structured-result fence instruction present
    expect(p).toContain('实现支付幂等') // requirement seed still present
  })

  it('threads deps.permissionMode into every StageInput → WorkOrder → task.permissionMode', async () => {
    const seenModes: Array<string | undefined> = []
    const provider: AgentProvider = {
      id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
      async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
      run(task, cb) { seenModes.push(task.permissionMode); const done = (async () => { cb.onHandoff?.({ summary: 'ok' }); const r = { ok: true, summary: '' }; cb.onDone(r); return r })(); return { id: task.agentId, cancel() {}, done } },
    }
    const store = new RunStore(ws, 'r1')
    const plan2: RunPlan = { runId: 'r1', stages: [{ key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: false }] }
    const c = new RunController(plan2, { providers: { x: provider }, store, env: {}, projects, sleep: async () => {}, now: () => 0, makeId: idFactory(), permissionMode: 'full' })
    const final = await c.start()
    expect(final.status).toBe('ok')
    expect(seenModes).toEqual(['full', 'full'])
  })

  it('liveLanes: shows per-lane live activity mid-run, then clears once the lane settles', async () => {
    const store = new RunStore(ws, 'r1')
    const plan2: RunPlan = { runId: 'r1', stages: [{ key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: false }] }
    const c = new RunController(plan2, { providers: { x: progressProvider() }, store, env: {}, projects: [{ name: 'a', cwd: '/ws/a' }], sleep: async () => {}, now: () => 0, makeId: idFactory() })
    const snapshots: RunControllerState[] = []
    c.onUpdate((s) => snapshots.push(s))
    const final = await c.start()

    const laneId = 'develop:a'
    const mid = snapshots.find((s) => s.liveLanes[laneId]?.activity)
    expect(mid).toBeTruthy()
    expect(mid!.liveLanes[laneId]).toMatchObject({ stageKey: 'develop', project: 'a', state: 'run', activity: 'working on it', cwd: '/ws/a' })

    expect(final.status).toBe('ok')
    expect(final.liveLanes[laneId]).toBeUndefined() // settled lane moved to outcomes, not live anymore
    expect(final.outcomes['develop']?.[0]?.status).toBe('ok')
  })

  it('laneSessions: captures a provider-emitted CLI session id per lane, in state and on disk', async () => {
    const store = new RunStore(ws, 'r1')
    const plan2: RunPlan = { runId: 'r1', stages: [{ key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: false }] }
    const c = new RunController(plan2, { providers: { x: sessionProvider('sess-123') }, store, env: {}, projects: [{ name: 'a', cwd: '/ws/a' }], sleep: async () => {}, now: () => 0, makeId: idFactory() })
    const final = await c.start()

    const laneId = 'develop:a'
    expect(final.laneSessions[laneId]).toEqual({ provider: 'x', sessionId: 'sess-123' })

    const { loadControllerState } = await import('./persist')
    const saved = loadControllerState(store)
    expect(saved?.laneSessions?.[laneId]).toEqual({ provider: 'x', sessionId: 'sess-123' })
  })

  it('onLog broadcasts live agent log lines on a channel separate from state/persistence', async () => {
    const store = new RunStore(ws, 'r1')
    const setContextSpy = vi.spyOn(store, 'setContext')
    const plan2: RunPlan = { runId: 'r1', stages: [{ key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: false }] }
    const c = new RunController(plan2, { providers: { x: toolLogProvider() }, store, env: {}, projects: [{ name: 'a', cwd: '/ws/a' }], sleep: async () => {}, now: () => 0, makeId: idFactory() })
    const logs: RunLogLine[] = []
    c.onLog((l) => logs.push(l))
    const final = await c.start()

    expect(final.status).toBe('ok')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      laneId: 'develop:a',
      stageKey: 'develop',
      project: 'a',
      agentName: '开发',
      line: { kind: 'tool', text: '调用 Bash' },
    })

    // Logs must never enter RunControllerState (no persisted-state field carries them)...
    expect(final).not.toHaveProperty('logs')
    expect(JSON.stringify(final)).not.toContain('调用 Bash')
    // ...and must never reach disk — every setContext() call (the sole write path to context.json)
    // is inspected, none of them may carry the log text.
    expect(setContextSpy.mock.calls.length).toBeGreaterThan(0)
    for (const call of setContextSpy.mock.calls) {
      expect(JSON.stringify(call[1])).not.toContain('调用 Bash')
    }
  })

  it('stageTimings: records startedAt when a stage begins and endedAt once its lanes settle', async () => {
    const store = new RunStore(ws, 'r1')
    let t = 1000
    const now = () => t++
    const plan2: RunPlan = { runId: 'r1', stages: [{ key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: false }] }
    const c = new RunController(plan2, { providers: { x: okProvider() }, store, env: {}, projects: [{ name: 'a', cwd: '/ws/a' }], sleep: async () => {}, now, makeId: idFactory() })
    const final = await c.start()
    expect(final.status).toBe('ok')
    const timing = final.stageTimings['develop']
    expect(timing).toBeTruthy()
    expect(timing.startedAt).toBeTypeOf('number')
    expect(timing.endedAt).toBeTypeOf('number')
    expect(timing.endedAt!).toBeGreaterThanOrEqual(timing.startedAt)
  })

  it('laneTimings: records startedAt/endedAt per lane (one per project), independent of the stage-level timing', async () => {
    const store = new RunStore(ws, 'r1')
    let t = 1000
    const now = () => t++
    const plan2: RunPlan = { runId: 'r1', stages: [{ key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: false }] }
    const c = new RunController(plan2, { providers: { x: okProvider() }, store, env: {}, projects, sleep: async () => {}, now, makeId: idFactory() })
    const final = await c.start()
    expect(final.status).toBe('ok')
    for (const laneId of ['develop:a', 'develop:b']) {
      const timing = final.laneTimings[laneId]
      expect(timing).toBeTruthy()
      expect(timing.startedAt).toBeTypeOf('number')
      expect(timing.endedAt).toBeTypeOf('number')
      expect(timing.endedAt!).toBeGreaterThanOrEqual(timing.startedAt)
    }
    // Independent lanes get their own entries, not one shared per-stage bucket.
    expect(final.laneTimings['develop:a']).not.toBe(final.laneTimings['develop:b'])
  })

  it('laneTimings: a manual retry after a failure resets the lane\'s timing to the fresh attempt', async () => {
    const store = new RunStore(ws, 'r1')
    let t = 1000
    const now = () => t++
    let calls = 0
    // Fails the very first invocation (raises a `failure` event for the controller's manual
    // retry/skip/abort decision), then succeeds on every subsequent call — so resolving the
    // failure with `{ type: 'retry' }` drives runOneOrder a SECOND time for the same order.id.
    const flakyProvider: AgentProvider = {
      id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
      async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
      run(task, cb) {
        calls++
        const done = (async () => {
          if (calls === 1) { cb.onState('err'); cb.onError(new Error('boom')); return { ok: false } }
          cb.onHandoff?.({ summary: 'ok' }); const r = { ok: true, summary: '' }; cb.onDone(r); return r
        })()
        return { id: task.agentId, cancel() {}, done }
      },
    }
    const plan2: RunPlan = { runId: 'r1', stages: [{ key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: false }] }
    const c = new RunController(plan2, { providers: { x: flakyProvider }, store, env: {}, projects: [{ name: 'a', cwd: '/ws/a' }], retries: 0, sleep: async () => {}, now, makeId: idFactory() })
    c.onEvent((e) => { if (e.kind === 'failure') c.resolveLane(e.id, { type: 'retry' }) })
    const final = await c.start()
    expect(final.status).toBe('ok')
    expect(calls).toBe(2)
    const timing = final.laneTimings['develop:a']
    expect(timing).toBeTruthy()
    expect(timing.endedAt).toBeTypeOf('number')
    // The retried attempt's own startedAt must be strictly later than the first attempt's — proof
    // the entry was overwritten (a fresh `{ startedAt }`), not accumulated/left at the first try.
    expect(timing.startedAt).toBeGreaterThan(1000)
  })

  it('pause() at the design→develop stage boundary holds; develop is not invoked until resume()', async () => {
    const store = new RunStore(ws, 'r1')
    const calls: string[] = []
    const provider: AgentProvider = {
      id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
      async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
      run(task, cb) {
        calls.push(task.stageKey)
        const done = (async () => { cb.onHandoff?.({ summary: 'ok' }); const r = { ok: true, summary: '' }; cb.onDone(r); return r })()
        return { id: task.agentId, cancel() {}, done }
      },
    }
    // Both stages ungated: pause()'s guard (`status !== 'running'` → no-op) means a GATED
    // stage's boundary is already status='awaiting' by the time a gate decision resolves — so
    // to observe pause() succeeding "right at the boundary" (status still 'running') this plan
    // uses two ungated stages, advancing machine straight through without a gate wait.
    const plan2: RunPlan = { runId: 'r1', stages: [
      { key: 'design', name: '方案', provider: 'x', model: 'm', scope: 'root', gate: false },
      { key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: false },
    ] }
    const c = new RunController(plan2, { providers: { x: provider }, store, env: {}, projects, sleep: async () => {}, now: () => 0, makeId: idFactory() })
    let paused = false
    c.onUpdate((s) => {
      // Fires synchronously right after design's machine-advance emitUpdate(), before develop's
      // work orders are built — i.e. exactly at the stage boundary, while status is still
      // 'running' (pause() no-ops once status flips to 'awaiting'/'ok'/'failed').
      if (!paused && s.outcomes['design'] && !s.outcomes['develop']) { paused = true; c.pause() }
    })
    const startPromise = c.start()

    // Promise.all(design's lanes) still needs at least one microtask turn to settle even though
    // the fake provider resolves "instantly" — poll rather than assume synchronous completion.
    await vi.waitFor(() => expect(c.state.paused).toBe(true))
    // develop must NOT have been invoked yet — the run is held at the boundary.
    expect(calls).toEqual(['design'])
    expect(c.state.status).not.toBe('ok')

    c.resume()
    const final = await Promise.race([
      startPromise,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('deadlock: start() did not settle after resume()')), 2000)),
    ])
    expect(final.status).toBe('ok')
    expect(final.paused).toBe(false)
    expect(calls.filter((k) => k === 'develop')).toHaveLength(2) // both projects' develop lanes ran after resume
    expect(final.machine.stages.map((s) => s.status)).toEqual(['done', 'done'])
  })

  it('abort() releases a paused run\'s pause gate — start() settles instead of hanging', async () => {
    const store = new RunStore(ws, 'r1')
    const c = new RunController(plan, { providers: { x: okProvider() }, store, env: {}, projects, sleep: async () => {}, now: () => 0, makeId: idFactory() })

    // Pause before the run even starts its first stage — the pause gate sits at the very top
    // of the loop (before any other await), so calling start() synchronously runs up to and
    // suspends on the pause promise before control returns here.
    c.pause()
    expect(c.state.paused).toBe(true)
    const startPromise = c.start()

    c.abort() // MUST release the pause gate — otherwise start() awaits pauseResolve forever.
    const final = await Promise.race([
      startPromise,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('deadlock: abort() did not release the pause gate')), 2000)),
    ])
    expect(final.status).toBe('failed')
    expect(final.paused).toBe(false) // terminal run must not surface as paused
  })

  it('abort() releases the pause gate of a run parked at a REAL mid-run stage boundary (pauseResolve genuinely set)', async () => {
    const store = new RunStore(ws, 'r1')
    const calls: string[] = []
    const provider: AgentProvider = {
      id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
      async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
      run(task, cb) {
        calls.push(task.stageKey)
        const done = (async () => { cb.onHandoff?.({ summary: 'ok' }); const r = { ok: true, summary: '' }; cb.onDone(r); return r })()
        return { id: task.agentId, cancel() {}, done }
      },
    }
    // Two ungated stages: pause() succeeds at the stage-1→stage-2 boundary while status is still
    // 'running' (same setup as the "pause holds" test) — so the loop GENUINELY parks on the pause
    // gate with pauseResolve set after a completed stage. This is the production deadlock scenario
    // the pre-run abort test above does NOT cover (there pauseResolve was never set by the loop).
    const plan2: RunPlan = { runId: 'r1', stages: [
      { key: 'design', name: '方案', provider: 'x', model: 'm', scope: 'root', gate: false },
      { key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: false },
    ] }
    const c = new RunController(plan2, { providers: { x: provider }, store, env: {}, projects, sleep: async () => {}, now: () => 0, makeId: idFactory() })
    let paused = false
    c.onUpdate((s) => {
      if (!paused && s.outcomes['design'] && !s.outcomes['develop']) { paused = true; c.pause() }
    })
    const startPromise = c.start()

    await vi.waitFor(() => expect(c.state.paused).toBe(true))
    expect(calls).toEqual(['design']) // parked at the boundary, develop not yet invoked

    c.abort() // release the genuinely-set pauseResolve — start() must settle, not hang.
    const final = await Promise.race([
      startPromise,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('deadlock: abort() did not release a mid-run pause gate')), 2000)),
    ])
    expect(final.status).toBe('failed')
    expect(final.paused).toBe(false) // cleared on terminal even though abort() left the flag set
    expect(calls).toEqual(['design']) // develop never ran — aborted at the boundary
    expect(final.machine.stages.map((s) => s.status)).not.toEqual(['done', 'done'])
  })

  it('requestJumpBack(target) at a stage boundary rolls the run back; downstream re-runs from target', async () => {
    const store = new RunStore(ws, 'r1')
    const calls: string[] = []
    const provider: AgentProvider = {
      id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
      async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
      run(task, cb) {
        calls.push(task.stageKey)
        const done = (async () => { cb.onHandoff?.({ summary: 'ok' }); const r = { ok: true, summary: '' }; cb.onDone(r); return r })()
        return { id: task.agentId, cancel() {}, done }
      },
    }
    const plan3: RunPlan = { runId: 'r1', stages: [
      { key: 'design', name: '方案', provider: 'x', model: 'm', scope: 'root', gate: false },
      { key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'root', gate: false },
      { key: 'review', name: '评审', provider: 'x', model: 'm', scope: 'root', gate: false },
    ] }
    const c = new RunController(plan3, { providers: { x: provider }, store, env: {}, projects: [], sleep: async () => {}, now: () => 0, makeId: idFactory() })
    let jumped = false
    c.onUpdate((s) => {
      // Fires right after develop's advance, before review's work orders are built — the boundary
      // right before the third stage, matching the brief's "boundary before stage 3" scenario.
      if (!jumped && s.outcomes['develop'] && !s.outcomes['review']) { jumped = true; c.requestJumpBack('design') }
    })
    const final = await c.start()
    expect(final.status).toBe('ok')
    // design and develop each ran twice: once before the jump, once again after rolling back to design.
    expect(calls).toEqual(['design', 'develop', 'design', 'develop', 'review'])
    expect(final.machine.stages.map((s) => s.status)).toEqual(['done', 'done', 'done'])
    expect(final.machine.stages[0].round).toBe(1) // design re-ran once via jumpBack
    expect(final.machine.stages[1].round).toBe(0) // develop re-ran via stale re-advance, not a redo round bump
  })

  it('requestJumpBack ignores an invalid target (unknown key, or not strictly before current) — run proceeds normally', async () => {
    const store = new RunStore(ws, 'r1')
    const calls: string[] = []
    const provider: AgentProvider = {
      id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
      async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
      run(task, cb) {
        calls.push(task.stageKey)
        const done = (async () => { cb.onHandoff?.({ summary: 'ok' }); const r = { ok: true, summary: '' }; cb.onDone(r); return r })()
        return { id: task.agentId, cancel() {}, done }
      },
    }
    const plan3: RunPlan = { runId: 'r1', stages: [
      { key: 'design', name: '方案', provider: 'x', model: 'm', scope: 'root', gate: false },
      { key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'root', gate: false },
      { key: 'review', name: '评审', provider: 'x', model: 'm', scope: 'root', gate: false },
    ] }
    const c = new RunController(plan3, { providers: { x: provider }, store, env: {}, projects: [], sleep: async () => {}, now: () => 0, makeId: idFactory() })
    let tried = false
    c.onUpdate((s) => {
      if (!tried && s.outcomes['develop'] && !s.outcomes['review']) {
        tried = true
        c.requestJumpBack('nonexistent') // unknown key
        c.requestJumpBack('review') // current stage itself — not strictly before currentIndex
      }
    })
    const final = await c.start()
    expect(final.status).toBe('ok')
    expect(calls).toEqual(['design', 'develop', 'review']) // no rollback, single pass through
    expect(final.machine.stages.map((s) => s.status)).toEqual(['done', 'done', 'done'])
  })

  it('requestJumpBack requested while paused is only applied once the loop reaches the next boundary (after resume)', async () => {
    const store = new RunStore(ws, 'r1')
    const calls: string[] = []
    const provider: AgentProvider = {
      id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
      async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
      run(task, cb) {
        calls.push(task.stageKey)
        const done = (async () => { cb.onHandoff?.({ summary: 'ok' }); const r = { ok: true, summary: '' }; cb.onDone(r); return r })()
        return { id: task.agentId, cancel() {}, done }
      },
    }
    const plan3: RunPlan = { runId: 'r1', stages: [
      { key: 'design', name: '方案', provider: 'x', model: 'm', scope: 'root', gate: false },
      { key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'root', gate: false },
      { key: 'review', name: '评审', provider: 'x', model: 'm', scope: 'root', gate: false },
    ] }
    const c = new RunController(plan3, { providers: { x: provider }, store, env: {}, projects: [], sleep: async () => {}, now: () => 0, makeId: idFactory() })
    let paused = false
    c.onUpdate((s) => {
      // Pause + request the jump at the develop→review boundary (status still 'running', matching
      // pause()'s own guard) — the jump must sit dormant until resume() lets the loop reach a
      // boundary, not fire immediately just because status stayed 'running' while paused.
      if (!paused && s.outcomes['develop'] && !s.outcomes['review']) {
        paused = true
        c.pause()
        c.requestJumpBack('design')
      }
    })
    const startPromise = c.start()
    await vi.waitFor(() => expect(c.state.paused).toBe(true))
    expect(calls).toEqual(['design', 'develop']) // review not yet invoked — held at the boundary
    c.resume()
    const final = await Promise.race([
      startPromise,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('deadlock: start() did not settle after resume()')), 2000)),
    ])
    expect(final.status).toBe('ok')
    // The jump requested while paused is only applied once the loop reaches the boundary after
    // resume() — design and develop each re-run once rolled back.
    expect(calls).toEqual(['design', 'develop', 'design', 'develop', 'review'])
    expect(final.machine.stages[0].round).toBe(1)
  })

  it('stageTimings: multi-stage run — each stage gets its own start/end timing', async () => {
    const store = new RunStore(ws, 'r1')
    let t = 5000
    const now = () => t++
    const c = new RunController(plan, { providers: { x: okProvider() }, store, env: {}, projects, sleep: async () => {}, now, makeId: idFactory() })
    c.onEvent((e) => { if (e.kind === 'gate') c.resolveGate(e.id, { type: 'advance' }) })
    const final = await c.start()
    expect(final.status).toBe('ok')
    const design = final.stageTimings['design']
    const develop = final.stageTimings['develop']
    expect(design).toBeTruthy()
    expect(develop).toBeTruthy()
    expect(design.endedAt!).toBeGreaterThanOrEqual(design.startedAt)
    expect(develop.endedAt!).toBeGreaterThanOrEqual(develop.startedAt)
    // design (gated, first) must have started no later than develop
    expect(design.startedAt).toBeLessThanOrEqual(develop.startedAt)
  })

  describe('doubt gates stage advance (P3-3)', () => {
    it('a doubt holds a gated stage from advancing even after its gate already passed; dismiss lets it proceed', async () => {
      const store = new RunStore(ws, 'r1')
      const plan2: RunPlan = { runId: 'r1', stages: [
        { key: 'design', name: '方案', provider: 'x', model: 'm', scope: 'root', gate: true },
        { key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: false },
      ] }
      const c = new RunController(plan2, { providers: { x: doubtProvider('note-1', 'design') }, store, env: {}, projects, sleep: async () => {}, now: () => 0, makeId: idFactory() })
      let doubtId = ''
      c.onEvent((e) => {
        if (e.kind === 'gate') c.resolveGate(e.id, { type: 'advance' }) // the gate itself passes right away
        if (e.kind === 'doubt') doubtId = e.id // deliberately left unresolved for now
      })
      const startPromise = c.start()
      await vi.waitFor(() => expect(doubtId).not.toBe(''))
      // Give the (already-passed) gate decision a chance to be applied — it must NOT be: the
      // stage must still be held by the unresolved doubt.
      await vi.waitFor(() => expect(c.state.status).toBe('awaiting'))
      expect(c.state.machine.currentIndex).toBe(0)
      expect(c.state.machine.stages[0].status).not.toBe('done')

      c.resolveLane(doubtId, { type: 'dismiss' })
      const final = await Promise.race([
        startPromise,
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('deadlock: dismiss did not unblock the run')), 2000)),
      ])
      expect(final.status).toBe('ok')
      expect(final.machine.stages.map((s) => s.status)).toEqual(['done', 'done'])
      expect(final.inbox).toEqual([]) // no orphaned doubt event left behind
    })

    it('回退改方案: jumpBack rewinds to the design stage (first gated stage), carrying the doubt note as feedback', async () => {
      const store = new RunStore(ws, 'r1')
      const plan2: RunPlan = { runId: 'r1', stages: [
        { key: 'design', name: '方案', provider: 'x', model: 'm', scope: 'root', gate: true },
        { key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: false },
      ] }
      const designPrompts: string[] = []
      let developRuns = 0
      const provider: AgentProvider = {
        id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
        async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
        run(task, cb) {
          const done = (async () => {
            if (task.stageKey === 'design') designPrompts.push(task.prompt)
            if (task.stageKey === 'develop') {
              developRuns++
              if (developRuns === 1) {
                // only the FIRST develop round raises the doubt, so the re-run after jumpBack
                // completes cleanly and the whole run can reach 'ok'.
                const block = `\`\`\`forge-result\n${JSON.stringify({ summary: 'done', filesChanged: [], testsRun: { passed: true }, blockers: [], doubts: ['方案没考虑并发写入'] })}\n\`\`\``
                cb.onHandoff?.({ summary: block })
                const r = { ok: true, summary: '' }; cb.onDone(r); return r
              }
            }
            cb.onHandoff?.({ summary: 'ok' }); const r = { ok: true, summary: '' }; cb.onDone(r); return r
          })()
          return { id: task.agentId, cancel() {}, done }
        },
      }
      const c = new RunController(plan2, { providers: { x: provider }, store, env: {}, projects: [{ name: 'a', cwd: '/ws/a' }], sleep: async () => {}, now: () => 0, makeId: idFactory() })
      c.onEvent((e) => {
        if (e.kind === 'gate') c.resolveGate(e.id, { type: 'advance' })
        // No targetKey supplied — the doubt-resolution "回退改方案" action defaults to the
        // design stage (first gated stage in the plan).
        if (e.kind === 'doubt') c.resolveLane(e.id, { type: 'jumpBack' })
      })
      const final = await Promise.race([
        c.start(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('deadlock: jumpBack did not resume the run')), 2000)),
      ])
      expect(final.status).toBe('ok')
      expect(designPrompts).toHaveLength(2) // design ran once initially, once again after the jumpBack
      expect(designPrompts[1]).toContain('方案没考虑并发写入')
      expect(final.machine.stages[0].round).toBe(1) // design's re-run bumped its round
    })

    it('补充说明后继续: redo re-runs the CURRENT stage with the clarification threaded into its prompt', async () => {
      const store = new RunStore(ws, 'r1')
      const plan2: RunPlan = { runId: 'r1', stages: [{ key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: false }] }
      const prompts: string[] = []
      let doubted = false
      const provider: AgentProvider = {
        id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
        async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
        run(task, cb) {
          const done = (async () => {
            prompts.push(task.prompt)
            if (!doubted) {
              doubted = true
              const block = `\`\`\`forge-result\n${JSON.stringify({ summary: 'd', filesChanged: [], testsRun: { passed: true }, blockers: [], doubts: ['缺少单测覆盖'] })}\n\`\`\``
              cb.onHandoff?.({ summary: block })
            } else {
              cb.onHandoff?.({ summary: 'ok' })
            }
            const r = { ok: true, summary: '' }; cb.onDone(r); return r
          })()
          return { id: task.agentId, cancel() {}, done }
        },
      }
      const c = new RunController(plan2, { providers: { x: provider }, store, env: {}, projects: [{ name: 'a', cwd: '/ws/a' }], sleep: async () => {}, now: () => 0, makeId: idFactory() })
      c.onEvent((e) => { if (e.kind === 'doubt') c.resolveLane(e.id, { type: 'redo', feedback: '补充：请补上单测' }) })
      const final = await Promise.race([
        c.start(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('deadlock: redo did not resume the run')), 2000)),
      ])
      expect(final.status).toBe('ok')
      expect(prompts).toHaveLength(2)
      expect(prompts[1]).toContain('缺少单测覆盖') // the doubt's own note
      expect(prompts[1]).toContain('补充：请补上单测') // the human's clarification
      expect(final.machine.stages[0].round).toBe(1)
    })

    // Prior review (P3-3): with MULTIPLE unresolved doubts on one stage resolved in the same batch,
    // does the shared feedback-draft queue (this.feedback — free text added via addFeedback/
    // editFeedback, distinct from a doubt's own `ld.feedback`) actually apply to the decision that
    // WINS the batch? A previous shape drained that queue inside the per-doubt loop, on the FIRST
    // non-dismiss/non-abort doubt — emptying it before a LATER doubt (whose override actually wins,
    // per the documented "later-resolved doubt's override wins" rule) ever got a look at it. Fixed
    // by draining once, after the loop, keyed off the winning decision.
    it('P3-3 multi-doubt: two unresolved doubts on one stage, resolved in one batch — the shared feedback-draft queue reaches the WINNING decision, not lost on the other doubt', async () => {
      const store = new RunStore(ws, 'r1')
      const plan2: RunPlan = { runId: 'r1', stages: [{ key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: false }] }
      const projectOf = (cwd: string) => (cwd.endsWith('/a') ? 'a' : 'b')
      const seen = new Set<string>()
      const prompts: Array<{ proj: string; prompt: string }> = []
      const provider: AgentProvider = {
        id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
        async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
        run(task, cb) {
          const proj = projectOf(task.cwd)
          const done = (async () => {
            prompts.push({ proj, prompt: task.prompt })
            if (!seen.has(proj)) {
              seen.add(proj)
              const note = proj === 'a' ? 'note-a' : 'note-b'
              const block = `\`\`\`forge-result\n${JSON.stringify({ summary: 'd', filesChanged: [], testsRun: { passed: true }, blockers: [], doubts: [note] })}\n\`\`\``
              cb.onHandoff?.({ summary: block })
            } else {
              cb.onHandoff?.({ summary: 'ok' })
            }
            const r = { ok: true, summary: '' }; cb.onDone(r); return r
          })()
          return { id: task.agentId, cancel() {}, done }
        },
      }
      const c = new RunController(plan2, { providers: { x: provider }, store, env: {}, projects, sleep: async () => {}, now: () => 0, makeId: idFactory() })
      // The user typed extra shared feedback BEFORE either doubt resolves.
      c.addFeedback('共享补充：两处都要看')
      const doubtEvents: Array<{ id: string; note: string }> = []
      c.onEvent((e) => {
        if (e.kind !== 'doubt') return
        doubtEvents.push({ id: e.id, note: e.note })
        if (doubtEvents.length === 2) {
          // Both doubts resolve to 'redo' (so the run reaches a clean 'ok' terminus). Resolved in
          // REVERSE creation order (b, then a) — proves the "winner" is decided by doubtWaits' array
          // (creation) order via Promise.all, not by real-world resolution order.
          const a = doubtEvents.find((x) => x.note === 'note-a')!
          const b = doubtEvents.find((x) => x.note === 'note-b')!
          c.resolveLane(b.id, { type: 'redo', feedback: 'b-own-feedback' })
          c.resolveLane(a.id, { type: 'redo', feedback: 'a-own-feedback' })
        }
      })
      const final = await Promise.race([
        c.start(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('deadlock: multi-doubt redo did not resume the run')), 2000)),
      ])
      expect(final.status).toBe('ok')
      const aPrompts = prompts.filter((p) => p.proj === 'a').map((p) => p.prompt)
      const bPrompts = prompts.filter((p) => p.proj === 'b').map((p) => p.prompt)
      expect(aPrompts).toHaveLength(2) // redo bumped the round — both lanes re-ran once more
      expect(bPrompts).toHaveLength(2)
      // "b" is last in CREATION order (outcomes loop runs project 'a' before 'b'), so its decision
      // wins: its own note/feedback are woven into the shared redo directive...
      expect(bPrompts[1]).toContain('note-b')
      expect(bPrompts[1]).toContain('b-own-feedback')
      // ...while "a"'s own note/feedback are discarded (only ITS decision was overridden — the
      // doubt event itself is still individually dropped, per the existing comment above).
      expect(bPrompts[1]).not.toContain('note-a')
      expect(bPrompts[1]).not.toContain('a-own-feedback')
      // The bug: the shared feedback-draft queue must still reach the winning ("b") directive — both
      // lanes read the SAME pendingDirective[stage.key], so it shows up in both re-run prompts.
      expect(bPrompts[1]).toContain('共享补充：两处都要看')
      expect(aPrompts[1]).toContain('共享补充：两处都要看')
      expect(final.machine.stages[0].round).toBe(1)
    })

    it('终止运行: abort on a doubt event stops the whole run', async () => {
      const store = new RunStore(ws, 'r1')
      const plan2: RunPlan = { runId: 'r1', stages: [{ key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: false }] }
      const c = new RunController(plan2, { providers: { x: doubtProvider('note', 'develop') }, store, env: {}, projects: [{ name: 'a', cwd: '/ws/a' }], sleep: async () => {}, now: () => 0, makeId: idFactory() })
      c.onEvent((e) => { if (e.kind === 'doubt') c.resolveLane(e.id, { type: 'abort' }) })
      const final = await Promise.race([
        c.start(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('deadlock: abort did not stop the run')), 2000)),
      ])
      expect(final.status).toBe('failed')
      expect(final.inbox).toEqual([]) // no orphaned doubt event left behind
    })

    it('abort while a GATE is still pending also drains a pending doubt for the same stage (no orphaned inbox entry)', async () => {
      const store = new RunStore(ws, 'r1')
      const plan2: RunPlan = { runId: 'r1', stages: [
        { key: 'design', name: '方案', provider: 'x', model: 'm', scope: 'root', gate: true },
        { key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: false },
      ] }
      const c = new RunController(plan2, { providers: { x: doubtProvider('note-race', 'design') }, store, env: {}, projects, sleep: async () => {}, now: () => 0, makeId: idFactory() })
      c.onEvent((e) => {
        // The doubt event (emitted first, per the outcomes loop running before gate creation)
        // is deliberately left unresolved. abort() fires once the GATE event shows up — at that
        // point the gate's resolver is still pending, reproducing the race: abort()'s settleAll
        // force-settles BOTH the gate and the earlier-registered doubt resolver, but the loop
        // breaks at the gate-await site (controller.ts ~389) BEFORE ever reaching the
        // doubt-drain block below it — the fix must drain the doubt there instead, or its event
        // and resolver id leak into the final inbox forever.
        if (e.kind === 'gate') c.abort()
      })
      const final = await Promise.race([
        c.start(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('deadlock: abort during a pending gate+doubt race did not settle')), 2000)),
      ])
      expect(final.status).toBe('failed')
      expect(final.inbox.some((e) => e.kind === 'doubt')).toBe(false) // no orphaned doubt event survives the abort
      expect(final.inbox).toEqual([]) // nothing lingers at all
    })
  })

  describe('P4-3: finalize gate (收尾确认) — merges or discards the run temp branch', () => {
    it('no projectTargets configured: run completes exactly as before, no finalize gate appears', async () => {
      const store = new RunStore(ws, 'r1')
      const c = new RunController(plan, { providers: { x: okProvider() }, store, env: {}, projects, sleep: async () => {}, now: () => 0, makeId: idFactory() })
      const events: RunEvent[] = []
      c.onEvent((e) => { events.push(e); if (e.kind === 'gate') c.resolveGate(e.id, { type: 'advance' }) })
      const final = await c.start()
      expect(final.status).toBe('ok')
      expect(events.some((e) => e.kind === 'gate' && (e as any).finalize)).toBe(false)
    })

    it('run completion holds at a finalize gate; 合并并完成 calls mergeTempBranch for every participating project', async () => {
      const store = new RunStore(ws, 'r1')
      const mergeCalls: Array<{ cwd: string; target: string; runId: string }> = []
      const c = new RunController(plan, {
        providers: { x: okProvider() }, store, env: {}, projects, sleep: async () => {}, now: () => 0, makeId: idFactory(),
        projectTargets: { a: 'main', b: 'develop-branch' },
        mergeTempBranch: async (cwd, target, runId) => { mergeCalls.push({ cwd, target, runId }) },
      })
      const events: RunEvent[] = []
      c.onEvent((e) => {
        events.push(e)
        if (e.kind === 'gate') c.resolveGate(e.id, (e as any).finalize ? { type: 'merge' } : { type: 'advance' })
      })
      const final = await c.start()
      expect(final.status).toBe('ok')
      const finalizeEvents = events.filter((e) => e.kind === 'gate' && (e as any).finalize)
      expect(finalizeEvents).toHaveLength(1)
      expect(finalizeEvents[0]).toMatchObject({ body: '全部完成，合并到目标分支？' })
      expect(mergeCalls).toEqual([
        { cwd: '/ws/a', target: 'main', runId: 'r1' },
        { cwd: '/ws/b', target: 'develop-branch', runId: 'r1' },
      ])
    })

    it('丢弃本次 calls discardTempBranch for every participating project instead of merging', async () => {
      const store = new RunStore(ws, 'r1')
      const mergeCalls: string[] = []
      const discardCalls: Array<{ cwd: string; target: string; runId: string }> = []
      const c = new RunController(plan, {
        providers: { x: okProvider() }, store, env: {}, projects, sleep: async () => {}, now: () => 0, makeId: idFactory(),
        projectTargets: { a: 'main', b: 'main' },
        mergeTempBranch: async (cwd) => { mergeCalls.push(cwd) },
        discardTempBranch: async (cwd, target, runId) => { discardCalls.push({ cwd, target, runId }) },
      })
      c.onEvent((e) => {
        if (e.kind === 'gate') c.resolveGate(e.id, (e as any).finalize ? { type: 'discard' } : { type: 'advance' })
      })
      const final = await c.start()
      expect(final.status).toBe('ok')
      expect(mergeCalls).toEqual([]) // discard path never touches merge
      expect(discardCalls).toEqual([
        { cwd: '/ws/a', target: 'main', runId: 'r1' },
        { cwd: '/ws/b', target: 'main', runId: 'r1' },
      ])
    })

    it('holds the run at the finalize gate until resolved — status stays "awaiting", never auto-completes', async () => {
      const store = new RunStore(ws, 'r1')
      const c = new RunController(plan, {
        providers: { x: okProvider() }, store, env: {}, projects, sleep: async () => {}, now: () => 0, makeId: idFactory(),
        projectTargets: { a: 'main', b: 'main' },
        discardTempBranch: async () => {},
      })
      let finalizeId = ''
      c.onEvent((e) => {
        if (e.kind === 'gate' && !(e as any).finalize) c.resolveGate(e.id, { type: 'advance' })
        if (e.kind === 'gate' && (e as any).finalize) finalizeId = e.id // deliberately left unresolved for now
      })
      const startPromise = c.start()
      await vi.waitFor(() => expect(finalizeId).not.toBe(''))
      expect(c.state.status).toBe('awaiting')

      c.resolveGate(finalizeId, { type: 'discard' })
      const final = await Promise.race([
        startPromise,
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('deadlock: finalize gate never resolved')), 2000)),
      ])
      expect(final.status).toBe('ok')
    })

    it('Finding 4: mid-run abort NEVER merges or discards but PARKS every participating project\'s temp branch (target left clean, temp branch kept)', async () => {
      const store = new RunStore(ws, 'r1')
      const plan2: RunPlan = { runId: 'r1', stages: [{ key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: false }] }
      const mergeCalls: string[] = []
      const discardCalls: string[] = []
      const parkCalls: Array<{ cwd: string; target: string; runId: string }> = []
      const c = new RunController(plan2, {
        providers: { x: askingProvider() }, store, env: {}, projects, sleep: async () => {}, now: () => 0, makeId: idFactory(),
        projectTargets: { a: 'main', b: 'main' },
        mergeTempBranch: async (cwd) => { mergeCalls.push(cwd) },
        discardTempBranch: async (cwd) => { discardCalls.push(cwd) },
        parkTempBranch: async (cwd, target, runId) => { parkCalls.push({ cwd, target, runId }) },
      })
      const authIds: string[] = []
      c.onEvent((e) => {
        if (e.kind !== 'auth') return
        authIds.push(e.id)
        if (authIds.length === 2) c.resolveLane(authIds[0], { type: 'abort' })
      })
      const final = await Promise.race([
        c.start(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('deadlock')), 2000)),
      ])
      expect(final.status).toBe('failed')
      expect(mergeCalls).toEqual([])
      expect(discardCalls).toEqual([]) // abort must not delete the temp branch — that's what discard does
      expect(parkCalls).toEqual([
        { cwd: '/ws/a', target: 'main', runId: 'r1' },
        { cwd: '/ws/b', target: 'main', runId: 'r1' },
      ])
    })

    it('Finding 4: abort() while parked at the finalize gate (no live lane) never merges/discards but parks every project (target left clean, temp branch kept)', async () => {
      const store = new RunStore(ws, 'r1')
      const mergeCalls: string[] = []
      const discardCalls: string[] = []
      const parkCalls: Array<{ cwd: string; target: string; runId: string }> = []
      const c = new RunController(plan, {
        providers: { x: okProvider() }, store, env: {}, projects, sleep: async () => {}, now: () => 0, makeId: idFactory(),
        projectTargets: { a: 'main', b: 'main' },
        mergeTempBranch: async (cwd) => { mergeCalls.push(cwd) },
        discardTempBranch: async (cwd) => { discardCalls.push(cwd) },
        parkTempBranch: async (cwd, target, runId) => { parkCalls.push({ cwd, target, runId }) },
      })
      c.onEvent((e) => {
        if (e.kind === 'gate' && !(e as any).finalize) c.resolveGate(e.id, { type: 'advance' })
        if (e.kind === 'gate' && (e as any).finalize) c.abort()
      })
      const final = await Promise.race([
        c.start(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('deadlock: abort at the finalize gate did not settle')), 2000)),
      ])
      expect(final.status).toBe('failed')
      expect(mergeCalls).toEqual([])
      expect(discardCalls).toEqual([])
      expect(parkCalls).toEqual([
        { cwd: '/ws/a', target: 'main', runId: 'r1' },
        { cwd: '/ws/b', target: 'main', runId: 'r1' },
      ])
    })

    it('I1: mid-run abort with NO projectTargets configured never calls park (nothing to clean up)', async () => {
      const store = new RunStore(ws, 'r1')
      const plan2: RunPlan = { runId: 'r1', stages: [{ key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: false }] }
      const parkCalls: string[] = []
      const c = new RunController(plan2, {
        providers: { x: askingProvider() }, store, env: {}, projects, sleep: async () => {}, now: () => 0, makeId: idFactory(),
        parkTempBranch: async (cwd) => { parkCalls.push(cwd) },
      })
      const authIds: string[] = []
      c.onEvent((e) => {
        if (e.kind !== 'auth') return
        authIds.push(e.id)
        if (authIds.length === 2) c.resolveLane(authIds[0], { type: 'abort' })
      })
      const final = await Promise.race([
        c.start(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('deadlock')), 2000)),
      ])
      expect(final.status).toBe('failed')
      expect(parkCalls).toEqual([])
    })

    it('Finding 4: abort cleanup is best-effort — a park failure for one project does not crash the abort', async () => {
      const store = new RunStore(ws, 'r1')
      const plan2: RunPlan = { runId: 'r1', stages: [{ key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: false }] }
      const parkCalls: string[] = []
      const c = new RunController(plan2, {
        providers: { x: askingProvider() }, store, env: {}, projects, sleep: async () => {}, now: () => 0, makeId: idFactory(),
        projectTargets: { a: 'main', b: 'main' },
        parkTempBranch: async (cwd) => {
          parkCalls.push(cwd)
          if (cwd === '/ws/a') throw new Error('branch already gone')
        },
      })
      const authIds: string[] = []
      c.onEvent((e) => {
        if (e.kind !== 'auth') return
        authIds.push(e.id)
        if (authIds.length === 2) c.resolveLane(authIds[0], { type: 'abort' })
      })
      const final = await Promise.race([
        c.start(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('deadlock')), 2000)),
      ])
      // Never rejects/throws despite project "a"'s park failing — best-effort per abortCleanup's doc.
      expect(final.status).toBe('failed')
      expect(parkCalls).toEqual(['/ws/a', '/ws/b']) // still attempted for BOTH projects
    })

    it('a merge failure for one project surfaces a readable per-project error — start() rejects rather than silently dropping it', async () => {
      const store = new RunStore(ws, 'r1')
      const c = new RunController(plan, {
        providers: { x: okProvider() }, store, env: {}, projects, sleep: async () => {}, now: () => 0, makeId: idFactory(),
        projectTargets: { a: 'main', b: 'main' },
        mergeTempBranch: async (cwd) => { if (cwd === '/ws/b') throw new Error('CONFLICT (content): app.ts') },
      })
      c.onEvent((e) => { if (e.kind === 'gate') c.resolveGate(e.id, (e as any).finalize ? { type: 'merge' } : { type: 'advance' }) })
      await expect(c.start()).rejects.toThrow(/b.*CONFLICT/)
      // Finding 1: the same readable message must also be recorded on the controller's state (not
      // just thrown) — start() rejecting means the caller (Run2Manager) never gets a resolved
      // RunControllerState here, so `error` must already be set by the time the promise rejects
      // (it's set synchronously in runFinalizeGate BEFORE the throw), letting the manager's
      // `.catch` handler surface it to the renderer instead of a generic failed-stage message.
      expect(c.state.error).toMatch(/b.*CONFLICT/)
    })
  })

  describe('P-C2/T1: rehydrating a controller from a state loaded off disk (app-restart resume)', () => {
    it('resumes from the first non-done stage: `done` stages\' providers are never re-invoked', async () => {
      const store = new RunStore(ws, 'r1')
      const calls: string[] = []
      let s3Prompt = ''
      const provider: AgentProvider = {
        id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
        async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
        run(task, cb) {
          calls.push(task.stageKey)
          if (task.stageKey === 's3') s3Prompt = task.prompt
          const done = (async () => { cb.onHandoff?.({ summary: 'ok' }); const r = { ok: true, summary: '' }; cb.onDone(r); return r })()
          return { id: task.agentId, cancel() {}, done }
        },
      }
      const plan3: RunPlan = { runId: 'r1', stages: [
        { key: 's1', name: 'S1', provider: 'x', model: 'm', scope: 'root', gate: false },
        { key: 's2', name: 'S2', provider: 'x', model: 'm', scope: 'root', gate: false },
        { key: 's3', name: 'S3', provider: 'x', model: 'm', scope: 'root', gate: false },
      ] }
      // Simulate s1/s2 having ALREADY completed and written their artifacts to disk (exactly as the
      // real controller does via writeArtifact + setContext('artifacts:<key>', refs)) before the app
      // died — this is the ONLY place downstream prompt assembly gets upstream content from; it must
      // still be there for a brand-new RunStore instance (same runDir) after "restart".
      const ref1 = store.writeArtifact('s1-root.md', 'design output from s1')
      store.setContext('artifacts:s1', [ref1])
      const ref2 = store.writeArtifact('s2-root.md', 'output from s2')
      store.setContext('artifacts:s2', [ref2])

      const savedMachine: MachineState = {
        plan: plan3,
        stages: [
          { key: 's1', status: 'done', round: 0 },
          { key: 's2', status: 'done', round: 0 },
          { key: 's3', status: 'pending', round: 0 },
        ],
        currentIndex: 2,
      }
      // Deliberately NOT passing `outcomes` into rehydrate — proves resume's prompt assembly for s3
      // does not depend on the (slim, in-memory) outcomes of s1/s2 at all, only on the on-disk
      // artifacts context restored above.
      const c = new RunController(
        plan3,
        { providers: { x: provider }, store, env: {}, projects: [], sleep: async () => {}, now: () => 0, makeId: idFactory() },
        { machine: savedMachine },
      )
      const final = await Promise.race([
        c.start(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('deadlock: resumed start() did not settle')), 2000)),
      ])
      expect(final.status).toBe('ok')
      expect(calls).toEqual(['s3']) // s1/s2 providers never re-invoked
      expect(final.machine.stages.map((s) => s.status)).toEqual(['done', 'done', 'done'])
      // The resumed downstream stage's prompt embeds BOTH upstream artifact paths — read via
      // store.getContext('artifacts:...'), i.e. from files on disk, not from in-memory outcomes.
      expect(s3Prompt).toContain(ref1.path)
      expect(s3Prompt).toContain(ref2.path)
    })

    it('a stage that was mid-flight (`running`) at crash time is NOT treated as complete — it re-runs', async () => {
      const store = new RunStore(ws, 'r1')
      const calls: string[] = []
      const provider: AgentProvider = {
        id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
        async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
        run(task, cb) {
          calls.push(task.stageKey)
          const done = (async () => { cb.onHandoff?.({ summary: 'ok' }); const r = { ok: true, summary: '' }; cb.onDone(r); return r })()
          return { id: task.agentId, cancel() {}, done }
        },
      }
      const plan2: RunPlan = { runId: 'r1', stages: [
        { key: 's1', name: 'S1', provider: 'x', model: 'm', scope: 'root', gate: false },
        { key: 's2', name: 'S2', provider: 'x', model: 'm', scope: 'root', gate: false },
      ] }
      // s2 was mid-flight (its lane process died with the app) — never reached `done`.
      const savedMachine: MachineState = {
        plan: plan2,
        stages: [
          { key: 's1', status: 'done', round: 0 },
          { key: 's2', status: 'running', round: 0 },
        ],
        currentIndex: 1,
      }
      const c = new RunController(
        plan2,
        { providers: { x: provider }, store, env: {}, projects: [], sleep: async () => {}, now: () => 0, makeId: idFactory() },
        { machine: savedMachine, outcomes: { s1: [{ id: 's1-0', status: 'ok', attempts: 1 }] } },
      )
      const final = await Promise.race([
        c.start(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('deadlock: resumed start() did not settle')), 2000)),
      ])
      expect(final.status).toBe('ok')
      expect(calls).toEqual(['s2']) // s2's provider IS invoked — re-run, not skipped
      expect(final.machine.stages.map((s) => s.status)).toEqual(['done', 'done'])
      // outcomes reconstructed for display continuity only (see RehydrateState's doc) — s1 shows up
      // even though its providers never ran in THIS process instance.
      expect(final.outcomes['s1']?.[0]?.status).toBe('ok')
    })

    it('a loaded machine that is already fully `done` resumes straight to the finalize check without invoking any provider', async () => {
      const store = new RunStore(ws, 'r1')
      const calls: string[] = []
      const provider = okProvider()
      const origRun = provider.run.bind(provider)
      provider.run = (task, cb, env) => { calls.push(task.stageKey); return origRun(task, cb, env) }
      const savedMachine: MachineState = {
        plan,
        stages: [
          { key: 'design', status: 'done', round: 0 },
          { key: 'develop', status: 'done', round: 0 },
        ],
        currentIndex: 1,
      }
      const c = new RunController(
        plan,
        { providers: { x: provider }, store, env: {}, projects, sleep: async () => {}, now: () => 0, makeId: idFactory() },
        { machine: savedMachine },
      )
      const final = await c.start()
      expect(final.status).toBe('ok')
      expect(calls).toEqual([]) // nothing re-invoked — every stage was already done
    })

    it('Finding 1 (Critical): a redo\'s feedback survives resume — captured "app died at the round\'s gate", rehydrated, the resumed re-run\'s prompt still contains it', async () => {
      const store = new RunStore(ws, 'r1')
      const prompts: string[] = []
      const provider: AgentProvider = {
        id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
        async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
        run(task, cb) {
          prompts.push(task.prompt)
          const done = (async () => { cb.onHandoff?.({ summary: 'ok' }); const r = { ok: true, summary: '' }; cb.onDone(r); return r })()
          return { id: task.agentId, cancel() {}, done }
        },
      }
      const plan4: RunPlan = { runId: 'r1', stages: [
        { key: 'design', name: '方案', provider: 'x', model: 'm', scope: 'root', gate: true },
      ] }
      const c1 = new RunController(plan4, { providers: { x: provider }, store, env: {}, projects: [], sleep: async () => {}, now: () => 0, makeId: idFactory() })

      let gateCount = 0
      let snapshot: RunControllerState | null = null
      c1.onEvent((e) => {
        if (e.kind !== 'gate') return
        gateCount++
        if (gateCount === 1) {
          // Round 0's gate: ask for a redo with feedback — this is the feedback that must survive.
          c1.resolveGate(e.id, { type: 'redo', feedback: '补充：加上错误处理' })
          return
        }
        // Round 1's gate (the redo round re-ran and is now parked here, exactly where a real crash
        // is most likely — user reviewing the redo). Capture the on-disk-equivalent snapshot RIGHT
        // NOW, before resolving anything further — this mirrors what persist.ts would have written
        // to disk at this exact instant (see emitEvent → emitUpdate → saveControllerState).
        snapshot = c1.state
        // Resolve so this controller instance finishes cleanly (no orphaned promise in the test).
        c1.resolveGate(e.id, { type: 'advance' })
      })
      const final1 = await Promise.race([
        c1.start(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('deadlock: c1.start() did not settle')), 2000)),
      ])
      expect(final1.status).toBe('ok')
      expect(gateCount).toBe(2)
      expect(prompts).toHaveLength(2) // round 0, round 1
      expect(prompts[1]).toContain('补充：加上错误处理') // round 1's OWN run got the feedback, as before this fix

      // The regression this locks: at the moment we captured `snapshot` (parked at round 1's gate,
      // "app died here"), the on-disk pendingDirective for 'design' must still hold the feedback —
      // the bug proactively cleared it right after round 1's lanes finished, long before this gate.
      expect(snapshot).not.toBeNull()
      expect(snapshot!.machine.stages[0].round).toBe(1)
      expect(snapshot!.pendingDirective['design']).toBe('补充：加上错误处理')

      // Now rehydrate a FRESH controller from exactly that captured snapshot (a new process, as if
      // the app restarted) and confirm the resumed re-run of 'design' still embeds the feedback.
      const store2 = new RunStore(ws, 'r1') // same runDir — same on-disk artifacts/context as c1
      const resumedPrompts: string[] = []
      const provider2: AgentProvider = {
        id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
        async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
        run(task, cb) {
          resumedPrompts.push(task.prompt)
          const done = (async () => { cb.onHandoff?.({ summary: 'ok' }); const r = { ok: true, summary: '' }; cb.onDone(r); return r })()
          return { id: task.agentId, cancel() {}, done }
        },
      }
      const c2 = new RunController(
        plan4,
        { providers: { x: provider2 }, store: store2, env: {}, projects: [], sleep: async () => {}, now: () => 0, makeId: idFactory() },
        { machine: snapshot!.machine, pendingDirective: snapshot!.pendingDirective, feedback: snapshot!.feedback, stageTimings: snapshot!.stageTimings }
      )
      c2.onEvent((e) => { if (e.kind === 'gate') c2.resolveGate(e.id, { type: 'advance' }) })
      const final2 = await Promise.race([
        c2.start(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('deadlock: resumed c2.start() did not settle')), 2000)),
      ])
      expect(final2.status).toBe('ok')
      expect(resumedPrompts).toHaveLength(1) // the parked round re-runs exactly once
      expect(resumedPrompts[0]).toContain('补充：加上错误处理') // the fix: feedback is NOT lost across resume
    })

    it('Finding 3: resume-while-parked-at-the-finalize-gate — no stage re-runs, and the finalize gate is re-emitted', async () => {
      const store = new RunStore(ws, 'r1')
      const calls: string[] = []
      const provider = okProvider()
      const origRun = provider.run.bind(provider)
      provider.run = (task, cb, env) => { calls.push(task.stageKey); return origRun(task, cb, env) }
      // Every stage already `done` — exactly the state persisted once the machine loop `break`s and
      // control reaches runFinalizeGate() (see start()'s tail), which is where the app died: the
      // finalize gate itself was raised but never resolved before the crash.
      const savedMachine: MachineState = {
        plan,
        stages: [
          { key: 'design', status: 'done', round: 0 },
          { key: 'develop', status: 'done', round: 0 },
        ],
        currentIndex: 1,
      }
      const mergeCalls: string[] = []
      const c = new RunController(
        plan,
        {
          providers: { x: provider }, store, env: {}, projects, sleep: async () => {}, now: () => 0, makeId: idFactory(),
          projectTargets: { a: 'main', b: 'main' }, // turns the finalize gate on — see runFinalizeGate's doc
          mergeTempBranch: async (cwd) => { mergeCalls.push(cwd) },
        },
        { machine: savedMachine },
      )
      let finalizeId = ''
      c.onEvent((e) => { if (e.kind === 'gate' && (e as any).finalize) finalizeId = e.id })
      const startPromise = c.start()
      await vi.waitFor(() => expect(finalizeId).not.toBe(''))
      c.resolveGate(finalizeId, { type: 'merge' })
      const final = await Promise.race([
        startPromise,
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('deadlock: resumed finalize gate never resolved')), 2000)),
      ])
      expect(final.status).toBe('ok')
      expect(calls).toEqual([]) // no stage re-ran on resume — every stage was already done
      expect(mergeCalls).toEqual(['/ws/a', '/ws/b']) // the user could still decide merge vs. discard
    })
  })

  // ④ (spec §7.4 ③硬阻塞): a run stage sub-agent that hits a HARD blocker (missing credential, "which
  // staging env", etc.) should be able to call forge_ask instead of guessing/failing — routed through
  // a per-run live forge bridge (RunController.setupBridge/envForOrder/askFromAgent), reusing the
  // SAME 输入门 (question) card / resolveLane('answer') path the text-fence onInput callback already
  // uses. `startBridge` is injected (RunControllerDeps.startBridge) so these tests never open a real
  // unix socket — they capture the BridgeRunCtx handed to it and drive `ctx.ask(...)` directly,
  // exactly what the real forgeBridge.ts dispatch does when a stage agent calls forge_ask.
  describe('forge_ask bridge (§7.4 ③硬阻塞: hard blocker asks the user)', () => {
    function fakeBridgeStarter(capture: { ctx?: BridgeRunCtx }, socketPath = '/fake/forge.sock') {
      return async (_runDir: string, ctx: BridgeRunCtx): Promise<ForgeBridge> => {
        capture.ctx = ctx
        return { socketPath, close: async () => {} }
      }
    }
    // A provider whose stage agent doesn't finish until the test releases it — lets the test drive
    // a forge_ask (via the captured bridge ctx) while the lane is still "in flight", without racing
    // the lane's own natural completion.
    function blockingProvider(): { provider: AgentProvider; release: () => void } {
      let release!: () => void
      const gate = new Promise<void>((res) => { release = res })
      const provider: AgentProvider = {
        id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
        async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
        run(task, cb) {
          const done = (async () => {
            await gate
            cb.onHandoff?.({ summary: 'ok' })
            const r = { ok: true, summary: '' }; cb.onDone(r); return r
          })()
          return { id: task.agentId, cancel() {}, done }
        },
      }
      return { provider, release }
    }

    it('a forge_ask from a run stage agent surfaces a `question` event for the asking lane, and resolveLane(answer) both resolves it and answers the bridge caller', async () => {
      const store = new RunStore(ws, 'r1')
      const capture: { ctx?: BridgeRunCtx } = {}
      const { provider, release } = blockingProvider()
      const p: RunPlan = { runId: 'r1', stages: [{ key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: false }] }
      const c = new RunController(p, {
        providers: { x: provider }, store, env: {}, projects, sleep: async () => {}, now: () => 0, makeId: idFactory(),
        mcpEntry: '/fake/forgeMcp.js', startBridge: fakeBridgeStarter(capture),
      })
      const events: RunEvent[] = []
      c.onEvent((e) => events.push(e))
      const startPromise = c.start()

      // setupBridge() is awaited before any lane starts (see start()'s doc) — wait for the bridge ctx
      // to actually be captured rather than assuming a fixed number of microtask ticks.
      await vi.waitFor(() => expect(capture.ctx).toBeTruthy())

      // Simulate the bridge dispatching a real forge_ask call from project a's develop-stage agent —
      // agentId is the lane's own WorkOrder.id (`${stageKey}:${project}`, see fanout.ts), exactly what
      // envForOrder() provisions as FORGE_AGENT_ID for that lane.
      const askPromise = capture.ctx!.ask('develop:a', '缺少 STRIPE_API_KEY，该连哪个环境？')

      await vi.waitFor(() => expect(events.some((e) => e.kind === 'question')).toBe(true))
      const q = events.find((e) => e.kind === 'question')!
      expect(q).toMatchObject({ laneId: 'develop:a', stageKey: 'develop', title: '缺少 STRIPE_API_KEY，该连哪个环境？' })

      const resolved = c.resolveLane(q.id, { type: 'answer', value: 'sk-test-123' })
      expect(resolved).toBe(true)
      await expect(askPromise).resolves.toBe('sk-test-123')

      // Let project a's (and b's) agent finish so the run itself completes cleanly.
      release()
      const final = await startPromise
      expect(final.status).toBe('ok')
    })

    it('provisions the bridge socket into the stage agent env (FORGE_SOCKET/FORGE_AGENT_ID/FORGE_MCP_ENTRY/FORGE_TOOLS)', async () => {
      const store = new RunStore(ws, 'r1')
      const capture: { ctx?: BridgeRunCtx } = {}
      const seenEnvs: Record<string, NodeJS.ProcessEnv> = {}
      const provider: AgentProvider = {
        id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
        async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
        run(task, cb, env) {
          seenEnvs[task.agentId] = env
          const done = (async () => { cb.onHandoff?.({ summary: 'ok' }); const r = { ok: true, summary: '' }; cb.onDone(r); return r })()
          return { id: task.agentId, cancel() {}, done }
        },
      }
      const p: RunPlan = { runId: 'r1', stages: [{ key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: false }] }
      const c = new RunController(p, {
        providers: { x: provider }, store, env: { EXISTING: '1' }, projects, sleep: async () => {}, now: () => 0, makeId: idFactory(),
        mcpEntry: '/fake/forgeMcp.js', startBridge: fakeBridgeStarter(capture, '/fake/run-r1/forge.sock'),
      })
      const final = await c.start()
      expect(final.status).toBe('ok')
      // Base env is preserved (proxy/etc. — buildAgentEnv's output, opaque to the controller) alongside
      // the injected forge vars, and FORGE_AGENT_ID is the WorkOrder's own laneId per project.
      expect(seenEnvs['develop:a']).toMatchObject({
        EXISTING: '1',
        FORGE_SOCKET: '/fake/run-r1/forge.sock',
        FORGE_AGENT_ID: 'develop:a',
        FORGE_MCP_ENTRY: '/fake/forgeMcp.js',
      })
      expect(seenEnvs['develop:a'].FORGE_TOOLS).toContain('forge_ask')
      expect(seenEnvs['develop:b']).toMatchObject({ FORGE_AGENT_ID: 'develop:b', FORGE_SOCKET: '/fake/run-r1/forge.sock' })
    })

    it('without deps.mcpEntry, no bridge starts and the stage agent env is unchanged (additive: text-fence handoff still works)', async () => {
      const store = new RunStore(ws, 'r1')
      const seenEnvs: Record<string, NodeJS.ProcessEnv> = {}
      const provider: AgentProvider = {
        id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
        async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
        run(task, cb, env) {
          seenEnvs[task.agentId] = env
          const done = (async () => { cb.onHandoff?.({ summary: 'ok' }); const r = { ok: true, summary: '' }; cb.onDone(r); return r })()
          return { id: task.agentId, cancel() {}, done }
        },
      }
      const p: RunPlan = { runId: 'r1', stages: [{ key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: false }] }
      const c = new RunController(p, { providers: { x: provider }, store, env: { EXISTING: '1' }, projects, sleep: async () => {}, now: () => 0, makeId: idFactory() })
      const final = await c.start()
      expect(final.status).toBe('ok')
      expect(seenEnvs['develop:a']).toEqual({ EXISTING: '1' })
      expect(seenEnvs['develop:a'].FORGE_SOCKET).toBeUndefined()
    })

    // Review finding (Important, resource leak): the per-run bridge is a REAL listening unix-socket
    // server (forgeBridge.ts's net.createServer().listen). Before this fix, `this.bridge.close()`
    // only ran on start()'s normal-completion tail — AFTER the main while loop — so two throw sites
    // INSIDE that loop/finalize (the `orders.length===0` guard, and a mergeTempBranch/discardTempBranch
    // failure in runFinalizeGate) bypassed the close entirely and leaked the socket+fd for the
    // process's lifetime. start() now wraps the whole run body in try/finally so `this.bridge?.close()`
    // runs on EVERY exit — these two tests drive each throw site with mcpEntry set and assert the
    // captured fake bridge's close() was actually invoked (exactly once — no double-close).
    it('closes the bridge when the run throws mid-loop (orders.length===0 guard) — no leaked socket', async () => {
      const store = new RunStore(ws, 'r1')
      const closeCalls: number[] = []
      const bridgeStarter = async (): Promise<ForgeBridge> => ({
        socketPath: '/fake/forge.sock', close: async () => { closeCalls.push(1) },
      })
      // scope 'per-project' with zero projects → buildWorkOrders() returns [] → the guard throws
      // inside the loop, before any lane ever starts.
      const p: RunPlan = { runId: 'r1', stages: [{ key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: false }] }
      const c = new RunController(p, {
        providers: {}, store, env: {}, projects: [], sleep: async () => {}, now: () => 0, makeId: idFactory(),
        mcpEntry: '/fake/forgeMcp.js', startBridge: bridgeStarter,
      })
      await expect(c.start()).rejects.toThrow(/no work orders/)
      expect(closeCalls).toEqual([1]) // closed exactly once despite the throw
    })

    it('closes the bridge when runFinalizeGate throws (merge failure) — no leaked socket', async () => {
      const store = new RunStore(ws, 'r1')
      const closeCalls: number[] = []
      const bridgeStarter = async (): Promise<ForgeBridge> => ({
        socketPath: '/fake/forge.sock', close: async () => { closeCalls.push(1) },
      })
      const c = new RunController(plan, {
        providers: { x: okProvider() }, store, env: {}, projects, sleep: async () => {}, now: () => 0, makeId: idFactory(),
        projectTargets: { a: 'main', b: 'main' },
        mergeTempBranch: async (cwd) => { if (cwd === '/ws/b') throw new Error('CONFLICT (content): app.ts') },
        mcpEntry: '/fake/forgeMcp.js', startBridge: bridgeStarter,
      })
      c.onEvent((e) => { if (e.kind === 'gate') c.resolveGate(e.id, (e as any).finalize ? { type: 'merge' } : { type: 'advance' }) })
      await expect(c.start()).rejects.toThrow(/b.*CONFLICT/)
      expect(closeCalls).toEqual([1]) // closed exactly once despite runFinalizeGate's throw
    })

    it('normal completion still closes the bridge exactly once (no double-close)', async () => {
      const store = new RunStore(ws, 'r1')
      const closeCalls: number[] = []
      const bridgeStarter = async (): Promise<ForgeBridge> => ({
        socketPath: '/fake/forge.sock', close: async () => { closeCalls.push(1) },
      })
      const c = new RunController(plan, {
        providers: { x: okProvider() }, store, env: {}, projects, sleep: async () => {}, now: () => 0, makeId: idFactory(),
        mcpEntry: '/fake/forgeMcp.js', startBridge: bridgeStarter,
      })
      c.onEvent((e) => { if (e.kind === 'gate') c.resolveGate(e.id, { type: 'advance' }) })
      const final = await c.start()
      expect(final.status).toBe('ok')
      expect(closeCalls).toEqual([1])
    })
  })
})
