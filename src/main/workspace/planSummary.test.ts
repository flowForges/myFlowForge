import { describe, it, expect } from 'vitest'
import { planStages, planHooks } from './planSummary'
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
  it('root 阶段 1 代理,per-project 阶段 = 项目数 + 项目名', () => {
    expect(planStages(base)).toEqual([
      { key: 'requirement', name: '需求评估', agents: 1, perProject: false, projects: [] },
      { key: 'develop', name: '代码开发', agents: 3, perProject: true, projects: ['a', 'b', 'c'] },
    ])
  })
  it('无项目时 per-project 也至少 1 代理', () => {
    expect(planStages({ ...base, developProjects: [] })).toEqual([
      { key: 'requirement', name: '需求评估', agents: 1, perProject: false, projects: [] },
      { key: 'develop', name: '代码开发', agents: 1, perProject: true, projects: [] },
    ])
  })
})

describe('planHooks', () => {
  it('列出 woven plugins + __wf stepPlugins,忽略非 __wf 的 stepPlugins', () => {
    const opts = { ...base,
      plugins: [{ id: 'h1', name: '规范', after: 'develop', prompt: '', skills: [], tools: [] }],
      stepPlugins: [
        { id: 'w1', name: '收尾', after: '__wf', prompt: '', skills: [], tools: [] },
        { id: 'b1', name: '建区', after: '__basic', prompt: '', skills: [], tools: [] },
      ],
    } as unknown as StartRunOpts
    expect(planHooks(opts)).toEqual([
      { id: 'h1', name: '规范', after: 'develop' },
      { id: 'w1', name: '收尾', after: '__wf' },
    ])
  })
  it('无 plugins/stepPlugins 时返回空', () => {
    expect(planHooks(base)).toEqual([])
  })
})
