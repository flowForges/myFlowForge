import { describe, it, expect } from 'vitest'
import { deriveWsName, buildCreateOpts, packModel, unpackModel, buildEditState, type WizardState, type WizardStage } from './wizardModel'
import type { Workspace } from '@shared/types'

describe('wizard model', () => {
  it('derives workspace name from the path last segment unless edited', () => {
    expect(deriveWsName('~/code/design-system-v3', false, '')).toBe('design-system-v3')
    expect(deriveWsName('~/code/design-system-v3', true, 'My Name')).toBe('My Name')
  })
  it('builds CreateWorkspaceOpts from enabled stages + selected projects', () => {
    const state: WizardState = {
      path: '~/code/ws-a', name: '', nameEdited: false,
      workflowId: 'standard',
      stages: {
        design: { on: true, provider: 'claude', model: 'opus-4.8' },
        develop: { on: true, provider: 'claude', model: 'sonnet-4.6' },
        test: { on: false, provider: 'claude', model: 'haiku-4.5' }
      },
      projects: [
        { repoId: 'proj1', name: 'proj1', sel: true, branch: 'forge/ws-a', model: 'sonnet-4.6' },
        { repoId: 'proj2', name: 'proj2', sel: false, branch: 'forge/ws-a', model: 'sonnet-4.6' }
      ],
      plugins: [],
      stepPlugins: []
    }
    const opts = buildCreateOpts(state)
    expect(opts.name).toBe('ws-a')                      // derived from path
    expect(opts.stages.map(s => s.key)).toEqual(['design', 'develop'])  // only enabled, order preserved
    expect(opts.projects.map(p => p.repoId)).toEqual(['proj1'])         // only selected
    expect(opts.workflowId).toBe('standard')
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
  name: '设计迁移', path: '/abs/ws-a', workflowId: 'standard',
  stages: [
    { key: 'design', provider: 'claude', model: 'opus-4.8' },
    { key: 'develop', provider: 'codex', model: 'gpt-5-codex' },
  ],
  projects: [{ repoId: 'p1', name: 'app', branch: 'feat/x', provider: 'codex', model: 'gpt-5-codex' }],
  status: 'ok',
  plugins: [],
  stepPlugins: [],
}

describe('buildEditState', () => {
  it('lights up persisted stages with their provider/model, others off', () => {
    const st = buildEditState(ws, knownProjects, baseStages(), 'claude::opus-4.8')
    expect(st.stages.design).toEqual({ on: true, provider: 'claude', model: 'opus-4.8' })
    expect(st.stages.develop).toEqual({ on: true, provider: 'codex', model: 'gpt-5-codex' })
    expect(st.stages.requirement.on).toBe(false)
    expect(st.name).toBe('设计迁移')
    expect(st.path).toBe('/abs/ws-a')
    expect(st.nameEdited).toBe(true)
    expect(st.workflowId).toBe('__custom')
  })

  it('marks included projects sel+locked (branch/model backfilled), others selectable', () => {
    const st = buildEditState(ws, knownProjects, baseStages(), 'claude::opus-4.8')
    const p1 = st.projects.find(p => p.repoId === 'p1')!
    expect(p1).toMatchObject({ sel: true, locked: true, branch: 'feat/x', model: 'codex::gpt-5-codex' })
    const p2 = st.projects.find(p => p.repoId === 'p2')!
    expect(p2).toMatchObject({ sel: false, branch: '', model: 'claude::opus-4.8' })
    expect(p2.locked).toBeFalsy()
  })

  it('appends ws-only projects (no longer in known list) as locked', () => {
    const wsX: Workspace = { ...ws, projects: [...ws.projects, { repoId: 'gone', name: 'gone', branch: 'main', provider: 'claude', model: 'opus-4.8' }] }
    const st = buildEditState(wsX, knownProjects, baseStages(), 'claude::opus-4.8')
    const g = st.projects.find(p => p.repoId === 'gone')!
    expect(g).toMatchObject({ sel: true, locked: true, name: 'gone' })
  })

  it('round-trips through buildCreateOpts back to the persisted config', () => {
    const st = buildEditState(ws, knownProjects, baseStages(), 'claude::opus-4.8')
    // mirror the component's doCreate: unpack each selected project's packed model before building opts
    const committed = { ...st, projects: st.projects.map(p => { const { provider, model } = unpackModel(p.model); return { ...p, provider, model } }) }
    const opts = buildCreateOpts(committed, ['requirement', 'design', 'develop', 'test', 'review'])
    expect(opts.name).toBe('设计迁移')
    expect(opts.stages).toEqual([
      { key: 'design', provider: 'claude', model: 'opus-4.8' },
      { key: 'develop', provider: 'codex', model: 'gpt-5-codex' },
    ])
    expect(opts.projects).toEqual([
      { repoId: 'p1', branch: 'feat/x', provider: 'codex', model: 'gpt-5-codex' },
    ])
  })

  it('buildCreateOpts 写入非空追加段、忽略空段', () => {
    const state: any = { path: '/w', name: 'w', nameEdited: true, workflowId: '__custom',
      stages: { design: { on: true, provider: 'claude', model: 'opus-4.8', prompt: '画时序图' },
                develop: { on: true, provider: 'claude', model: 'opus-4.8', prompt: '  ' } },
      projects: [], plugins: [], stepPlugins: [] }
    const opts = buildCreateOpts(state, ['design', 'develop'])
    expect(opts.stages.find(s => s.key === 'design')?.prompt).toBe('画时序图')
    expect(opts.stages.find(s => s.key === 'develop')?.prompt).toBeUndefined()
  })

  it('buildEditState 回填已有追加段', () => {
    const ws: any = { name: 'w', path: '/w', workflowId: 'standard',
      stages: [{ key: 'design', provider: 'claude', model: 'opus-4.8', prompt: '画时序图' }],
      projects: [], status: 'idle', plugins: [], stepPlugins: [] }
    const base: any = { design: { on: false, provider: '', model: '' } }
    const st = buildEditState(ws, [], base, 'claude::opus-4.8')
    expect(st.stages.design.prompt).toBe('画时序图')
  })
})
