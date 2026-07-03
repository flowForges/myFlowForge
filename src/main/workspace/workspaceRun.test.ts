import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { STAGE_NAMES } from '../config/schema'
import type { Workspace } from '../config/schema'
import { workspaceToStartRunOpts } from './workspaceRun'

const ws: Workspace = {
  name: 'demo', path: '/tmp/demo', workflowId: 'standard',
  stages: [
    { key: 'design', provider: 'claude', model: 'opus-4.8' },
    { key: 'develop', provider: 'claude', model: 'sonnet-4.6' }
  ],
  projects: [
    { repoId: 'p1', name: 'alpha', branch: 'forge/demo', provider: 'codex', model: 'gpt-5-codex' },
    { repoId: 'p2', name: 'beta', branch: 'forge/demo', provider: '', model: '' }
  ],
  status: 'idle',
  plugins: [], stepPlugins: []
}

describe('workspaceToStartRunOpts', () => {
  it('rebuilds StartRunOpts with runId, derived stage names, and project cwds', () => {
    const opts = workspaceToStartRunOpts(ws)
    expect(opts.runId).toBe('run-demo')
    expect(opts.workspaceName).toBe('demo')
    expect(opts.workspacePath).toBe('/tmp/demo')
    expect(opts.task).toBeUndefined()
    expect(opts.stages).toEqual([
      { key: 'design', name: STAGE_NAMES.design, provider: 'claude', model: 'opus-4.8' },
      { key: 'develop', name: STAGE_NAMES.develop, provider: 'claude', model: 'sonnet-4.6' }
    ])
    expect(opts.developProjects).toEqual([
      { name: 'alpha', cwd: join('/tmp/demo', 'alpha'), provider: 'codex', model: 'gpt-5-codex' },
      { name: 'beta', cwd: join('/tmp/demo', 'beta'), provider: undefined, model: undefined }
    ])
  })

  it('passes task through', () => {
    const opts = workspaceToStartRunOpts(ws, 'do the thing')
    expect(opts.task).toBe('do the thing')
  })

  it('maps empty stages to an empty stages array', () => {
    const opts = workspaceToStartRunOpts({ ...ws, stages: [] })
    expect(opts.stages).toEqual([])
  })

  it('falls back to repoId for name+cwd when project name is empty (old workspace.json)', () => {
    // Old/pre-SP-A workspace.json stored only {repoId,branch}; name parses as ''. The worktree
    // dir on disk is named by repoId, so the develop agent must cwd into <ws>/<repoId>, not the
    // workspace root (join(path,'') === path), and the label must show repoId, not ''.
    const oldWs: Workspace = {
      ...ws,
      projects: [
        { repoId: 'go-blog', name: '', branch: 'forge/demo', provider: '', model: '' }
      ]
    }
    const opts = workspaceToStartRunOpts(oldWs)
    expect(opts.developProjects).toEqual([
      { name: 'go-blog', cwd: join('/tmp/demo', 'go-blog'), provider: undefined, model: undefined }
    ])
  })

  it('keeps an explicit project name (it wins over repoId)', () => {
    const opts = workspaceToStartRunOpts(ws)
    expect(opts.developProjects[0].name).toBe('alpha')
    expect(opts.developProjects[0].cwd).toBe(join('/tmp/demo', 'alpha'))
  })

  it('carries WsStage.review through to StageSpec.review', () => {
    const ws = {
      name: 'w', path: '/ws', workflowId: 'standard', status: 'idle' as const,
      projects: [{ repoId: 'web', name: 'web', branch: 'main', provider: '', model: '' }],
      stages: [{ key: 'review' as const, provider: 'claude', model: 'm', review: { mode: 'parallel' as const, scope: 'per-project' as const } }],
      plugins: [], stepPlugins: [],
    }
    const opts = workspaceToStartRunOpts(ws)
    expect(opts.stages[0].review).toEqual({ mode: 'parallel', scope: 'per-project' })
  })

  it('leaves review undefined when the stage has none', () => {
    const ws = {
      name: 'w', path: '/ws', workflowId: 'standard', status: 'idle' as const,
      projects: [], stages: [{ key: 'develop' as const, provider: 'claude', model: 'm' }],
      plugins: [], stepPlugins: [],
    }
    expect(workspaceToStartRunOpts(ws).stages[0].review).toBeUndefined()
  })

  it('workspaceToStartRunOpts 透传 stage 追加段', () => {
    const ws: any = { name: 'w', path: '/w', workflowId: 'standard',
      stages: [{ key: 'design', provider: 'claude', model: 'opus-4.8', prompt: '画时序图' }],
      projects: [], status: 'idle', plugins: [], stepPlugins: [] }
    const opts = workspaceToStartRunOpts(ws)
    expect(opts.stages[0].prompt).toBe('画时序图')
  })
})
