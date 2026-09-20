import { describe, it, expect } from 'vitest'
import {
  addStage, draftFromFlow, isDirty, moveStage, removeStage, saveBlocker, setName,
  setStageAgent, toggleGate, toWorkflowEdit, type CatalogStage, type FlowDraft,
} from './flowDraft'
import type { WorkflowInfo } from './useWorkflow'

const flow: WorkflowInfo = {
  id: 'light', name: '轻量',
  stages: [
    { key: 'requirement', name: '需求评估', provider: 'claude', model: 'opus', gate: true, code: false, producesDoc: true, desc: '梳理' },
    { key: 'develop', name: '代码开发', provider: 'codex', model: 'gpt-5', gate: false, code: true },
  ],
}
const cat = (over: Partial<CatalogStage> = {}): CatalogStage =>
  ({ key: 'test', name: '写单测', desc: '补测试', provider: 'claude', model: 'opus', code: false, producesDoc: false, gate: false, ...over })

describe('draftFromFlow', () => {
  it('照抄启动屏已经解析好的那份 —— 不在手机上重新解析一遍', () => {
    const d = draftFromFlow(flow)
    expect(d).toEqual({
      id: 'light', name: '轻量',
      stages: [
        { key: 'requirement', name: '需求评估', desc: '梳理', provider: 'claude', model: 'opus', code: false, producesDoc: true, gate: true },
        { key: 'develop', name: '代码开发', desc: '', provider: 'codex', model: 'gpt-5', code: true, producesDoc: false, gate: false },
      ],
    })
  })
  it('新建 = 一条空的', () => {
    expect(draftFromFlow(null)).toEqual({ id: '', name: '', stages: [] })
  })
})

describe('改阶段', () => {
  it('上移 / 下移', () => {
    expect(moveStage(draftFromFlow(flow), 1, -1).stages.map((s) => s.key)).toEqual(['develop', 'requirement'])
    expect(moveStage(draftFromFlow(flow), 0, 1).stages.map((s) => s.key)).toEqual(['develop', 'requirement'])
  })
  it('★第一条上移 / 最后一条下移原样返回 —— 人就是会去点', () => {
    const d = draftFromFlow(flow)
    expect(moveStage(d, 0, -1)).toEqual(d)
    expect(moveStage(d, 1, 1)).toEqual(d)
    expect(moveStage(d, 9, -1)).toEqual(d)
  })
  it('删一个', () => {
    expect(removeStage(draftFromFlow(flow), 'develop').stages.map((s) => s.key)).toEqual(['requirement'])
  })
  it('加一个,加在最后', () => {
    expect(addStage(draftFromFlow(flow), cat()).stages.map((s) => s.key)).toEqual(['requirement', 'develop', 'test'])
  })
  it('★同 key 的加不进去 —— 跑起来会撞 id', () => {
    const d = draftFromFlow(flow)
    expect(addStage(d, cat({ key: 'develop', name: '另一个开发' }))).toEqual(d)
  })
  it('自定义阶段带上 libId', () => {
    expect(addStage(draftFromFlow(flow), cat({ key: 'perf', libId: 'lib1' })).stages[2].libId).toBe('lib1')
  })
  it('换代理只动那一条', () => {
    const d = setStageAgent(draftFromFlow(flow), 'develop', { provider: 'claude', model: 'sonnet' })
    expect(d.stages[1]).toMatchObject({ provider: 'claude', model: 'sonnet' })
    expect(d.stages[0].provider).toBe('claude')
    expect(d.stages[0].model).toBe('opus')
  })
  it('开关确认门', () => {
    expect(toggleGate(draftFromFlow(flow), 'develop').stages[1].gate).toBe(true)
    expect(toggleGate(draftFromFlow(flow), 'requirement').stages[0].gate).toBe(false)
  })
})

describe('saveBlocker', () => {
  const d = draftFromFlow(flow)
  it('没名字', () => { expect(saveBlocker(setName(d, '  '), [])).toContain('名字') })
  it('重名(和别条比,不和自己比)', () => {
    expect(saveBlocker(d, ['完整', '轻量'])).toContain('轻量')
    expect(saveBlocker(d, ['完整'])).toBeNull()
  })
  it('★一个阶段都不留 —— 主机那边存下去就是「回退全局模板」,下次启动全长回来', () => {
    expect(saveBlocker({ ...d, stages: [] }, [])).toBe('至少留一个阶段')
  })
  it('阶段没代理', () => {
    expect(saveBlocker({ ...d, stages: [{ ...d.stages[0], provider: '' }] }, [])).toContain('代理')
  })
})

describe('toWorkflowEdit', () => {
  it('只发主机需要的那几个字段(name/desc/code 这些是给界面看的,不发)', () => {
    expect(toWorkflowEdit(setName(draftFromFlow(flow), ' 轻量 '))).toEqual({
      id: 'light', name: '轻量',
      stages: [
        { key: 'requirement', provider: 'claude', model: 'opus', gate: true },
        { key: 'develop', provider: 'codex', model: 'gpt-5', gate: false },
      ],
    })
  })
  it('libId 有才带', () => {
    const d = addStage(draftFromFlow(flow), cat({ key: 'perf', libId: 'lib1' }))
    expect(toWorkflowEdit(d).stages[2]).toEqual({ key: 'perf', provider: 'claude', model: 'opus', gate: false, libId: 'lib1' })
  })
})

describe('isDirty', () => {
  it('没改 = false', () => { expect(isDirty(draftFromFlow(flow), draftFromFlow(flow))).toBe(false) })
  it('挪了顺序也算改了 —— 顺序就是工作流本身', () => {
    expect(isDirty(draftFromFlow(flow), moveStage(draftFromFlow(flow), 0, 1))).toBe(true)
  })
  it('改了确认门也算', () => {
    expect(isDirty(draftFromFlow(flow), toggleGate(draftFromFlow(flow), 'develop'))).toBe(true)
  })
})

describe('原状不变(纯函数)', () => {
  it('每个改法都返回新对象,不动传进去那份', () => {
    const d: FlowDraft = draftFromFlow(flow)
    const snapshot = JSON.stringify(d)
    moveStage(d, 0, 1); removeStage(d, 'develop'); addStage(d, cat()); setStageAgent(d, 'develop', { provider: 'x', model: 'y' }); toggleGate(d, 'develop'); setName(d, 'z')
    expect(JSON.stringify(d)).toBe(snapshot)
  })
})
