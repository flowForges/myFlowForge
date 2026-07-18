// src/main/run/controller.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RunStore } from '../orchestrator/runStore'
import { RunController } from './controller'
import type { RunPlan } from './machine'
import type { RunEvent } from './events'
import type { AgentProvider, AgentTask, AgentCallbacks } from '../agents/types'

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
})
