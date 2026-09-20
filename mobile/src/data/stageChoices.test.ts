import { describe, it, expect } from 'vitest'
import { initDrafts, patchDraft, setStageProjectAgent, toStageChoices, stageFansOut, launchBlocker } from './stageChoices'
import type { StageInfo } from './useWorkflow'

const st = (over: Partial<StageInfo> & { key: string }): StageInfo =>
  ({ name: over.key, provider: 'claude', model: 'opus', gate: false, code: false, ...over })

const FLOW: StageInfo[] = [
  st({ key: 'require', name: '需求评估' }),
  st({ key: 'design', name: '技术方案', producesDoc: true }),
  st({ key: 'develop', name: '代码开发', code: true }),
  st({ key: 'test', name: '写单测' }),
]

describe('初始草稿', () => {
  it('全部启用,代理用阶段自己的默认', () => {
    const d = initDrafts(FLOW)
    expect(Object.keys(d)).toEqual(['require', 'design', 'develop', 'test'])
    expect(d.require).toMatchObject({ enabled: true, provider: 'claude', model: 'opus', perProject: false })
  })

  it('★工作区里配过的逐项目代理要带进草稿 —— 否则用户没动过,一提交界面上像是被清空了', () => {
    const d = initDrafts([st({ key: 'test', projectAgents: [{ name: 'api', provider: 'codex', model: 'gpt-5' }] })])
    expect(d.test.projectAgents).toEqual({ api: { provider: 'codex', model: 'gpt-5' } })
  })
})

describe('改草稿', () => {
  it('改一项不动别的阶段', () => {
    const d = patchDraft(initDrafts(FLOW), 'test', { enabled: false })
    expect(d.test.enabled).toBe(false)
    expect(d.require.enabled).toBe(true)
  })
  it('★不认识的 key 原样返回 —— 切工作流那一刻旧 key 还在,不该崩', () => {
    const d = initDrafts(FLOW)
    expect(patchDraft(d, '不存在的阶段', { enabled: false })).toBe(d)
  })
  it('指定逐项目代理,以及清掉它', () => {
    let d = setStageProjectAgent(initDrafts(FLOW), 'test', 'api', { provider: 'codex', model: 'gpt-5' })
    expect(d.test.projectAgents.api).toEqual({ provider: 'codex', model: 'gpt-5' })
    d = setStageProjectAgent(d, 'test', 'api', null)
    expect(d.test.projectAgents.api).toBeUndefined()
  })
})

describe('组装发给服务端的 stages', () => {
  it('★★代码开发和技术方案**不带** perProject —— 带了会把它们的逐项目扇出压成单代理', () => {
    const cs = toStageChoices(FLOW, initDrafts(FLOW), ['api'])
    expect(cs.find((c) => c.key === 'develop')).not.toHaveProperty('perProject')
    expect(cs.find((c) => c.key === 'design')).not.toHaveProperty('perProject')
    expect(cs.find((c) => c.key === 'test')).toHaveProperty('perProject')
  })

  it('关掉的阶段照样发出去(enabled:false),服务端靠它把阶段丢掉', () => {
    const d = patchDraft(initDrafts(FLOW), 'design', { enabled: false })
    expect(toStageChoices(FLOW, d, ['api']).find((c) => c.key === 'design')!.enabled).toBe(false)
  })

  it('逐阶段改的代理带出去', () => {
    const d = patchDraft(initDrafts(FLOW), 'require', { provider: 'codex', model: 'gpt-5' })
    expect(toStageChoices(FLOW, d, []).find((c) => c.key === 'require')).toMatchObject({ provider: 'codex', model: 'gpt-5' })
  })

  it('★★逐项目代理只带**选中的**项目 —— 挂在没选的项目上是纯噪音', () => {
    let d = initDrafts(FLOW)
    d = setStageProjectAgent(d, 'test', 'api', { provider: 'codex', model: 'gpt-5' })
    d = setStageProjectAgent(d, 'test', 'web', { provider: 'claude', model: 'sonnet' })
    const cs = toStageChoices(FLOW, d, ['api'])       // web 没选
    expect(cs.find((c) => c.key === 'test')!.projects).toEqual([{ name: 'api', provider: 'codex', model: 'gpt-5' }])
  })

  it('没改过逐项目代理就不带 projects —— 让主进程回落到工作区那份', () => {
    expect(toStageChoices(FLOW, initDrafts(FLOW), ['api']).find((c) => c.key === 'test')).not.toHaveProperty('projects')
  })
})

describe('这次会不会按项目扇出', () => {
  it('代码开发永远是', () => {
    expect(stageFansOut(FLOW[2]!, initDrafts(FLOW))).toBe(true)
  })
  it('可切的听开关', () => {
    const d = patchDraft(initDrafts(FLOW), 'test', { perProject: true })
    expect(stageFansOut(FLOW[3]!, d)).toBe(true)
    expect(stageFansOut(FLOW[3]!, initDrafts(FLOW))).toBe(false)
  })
})

describe('能不能启动', () => {
  const d = initDrafts(FLOW)
  it('没说要做什么 → 拦', () => {
    expect(launchBlocker(FLOW, d, ['api'], '   ')).toBe('先说一句这次要做什么')
  })
  it('★一个阶段都不留 → 拦', () => {
    let x = d
    for (const s of FLOW) x = patchDraft(x, s.key, { enabled: false })
    expect(launchBlocker(FLOW, x, ['api'], '加分页')).toBe('至少留一个阶段')
  })
  it('★★有按项目跑的阶段开着、却一个项目都没选 → 拦(它会得到零个 lane)', () => {
    expect(launchBlocker(FLOW, d, [], '加分页')).toBe('按项目跑的阶段需要至少选一个项目')
  })
  it('把按项目那些阶段都关掉之后,不选项目也能跑', () => {
    let x = patchDraft(d, 'develop', { enabled: false })
    expect(launchBlocker(FLOW, x, [], '加分页')).toBeNull()
  })
  it('都齐了 → 放行', () => {
    expect(launchBlocker(FLOW, d, ['api'], '加分页')).toBeNull()
  })
})
