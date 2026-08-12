import { describe, it, expect } from 'vitest'
import { planToStageViews, buildWorkflowSession, tailLaunchConfig, extractProjectBriefs } from './workflowEnter'
import type { RunPlan } from './machine'

const plan: RunPlan = {
  runId: 'r1',
  stages: [
    { key: 'requirement', name: '需求评估', provider: 'claude', model: 'opus', scope: 'root', gate: false, prompt: '梳理需求' },
    { key: 'design', name: '技术方案设计', provider: 'claude', model: 'opus', scope: 'root', gate: true, prompt: '出方案', permissionMode: 'readonly' },
    { key: 'develop', name: '代码开发', provider: 'codex', model: 'gpt', scope: 'per-project', gate: false, prompt: '写代码' },
  ],
}

describe('planToStageViews', () => {
  it('maps each StagePlan to a stage view carrying provider/model/permission/scope/preamble', () => {
    const views = planToStageViews(plan)
    expect(views).toHaveLength(3)
    expect(views[1]).toMatchObject({ key: 'design', provider: 'claude', model: 'opus', scope: 'root', permissionMode: 'readonly' })
    // root(对话)阶段 preamble = 原 prompt + 对话模式覆盖说明(修图6)
    expect(views[1].preamble).toContain('出方案')
    expect(views[1].preamble).toContain('对话模式')
    // per-project(执行)阶段不加对话说明,保持原样(它们真的有 forge 工具)
    expect(views[2]).toMatchObject({ key: 'develop', scope: 'per-project', preamble: '写代码' })
  })
})

describe('buildWorkflowSession', () => {
  it('starts at index 0 in chatting when the first stage is conversational (root)', () => {
    const ws = buildWorkflowSession({ flowId: 'wf1', flowName: '标准', plan, projects: [{ name: 'api', provider: 'codex', model: 'gpt' }], seed: 's', supplement: 'x' })
    expect(ws.currentIndex).toBe(0)
    expect(ws.phase).toBe('chatting')
    expect(ws.flowId).toBe('wf1')
    expect(ws.projects[0].name).toBe('api')
    expect(ws.seed).toBe('s')
  })
  it('starts in executing when the first stage is fan-out (per-project)', () => {
    const p: RunPlan = { runId: 'r', stages: [{ key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: false }] }
    const ws = buildWorkflowSession({ flowId: 'wf', flowName: 'f', plan: p, projects: [] })
    expect(ws.phase).toBe('executing')
  })
})

// 阶段级项目代理(按项目 CR 换 provider)必须一路活到执行尾段:对话式工作流先聊需求/方案,点「下一步」
// 才启动尾段 run —— 中途只要 session 没记住它,用户在启动门里选的 codex 就会在真正开跑时悄悄变回 claude。
describe('阶段级项目代理:对话式工作流全程不丢', () => {
  const withAgents: RunPlan = {
    runId: 'r2',
    stages: [
      { key: 'design', name: '技术方案设计', provider: 'claude', model: 'opus', scope: 'root', gate: true },
      { key: 'review', name: '代码CR', provider: 'claude', model: 'opus', scope: 'per-project', gate: true,
        projectAgents: [{ name: 'a', provider: 'codex', model: 'gpt-5-codex' }] },
    ],
  }

  it('planToStageViews 把它记进 session 的阶段视图', () => {
    expect(planToStageViews(withAgents)[1].projectAgents).toEqual([{ name: 'a', provider: 'codex', model: 'gpt-5-codex' }])
  })

  it('tailLaunchConfig 原样回传给尾段启动配置', () => {
    const cfg = tailLaunchConfig(
      { workspacePath: '/ws', flowId: 'wf', projects: [{ name: 'a', provider: 'claude', model: 'opus' }] },
      planToStageViews(withAgents), 1,
    )
    expect(cfg.stages!.find((s) => s.key === 'review')!.projects).toEqual([{ name: 'a', provider: 'codex', model: 'gpt-5-codex' }])
  })

  it('没配过的阶段不带这个字段', () => {
    const cfg = tailLaunchConfig({ workspacePath: '/ws', flowId: 'wf', projects: [] }, planToStageViews(plan), 2)
    expect(cfg.stages!.every((s) => s.projects === undefined)).toBe(true)
  })
})

describe('tailLaunchConfig', () => {
  it('enables only stages from fromIndex and restores each stage scope via perProject', () => {
    const views = planToStageViews(plan)
    const cfg = tailLaunchConfig(
      { workspacePath: '/ws', flowId: 'wf1', sessionId: 'sess', seed: 's', supplement: 'x', projects: [{ name: 'api', provider: 'codex', model: 'gpt', permissionMode: 'full' }] },
      views, 2,
    )
    expect(cfg.workflowId).toBe('wf1')
    expect(cfg.sessionId).toBe('sess')
    expect(cfg.projects[0].permissionMode).toBe('full')
    // only develop (index 2) enabled
    expect(cfg.stages!.map((s) => [s.key, s.enabled])).toEqual([['requirement', false], ['design', false], ['develop', true]])
    // scope restored: root stages → perProject false, fan-out → true
    expect(cfg.stages!.map((s) => s.perProject)).toEqual([false, false, true])
    // per-stage permission carried
    expect(cfg.stages!.find((s) => s.key === 'design')!.permissionMode).toBe('readonly')
    // lead stages = the already-done conversational stages before the tail (for full-workflow progress)
    expect(cfg.leadStages!.map((s) => s.key)).toEqual(['requirement', 'design'])
  })
})

describe('extractProjectBriefs', () => {
  const md = [
    '# 技术方案',
    '## 整体方案',
    '整体设计……',
    '## 各项目任务分工',
    '### go-blog',
    '目标：前端接入角色权限。',
    '- 改 src/router 菜单守卫',
    '### zgh',
    '目标：无。',
    '## 风险',
    '略',
  ].join('\n')

  it('extracts each project section under the 分工 heading', () => {
    const { found, sections } = extractProjectBriefs(md, ['go-blog', 'zgh', 'go-blog-backend'])
    expect(found).toBe(true)
    expect(sections['go-blog']).toContain('前端接入角色权限')
    expect(sections['go-blog']).toContain('菜单守卫')
    expect(sections['zgh']).toContain('目标：无')
    // a project with no subsection is simply absent (caller falls back)
    expect(sections['go-blog-backend']).toBeUndefined()
    // must not bleed the following ## 风险 section into zgh
    expect(sections['zgh']).not.toContain('略')
  })

  it('assigns a prefix-colliding project to the LONGEST match (go-blog-backend not swallowed by go-blog)', () => {
    const doc = [
      '## 各项目任务分工',
      '### 📦 go-blog',
      '目标：改后端。',
      '### 📦 go-blog-backend',
      '目标：改前端。',
    ].join('\n')
    const { sections } = extractProjectBriefs(doc, ['go-blog', 'go-blog-backend'])
    expect(sections['go-blog']).toContain('改后端')
    expect(sections['go-blog']).not.toContain('改前端')
    expect(sections['go-blog-backend']).toContain('改前端')
  })

  it('matches headings that merely contain the project name', () => {
    const doc = '## 各项目任务分工\n### go-blog（前端）\n做前端\n'
    const { sections } = extractProjectBriefs(doc, ['go-blog'])
    expect(sections['go-blog']).toContain('做前端')
  })

  it('falls back to whole-doc heading search when there is no 分工 section', () => {
    const doc = '# 方案\n## go-blog\n做这个\n## other\n无关'
    const { found, sections } = extractProjectBriefs(doc, ['go-blog'])
    expect(found).toBe(true)
    expect(sections['go-blog']).toContain('做这个')
    expect(sections['go-blog']).not.toContain('无关')
  })

  it('returns found=false for empty/irrelevant docs', () => {
    expect(extractProjectBriefs('', ['a']).found).toBe(false)
    expect(extractProjectBriefs('# 方案\n没有任何项目节', ['a']).found).toBe(false)
  })
})
