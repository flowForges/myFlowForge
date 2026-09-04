import { describe, it, expect } from 'vitest'
import type { Workspace, Workflow, CustomStage } from '../config/schema'
import { buildStageCatalog, upsertWorkflow, removeWorkflow } from './editWorkflows'

const ws = (over: Partial<Workspace> = {}): Workspace => ({
  name: 'w', path: '/w', workflowId: '', stages: [], projects: [],
  status: 'idle', plugins: [], stepPlugins: [],
  workflows: [
    { id: 'light', name: '轻量', stages: [
      // ★这条阶段带着电脑端配好的提示词/CR 配置 —— 手机上看不见的东西。
      { key: 'requirement', provider: 'claude', model: 'opus-4.8', prompt: '别改数据库', permissionMode: 'readonly' },
      { key: 'review', provider: 'claude', model: 'opus-4.8', review: { mode: 'parallel', reviewers: ['security'] } },
    ] },
    { id: 'full', name: '完整', stages: [{ key: 'develop', provider: 'codex', model: 'gpt-5' }] },
  ],
  ...over,
})

const globals: Workflow[] = [{
  // stagePrompts:模板级的追加段。它只在「工作区那条工作流 stages 为空 ⇒ 回退模板」这条路上
  // 被物化出来 —— 下面那条测试就是拿它钉死「合并的底必须是解析后的阶段」的。
  id: 'standard', name: '标准工作流', plugins: [], stagePrompts: { develop: '小步提交' },
  stages: [
    { key: 'requirement', defaultAgent: 'codex', defaultModel: 'gpt-5' },
    { key: 'develop', defaultAgent: 'claude', defaultModel: 'opus-4.8' },
  ],
}]

const lib: CustomStage[] = [{
  id: 'lib1', key: 'perf', name: '性能回归', defaultAgent: 'codex', defaultModel: 'gpt-5',
  prompt: '跑一遍压测', producesDoc: true, gate: true,
}]

describe('buildStageCatalog', () => {
  it('内置阶段的默认代理取自全局模板,取不到才落 claude', () => {
    const cat = buildStageCatalog(globals, [])
    expect(cat.builtin.find((s) => s.key === 'requirement')).toMatchObject({ provider: 'codex', model: 'gpt-5', name: '需求评估' })
    // 'test' 没在任何全局模板里 → 落回默认,而不是留一个空 provider(存下去就是跑不起来的阶段)。
    expect(cat.builtin.find((s) => s.key === 'test')?.provider).toBe('claude')
  })
  it('内置阶段带着「天生按项目/必须产出文档」两个标记 —— 手机端据此决定给不给开关', () => {
    const cat = buildStageCatalog(globals, [])
    expect(cat.builtin.find((s) => s.key === 'develop')?.code).toBe(true)
    expect(cat.builtin.find((s) => s.key === 'design')?.producesDoc).toBe(true)
    expect(cat.builtin.find((s) => s.key === 'test')?.code).toBe(false)
  })
  it('自定义阶段库整条列出来,带 libId', () => {
    const cat = buildStageCatalog(globals, lib)
    expect(cat.custom).toEqual([{ libId: 'lib1', key: 'perf', name: '性能回归', desc: '', provider: 'codex', model: 'gpt-5', code: false, producesDoc: true, gate: true }])
  })
})

describe('upsertWorkflow · 改一条已有的', () => {
  it('★手机上只动了顺序和代理,电脑端配的提示词/权限档/CR 配置一个都不能丢', () => {
    const out = upsertWorkflow(ws(), {
      id: 'light', name: '轻量',
      stages: [
        { key: 'review', provider: 'claude', model: 'opus-4.8' },
        { key: 'requirement', provider: 'codex', model: 'gpt-5' },
      ],
    }, globals, lib)
    const light = out.find((w) => w.id === 'light')!
    expect(light.stages.map((s) => s.key)).toEqual(['review', 'requirement'])
    expect(light.stages[1]).toMatchObject({ provider: 'codex', model: 'gpt-5', prompt: '别改数据库', permissionMode: 'readonly' })
    expect(light.stages[0].review).toEqual({ mode: 'parallel', reviewers: ['security'] })
  })

  it('没动的那条工作流原样留着', () => {
    const out = upsertWorkflow(ws(), { id: 'light', name: '轻量', stages: [{ key: 'requirement', provider: 'claude', model: 'opus-4.8' }] }, globals, lib)
    expect(out.find((w) => w.id === 'full')).toEqual(ws().workflows[1])
  })

  it('删掉的阶段真的没了', () => {
    const out = upsertWorkflow(ws(), { id: 'light', name: '轻量', stages: [{ key: 'review', provider: 'claude', model: 'opus-4.8' }] }, globals, lib)
    expect(out.find((w) => w.id === 'light')!.stages.map((s) => s.key)).toEqual(['review'])
  })

  it('改名字', () => {
    const out = upsertWorkflow(ws(), { id: 'light', name: '快跑', stages: [{ key: 'review', provider: 'c', model: 'm' }] }, globals, lib)
    expect(out.find((w) => w.id === 'light')!.name).toBe('快跑')
  })

  it('gate 传了才改,不传不动', () => {
    const base = ws({ workflows: [{ id: 'light', name: '轻量', stages: [{ key: 'review', provider: 'c', model: 'm', gate: true }] }] })
    expect(upsertWorkflow(base, { id: 'light', name: '轻量', stages: [{ key: 'review', provider: 'c', model: 'm' }] }, globals, lib)[0].stages[0].gate).toBe(true)
    expect(upsertWorkflow(base, { id: 'light', name: '轻量', stages: [{ key: 'review', provider: 'c', model: 'm', gate: false }] }, globals, lib)[0].stages[0].gate).toBe(false)
  })

  it('★空 stages 的工作流(靠回退全局模板)编辑后,存的是物化后的阶段 —— 删掉的不会因回退长回来', () => {
    const base = ws({ workflows: [{ id: 'standard', name: '标准工作流', stages: [] }] })
    const out = upsertWorkflow(base, {
      id: 'standard', name: '标准工作流',
      stages: [{ key: 'develop', provider: 'claude', model: 'opus-4.8' }],
    }, globals, lib)
    expect(out[0].stages.map((s) => s.key)).toEqual(['develop'])
    // ★物化,不是抄手机发来的三个字段:模板里的追加段跟着落到工作区了。
    // 拿 `wf.stages`(空数组)当底的话这里会是 undefined,而界面上一切正常 —— 下一次跑才发现少了指令。
    expect(out[0].stages[0].prompt).toBe('小步提交')
    // 回退路径已断开:stages 非空,下次 resolveWorkflowStages 不会再去看全局模板。
    expect(out[0].stages.length).toBe(1)
  })
})

describe('upsertWorkflow · 新建', () => {
  it('新建一条,老的都还在,id 由服务端按名字生成', () => {
    const out = upsertWorkflow(ws(), { id: '', name: 'hotfix', stages: [{ key: 'develop', provider: 'claude', model: 'opus-4.8' }] }, globals, lib)
    expect(out.map((w) => w.name)).toEqual(['轻量', '完整', 'hotfix'])
    expect(out[2].id).toBe('hotfix')
  })

  it('id 撞了自动加序号', () => {
    const base = ws({ workflows: [{ id: 'hotfix', name: '别的', stages: [{ key: 'develop', provider: 'c', model: 'm' }] }] })
    const out = upsertWorkflow(base, { id: '', name: 'hotfix', stages: [{ key: 'develop', provider: 'c', model: 'm' }] }, globals, lib)
    expect(out[1].id).toBe('hotfix-2')
  })

  it('★加一条自定义阶段:提示词和行为开关从阶段库物化下来(WsStage 没有 libId,存的是快照)', () => {
    const out = upsertWorkflow(ws(), { id: '', name: '带压测', stages: [{ key: 'perf', provider: '', model: '', libId: 'lib1' }] }, globals, lib)
    expect(out[2].stages[0]).toEqual({ key: 'perf', provider: 'codex', model: 'gpt-5', name: '性能回归', prompt: '跑一遍压测', gate: true, producesDoc: true })
  })

  it('库项已经被删了也不崩:退化成一个裸阶段', () => {
    const out = upsertWorkflow(ws(), { id: '', name: 'x', stages: [{ key: 'perf', provider: 'claude', model: 'm', libId: '没了' }] }, globals, lib)
    expect(out[2].stages[0]).toEqual({ key: 'perf', provider: 'claude', model: 'm' })
  })

  it('id 对不上(手机上的列表过期了)按新建处理,不静默改错人', () => {
    const out = upsertWorkflow(ws(), { id: '不存在', name: '新的', stages: [{ key: 'develop', provider: 'c', model: 'm' }] }, globals, lib)
    expect(out.length).toBe(3)
    expect(out[0]).toEqual(ws().workflows[0])
  })
})

describe('upsertWorkflow · 拦下来的', () => {
  it('名字空的', () => {
    expect(() => upsertWorkflow(ws(), { id: '', name: '  ', stages: [{ key: 'develop', provider: 'c', model: 'm' }] }, globals, lib)).toThrow('名字')
  })
  it('重名', () => {
    expect(() => upsertWorkflow(ws(), { id: '', name: '完整', stages: [{ key: 'develop', provider: 'c', model: 'm' }] }, globals, lib)).toThrow('完整')
  })
  it('改名字改成跟自己一样不算重名', () => {
    expect(() => upsertWorkflow(ws(), { id: 'light', name: '轻量', stages: [{ key: 'review', provider: 'c', model: 'm' }] }, globals, lib)).not.toThrow()
  })
  it('★一个阶段都不留 —— 存下去就是「回退全局模板」,下次启动全长回来', () => {
    expect(() => upsertWorkflow(ws(), { id: 'light', name: '轻量', stages: [] }, globals, lib)).toThrow('至少留一个阶段')
  })
  it('同 key 的阶段去重(保留第一条),跑起来撞 id', () => {
    const out = upsertWorkflow(ws(), { id: 'light', name: '轻量', stages: [
      { key: 'review', provider: 'a', model: '1' },
      { key: 'review', provider: 'b', model: '2' },
    ] }, globals, lib)
    expect(out[0].stages.map((s) => s.provider)).toEqual(['a'])
  })
})

describe('removeWorkflow', () => {
  it('删一条', () => {
    expect(removeWorkflow(ws(), 'light').map((w) => w.id)).toEqual(['full'])
  })
  it('★最后一条不让删 —— 空了会被 ensureWorkspaceWorkflows 兜出一条陌生的', () => {
    const one = ws({ workflows: [{ id: 'a', name: 'A', stages: [{ key: 'develop', provider: 'c', model: 'm' }] }] })
    expect(() => removeWorkflow(one, 'a')).toThrow('至少留一条')
  })
  it('不存在的 id 明确报错,不静默无事发生', () => {
    expect(() => removeWorkflow(ws(), 'nope')).toThrow('未知工作流')
  })
})
