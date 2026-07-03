/**
 * End-to-end smoke test (no GUI): proves the Phase-2B create flow produces a
 * runnable orchestration. Builds a local source repo, runs the REAL
 * createWorkspace (git mirror + worktree + workspace.json + StartRunOpts), then
 * feeds the resulting StartRunOpts into the REAL Phase-1 Orchestrator driven by a
 * fake agent provider (no real CLI, no network — the local source repo is the
 * "remote"). Asserts the run completes ok, the develop stage fans out to the one
 * project (with cwd = the real worktree path under the workspace), and
 * .forge/workspace.json was written.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '../git/gitRunner'
import { EventBus } from '../orchestrator/eventBus'
import { Orchestrator } from '../orchestrator/orchestrator'
import type { AgentProvider } from '../agents/types'

let root: string

// Redirect bare mirrors into the per-test temp dir so the real createWorkspace
// clones/fetches there instead of ~/.myFlowForge/repos.
vi.mock('../config/paths', async (orig) => {
  const actual = await orig<typeof import('../config/paths')>()
  return {
    ...actual,
    mirrorPath: (id: string) => join((globalThis as any).__REPOS__, `${id}.git`),
    sysFile: (n: string) => join((globalThis as any).__SYS__, n),
  }
})

// Fake provider that structurally satisfies AgentProvider and drives a
// successful run: flips state run -> ok and resolves done with { ok: true }.
// The Orchestrator awaits session.done then marks the stage ok iff every agent
// reached state 'ok', so we must call cb.onState('ok').
function fakeProvider(): AgentProvider {
  return {
    id: 'claude',
    displayName: 'Claude Code',
    capabilities: { structuredOutput: true, permissionHook: true, pty: false },
    async detect() { return true },
    async listModels() { return [{ id: 'opus-4.8', label: 'opus-4.8' }] },
    run(task, cb) {
      cb.onState('run')
      const done = (async () => {
        cb.onState('ok')
        const result = { ok: true, summary: `${task.name} done` }
        cb.onDone(result)
        return result
      })()
      return { id: task.agentId, cancel() {}, done }
    }
  }
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'e2e-')); (globalThis as any).__REPOS__ = join(root, 'repos'); (globalThis as any).__SYS__ = join(root, 'sys') })
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('create -> run e2e', () => {
  it('creates a workspace and runs it through the orchestrator', async () => {
    // 1. Build a local source repo to act as the project's git remote.
    const src = join(root, 'src')
    mkdirSync(src, { recursive: true })
    await git(['init', '-b', 'main'], { cwd: src })
    writeFileSync(join(src, 'a.txt'), 'a')
    await git(['add', '.'], { cwd: src })
    await git(['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-m', 'i'], { cwd: src })

    // 2. Run the REAL createWorkspace to get StartRunOpts + side effects on disk.
    const { createWorkspace } = await import('./workspaceService')
    const wsPath = join(root, 'ws')
    const { startRunOpts } = await createWorkspace({
      opts: {
        name: 'ws', path: wsPath, workflowId: 'standard',
        stages: [
          { key: 'design', provider: 'claude', model: 'opus-4.8' },
          { key: 'develop', provider: 'claude', model: 'opus-4.8' }
        ],
        projects: [{ repoId: 'proj', branch: 'forge/ws', model: 'opus-4.8' }]
      },
      knownProjects: [{ id: 'proj', name: 'proj', repoUrl: src, defaultBranch: 'main' }],
      proxy: ''
    })

    // createWorkspace already wired the develop fan-out cwd to the real worktree.
    const worktreePath = join(wsPath, 'proj')
    expect(startRunOpts.developProjects.map(p => p.name)).toEqual(['proj'])
    expect(startRunOpts.developProjects[0].cwd).toBe(worktreePath)
    expect(existsSync(join(worktreePath, 'a.txt'))).toBe(true)

    // 3. Feed StartRunOpts into the REAL Orchestrator with a fake provider.
    const bus = new EventBus()
    const orch = new Orchestrator({ bus, providers: { claude: fakeProvider() }, proxy: () => '' })
    // Approve the inter-stage design review gate so develop runs (gate added in feat/render-evidence-stage-gate).
    bus.subscribe(e => { if (e.type === 'pending:add') setTimeout(() => orch.resolve({ id: e.action.id, decision: 'allow' }), 0) })
    const run = await orch.startRun(startRunOpts)

    // 4. Run completed ok and develop fanned out to exactly the one project 'proj'.
    expect(run.status).toBe('ok')
    const develop = run.stages.find(s => s.key === 'develop')!
    expect(develop.state).toBe('ok')
    expect(develop.agents.map(a => a.name)).toEqual(['proj'])

    // 5. The persisted workspace config exists.
    expect(existsSync(join(wsPath, '.forge', 'workspace.json'))).toBe(true)
  })
})
