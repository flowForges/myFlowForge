import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunState } from '@shared/types'

// ─── helpers ─────────────────────────────────────────────────────────────────

const makeRun = (over: Partial<RunState> = {}): RunState => ({
  id: 'run-1',
  workspaceName: 'ws',
  workspacePath: '/tmp/ws',
  status: 'run',
  projects: [{ name: 'p', cwd: '/tmp/p' }],
  stages: [
    {
      key: 'develop',
      name: '开发',
      state: 'run',
      agents: [
        { id: 'a1', name: 'a1', role: 'dev', provider: 'claude', model: 'm', state: 'run', logs: [] },
        { id: 'a2', name: 'a2', role: 'dev', provider: 'claude', model: 'm', state: 'ok',  logs: [] },
        { id: 'a3', name: 'a3', role: 'dev', provider: 'claude', model: 'm', state: 'wait', logs: [] },
      ],
    },
    {
      key: 'review',
      name: '审核',
      state: 'ok',
      agents: [
        { id: 'b1', name: 'b1', role: 'rev', provider: 'claude', model: 'm', state: 'ok',  logs: [] },
      ],
    },
  ],
  pending: [{ id: 'p1', kind: 'confirm', agentId: 'a1', agentName: 'a1', wsName: 'ws', title: 't' }],
  ...over,
})

// ─── reconcileRun (pure) ─────────────────────────────────────────────────────

describe('reconcileRun (pure)', () => {
  it('returns null when status is already "ok" (terminal — no change needed)', async () => {
    const { reconcileRun } = await import('./reconcile')
    expect(reconcileRun(makeRun({ status: 'ok' }))).toBeNull()
  })

  it('returns null when status is already "err" (terminal — no change needed)', async () => {
    const { reconcileRun } = await import('./reconcile')
    expect(reconcileRun(makeRun({ status: 'err' }))).toBeNull()
  })

  it('returns a fixed run with status "err" when input status is "run"', async () => {
    const { reconcileRun } = await import('./reconcile')
    const result = reconcileRun(makeRun({ status: 'run' }))
    expect(result).not.toBeNull()
    expect(result!.status).toBe('err')
  })

  it('returns a fixed run with status "err" when input status is "wait" (non-terminal)', async () => {
    const { reconcileRun } = await import('./reconcile')
    const result = reconcileRun(makeRun({ status: 'wait' }))
    expect(result).not.toBeNull()
    expect(result!.status).toBe('err')
  })

  it('normalises non-terminal stage states to "err", preserves terminal "ok"', async () => {
    const { reconcileRun } = await import('./reconcile')
    const result = reconcileRun(makeRun())!
    expect(result.stages[0].state).toBe('err')  // was 'run'
    expect(result.stages[1].state).toBe('ok')   // terminal – kept
  })

  it('normalises non-terminal agent states to "err", preserves terminal "ok"', async () => {
    const { reconcileRun } = await import('./reconcile')
    const result = reconcileRun(makeRun())!
    const agents = result.stages[0].agents
    expect(agents[0].state).toBe('err')   // was 'run'
    expect(agents[1].state).toBe('ok')    // terminal – kept
    expect(agents[2].state).toBe('err')   // was 'wait'
  })

  it('drops pending actions (dead run — no one can resolve them)', async () => {
    const { reconcileRun } = await import('./reconcile')
    const result = reconcileRun(makeRun())!
    expect(result.pending).toEqual([])
  })

  it('preserves all other top-level fields unchanged', async () => {
    const { reconcileRun } = await import('./reconcile')
    const input = makeRun()
    const result = reconcileRun(input)!
    expect(result.id).toBe(input.id)
    expect(result.workspaceName).toBe(input.workspaceName)
    expect(result.workspacePath).toBe(input.workspacePath)
    expect(result.projects).toEqual(input.projects)
  })
})

// ─── reconcileWorkspaceRuns (fs) ─────────────────────────────────────────────

// Mock config/paths so wsRunsDir(wsPath) points at <wsPath>/.forge/runs
// (the real impl does exactly that — we do NOT mock; we just use a real tmp dir).
// Mock config/store so readWorkspace/writeWorkspace operate on our tmp dir files.

let wsPath: string
let sysDir: string

vi.mock('../config/paths', async (orig) => {
  const actual = await orig<typeof import('../config/paths')>()
  return {
    ...actual,
    sysFile: (n: string) => join((globalThis as any).__SYS__, n),
  }
})

beforeEach(() => {
  wsPath = mkdtempSync(join(tmpdir(), 'reconcile-ws-'))
  sysDir = mkdtempSync(join(tmpdir(), 'reconcile-sys-'))
  ;(globalThis as any).__SYS__ = sysDir
})
afterEach(() => {
  rmSync(wsPath, { recursive: true, force: true })
  rmSync(sysDir, { recursive: true, force: true })
})

function writeStateJson(ws: string, runId: string, run: RunState) {
  const dir = join(ws, '.forge', 'runs', runId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'state.json'), JSON.stringify(run, null, 2), 'utf8')
}

function readStateJson(ws: string, runId: string): RunState {
  return JSON.parse(readFileSync(join(ws, '.forge', 'runs', runId, 'state.json'), 'utf8'))
}

function writeWorkspaceJson(ws: string, status: 'idle' | 'run' | 'ok' | 'err') {
  const dir = join(ws, '.forge')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'workspace.json'),
    JSON.stringify({ name: 'ws', path: ws, workflowId: 'default', stages: [], projects: [], status }, null, 2),
    'utf8',
  )
}

function readWorkspaceStatus(ws: string): string {
  return JSON.parse(readFileSync(join(ws, '.forge', 'workspace.json'), 'utf8')).status
}

describe('reconcileWorkspaceRuns (fs)', () => {
  it('rewrites a stuck "run" state.json to "err" on disk', async () => {
    const { reconcileWorkspaceRuns } = await import('./reconcile')
    const run = makeRun({ id: 'run-stuck', workspacePath: wsPath, status: 'run' })
    writeStateJson(wsPath, 'run-stuck', run)
    writeWorkspaceJson(wsPath, 'run')

    reconcileWorkspaceRuns(wsPath)

    const onDisk = readStateJson(wsPath, 'run-stuck')
    expect(onDisk.status).toBe('err')
    expect(onDisk.pending).toEqual([])
  })

  it('does NOT rewrite an already-terminal "ok" state.json', async () => {
    const { reconcileWorkspaceRuns } = await import('./reconcile')
    const run = makeRun({ id: 'run-ok', workspacePath: wsPath, status: 'ok' })
    writeStateJson(wsPath, 'run-ok', run)
    writeWorkspaceJson(wsPath, 'ok')

    const before = readFileSync(join(wsPath, '.forge', 'runs', 'run-ok', 'state.json'), 'utf8')
    reconcileWorkspaceRuns(wsPath)
    const after = readFileSync(join(wsPath, '.forge', 'runs', 'run-ok', 'state.json'), 'utf8')

    expect(after).toBe(before)  // untouched
  })

  it('does NOT rewrite an already-terminal "err" state.json', async () => {
    const { reconcileWorkspaceRuns } = await import('./reconcile')
    const run = makeRun({ id: 'run-err', workspacePath: wsPath, status: 'err' })
    writeStateJson(wsPath, 'run-err', run)
    writeWorkspaceJson(wsPath, 'err')

    const before = readFileSync(join(wsPath, '.forge', 'runs', 'run-err', 'state.json'), 'utf8')
    reconcileWorkspaceRuns(wsPath)
    const after = readFileSync(join(wsPath, '.forge', 'runs', 'run-err', 'state.json'), 'utf8')

    expect(after).toBe(before)
  })

  it('updates workspace.json status to "err" when workspace was stuck "run"', async () => {
    const { reconcileWorkspaceRuns } = await import('./reconcile')
    writeWorkspaceJson(wsPath, 'run')
    // No runs needed – just verify ws.json gets fixed
    reconcileWorkspaceRuns(wsPath)
    expect(readWorkspaceStatus(wsPath)).toBe('err')
  })

  it('leaves workspace.json status "idle" untouched (benign resting state, not a stuck run)', async () => {
    const { reconcileWorkspaceRuns } = await import('./reconcile')
    writeWorkspaceJson(wsPath, 'idle')
    reconcileWorkspaceRuns(wsPath)
    expect(readWorkspaceStatus(wsPath)).toBe('idle')
  })

  it('leaves workspace.json status "ok" untouched (already terminal)', async () => {
    const { reconcileWorkspaceRuns } = await import('./reconcile')
    writeWorkspaceJson(wsPath, 'ok')
    reconcileWorkspaceRuns(wsPath)
    expect(readWorkspaceStatus(wsPath)).toBe('ok')
  })

  it('leaves workspace.json status "err" untouched (already terminal)', async () => {
    const { reconcileWorkspaceRuns } = await import('./reconcile')
    writeWorkspaceJson(wsPath, 'err')
    reconcileWorkspaceRuns(wsPath)
    expect(readWorkspaceStatus(wsPath)).toBe('err')
  })

  it('does nothing when the runs dir does not exist (no crash)', async () => {
    const { reconcileWorkspaceRuns } = await import('./reconcile')
    // No .forge/runs dir — just ensure no throw
    expect(() => reconcileWorkspaceRuns(wsPath)).not.toThrow()
  })

  it('skips a run dir that has no state.json (no crash)', async () => {
    const { reconcileWorkspaceRuns } = await import('./reconcile')
    // Create an empty run subdir without state.json
    mkdirSync(join(wsPath, '.forge', 'runs', 'empty-run'), { recursive: true })
    writeWorkspaceJson(wsPath, 'ok')
    expect(() => reconcileWorkspaceRuns(wsPath)).not.toThrow()
  })

  it('skips a corrupt state.json (no crash, continues to next run)', async () => {
    const { reconcileWorkspaceRuns } = await import('./reconcile')
    const dir = join(wsPath, '.forge', 'runs', 'corrupt-run')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'state.json'), '{bad json', 'utf8')
    // also a valid stuck run
    const run = makeRun({ id: 'run-stuck', workspacePath: wsPath, status: 'run' })
    writeStateJson(wsPath, 'run-stuck', run)
    writeWorkspaceJson(wsPath, 'run')

    expect(() => reconcileWorkspaceRuns(wsPath)).not.toThrow()
    // valid stuck run still gets fixed
    expect(readStateJson(wsPath, 'run-stuck').status).toBe('err')
  })

  it('removes a stale forge.sock left in a dead run dir', async () => {
    const { reconcileWorkspaceRuns } = await import('./reconcile')
    const run = makeRun({ id: 'run-sock', workspacePath: wsPath, status: 'run' })
    writeStateJson(wsPath, 'run-sock', run)
    const sockPath = join(wsPath, '.forge', 'runs', 'run-sock', 'forge.sock')
    writeFileSync(sockPath, '', 'utf8')   // simulate stale socket file
    writeWorkspaceJson(wsPath, 'run')

    reconcileWorkspaceRuns(wsPath)

    expect(existsSync(sockPath)).toBe(false)
  })

  it('handles multiple runs — fixes all non-terminal, leaves terminal untouched', async () => {
    const { reconcileWorkspaceRuns } = await import('./reconcile')
    writeStateJson(wsPath, 'run-a', makeRun({ id: 'run-a', workspacePath: wsPath, status: 'run' }))
    writeStateJson(wsPath, 'run-b', makeRun({ id: 'run-b', workspacePath: wsPath, status: 'ok' }))
    writeStateJson(wsPath, 'run-c', makeRun({ id: 'run-c', workspacePath: wsPath, status: 'err' }))
    writeWorkspaceJson(wsPath, 'run')

    reconcileWorkspaceRuns(wsPath)

    expect(readStateJson(wsPath, 'run-a').status).toBe('err')
    expect(readStateJson(wsPath, 'run-b').status).toBe('ok')   // terminal – untouched
    expect(readStateJson(wsPath, 'run-c').status).toBe('err')  // already err – untouched
  })
})

// ─── reconcileDeadRuns ────────────────────────────────────────────────────────

describe('reconcileDeadRuns', () => {
  it('calls reconcileWorkspaceRuns for each workspace path', async () => {
    const { reconcileDeadRuns } = await import('./reconcile')

    const ws2 = mkdtempSync(join(tmpdir(), 'reconcile-ws2-'))
    try {
      // set up stuck runs in both workspaces
      writeStateJson(wsPath, 'run-1', makeRun({ id: 'run-1', workspacePath: wsPath, status: 'run' }))
      writeWorkspaceJson(wsPath, 'run')
      writeStateJson(ws2, 'run-2', makeRun({ id: 'run-2', workspacePath: ws2, status: 'run' }))
      writeWorkspaceJson(ws2, 'run')

      reconcileDeadRuns([wsPath, ws2])

      expect(readStateJson(wsPath, 'run-1').status).toBe('err')
      expect(readStateJson(ws2, 'run-2').status).toBe('err')
    } finally {
      rmSync(ws2, { recursive: true, force: true })
    }
  })

  it('does not throw when wsPaths is empty', async () => {
    const { reconcileDeadRuns } = await import('./reconcile')
    expect(() => reconcileDeadRuns([])).not.toThrow()
  })
})
