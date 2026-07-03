import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '../git/gitRunner'
import { FORGE_WORKFLOW_SKILL } from '../skills/forgeWorkflowSkill'

let root: string
vi.mock('../config/paths', async (orig) => {
  const actual = await orig<typeof import('../config/paths')>()
  return {
    ...actual,
    mirrorPath: (id: string) => join((globalThis as any).__REPOS__, `${id}.git`),
    sysFile: (n: string) => join((globalThis as any).__SYS__, n),
  }
})

async function makeSourceRepo(dir: string) {
  mkdirSync(dir, { recursive: true })
  await git(['init', '-b', 'main'], { cwd: dir })
  writeFileSync(join(dir, 'README.md'), '# src\n')
  await git(['add', '.'], { cwd: dir })
  await git(['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: dir })
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'svc-')); (globalThis as any).__REPOS__ = join(root, 'repos'); (globalThis as any).__SYS__ = join(root, 'sys') })
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('createWorkspace', () => {
  it('clones mirrors, adds worktrees per project, writes workspace.json, and builds StartRunOpts', async () => {
    const src = join(root, 'srcproj'); await makeSourceRepo(src)
    const { createWorkspace } = await import('./workspaceService')
    const projects = [{ id: 'proj', name: 'proj', repoUrl: src, defaultBranch: 'main' }]
    const wsPath = join(root, 'ws-a')
    const result = await createWorkspace({
      opts: {
        name: 'design-migration', path: wsPath, workflowId: 'standard',
        stages: [
          { key: 'design', provider: 'claude', model: 'opus-4.8' },
          { key: 'develop', provider: 'claude', model: 'sonnet-4.6' }
        ],
        projects: [{ repoId: 'proj', branch: 'forge/ws-a', model: 'sonnet-4.6' }]
      },
      knownProjects: projects, proxy: ''
    })
    expect(existsSync(join(wsPath, 'proj', 'README.md'))).toBe(true)
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: join(wsPath, 'proj') })
    expect(branch.trim()).toBe('forge/ws-a')
    expect(existsSync(join(wsPath, '.forge', 'workspace.json'))).toBe(true)
    expect(result.workspace.name).toBe('design-migration')
    expect(result.startRunOpts.stages.find(s => s.key === 'develop')).toBeTruthy()
    expect(result.startRunOpts.developProjects.map(p => p.name)).toEqual(['proj'])
    expect(result.startRunOpts.developProjects[0].cwd).toBe(join(wsPath, 'proj'))
  })

  it('creates a folder-only workspace (no projects, no stages) for chat-only use', async () => {
    const { createWorkspace } = await import('./workspaceService')
    const wsPath = join(root, 'ws-chat-only')
    const result = await createWorkspace({
      opts: { name: 'just-chat', path: wsPath, workflowId: 'standard', stages: [], projects: [] },
      knownProjects: [], proxy: ''
    })
    // The workspace folder + .forge metadata are created even without any project/worktree.
    expect(existsSync(join(wsPath, '.forge', 'workspace.json'))).toBe(true)
    expect(result.workspace.name).toBe('just-chat')
    expect(result.workspace.projects).toEqual([])
    expect(result.startRunOpts.workspacePath).toBe(wsPath)
    expect(result.startRunOpts.developProjects).toEqual([])
  })

  it('carries per-project provider and model into StartRunOpts.developProjects', async () => {
    const src = join(root, 'srcproj2'); await makeSourceRepo(src)
    const { createWorkspace } = await import('./workspaceService')
    const projects = [{ id: 'proj', name: 'proj', repoUrl: src, defaultBranch: 'main' }]
    const wsPath = join(root, 'ws-b')
    const result = await createWorkspace({
      opts: {
        name: 'per-provider-test', path: wsPath, workflowId: 'standard',
        stages: [{ key: 'develop', provider: 'claude', model: 'sonnet-4.6' }],
        projects: [{ repoId: 'proj', branch: 'forge/ws-b', provider: 'codex', model: 'gpt-5-codex' }]
      },
      knownProjects: projects, proxy: ''
    })
    expect(result.startRunOpts.developProjects[0]).toMatchObject({
      provider: 'codex',
      model: 'gpt-5-codex'
    })
  })

  it('persists resolved stages + enriched projects into workspace.json (round-trips via readWorkspace)', async () => {
    const src = join(root, 'srcproj3'); await makeSourceRepo(src)
    const { createWorkspace } = await import('./workspaceService')
    const { readWorkspace } = await import('../config/store')
    const projects = [{ id: 'proj', name: 'proj', repoUrl: src, defaultBranch: 'main' }]
    const wsPath = join(root, 'ws-c')
    await createWorkspace({
      opts: {
        name: 'persist-test', path: wsPath, workflowId: 'standard',
        stages: [
          { key: 'design', provider: 'claude', model: 'opus-4.8' },
          { key: 'develop', provider: 'claude', model: 'sonnet-4.6' }
        ],
        projects: [{ repoId: 'proj', branch: 'forge/ws-c', provider: 'codex', model: 'gpt-5-codex' }]
      },
      knownProjects: projects, proxy: ''
    })
    const ws = readWorkspace(wsPath)!
    expect(ws).not.toBeNull()
    expect(ws.workflowId).toBe('standard')
    expect(ws.stages).toEqual([
      { key: 'design', provider: 'claude', model: 'opus-4.8' },
      { key: 'develop', provider: 'claude', model: 'sonnet-4.6' }
    ])
    expect(ws.projects).toEqual([
      { repoId: 'proj', name: 'proj', branch: 'forge/ws-c', provider: 'codex', model: 'gpt-5-codex' }
    ])
  })

  it('defaults missing per-project provider/model to empty string when persisting', async () => {
    const src = join(root, 'srcproj4'); await makeSourceRepo(src)
    const { createWorkspace } = await import('./workspaceService')
    const { readWorkspace } = await import('../config/store')
    const projects = [{ id: 'proj', name: 'proj', repoUrl: src, defaultBranch: 'main' }]
    const wsPath = join(root, 'ws-d')
    await createWorkspace({
      opts: {
        name: 'defaults-test', path: wsPath, workflowId: 'standard',
        stages: [{ key: 'develop', provider: 'claude', model: 'sonnet-4.6' }],
        projects: [{ repoId: 'proj', branch: 'forge/ws-d' }]
      },
      knownProjects: projects, proxy: ''
    })
    const ws = readWorkspace(wsPath)!
    expect(ws.projects[0]).toEqual({ repoId: 'proj', name: 'proj', branch: 'forge/ws-d', provider: '', model: '' })
  })

  it('defaults persisted project name to repoId when the known project has no display name', async () => {
    const src = join(root, 'srcproj4b'); await makeSourceRepo(src)
    const { createWorkspace } = await import('./workspaceService')
    const { readWorkspace } = await import('../config/store')
    // known project with an EMPTY name → must not persist name:'' (would break cwd + labels)
    const projects = [{ id: 'go-blog', name: '', repoUrl: src, defaultBranch: 'main' }]
    const wsPath = join(root, 'ws-d2')
    await createWorkspace({
      opts: {
        name: 'noname-test', path: wsPath, workflowId: 'standard',
        stages: [{ key: 'develop', provider: 'claude', model: 'sonnet-4.6' }],
        projects: [{ repoId: 'go-blog', branch: 'forge/ws-d2' }]
      },
      knownProjects: projects, proxy: ''
    })
    const ws = readWorkspace(wsPath)!
    expect(ws.projects[0].name).toBe('go-blog')
  })

  it('installs the forge-workflow skill into the new workspace', async () => {
    const src = join(root, 'srcproj5'); await makeSourceRepo(src)
    const { createWorkspace } = await import('./workspaceService')
    const projects = [{ id: 'proj', name: 'proj', repoUrl: src, defaultBranch: 'main' }]
    const wsPath = join(root, 'ws-e')
    await createWorkspace({
      opts: {
        name: 'skill-test', path: wsPath, workflowId: 'standard',
        stages: [{ key: 'develop', provider: 'claude', model: 'sonnet-4.6' }],
        projects: [{ repoId: 'proj', branch: 'forge/ws-e' }]
      },
      knownProjects: projects, proxy: ''
    })
    expect(existsSync(join(wsPath, FORGE_WORKFLOW_SKILL.relPath))).toBe(true)
  })
})

describe('editWorkspace', () => {
  it('rewrites stages/projects/name in place without re-adding existing worktrees', async () => {
    const src = join(root, 'srcA'); await makeSourceRepo(src)
    const { createWorkspace, editWorkspace } = await import('./workspaceService')
    const { readWorkspace } = await import('../config/store')
    const known = [{ id: 'proj', name: 'proj', repoUrl: src, defaultBranch: 'main' }]
    const wsPath = join(root, 'ws-edit')
    await createWorkspace({
      opts: { name: 'orig', path: wsPath, workflowId: 'standard',
        stages: [{ key: 'develop', provider: 'claude', model: 'sonnet-4.6' }],
        projects: [{ repoId: 'proj', branch: 'forge/ws-edit' }] },
      knownProjects: known, proxy: ''
    })
    const result = await editWorkspace({
      path: wsPath,
      opts: { name: 'renamed', path: wsPath, workflowId: '__custom',
        stages: [
          { key: 'design', provider: 'claude', model: 'opus-4.8' },
          { key: 'develop', provider: 'codex', model: 'gpt-5-codex' },
        ],
        projects: [{ repoId: 'proj', branch: 'forge/ws-edit', provider: 'codex', model: 'gpt-5-codex' }] },
      knownProjects: known, proxy: ''
    })
    expect(result.name).toBe('renamed')
    const ws = readWorkspace(wsPath)!
    expect(ws.name).toBe('renamed')
    expect(ws.status).toBe('idle')
    expect(ws.stages).toEqual([
      { key: 'design', provider: 'claude', model: 'opus-4.8' },
      { key: 'develop', provider: 'codex', model: 'gpt-5-codex' },
    ])
    expect(ws.projects).toEqual([
      { repoId: 'proj', name: 'proj', branch: 'forge/ws-edit', provider: 'codex', model: 'gpt-5-codex' },
    ])
  })

  it('provisions a worktree only for newly added projects', async () => {
    const srcA = join(root, 'srcB1'); await makeSourceRepo(srcA)
    const srcB = join(root, 'srcB2'); await makeSourceRepo(srcB)
    const { createWorkspace, editWorkspace } = await import('./workspaceService')
    const known = [
      { id: 'a', name: 'a', repoUrl: srcA, defaultBranch: 'main' },
      { id: 'b', name: 'b', repoUrl: srcB, defaultBranch: 'main' },
    ]
    const wsPath = join(root, 'ws-add')
    await createWorkspace({
      opts: { name: 'w', path: wsPath, workflowId: 'standard',
        stages: [{ key: 'develop', provider: 'claude', model: 'sonnet-4.6' }],
        projects: [{ repoId: 'a', branch: 'forge/ws-add' }] },
      knownProjects: known, proxy: ''
    })
    expect(existsSync(join(wsPath, 'a', 'README.md'))).toBe(true)
    expect(existsSync(join(wsPath, 'b'))).toBe(false)
    await editWorkspace({
      path: wsPath,
      opts: { name: 'w', path: wsPath, workflowId: 'standard',
        stages: [{ key: 'develop', provider: 'claude', model: 'sonnet-4.6' }],
        projects: [
          { repoId: 'a', branch: 'forge/ws-add' },
          { repoId: 'b', branch: 'forge/ws-add' },
        ] },
      knownProjects: known, proxy: ''
    })
    expect(existsSync(join(wsPath, 'b', 'README.md'))).toBe(true)
  })

  it('updates the registry name (keyed by path)', async () => {
    const src = join(root, 'srcC'); await makeSourceRepo(src)
    const { createWorkspace, editWorkspace } = await import('./workspaceService')
    const { readWorkspaceRegistry } = await import('../config/store')
    const known = [{ id: 'proj', name: 'proj', repoUrl: src, defaultBranch: 'main' }]
    const wsPath = join(root, 'ws-reg')
    await createWorkspace({ opts: { name: 'before', path: wsPath, workflowId: 'standard',
      stages: [{ key: 'develop', provider: 'claude', model: 'sonnet-4.6' }], projects: [{ repoId: 'proj', branch: 'b' }] },
      knownProjects: known, proxy: '' })
    await editWorkspace({ path: wsPath, opts: { name: 'after', path: wsPath, workflowId: 'standard',
      stages: [{ key: 'develop', provider: 'claude', model: 'sonnet-4.6' }], projects: [{ repoId: 'proj', branch: 'b' }] },
      knownProjects: known, proxy: '' })
    const reg = readWorkspaceRegistry().filter(w => w.path === wsPath)
    expect(reg).toHaveLength(1)
    expect(reg[0].name).toBe('after')
  })

  it('throws when the workspace does not exist', async () => {
    const { editWorkspace } = await import('./workspaceService')
    await expect(editWorkspace({ path: join(root, 'nope'), opts: { name: 'x', path: join(root, 'nope'), workflowId: 'standard', stages: [], projects: [] }, knownProjects: [], proxy: '' })).rejects.toThrow()
  })
})

describe('buildStartRunOpts', () => {
  it('buildStartRunOpts 透传 stage 追加段', async () => {
    const { buildStartRunOpts } = await import('./workspaceService')
    const opts: any = { name: 'w', path: '/w', workflowId: 'standard',
      stages: [{ key: 'design', provider: 'claude', model: 'opus-4.8', prompt: '画时序图' }], projects: [] }
    const sr = buildStartRunOpts(opts, [])
    expect(sr.stages[0].prompt).toBe('画时序图')
  })
})
