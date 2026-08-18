import { describe, it, expect } from 'vitest'
import { buildLaunchInfo, resolveStartPlan, buildLaunchPlan, buildLaunchProjects, createRunTempBranches, launchTaskSeed, hasRequirement, type LaunchStartConfig } from './launch'
import { buildWorkOrders } from './fanout'
import type { Workspace, Workflow } from '../config/schema'
import { STAGE_PROMPTS } from '../config/schema'

const ws: Workspace = {
  name: 'pay', path: '/ws/pay', workflowId: '', stages: [],
  workflows: [{ id: 'wf1', name: '标准五段', stages: [
    { key: 'design', provider: 'claude', model: 'm', scope: 'root', gate: true, prompt: '额外要求:只改前端' },
    { key: 'develop', provider: 'codex', model: 'g' },
  ] }],
  projects: [{ repoId: 'api', name: 'api', branch: 'main', provider: 'codex', model: 'g' }, { repoId: 'web', name: 'web', branch: 'main' }] as any,
  status: 'idle', plugins: [], stepPlugins: [],
} as any

describe('buildLaunchInfo', () => {
  it('lists workflows + projects with cwd', () => {
    const info = buildLaunchInfo(ws)
    expect(info.workflows).toEqual([{ id: 'wf1', name: '标准五段', stages: [
      { key: 'design', name: '技术方案设计', provider: 'claude', model: 'm', gate: true,
        code: false, producesDoc: true, lensCount: 0, desc: '设计技术方案与阶段计划', prompt: STAGE_PROMPTS.design + '\n\n' + '额外要求:只改前端' },
      { key: 'develop', name: '代码开发', provider: 'codex', model: 'g', gate: false,
        code: true, producesDoc: false, lensCount: 0, desc: '按项目并行开发', prompt: STAGE_PROMPTS.develop },
    ] }])
    expect(info.projects.map((p) => p.name)).toEqual(['api', 'web'])
    expect(info.projects[0].cwd).toBe('/ws/pay/api')
    expect(info.projects[0].provider).toBe('codex')
  })

  // P5-UI Task 1: LaunchStage carries code (per-project fan-out?)/desc (short blurb)/prompt (the exact
  // instruction text the stage's agent will receive) — the config-preview overlay needs all three to
  // render a rich flow before a run starts.
  it('stages carry code/desc/prompt — develop fans out per-project, design does not', () => {
    const info = buildLaunchInfo(ws)
    const [design, develop] = info.workflows[0].stages

    expect(design.code).toBe(false)
    expect(design.desc).toBe('设计技术方案与阶段计划')
    // prompt = built-in base + the WsStage's own custom append (mirrors planFromStages composition)
    expect(design.prompt).toBe(STAGE_PROMPTS.design + '\n\n' + '额外要求:只改前端')

    expect(develop.code).toBe(true)
    expect(develop.desc).toBe('按项目并行开发')
    expect(develop.prompt).toBe(STAGE_PROMPTS.develop)
  })

  it('falls back to the global workflow template when a workspace workflow has no stashed stages', () => {
    const wsEmpty: Workspace = {
      ...ws,
      workflows: [{ id: 'std', name: '', stages: [] }],
    } as any
    const globalWorkflows: Workflow[] = [
      { id: 'std', name: '标准工作流', stages: [
        { key: 'design', defaultAgent: 'claude', defaultModel: 'opus' },
        { key: 'develop', defaultAgent: 'codex', defaultModel: 'g', gate: true },
      ], plugins: [], stagePrompts: {} } as any,
    ]
    const info = buildLaunchInfo(wsEmpty, globalWorkflows, [])
    expect(info.workflows[0].stages.map((s) => s.key)).toEqual(['design', 'develop'])
    expect(info.workflows[0].stages[1]).toEqual({ key: 'develop', name: '代码开发', provider: 'codex', model: 'g', gate: true,
      code: true, producesDoc: false, lensCount: 0, desc: '按项目并行开发', prompt: STAGE_PROMPTS.develop })
  })

  // Repro for the real-app bug report: a workspace workflow named "标准工作流" with empty stashed
  // stages whose `id` does NOT match the current global template's id (e.g. a generated/stale id) still
  // resolves via resolveWorkflowStages' by-name fallback — the launcher preview must show the SAME
  // stages the workspace's right-panel "当前工作流" glance would (both ultimately read ws.workflows[],
  // this is the shared resolution). Covered at this level (not just resolveStages.test.ts) so a
  // regression here is caught where the launcher actually consumes it.
  it('falls back to the global template by NAME when the id does not match (stale/generated workspace-workflow id)', () => {
    const wsIdMismatch: Workspace = {
      ...ws,
      workflows: [{ id: 'generated-abc123', name: '标准工作流', stages: [] }],
    } as any
    const globalWorkflows: Workflow[] = [
      { id: 'standard', name: '标准工作流', stages: [
        { key: 'requirement', defaultAgent: 'claude', defaultModel: 'opus-4.8' },
        { key: 'design', defaultAgent: 'claude', defaultModel: 'opus-4.8' },
        { key: 'develop', defaultAgent: 'codex', defaultModel: 'g' },
        { key: 'review', defaultAgent: 'claude', defaultModel: 'opus-4.8' },
      ], plugins: [], stagePrompts: {} } as any,
    ]
    const info = buildLaunchInfo(wsIdMismatch, globalWorkflows, [])
    expect(info.workflows[0].stages.map((s) => s.key)).toEqual(['requirement', 'design', 'develop', 'review'])

    // The START path (resolveStartPlan) must resolve the SAME stages — otherwise the launcher preview
    // and the actual run would disagree.
    const { plan } = resolveStartPlan(wsIdMismatch, globalWorkflows, [], {
      workspacePath: '/ws/pay', workflowId: 'generated-abc123', projectNames: [], runId: 'r1',
    })
    expect(plan.stages.map((s) => s.key)).toEqual(['requirement', 'design', 'develop', 'review'])
  })
})

describe('resolveStartPlan', () => {
  it('resolves the picked workflow stages into a RunPlan + filtered projects', () => {
    const { plan, projects, task } = resolveStartPlan(ws, [], [], { workspacePath: '/ws/pay', workflowId: 'wf1', projectNames: ['api'], task: '做幂等', runId: 'r1' })
    expect(plan.stages.map((s) => s.key)).toEqual(['design', 'develop'])
    expect(plan.stages[0].gate).toBe(true)
    // custom per-stage prompt (WsStage.prompt) must survive resolveStartPlan → planFromStages,
    // appended after the built-in design base prompt.
    expect(plan.stages[0].prompt).toContain('技术方案')
    expect(plan.stages[0].prompt).toContain('额外要求:只改前端')
    expect(projects.map((p) => p.name)).toEqual(['api']) // filtered
    expect(task).toBe('做幂等')
  })
  it('throws on unknown workflow', () => {
    expect(() => resolveStartPlan(ws, [], [], { workspacePath: '/ws/pay', workflowId: 'nope', projectNames: [], runId: 'r1' })).toThrow()
  })
  it('carries permissionMode through untouched (undefined stays undefined, set value passes through)', () => {
    const noMode = resolveStartPlan(ws, [], [], { workspacePath: '/ws/pay', workflowId: 'wf1', projectNames: ['api'], runId: 'r1' })
    expect(noMode.permissionMode).toBeUndefined()
    const withMode = resolveStartPlan(ws, [], [], { workspacePath: '/ws/pay', workflowId: 'wf1', projectNames: ['api'], runId: 'r1', permissionMode: 'readonly' })
    expect(withMode.permissionMode).toBe('readonly')
  })
})

// P1-4: the in-chat launch gate's 确认 button calls buildLaunchPlan/buildLaunchProjects (via a new
// run2:launch-start IPC handler — see run2Handlers.test.ts) instead of the floating WorkflowOverlay.
// `cfg.projects` is ALREADY the caller-selected subset (see LaunchStartConfig doc) — ws has `api`+`web`,
// but only `api` is passed here, so `web` must never appear in the develop stage's fan-out.
describe('buildLaunchPlan + buildLaunchProjects (P1-4 launch gate start)', () => {
  const cfg: LaunchStartConfig = {
    workspacePath: '/ws/pay',
    workflowId: 'wf1',
    projects: [{ name: 'api', provider: 'codex', model: 'g2' }], // 'web' deliberately NOT selected
    supplement: '补充:优先兼容旧接口',
    seed: '用户原话:先做支付幂等',
  }

  it('only selected projects reach the develop-stage fan-out, with their chosen provider/model overriding the stage default', () => {
    const plan = buildLaunchPlan(cfg, ws)
    const projects = buildLaunchProjects(cfg, ws)
    const develop = plan.stages.find((s) => s.key === 'develop')!
    const orders = buildWorkOrders({ stage: develop, workspacePath: ws.path, projects, upstream: [], buildPrompt: () => 'x' })
    expect(orders.map((o) => o.project)).toEqual(['api'])
    expect(orders[0].provider).toBe('codex') // from cfg.projects override
    expect(orders[0].model).toBe('g2')       // overrides stage's default model 'g'
  })

  it('injects supplement + seed into the root (first) stage prompt as ground truth', () => {
    const plan = buildLaunchPlan(cfg, ws)
    const root = plan.stages[0]
    expect(root.key).toBe('design') // first stage in the fixture's workflow
    expect(root.prompt).toContain(cfg.supplement)
    expect(root.prompt).toContain(cfg.seed)
    // the stage's own custom prompt must still survive alongside the injected ground truth
    expect(root.prompt).toContain('额外要求:只改前端')
  })

  it('throws on an unknown workflow id', () => {
    expect(() => buildLaunchPlan({ ...cfg, workflowId: 'nope' }, ws)).toThrow()
  })

  // P1.2: the gate's per-stage / per-project permission choice reaches the plan and the develop lanes.
  it('threads per-stage and per-project permissionMode into the plan and fan-out', () => {
    const plan = buildLaunchPlan({
      ...cfg,
      projects: [{ name: 'api', provider: 'codex', model: 'g2', permissionMode: 'full' }],
      stages: [{ key: 'develop', enabled: true, permissionMode: 'readonly' }],
    }, ws)
    const projects = buildLaunchProjects({
      ...cfg,
      projects: [{ name: 'api', provider: 'codex', model: 'g2', permissionMode: 'full' }],
    }, ws)
    const develop = plan.stages.find((s) => s.key === 'develop')!
    expect(develop.permissionMode).toBe('readonly') // per-stage choice on the plan
    expect(projects[0].permissionMode).toBe('full')  // per-project choice on the DevelopProject
    const orders = buildWorkOrders({ stage: develop, workspacePath: ws.path, projects, upstream: [], buildPrompt: () => 'x' })
    expect(orders[0].permissionMode).toBe('full') // project override wins over the stage's readonly
  })

  // #3: gate stage on/off — an unchecked stage is dropped from the plan (not merely hinted in the supplement).
  it('drops stages the gate unchecked (enabled:false) from the plan', () => {
    const plan = buildLaunchPlan({ ...cfg, stages: [{ key: 'design', enabled: false }, { key: 'develop', enabled: true }] }, ws)
    expect(plan.stages.map((s) => s.key)).toEqual(['develop'])
  })

  it('throws when the gate unchecked every stage', () => {
    expect(() => buildLaunchPlan({ ...cfg, stages: [{ key: 'design', enabled: false }, { key: 'develop', enabled: false }] }, ws)).toThrow('至少')
  })

  // #1: gate per-stage provider/model override wins over the workflow's stage default.
  it('applies the gate per-stage provider/model override', () => {
    const plan = buildLaunchPlan({ ...cfg, stages: [{ key: 'design', enabled: true, provider: 'qoder', model: 'qm' }] }, ws)
    const design = plan.stages.find((s) => s.key === 'design')!
    expect(design.provider).toBe('qoder')
    expect(design.model).toBe('qm')
  })

  // 单代理⇄按项目 toggle: the gate's per-stage perProject choice overrides the stage's default scope
  // (true → per-project fan-out, false → single root agent); omitting it leaves the default untouched.
  it('honors the gate 单代理⇄按项目 toggle over the stage default scope', () => {
    const designScope = (stages: LaunchStartConfig['stages']) =>
      buildLaunchPlan({ ...cfg, stages }, ws).stages.find((s) => s.key === 'design')!.scope
    // forcing perProject:false pins the stage to a single root agent
    expect(designScope([{ key: 'design', enabled: true, perProject: false }, { key: 'develop', enabled: true }])).toBe('root')
    // forcing perProject:true overrides even an explicit root scope → per-project fan-out
    expect(designScope([{ key: 'design', enabled: true, perProject: true }, { key: 'develop', enabled: true }])).toBe('per-project')
    // omitting perProject leaves the stage's own scope (this fixture pins design to 'root') untouched
    expect(designScope([{ key: 'design', enabled: true }, { key: 'develop', enabled: true }])).toBe('root')
  })

  it('drops hooks the gate unchecked, keeps the rest', () => {
    const wsHooked: Workspace = {
      ...ws,
      plugins: [
        { id: 'h1', name: '跑测试', prompt: '', after: 'develop', skills: [], tools: [] },
        { id: 'h2', name: '收尾', prompt: '', after: '__start', skills: [], tools: [] },
      ],
    } as any
    const plan = buildLaunchPlan({ ...cfg, hooks: [{ id: 'h1', enabled: false }, { id: 'h2', enabled: true }] }, wsHooked)
    expect((plan.hooks ?? []).map((h) => h.id)).toEqual(['h2'])
  })

  // Regression: the picker (buildLaunchInfo) resolves a workflow with empty stashed stages via the
  // global template fallback, so it previews resolved stages — buildLaunchPlan must resolve the SAME
  // fallback (given the deps) instead of throwing "没有可执行阶段" on confirm.
  it('resolves the global-template fallback (not a throw) when the workspace workflow has empty stashed stages', () => {
    const wsEmpty: Workspace = {
      ...ws,
      workflows: [{ id: 'wf1', name: '标准五段', stages: [] }],
    } as any
    const globalWorkflows: Workflow[] = [
      { id: 'wf1', name: '标准五段', stages: [
        { key: 'design', defaultAgent: 'claude', defaultModel: 'opus' },
        { key: 'develop', defaultAgent: 'codex', defaultModel: 'g', gate: true },
      ], plugins: [], stagePrompts: {} } as any,
    ]
    const plan = buildLaunchPlan(cfg, wsEmpty, globalWorkflows, [])
    expect(plan.stages.map((s) => s.key)).toEqual(['design', 'develop'])
    expect(plan.stages[0].provider).toBe('claude')
    expect(plan.stages[1].provider).toBe('codex')
  })
})

// 代码CR(review) 的诚实标签 + 「按项目真能用」证据:review 默认 4 视角多镜头(不是单代理);门里切「按项目」后
// buildWorkOrders 真的按项目扇出成每项目一个 reviewer(和 develop 同一套机制)。
describe('review 扇出:多镜头(off) ⇄ 按项目(on)', () => {
  const wsReview: Workspace = {
    name: 'r', path: '/ws/r', workflowId: '', stages: [],
    // review 无显式 review 配置 → resolveWorkflowStages 的 withReviewDefaults 补上默认 4 视角
    workflows: [{ id: 'wf', name: 'wf', stages: [{ key: 'review', provider: 'claude', model: 'm' }] }],
    projects: [{ repoId: 'a', name: 'a', branch: 'main' }, { repoId: 'b', name: 'b', branch: 'main' }] as any,
    status: 'idle', plugins: [], stepPlugins: [],
  } as any
  const cfgFor = (perProject: boolean): LaunchStartConfig => ({
    workspacePath: '/ws/r', workflowId: 'wf',
    projects: [{ name: 'a', provider: 'claude', model: 'm' }, { name: 'b', provider: 'claude', model: 'm' }],
    supplement: '', seed: '', stages: [{ key: 'review', enabled: true, perProject }],
  })
  const reviewOrders = (perProject: boolean) => {
    const cfg = cfgFor(perProject)
    const stage = buildLaunchPlan(cfg, wsReview).stages.find((s) => s.key === 'review')!
    return buildWorkOrders({ stage, workspacePath: '/ws/r', projects: buildLaunchProjects(cfg, wsReview), upstream: [], buildPrompt: () => 'x' })
  }

  it('buildLaunchInfo 给 review 标 lensCount=4(供门显示「多镜头」而非「单代理」)', () => {
    const review = buildLaunchInfo(wsReview, [], []).workflows[0].stages.find((s) => s.key === 'review')!
    expect(review.lensCount).toBe(4)
  })

  it('off(单代理开关关)= 多镜头:在工作区根扇成 4 个每视角 reviewer,不是单代理', () => {
    const orders = reviewOrders(false)
    expect(orders.length).toBe(4)
    expect(orders.every((o) => o.cwd === '/ws/r')).toBe(true)   // 都在工作区根,审聚合变更
  })

  it('on(按项目)= 每个项目一个 reviewer(真能用,和 develop 同一套按项目扇出)', () => {
    const orders = reviewOrders(true)
    expect(orders.map((o) => o.project).sort()).toEqual(['a', 'b'])
  })
})

// 阶段级项目代理:按项目 CR 用与代码开发不同的 provider。工作区里配过的是默认值,启动门当次改的赢过它。
describe('阶段级项目代理(按项目 CR 换 provider)', () => {
  const wsPersisted: Workspace = {
    name: 'r', path: '/ws/r', workflowId: '', stages: [],
    workflows: [{ id: 'wf', name: 'wf', stages: [
      { key: 'develop', provider: 'claude', model: 'opus' },
      // 工作区里配好的:CR 按项目跑,a 项目用 codex 审
      { key: 'review', provider: 'claude', model: 'opus', scope: 'per-project',
        projectAgents: [{ name: 'a', provider: 'codex', model: 'gpt-5-codex' }] },
    ] }],
    projects: [{ repoId: 'a', name: 'a', branch: 'main', provider: 'claude', model: 'opus' },
               { repoId: 'b', name: 'b', branch: 'main', provider: 'claude', model: 'opus' }] as any,
    status: 'idle', plugins: [], stepPlugins: [],
  } as any
  const baseCfg = (stages: LaunchStartConfig['stages']): LaunchStartConfig => ({
    workspacePath: '/ws/r', workflowId: 'wf',
    projects: [{ name: 'a', provider: 'claude', model: 'opus' }, { name: 'b', provider: 'claude', model: 'opus' }],
    supplement: '', seed: '', stages,
  })
  const ordersFor = (cfg: LaunchStartConfig, key: string) => {
    const stage = buildLaunchPlan(cfg, wsPersisted).stages.find((s) => s.key === key)!
    return buildWorkOrders({ stage, workspacePath: '/ws/r', projects: buildLaunchProjects(cfg, wsPersisted), upstream: [], buildPrompt: () => 'x' })
  }

  it('工作区里配好的阶段级项目代理会带进 plan(启动门没改时就用它)', () => {
    const orders = ordersFor(baseCfg([{ key: 'review', enabled: true, perProject: true }]), 'review')
    expect(orders.map((o) => [o.project, o.provider])).toEqual([['a', 'codex'], ['b', 'claude']])
  })

  it('同一次启动里代码开发不受影响,仍走项目自己的编码代理', () => {
    const orders = ordersFor(baseCfg([{ key: 'review', enabled: true, perProject: true }]), 'develop')
    expect(orders.map((o) => o.provider)).toEqual(['claude', 'claude'])
  })

  it('启动门当次改的覆盖赢过工作区里配好的', () => {
    const cfg = baseCfg([{ key: 'review', enabled: true, perProject: true,
      projects: [{ name: 'a', provider: 'gemini', model: 'gemini-2.5-pro' }] }])
    const orders = ordersFor(cfg, 'review')
    expect(orders.map((o) => [o.project, o.provider])).toEqual([['a', 'gemini'], ['b', 'claude']])
  })

  it('buildLaunchInfo 把工作区里配好的带给启动门做初值', () => {
    const review = buildLaunchInfo(wsPersisted, [], []).workflows[0].stages.find((s) => s.key === 'review')!
    expect(review.projectAgents).toEqual([{ name: 'a', provider: 'codex', model: 'gpt-5-codex' }])
  })

  it('两处都没配的阶段不产生 projectAgents(老工作区零变化)', () => {
    const plan = buildLaunchPlan(baseCfg([{ key: 'develop', enabled: true }]), wsPersisted)
    expect(plan.stages.find((s) => s.key === 'develop')!.projectAgents).toBeUndefined()
  })
})


// 用户反馈(2026-08-12):什么也没聊、什么也没输入就点了启动工作流,agent 手上只有一串项目名,于是自己
// 猜一个需求出来、执行了一堆东西。什么都没有时就该什么都不执行。
describe('hasRequirement:没有需求就不该启动', () => {
  it('需求和补充说明都空 → 没有需求', () => {
    expect(hasRequirement({ seed: '', supplement: '' })).toBe(false)
    expect(hasRequirement({ seed: '   \n ', supplement: '\t' })).toBe(false)
  })
  it('只有需求 → 可以启动', () => {
    expect(hasRequirement({ seed: '把 token 迁到 OKLCH', supplement: '' })).toBe(true)
  })
  it('没聊过但在门里手打了补充说明 → 也可以启动(这条路要留着)', () => {
    expect(hasRequirement({ seed: '', supplement: '只改前端配色' })).toBe(true)
  })
  it('字段缺失(老调用方)按空处理,不炸', () => {
    expect(hasRequirement({} as { seed: string; supplement: string })).toBe(false)
  })
})

// P4-2: at run start, each participating project's worktree must be checked out onto the run's shared
// temp branch off ITS OWN currently-checked-out branch (readCurrentBranch — see the "基准分支" describe
// below for the bug this fixes) — no real git here, createBranch/readCurrentBranch are injected fakes
// per the task's "do not touch real git in tests" rule.
describe('createRunTempBranches (P4-2)', () => {
  // A project's working tree may be dirty when a run starts — createTempBranch's own pre-run snapshot
  // handles that now (see tempBranch.test.ts), so this fake just reports success as an object matching
  // the real createTempBranch's TempBranchCreated return shape.
  const fakeBranch = (runId: string) => ({ branch: `forge/run-${runId}`, snapshotSha: null })
  const readMain = async () => 'main'

  it('creates a branch for each project off its own currently-checked-out branch (cwd/base/runId all correct)', async () => {
    const calls: Array<{ cwd: string; base: string; runId: string }> = []
    const fakeCreate = async (cwd: string, base: string, runId: string) => {
      calls.push({ cwd, base, runId })
      return fakeBranch(runId)
    }
    await createRunTempBranches(
      ws,
      [{ name: 'api', cwd: '/ws/pay/api' }, { name: 'web', cwd: '/ws/pay/web' }],
      'r1',
      fakeCreate,
      undefined,
      readMain,
    )
    // both projects report 'main' as their currently-checked-out branch — distinct cwd per project,
    // same runId/branch-name across all of them.
    expect(calls).toEqual([
      { cwd: '/ws/pay/api', base: 'main', runId: 'r1' },
      { cwd: '/ws/pay/web', base: 'main', runId: 'r1' },
    ])
  })

  it('uses each project\'s OWN currently-checked-out branch as base, not a shared default', async () => {
    const calls: Array<{ cwd: string; base: string }> = []
    const fakeCreate = async (cwd: string, base: string) => { calls.push({ cwd, base }); return fakeBranch('r1') }
    const readCurrent = async (cwd: string) => (cwd.endsWith('api') ? 'feat/api-x' : 'develop')
    await createRunTempBranches(ws, [{ name: 'api', cwd: '/ws/pay/api' }, { name: 'web', cwd: '/ws/pay/web' }], 'r1', fakeCreate, undefined, readCurrent)
    expect(calls).toEqual([{ cwd: '/ws/pay/api', base: 'feat/api-x' }, { cwd: '/ws/pay/web', base: 'develop' }])
  })

  it('on a later project\'s checkout failure, rolls back every branch already created (with its own snapshot SHA) and throws naming the failing project', async () => {
    const createCalls: string[] = []
    const rollbackCalls: Array<{ cwd: string; target: string; sha: string | null }> = []
    const fakeCreate = async (cwd: string) => {
      createCalls.push(cwd)
      if (cwd === '/ws/pay/web') throw new Error('本地更改未提交')
      return { branch: 'forge/run-r1', snapshotSha: 'sha-api' }
    }
    const fakeRollback = async (cwd: string, target: string, _runId: string, sha: string | null) => { rollbackCalls.push({ cwd, target, sha }) }
    await expect(createRunTempBranches(
      ws,
      [{ name: 'api', cwd: '/ws/pay/api' }, { name: 'web', cwd: '/ws/pay/web' }],
      'r1',
      fakeCreate,
      fakeRollback,
      readMain,
    )).rejects.toThrow(/web/)
    expect(createCalls).toEqual(['/ws/pay/api', '/ws/pay/web'])
    // api's branch was already created when web failed → rolled back to ITS OWN target ('main'),
    // carrying api's own snapshot SHA (not null, not web's) so its uncommitted work isn't destroyed.
    expect(rollbackCalls).toEqual([{ cwd: '/ws/pay/api', target: 'main', sha: 'sha-api' }])
  })

  it('surfaces (not swallows) a rollback failure alongside the original error', async () => {
    const fakeCreate = async (cwd: string) => {
      if (cwd === '/ws/pay/web') throw new Error('checkout failed')
      return fakeBranch('r1')
    }
    const fakeRollback = async () => { throw new Error('rollback also failed') }
    await expect(createRunTempBranches(
      ws,
      [{ name: 'api', cwd: '/ws/pay/api' }, { name: 'web', cwd: '/ws/pay/web' }],
      'r1',
      fakeCreate,
      fakeRollback,
      readMain,
    )).rejects.toThrow(/rollback also failed/)
  })

  it('never calls createBranch for later projects once an earlier one fails (no partial fan-out beyond the failure point)', async () => {
    const calls: string[] = []
    const fakeCreate = async (cwd: string) => {
      calls.push(cwd)
      throw new Error('boom')
    }
    await expect(createRunTempBranches(
      ws,
      [{ name: 'api', cwd: '/ws/pay/api' }, { name: 'web', cwd: '/ws/pay/web' }],
      'r1',
      fakeCreate,
      undefined,
      readMain,
    )).rejects.toThrow()
    expect(calls).toEqual(['/ws/pay/api'])
  })
})

describe('createRunTempBranches 基准分支', () => {
  const ws = { path: '/ws', projects: [{ name: 'web', branch: 'main' }] } as unknown as Workspace
  const projects = [{ name: 'web', cwd: '/ws/web' }]

  it('用实测 HEAD 当基准，而不是工作区存盘的 branch 字段', async () => {
    const bases: string[] = []
    const createBranch = async (_cwd: string, base: string) => { bases.push(base); return { branch: 'forge/run-r1', snapshotSha: null } }
    const rollback = async () => {}
    const readCurrent = async () => 'branch1'   // 存盘是 main，实际在 branch1

    const got = await createRunTempBranches(ws, projects, 'r1', createBranch, rollback, readCurrent)

    expect(bases).toEqual(['branch1'])
    expect(got.targets).toEqual({ web: 'branch1' })
  })

  it('返回每个项目的快照 SHA；干净树的项目不出现在 snapshots 里', async () => {
    const ws2 = { path: '/ws', projects: [{ name: 'web', branch: 'main' }, { name: 'api', branch: 'main' }] } as unknown as Workspace
    const projs = [{ name: 'web', cwd: '/ws/web' }, { name: 'api', cwd: '/ws/api' }]
    const createBranch = async (cwd: string) => ({ branch: 'forge/run-r1', snapshotSha: cwd.endsWith('web') ? 'sha-web' : null })
    const got = await createRunTempBranches(ws2, projs, 'r1', createBranch, async () => {}, async () => 'branch1')

    expect(got.snapshots).toEqual({ web: 'sha-web' })
  })

  it('detached HEAD → 抛可读错误，且一个分支都不建', async () => {
    let created = 0
    const createBranch = async () => { created++; return { branch: 'x', snapshotSha: null } }
    await expect(
      createRunTempBranches(ws, projects, 'r1', createBranch, async () => {}, async () => '')
    ).rejects.toThrow(/项目「web」当前处于 detached HEAD/)
    expect(created).toBe(0)
  })

  // Task 8 审查修正：readCurrentBranch 读取失败(目录不存在/不是仓库/……)是与 detached HEAD 完全不同的
  // 情况 —— 前者该指示用户检查目录，后者该指示 git switch。以前 currentBranch 把两者都归一成 ''，这里
  // 就只能把两者说成同一句话；现在 readCurrentBranch 对"读取失败"改为抛出，这里必须原样接住并换一句
  // 措辞，钉死不能把"目录不存在"说成"detached HEAD"。
  it('读取分支失败（目录不存在等）→ 报"读取失败"，绝不说成 detached HEAD，且一个分支都不建', async () => {
    let created = 0
    const createBranch = async () => { created++; return { branch: 'x', snapshotSha: null } }
    const readCurrent = async () => { throw new Error('ENOENT: no such file or directory') }
    await expect(
      createRunTempBranches(ws, projects, 'r1', createBranch, async () => {}, readCurrent)
    ).rejects.toThrow(/项目「web」读取当前分支失败/)
    let message = ''
    try {
      await createRunTempBranches(ws, projects, 'r1', createBranch, async () => {}, readCurrent)
    } catch (err) { message = err instanceof Error ? err.message : String(err) }
    expect(message).not.toMatch(/detached HEAD/)
    expect(message).toMatch(/ENOENT/)
    expect(created).toBe(0)
  })

  it('某项目建分支失败 → 回滚已建的，回滚时带上它自己的快照 SHA', async () => {
    const ws2 = { path: '/ws', projects: [{ name: 'web', branch: 'main' }, { name: 'api', branch: 'main' }] } as unknown as Workspace
    const projs = [{ name: 'web', cwd: '/ws/web' }, { name: 'api', cwd: '/ws/api' }]
    const rolledBack: Array<[string, string, string | null]> = []
    const createBranch = async (cwd: string) => {
      if (cwd.endsWith('api')) throw new Error('fatal: boom')
      return { branch: 'forge/run-r1', snapshotSha: 'sha-web' }
    }
    const rollback = async (cwd: string, target: string, _runId: string, sha: string | null) => { rolledBack.push([cwd, target, sha]) }

    await expect(
      createRunTempBranches(ws2, projs, 'r1', createBranch, rollback, async () => 'branch1')
    ).rejects.toThrow(/项目「api」创建运行分支失败/)
    expect(rolledBack).toEqual([['/ws/web', 'branch1', 'sha-web']])
  })
})

describe('launchTaskSeed — carries the requirement to every stage via deps.task', () => {
  it('combines the requirement seed and the supplement (both preserved for downstream stages)', () => {
    expect(launchTaskSeed({ seed: '做一个登录页', supplement: '要支持手机号' }))
      .toBe('做一个登录页\n\n【补充说明】\n要支持手机号')
  })
  it('seed only / supplement only / neither', () => {
    expect(launchTaskSeed({ seed: '只有需求', supplement: '' })).toBe('只有需求')
    expect(launchTaskSeed({ seed: '', supplement: '只有补充' })).toBe('【补充说明】\n只有补充')
    expect(launchTaskSeed({ seed: '  ', supplement: '  ' })).toBe('')  // caller passes `|| undefined`
  })
})
