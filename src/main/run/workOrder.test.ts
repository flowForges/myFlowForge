import { describe, it, expect } from 'vitest'
import type { AgentProvider, AgentTask, AgentCallbacks } from '../agents/types'
import { runWorkOrder, isTransientError, type WorkOrder } from './workOrder'

const order: WorkOrder = {
  id: 'develop:proj1', stageKey: 'develop', name: '代码开发', project: 'proj1',
  provider: 'fake', model: 'm', cwd: '/tmp/proj1', prompt: 'do it',
}
const noSleep = async () => {}

function providerThatHandsOff(summary: string): AgentProvider {
  return {
    id: 'fake', displayName: 'F', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
    async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
    run(task: AgentTask, cb: AgentCallbacks) {
      const done = (async () => {
        cb.onState('run')
        cb.onHandoff?.({ summary })
        cb.onState('ok')
        const r = { ok: true, summary }
        cb.onDone(r)
        return r
      })()
      return { id: task.agentId, cancel() {}, done }
    },
  }
}

// 前 N 次抛瞬时错，之后成功
function flakyProvider(failTimes: number): AgentProvider {
  let calls = 0
  return {
    id: 'fake', displayName: 'F', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
    async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
    run(task: AgentTask, cb: AgentCallbacks) {
      calls++
      const shouldFail = calls <= failTimes
      const done = (async () => {
        cb.onState('run')
        if (shouldFail) { cb.onState('err'); throw new Error('network timeout') }
        cb.onHandoff?.({ summary: 'ok now' })
        cb.onState('ok'); const r = { ok: true, summary: 'ok now' }; cb.onDone(r); return r
      })()
      return { id: task.agentId, cancel() {}, done }
    },
  }
}

describe('runWorkOrder', () => {
  it('parses handoff into a structured result on success', async () => {
    const out = await runWorkOrder(order, { provider: providerThatHandsOff('done'), env: {} })
    expect(out.status).toBe('ok')
    expect(out.attempts).toBe(1)
    expect(out.result?.summary).toBe('done')
    expect(out.result?.project).toBeUndefined() // no structured block
  })

  it('retries transient failures then succeeds', async () => {
    const out = await runWorkOrder(order, { provider: flakyProvider(2), env: {}, sleep: noSleep })
    expect(out.status).toBe('ok')
    expect(out.attempts).toBe(3) // 2 fails + 1 success
  })

  it('gives up after retries are exhausted and never throws', async () => {
    const out = await runWorkOrder(order, { provider: flakyProvider(99), env: {}, retries: 2, sleep: noSleep })
    expect(out.status).toBe('failed')
    expect(out.attempts).toBe(3)
    expect(out.error).toMatch(/timeout/)
  })

  it('does not retry a non-transient error', async () => {
    const out = await runWorkOrder(order, {
      provider: flakyProvider(99), env: {}, sleep: noSleep,
      isTransient: () => false,
    })
    expect(out.status).toBe('failed')
    expect(out.attempts).toBe(1)
  })
})

describe('isTransientError', () => {
  it('classifies timeouts/network as transient', () => {
    expect(isTransientError(new Error('network timeout'))).toBe(true)
    expect(isTransientError(new Error('ECONNRESET'))).toBe(true)
    expect(isTransientError(new Error('bad design decision'))).toBe(false)
  })
})
