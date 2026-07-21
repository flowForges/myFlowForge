import { describe, it, expect } from 'vitest'
import { buildWorkOrders, runStage, type StageInput } from './fanout'
import type { AgentProvider, AgentTask, AgentCallbacks } from '../agents/types'
import type { StagePlan } from './machine'

const buildPrompt = (o: { stageKey: string; project?: string }) => `stage=${o.stageKey} proj=${o.project ?? '-'}`

function failFor(project: string): AgentProvider {
  return {
    id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
    async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
    run(task: AgentTask, cb: AgentCallbacks) {
      const done = (async () => {
        if (task.agentId.includes(project)) {
          cb.onState('err')
          const err = new Error('boom')
          cb.onError(err)
          const r = { ok: false }
          cb.onDone(r)
          return r
        }
        cb.onHandoff?.({ summary: `did ${task.agentId}` }); const r = { ok: true, summary: 'x' }; cb.onDone(r); return r
      })()
      return { id: task.agentId, cancel() {}, done }
    },
  }
}

const rootStage: StagePlan = { key: 'design', name: '方案', provider: 'x', model: 'm', scope: 'root', gate: true }
const devStage: StagePlan = { key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: true }

describe('buildWorkOrders', () => {
  it('root scope produces a single order at workspace cwd', () => {
    const input: StageInput = { stage: rootStage, workspacePath: '/ws', projects: [], upstream: [], buildPrompt }
    const orders = buildWorkOrders(input)
    expect(orders).toHaveLength(1)
    expect(orders[0].id).toBe('design:root')
    expect(orders[0].cwd).toBe('/ws')
  })
  it('per-project produces one order per project, project model overrides stage', () => {
    const input: StageInput = {
      stage: devStage, workspacePath: '/ws',
      projects: [{ name: 'a', cwd: '/ws/a', provider: 'codex', model: 'gpt' }, { name: 'b', cwd: '/ws/b' }],
      upstream: [], buildPrompt,
    }
    const orders = buildWorkOrders(input)
    expect(orders.map((o) => o.id)).toEqual(['develop:a', 'develop:b'])
    expect(orders[0].provider).toBe('codex')
    expect(orders[0].model).toBe('gpt')
    expect(orders[1].provider).toBe('x') // fallback to stage
    expect(orders[1].model).toBe('m')
    expect(orders[1].cwd).toBe('/ws/b')
  })
  it('②多镜头CR: a lens-mode review stage fans out one reviewer per lens at workspace root (wins over scope)', () => {
    const reviewStage: StagePlan = {
      key: 'review', name: '代码 CR', provider: 'x', model: 'm', scope: 'root', gate: true,
      review: { mode: 'parallel', reviewers: ['correctness', 'security'] },
    }
    const orders = buildWorkOrders({ stage: reviewStage, workspacePath: '/ws', projects: [{ name: 'a', cwd: '/ws/a' }], upstream: [], buildPrompt })
    expect(orders.map((o) => o.id)).toEqual(['review:workspace:correctness', 'review:workspace:security'])
    expect(orders.map((o) => o.lens)).toEqual(['correctness', 'security'])
    expect(orders.every((o) => o.cwd === '/ws')).toBe(true) // root, not per-project
  })
  it('②多镜头CR: a non-lens review config falls through to the stage’s normal shape', () => {
    const reviewStage: StagePlan = { key: 'review', name: '代码 CR', provider: 'x', model: 'm', scope: 'root', gate: true, review: { mode: 'single' } }
    const orders = buildWorkOrders({ stage: reviewStage, workspacePath: '/ws', projects: [], upstream: [], buildPrompt })
    expect(orders.map((o) => o.id)).toEqual(['review:root']) // single root order, unchanged
  })
  it('②多镜头CR: a PER-PROJECT stage carrying a stray lens config is NOT hijacked into lens fan-out', () => {
    const strayed: StagePlan = { key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: true, review: { mode: 'parallel', reviewers: ['security'] } }
    const orders = buildWorkOrders({ stage: strayed, workspacePath: '/ws', projects: [{ name: 'a', cwd: '/ws/a' }, { name: 'b', cwd: '/ws/b' }], upstream: [], buildPrompt })
    expect(orders.map((o) => o.id)).toEqual(['develop:a', 'develop:b']) // per-project preserved, no lens lanes
  })
})

describe('runStage', () => {
  it('one failing lane does not sink the siblings', async () => {
    const input: StageInput = {
      stage: devStage, workspacePath: '/ws',
      projects: [{ name: 'a', cwd: '/ws/a' }, { name: 'b', cwd: '/ws/b' }, { name: 'c', cwd: '/ws/c' }],
      upstream: [], buildPrompt,
    }
    const orders = buildWorkOrders(input)
    const provider = failFor('b')
    const outcomes = await runStage(orders, () => ({ provider, env: {}, sleep: async () => {}, isTransient: () => false }))
    const byId = Object.fromEntries(outcomes.map((o) => [o.order.id, o.status]))
    expect(byId).toEqual({ 'develop:a': 'ok', 'develop:b': 'failed', 'develop:c': 'ok' })
  })
})
