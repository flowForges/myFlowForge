import { describe, it, expect } from 'vitest'
import { buildReviewTasks, type ReviewerTask } from './reviewTasks'
import type { ReviewConfig } from '../config/schema'

const projects = [
  { name: 'web', cwd: '/ws/web' },
  { name: 'api', cwd: '/ws/api' },
]
const root = { name: 'review', cwd: '/ws' }
const ids = (t: ReviewerTask[]) => t.map(x => x.id)

describe('buildReviewTasks', () => {
  it('single -> one root-scope reviewer审全工作区(id "review", cwd = workspace root)', () => {
    const cfg: ReviewConfig = { mode: 'single' }
    const tasks = buildReviewTasks(cfg, projects, root)
    expect(ids(tasks)).toEqual(['review'])
    expect(tasks[0]).toMatchObject({ id: 'review', name: '代码 CR', cwd: '/ws' })
    expect(tasks[0].lens).toBeUndefined()
  })

  it('single still produces ONE reviewer even with zero projects', () => {
    expect(ids(buildReviewTasks({ mode: 'single' }, [], root))).toEqual(['review'])
  })

  it('parallel per-project -> one reviewer per project worktree (mirrors develop fan-out)', () => {
    const cfg: ReviewConfig = { mode: 'parallel', scope: 'per-project' }
    const tasks = buildReviewTasks(cfg, projects, root)
    expect(ids(tasks)).toEqual(['review:web', 'review:api'])
    expect(tasks.map(t => t.cwd)).toEqual(['/ws/web', '/ws/api'])
    expect(tasks.map(t => t.name)).toEqual(['web', 'api'])
  })

  it('parallel per-project with NO projects falls back to a single root reviewer', () => {
    expect(ids(buildReviewTasks({ mode: 'parallel', scope: 'per-project' }, [], root))).toEqual(['review'])
  })

  it('parallel multi-lens (scope=workspace, reviewers=lens[]) -> one reviewer per lens, same root scope', () => {
    const cfg: ReviewConfig = { mode: 'parallel', scope: 'workspace', reviewers: ['correctness', 'security'] }
    const tasks = buildReviewTasks(cfg, projects, root)
    expect(ids(tasks)).toEqual(['review:workspace:correctness', 'review:workspace:security'])
    expect(tasks.every(t => t.cwd === '/ws')).toBe(true)
    expect(tasks.map(t => t.lens)).toEqual(['correctness', 'security'])
  })

  it('parallel defaults scope to per-project when scope omitted', () => {
    expect(ids(buildReviewTasks({ mode: 'parallel' }, projects, root))).toEqual(['review:web', 'review:api'])
  })
})
