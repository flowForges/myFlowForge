import { describe, it, expect } from 'vitest'
import { reviewLenses, isLensReviewStage, reviewLaneId, reviewLaneName, lensDirective, buildReviewOrders, composeReviewReport } from './reviewFanout'
import type { StagePlan } from './machine'
import type { WorkOrderOutcome } from './workOrder'

const reviewStage = (review: StagePlan['review']): StagePlan => ({
  key: 'review', name: '代码 CR', provider: 'claude', model: 'm', scope: 'root', gate: true, review,
})

describe('reviewLenses', () => {
  it('parallel + lens[] → the lens array', () => {
    expect(reviewLenses({ mode: 'parallel', reviewers: ['security', 'correctness'] })).toEqual(['security', 'correctness'])
  })
  it('single / number / empty / undefined → null (not lens mode)', () => {
    expect(reviewLenses({ mode: 'single' })).toBeNull()
    expect(reviewLenses({ mode: 'parallel', reviewers: 3 })).toBeNull()
    expect(reviewLenses({ mode: 'parallel', reviewers: [] })).toBeNull()
    expect(reviewLenses({ mode: 'parallel', scope: 'per-project' })).toBeNull()
    expect(reviewLenses(undefined)).toBeNull()
  })
})

describe('isLensReviewStage', () => {
  const lens = { mode: 'parallel' as const, reviewers: ['security' as const] }
  it('true only for a ROOT-scope stage with a lens config', () => {
    expect(isLensReviewStage({ scope: 'root', review: lens })).toBe(true)
  })
  it('false for a per-project stage even with a lens config (no hijack)', () => {
    expect(isLensReviewStage({ scope: 'per-project', review: lens })).toBe(false)
  })
  it('false for a root stage with no / non-lens review config', () => {
    expect(isLensReviewStage({ scope: 'root' })).toBe(false)
    expect(isLensReviewStage({ scope: 'root', review: { mode: 'single' } })).toBe(false)
  })
})

describe('lane id/name/directive', () => {
  it('id + name encode the lens', () => {
    expect(reviewLaneId('review', 'security')).toBe('review:workspace:security')
    expect(reviewLaneName('代码 CR', 'security')).toBe('代码 CR · 安全')
  })
  it('directive names the lens focus', () => {
    expect(lensDirective('performance')).toContain('性能')
    expect(lensDirective('performance')).toContain('本次评审视角')
  })
})

describe('buildReviewOrders', () => {
  it('one order per lens at workspace root, carrying its lens + lens-scoped prompt', () => {
    const stage = reviewStage({ mode: 'parallel', reviewers: ['correctness', 'security'] })
    const seen: Array<{ lens?: string }> = []
    const orders = buildReviewOrders(stage, '/ws', (o) => { seen.push({ lens: o.lens }); return `P:${o.lens}` }, 'full')
    expect(orders.map(o => o.id)).toEqual(['review:workspace:correctness', 'review:workspace:security'])
    expect(orders.map(o => o.name)).toEqual(['代码 CR · 正确性', '代码 CR · 安全'])
    expect(orders.every(o => o.cwd === '/ws')).toBe(true)
    expect(orders.every(o => o.permissionMode === 'full')).toBe(true)
    expect(orders.map(o => o.lens)).toEqual(['correctness', 'security'])
    expect(orders.map(o => o.prompt)).toEqual(['P:correctness', 'P:security'])
    expect(seen).toEqual([{ lens: 'correctness' }, { lens: 'security' }])
  })
  it('non-lens config → no orders (caller falls through to normal fan-out)', () => {
    expect(buildReviewOrders(reviewStage({ mode: 'single' }), '/ws', () => 'x')).toEqual([])
  })
})

describe('composeReviewReport', () => {
  const okOutcome = (lens: any, summary: string): WorkOrderOutcome => ({
    order: { id: `review:workspace:${lens}`, stageKey: 'review', name: `代码 CR · ${lens}`, provider: 'c', model: 'm', cwd: '/ws', prompt: '', lens },
    status: 'ok', attempts: 1, result: { summary, filesChanged: [], blockers: [], doubts: [], artifacts: [] },
  })
  it('groups by lens label, shows each verdict + count', () => {
    const r = composeReviewReport('代码 CR', [okOutcome('correctness', '无正确性问题'), okOutcome('security', '发现越权')])
    expect(r).toContain('代码 CR汇总 · 2 个视角')
    expect(r).toContain('### 正确性\n无正确性问题')
    expect(r).toContain('### 安全\n发现越权')
  })
  it('failed reviewer shows ✗ error', () => {
    const failed: WorkOrderOutcome = {
      order: { id: 'review:workspace:performance', stageKey: 'review', name: 'x', provider: 'c', model: 'm', cwd: '/ws', prompt: '', lens: 'performance' },
      status: 'failed', attempts: 3, error: '超时',
    }
    expect(composeReviewReport('代码 CR', [failed])).toContain('### 性能\n  ✗ 超时')
  })
})
