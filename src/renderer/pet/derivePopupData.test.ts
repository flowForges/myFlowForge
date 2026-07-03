import { describe, it, expect } from 'vitest'
import { derivePopupData } from './derivePopupData'
import type { RunState, PendingAction, WorkspaceMeta } from '@shared/types'

const ws = (name: string, path: string, status: WorkspaceMeta['status']): WorkspaceMeta =>
  ({ name, path, projectCount: 2, workflowId: 'standard', status, pinned: false, archived: false, archivedAt: null, createdAt: 0, description: '' })

const runOn = (path: string, agentNames: string[]): RunState => ({
  id: 'r1', workspaceName: 'ws', workspacePath: path, status: 'run', projects: [],
  stages: [{ key: 'develop', name: '开发', state: 'run', agents: agentNames.map((n, i) => ({ id: 'a' + i, name: n, role: 'r', provider: 'claude', model: 'opus-4.8', state: 'run' as const, logs: [] })) }],
  pending: []
})

const confirm: PendingAction = { id: 'p1', kind: 'confirm', agentId: 'a', agentName: 'Refactor 代理', wsName: 'design-system-v3', title: '覆盖 theme.ts', where: 'src/styles/theme.ts' }

describe('derivePopupData', () => {
  it('idle: no run, no pending → 全部空闲, no badge', () => {
    const d = derivePopupData(null, [], [ws('A', '/a', 'idle')])
    expect(d.statusText).toBe('看守 1 个工作区 · 全部空闲')
    expect(d.badge).toBeNull()
    expect(d.workspaces).toHaveLength(1)
    expect(d.workspaces[0]).toMatchObject({ name: 'A', path: '/a', status: 'idle', agents: [], done: false, sub: '2 个项目 · standard' })
  })

  it('working: running agents on the active workspace → working badge + chips', () => {
    const d = derivePopupData(runOn('/a', ['设计代理', '部署代理']), [], [ws('A', '/a', 'run'), ws('B', '/b', 'idle')])
    expect(d.badge).toEqual({ count: 2, warn: false })
    expect(d.statusText).toBe('看守 2 个工作区 · 2 个代理在执行')
    const active = d.workspaces.find(w => w.path === '/a')!
    expect(active.agents).toEqual(['设计代理', '部署代理'])
    expect(d.workspaces.find(w => w.path === '/b')!.agents).toEqual([])
  })

  it('pending takes priority for badge + status (warn)', () => {
    const d = derivePopupData(runOn('/a', ['设计代理']), [confirm], [ws('A', '/a', 'run')])
    expect(d.badge).toEqual({ count: 1, warn: true })
    expect(d.statusText).toBe('1 项待处理 · 1 个代理在执行')
    expect(d.pending).toEqual([confirm])
  })

  it('exposes the currently-running agents (name/role/stage) so the popup can show what is executing', () => {
    const d = derivePopupData(runOn('/a', ['设计代理', '部署代理']), [], [ws('A', '/a', 'run')])
    expect(d.activeAgents).toEqual([
      { name: '设计代理', role: 'r', stage: '开发' },
      { name: '部署代理', role: 'r', stage: '开发' },
    ])
  })

  it('has an empty activeAgents list when nothing is running', () => {
    const d = derivePopupData(null, [], [ws('A', '/a', 'idle')])
    expect(d.activeAgents).toEqual([])
  })

  it('sorts workspaces run → ok → idle and marks ok-with-no-agents as done', () => {
    const d = derivePopupData(null, [], [ws('I', '/i', 'idle'), ws('O', '/o', 'ok'), ws('R', '/r', 'run')])
    expect(d.workspaces.map(w => w.status)).toEqual(['run', 'ok', 'idle'])
    expect(d.workspaces.find(w => w.path === '/o')!.done).toBe(true)
  })

  it('treats err status as idle bucket', () => {
    const d = derivePopupData(null, [], [ws('E', '/e', 'err')])
    expect(d.workspaces[0].status).toBe('idle')
  })

  it('lights the dot (run) for a workspace with a chat turn in flight (busyWs), even when persisted idle', () => {
    const d = derivePopupData(null, [], [ws('A', '/a', 'idle'), ws('B', '/b', 'idle')], new Set(['/a']))
    expect(d.workspaces.find(w => w.path === '/a')!.status).toBe('run')
    expect(d.workspaces.find(w => w.path === '/b')!.status).toBe('idle')
  })

  it('lights the dot for the whole orchestrator run, even in the gap between stages (no agent in run state)', () => {
    // run.status === 'run' but every agent is momentarily 'wait' (e.g. between stages) — still lit.
    const run = { id: 'r', workspaceName: 'ws', workspacePath: '/a', status: 'run' as const, projects: [], pending: [],
      stages: [{ key: 'develop', name: '开发', state: 'wait' as const, agents: [{ id: 'a0', name: 'x', role: 'r', provider: 'claude', model: 'm', state: 'wait' as const, logs: [] }] }] }
    const d = derivePopupData(run, [], [ws('A', '/a', 'idle')])
    expect(d.workspaces[0].status).toBe('run')
  })
})
