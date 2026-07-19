import { describe, it, expect } from 'vitest'
import { buildLaunchInfo, resolveStartPlan, buildLaunchPlan, buildLaunchProjects, createRunTempBranches, type LaunchStartConfig } from './launch'
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
        code: false, desc: '设计技术方案与阶段计划', prompt: STAGE_PROMPTS.design + '\n\n' + '额外要求:只改前端' },
      { key: 'develop', name: '代码开发', provider: 'codex', model: 'g', gate: false,
        code: true, desc: '按项目并行开发', prompt: STAGE_PROMPTS.develop },
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
      code: true, desc: '按项目并行开发', prompt: STAGE_PROMPTS.develop })
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

// P4-2: at run start, each participating project's worktree must be checked out onto the run's shared
// temp branch off ITS OWN configured target branch (ws.projects[].branch) — no real git here, createBranch
// is injected as a fake recorder/failure-simulator per the task's "do not touch real git in tests" rule.
describe('createRunTempBranches (P4-2)', () => {
  // Every test in this describe block cares about the create/rollback contract, not the Finding 3
  // clean-tree precondition — pass an always-clean fake so the (real, by default) isCleanTree check
  // never runs against these fictitious `/ws/pay/*` paths. The precondition itself is covered by its
  // own describe block below (fake-runner) and by tempBranch.integration.test.ts (real git).
  const alwaysClean = async () => true

  it('creates a branch for each project off its own target branch (cwd/base/runId all correct)', async () => {
    const calls: Array<{ cwd: string; base: string; runId: string }> = []
    const fakeCreate = async (cwd: string, base: string, runId: string) => {
      calls.push({ cwd, base, runId })
      return `forge/run-${runId}`
    }
    await createRunTempBranches(
      ws,
      [{ name: 'api', cwd: '/ws/pay/api' }, { name: 'web', cwd: '/ws/pay/web' }],
      'r1',
      fakeCreate,
      undefined,
      alwaysClean,
    )
    // fixture ws (top of file): api's own branch = 'main', web's own branch = 'main' too — distinct cwd
    // per project, same runId/branch-name across all of them.
    expect(calls).toEqual([
      { cwd: '/ws/pay/api', base: 'main', runId: 'r1' },
      { cwd: '/ws/pay/web', base: 'main', runId: 'r1' },
    ])
  })

  it('uses each project\'s OWN target branch as base, not a shared default', async () => {
    const wsMixedBranches = { ...ws, projects: [{ repoId: 'api', name: 'api', branch: 'feat/api-x' }, { repoId: 'web', name: 'web', branch: 'develop' }] as any } as any
    const calls: Array<{ cwd: string; base: string }> = []
    const fakeCreate = async (cwd: string, base: string) => { calls.push({ cwd, base }); return 'forge/run-r1' }
    await createRunTempBranches(wsMixedBranches, [{ name: 'api', cwd: '/ws/pay/api' }, { name: 'web', cwd: '/ws/pay/web' }], 'r1', fakeCreate, undefined, alwaysClean)
    expect(calls).toEqual([{ cwd: '/ws/pay/api', base: 'feat/api-x' }, { cwd: '/ws/pay/web', base: 'develop' }])
  })

  it('throws a readable error naming the project when its own project entry has no branch configured', async () => {
    const wsNoBranch = { ...ws, projects: [{ repoId: 'api', name: 'api', branch: '' }] as any } as any
    await expect(createRunTempBranches(wsNoBranch, [{ name: 'api', cwd: '/ws/pay/api' }], 'r1', async () => 'x', undefined, alwaysClean))
      .rejects.toThrow(/api/)
  })

  it('on a later project\'s checkout failure, rolls back every branch already created and throws naming the failing project', async () => {
    const createCalls: string[] = []
    const rollbackCalls: Array<{ cwd: string; target: string }> = []
    const fakeCreate = async (cwd: string) => {
      createCalls.push(cwd)
      if (cwd === '/ws/pay/web') throw new Error('本地更改未提交')
      return 'forge/run-r1'
    }
    const fakeRollback = async (cwd: string, target: string) => { rollbackCalls.push({ cwd, target }) }
    await expect(createRunTempBranches(
      ws,
      [{ name: 'api', cwd: '/ws/pay/api' }, { name: 'web', cwd: '/ws/pay/web' }],
      'r1',
      fakeCreate,
      fakeRollback,
      alwaysClean,
    )).rejects.toThrow(/web/)
    expect(createCalls).toEqual(['/ws/pay/api', '/ws/pay/web'])
    // api's branch was already created when web failed → rolled back to ITS OWN target ('main')
    expect(rollbackCalls).toEqual([{ cwd: '/ws/pay/api', target: 'main' }])
  })

  it('surfaces (not swallows) a rollback failure alongside the original error', async () => {
    const fakeCreate = async (cwd: string) => {
      if (cwd === '/ws/pay/web') throw new Error('checkout failed')
      return 'forge/run-r1'
    }
    const fakeRollback = async () => { throw new Error('rollback also failed') }
    await expect(createRunTempBranches(
      ws,
      [{ name: 'api', cwd: '/ws/pay/api' }, { name: 'web', cwd: '/ws/pay/web' }],
      'r1',
      fakeCreate,
      fakeRollback,
      alwaysClean,
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
      alwaysClean,
    )).rejects.toThrow()
    expect(calls).toEqual(['/ws/pay/api'])
  })

  describe('clean-tree precondition (Finding 3 — reject dirty-tree run start)', () => {
    it('checks EVERY project BEFORE creating any branch, and creates none when one is dirty', async () => {
      const cleanChecks: string[] = []
      const createCalls: string[] = []
      const fakeCheckClean = async (cwd: string) => { cleanChecks.push(cwd); return cwd !== '/ws/pay/web' }
      const fakeCreate = async (cwd: string) => { createCalls.push(cwd); return 'forge/run-r1' }
      await expect(createRunTempBranches(
        ws,
        [{ name: 'api', cwd: '/ws/pay/api' }, { name: 'web', cwd: '/ws/pay/web' }],
        'r1',
        fakeCreate,
        undefined,
        fakeCheckClean,
      )).rejects.toThrow(/web/)
      expect(cleanChecks).toEqual(['/ws/pay/api', '/ws/pay/web']) // every project checked...
      expect(createCalls).toEqual([]) // ...and NO branch created anywhere, not even for the clean one
    })

    it('names ALL dirty projects in the error when more than one is dirty', async () => {
      const fakeCheckClean = async () => false
      await expect(createRunTempBranches(
        ws,
        [{ name: 'api', cwd: '/ws/pay/api' }, { name: 'web', cwd: '/ws/pay/web' }],
        'r1',
        async () => 'forge/run-r1',
        undefined,
        fakeCheckClean,
      )).rejects.toThrow(/api.*web|web.*api/s)
    })

    it('proceeds to create branches when every project is clean', async () => {
      const createCalls: string[] = []
      const fakeCreate = async (cwd: string) => { createCalls.push(cwd); return 'forge/run-r1' }
      await createRunTempBranches(
        ws,
        [{ name: 'api', cwd: '/ws/pay/api' }, { name: 'web', cwd: '/ws/pay/web' }],
        'r1',
        fakeCreate,
        undefined,
        async () => true,
      )
      expect(createCalls).toEqual(['/ws/pay/api', '/ws/pay/web'])
    })

    it('defaults to the real tempBranch.ts isCleanTree when no checkClean is injected', async () => {
      // No checkClean passed — createRunTempBranches must fall back to the real isCleanTree, which
      // runs real `git status --porcelain` and throws (not silently pass) against a nonexistent
      // directory, proving the default isn't a silent no-op.
      await expect(createRunTempBranches(
        ws,
        [{ name: 'api', cwd: '/definitely/not/a/real/git/repo/path-xyz' }],
        'r1',
        async () => 'forge/run-r1',
      )).rejects.toThrow()
    })
  })
})
