import { describe, it, expect } from 'vitest'
import { planStages } from './planSummary'
import type { StartRunOpts } from '../orchestrator/orchestrator'

const base: StartRunOpts = {
  runId: 'r', workspaceName: 'w', workspacePath: '/w',
  stages: [
    { key: 'requirement', name: '需求评估', provider: 'claude', model: 'opus-4.8' },
    { key: 'develop', name: '代码开发', provider: 'claude', model: 'opus-4.8' },
  ],
  developProjects: [
    { name: 'a', cwd: '/w/a' }, { name: 'b', cwd: '/w/b' }, { name: 'c', cwd: '/w/c' },
  ],
}

describe('planStages', () => {
  it('root 阶段 1 代理,per-project 阶段 = 项目数', () => {
    expect(planStages(base)).toEqual([
      { name: '需求评估', agents: 1 },
      { name: '代码开发', agents: 3 },
    ])
  })
  it('无项目时 per-project 也至少 1 代理', () => {
    expect(planStages({ ...base, developProjects: [] })).toEqual([
      { name: '需求评估', agents: 1 },
      { name: '代码开发', agents: 1 },
    ])
  })
})
