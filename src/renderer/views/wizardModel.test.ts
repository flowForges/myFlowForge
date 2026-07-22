import { describe, it, expect } from 'vitest'
import { deriveWsName, buildCreateOpts, packModel, unpackModel, buildEditState, emptyWorkflow, type WizardState, type WizardStage } from './wizardModel'
import type { Workspace } from '@shared/types'

describe('wizard model', () => {
  it('derives workspace name from the path last segment unless edited', () => {
    expect(deriveWsName('~/code/design-system-v3', false, '')).toBe('design-system-v3')
    expect(deriveWsName('~/code/design-system-v3', true, 'My Name')).toBe('My Name')
  })

  it('buildCreateOpts 产出多条 workflows,各带有序 enabled 阶段', () => {
    const state: WizardState = {
      path: '~/code/ws-a', name: '', nameEdited: false, purpose: '把三层记忆做成可开关的功能',
      workflows: [
        emptyWorkflow('light', 'Light', {
          requirement: { on: true, provider: 'claude', model: 'opus-4.8' },
          design: { on: true, provider: 'claude', model: 'opus-4.8' },
          develop: { on: false, provider: 'claude', model: 'opus-4.8' },
        }, ['requirement', 'design', 'develop']),
        emptyWorkflow('full', 'Full', {
          requirement: { on: true, provider: 'claude', model: 'opus-4.8' },
          design: { on: true, provider: 'claude', model: 'opus-4.8' },
          develop: { on: true, provider: 'claude', model: 'opus-4.8' },
        }, ['requirement', 'design', 'develop']),
      ],
      activeWorkflowId: 'light',
      projects: [
        { repoId: 'proj1', name: 'proj1', sel: true, branch: 'forge/ws-a', model: 'sonnet-4.6' },
        { repoId: 'proj2', name: 'proj2', sel: false, branch: 'forge/ws-a', model: 'sonnet-4.6' }
      ],
      plugins: [],
      stepPlugins: []
    }
    const opts = buildCreateOpts(state)
    expect(opts.name).toBe('ws-a')                                          // derived from path
    expect(opts.workflows.map(w => w.id)).toEqual(['light', 'full'])
    expect(opts.workflows[0].stages.map(s => s.key)).toEqual(['requirement', 'design'])           // only enabled, order preserved
    expect(opts.workflows[1].stages.map(s => s.key)).toEqual(['requirement', 'design', 'develop'])
    expect(opts.projects.map(p => p.repoId)).toEqual(['proj1'])             // only selected
    expect(opts.purpose).toBe('把三层记忆做成可开关的功能')                    // 建区目的 passthrough (trimmed non-empty)
  })

  it('carries inPlace through buildCreateOpts for an auto-detected repo row (Task 5)', () => {
    const state: WizardState = {
      path: '~/code/ws-a', name: '', nameEdited: false, purpose: '',
      workflows: [emptyWorkflow('light', 'Light', {
        develop: { on: true, provider: 'claude', model: 'opus-4.8' },
      }, ['develop'])],
      activeWorkflowId: 'light',
      projects: [
        { repoId: 'api', name: 'api', sel: true, branch: 'main', model: 'claude::opus-4.8', inPlace: true },
        { repoId: 'proj1', name: 'proj1', sel: true, branch: 'forge/ws-a', model: 'sonnet-4.6' },
      ],
      plugins: [], stepPlugins: []
    }
    const opts = buildCreateOpts(state)
    const inPlaceProj = opts.projects.find(p => p.repoId === 'api')!
    expect(inPlaceProj.inPlace).toBe(true)
    const regularProj = opts.projects.find(p => p.repoId === 'proj1')!
    expect(regularProj.inPlace).toBeUndefined()
  })
})

describe('packModel/unpackModel', () => {
  it('round-trips provider + model', () => {
    expect(packModel('claude', 'opus-4.8')).toBe('claude::opus-4.8')
    expect(unpackModel('claude::opus-4.8')).toEqual({ provider: 'claude', model: 'opus-4.8' })
  })
  it('unpacks a bare model (no provider) as empty provider', () => {
    expect(unpackModel('opus-4.8')).toEqual({ provider: '', model: 'opus-4.8' })
  })
})

const baseStages = (): Record<string, WizardStage> => ({
  requirement: { on: false, provider: 'claude', model: 'opus-4.8' },
  design: { on: false, provider: 'claude', model: 'opus-4.8' },
  develop: { on: false, provider: 'claude', model: 'opus-4.8' },
  test: { on: false, provider: 'claude', model: 'opus-4.8' },
  review: { on: false, provider: 'claude', model: 'opus-4.8' },
})
const knownProjects = [
  { id: 'p1', name: 'app', repoUrl: 'git@x:app.git', defaultBranch: 'main' },
  { id: 'p2', name: 'lib', repoUrl: 'git@x:lib.git', defaultBranch: 'main' },
]
const ws: Workspace = {
  name: '设计迁移', path: '/abs/ws-a',
  workflowId: 'standard', stages: [],   // legacy migration seed — buildEditState no longer reads these
  workflows: [
    {
      id: 'wf1', name: '标准', stages: [
        { key: 'design', provider: 'claude', model: 'opus-4.8' },
        { key: 'develop', provider: 'codex', model: 'gpt-5-codex' },
      ]
    },
    {
      id: 'wf2', name: '轻量', stages: [
        { key: 'design', provider: 'claude', model: 'opus-4.8' },
      ]
    },
  ],
  projects: [{ repoId: 'p1', name: 'app', branch: 'feat/x', provider: 'codex', model: 'gpt-5-codex' }],
  status: 'ok',
  plugins: [],
  stepPlugins: [],
}

describe('buildEditState', () => {
  it('buildEditState 从 ws.workflows round-trip 回来', () => {
    const st = buildEditState(ws, knownProjects, baseStages(), 'claude::opus-4.8')
    expect(st.workflows).toHaveLength(2)
    expect(st.workflows.map(w => w.id)).toEqual(['wf1', 'wf2'])
    expect(st.activeWorkflowId).toBe(st.workflows[0].id)
  })

  it('lights up persisted stages per workflow with their provider/model, others off', () => {
    const st = buildEditState(ws, knownProjects, baseStages(), 'claude::opus-4.8')
    const wf1 = st.workflows.find(w => w.id === 'wf1')!
    expect(wf1.stages.design).toEqual({ on: true, provider: 'claude', model: 'opus-4.8' })
    expect(wf1.stages.develop).toEqual({ on: true, provider: 'codex', model: 'gpt-5-codex' })
    expect(wf1.stages.requirement.on).toBe(false)
    const wf2 = st.workflows.find(w => w.id === 'wf2')!
    expect(wf2.stages.design.on).toBe(true)
    expect(wf2.stages.develop.on).toBe(false)
    expect(st.name).toBe('设计迁移')
    expect(st.path).toBe('/abs/ws-a')
    expect(st.nameEdited).toBe(true)
  })

  it('stageOrder = that workflow\'s own stage order ∪ all base stage keys', () => {
    const st = buildEditState(ws, knownProjects, baseStages(), 'claude::opus-4.8')
    const wf1 = st.workflows.find(w => w.id === 'wf1')!
    expect(wf1.stageOrder).toEqual(['design', 'develop', 'requirement', 'test', 'review'])
    const wf2 = st.workflows.find(w => w.id === 'wf2')!
    expect(wf2.stageOrder).toEqual(['design', 'requirement', 'develop', 'test', 'review'])
  })

  it('marks included projects sel+existing (branch/model backfilled), others selectable', () => {
    const st = buildEditState(ws, knownProjects, baseStages(), 'claude::opus-4.8')
    const p1 = st.projects.find(p => p.repoId === 'p1')!
    expect(p1).toMatchObject({ sel: true, existing: true, branch: 'feat/x', model: 'codex::gpt-5-codex' })
    expect(p1.locked).toBeFalsy()   // no longer locked — can be unchecked to remove
    const p2 = st.projects.find(p => p.repoId === 'p2')!
    expect(p2).toMatchObject({ sel: false, branch: '', model: 'claude::opus-4.8' })
    expect(p2.existing).toBeFalsy()
  })

  it('appends ws-only projects (no longer in known list) as existing', () => {
    const wsX: Workspace = { ...ws, projects: [...ws.projects, { repoId: 'gone', name: 'gone', branch: 'main', provider: 'claude', model: 'opus-4.8' }] }
    const st = buildEditState(wsX, knownProjects, baseStages(), 'claude::opus-4.8')
    const g = st.projects.find(p => p.repoId === 'gone')!
    expect(g).toMatchObject({ sel: true, existing: true, name: 'gone' })
  })

  it('round-trips through buildCreateOpts back to the persisted per-workflow config', () => {
    const st = buildEditState(ws, knownProjects, baseStages(), 'claude::opus-4.8')
    // mirror the component's doCreate: unpack each selected project's packed model before building opts
    const committed = { ...st, projects: st.projects.map(p => { const { provider, model } = unpackModel(p.model); return { ...p, provider, model } }) }
    const opts = buildCreateOpts(committed)
    expect(opts.name).toBe('设计迁移')
    expect(opts.workflows.map(w => w.id)).toEqual(['wf1', 'wf2'])
    expect(opts.workflows.find(w => w.id === 'wf1')?.stages).toEqual([
      { key: 'design', provider: 'claude', model: 'opus-4.8' },
      { key: 'develop', provider: 'codex', model: 'gpt-5-codex' },
    ])
    expect(opts.workflows.find(w => w.id === 'wf2')?.stages).toEqual([
      { key: 'design', provider: 'claude', model: 'opus-4.8' },
    ])
    expect(opts.projects).toEqual([
      { repoId: 'p1', branch: 'feat/x', provider: 'codex', model: 'gpt-5-codex' },
    ])
  })

  it('buildCreateOpts 写入非空追加段、忽略空段', () => {
    const state: WizardState = {
      path: '/w', name: 'w', nameEdited: true, purpose: '',
      workflows: [emptyWorkflow('__custom', '__custom', {
        design: { on: true, provider: 'claude', model: 'opus-4.8', prompt: '画时序图' },
        develop: { on: true, provider: 'claude', model: 'opus-4.8', prompt: '  ' },
      }, ['design', 'develop'])],
      activeWorkflowId: '__custom',
      projects: [], plugins: [], stepPlugins: []
    }
    const opts = buildCreateOpts(state)
    const stages = opts.workflows[0].stages
    expect(stages.find(s => s.key === 'design')?.prompt).toBe('画时序图')
    expect(stages.find(s => s.key === 'develop')?.prompt).toBeUndefined()
  })

  it('carries a custom (#3) stage + its behavior flags through buildCreateOpts, in template order', () => {
    const state: WizardState = {
      path: '/w', name: 'w', nameEdited: true, purpose: '',
      workflows: [emptyWorkflow('standard', 'standard', {
        design: { on: true, provider: 'claude', model: 'opus-4.8' },
        'security-audit': { on: true, custom: true, name: '安全审计', provider: 'claude', model: 'm', prompt: '核对 OWASP', scope: 'per-project', gate: true, summary: true },
        develop: { on: true, provider: 'claude', model: 'opus-4.8' },
      }, ['design', 'security-audit', 'develop'])],   // template order places the custom stage between design and develop
      activeWorkflowId: 'standard',
      projects: [], plugins: [], stepPlugins: []
    }
    const opts = buildCreateOpts(state)
    const stages = opts.workflows[0].stages
    expect(stages.map(s => s.key)).toEqual(['design', 'security-audit', 'develop'])
    const audit = stages.find(s => s.key === 'security-audit')!
    expect(audit).toMatchObject({ name: '安全审计', prompt: '核对 OWASP', scope: 'per-project', gate: true, summary: true })
  })

  it('buildEditState 回填已有追加段', () => {
    const wsY: Workspace = {
      name: 'w', path: '/w', workflowId: 'standard', stages: [],
      workflows: [{ id: 'standard', name: 'standard', stages: [{ key: 'design', provider: 'claude', model: 'opus-4.8', prompt: '画时序图' }] }],
      projects: [], status: 'idle', plugins: [], stepPlugins: []
    }
    const base: Record<string, WizardStage> = { design: { on: false, provider: '', model: '' } }
    const st = buildEditState(wsY, [], base, 'claude::opus-4.8')
    expect(st.workflows[0].stages.design.prompt).toBe('画时序图')
  })
})
