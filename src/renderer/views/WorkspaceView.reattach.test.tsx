import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { WorkspaceView } from './WorkspaceView'
import type { RunState } from '@shared/types'

const snapshot: RunState = {
  id: 'run-old', workspaceName: 'demo', workspacePath: '/ws/demo', status: 'err',
  projects: [{ name: 'proj', cwd: '/ws/demo/proj' }],
  stages: [{ key: 'develop', name: '开发', state: 'err', agents: [
    { id: 'develop:proj', name: 'proj', role: '在 proj 中开发', provider: 'claude', model: 'm', state: 'ok', logs: [] },
  ] }],
  pending: [],
}
const idleEngine = { run: null, pending: [], resolve: vi.fn() }

beforeEach(() => {
  ;(window as any).forge = {
    lastRun: vi.fn(async () => null),
    chatHistory: vi.fn(async () => []),
    sendChat: vi.fn(async () => ({})),
    openFiles: async () => [],
    savePaste: vi.fn(),
    onChatEvent: () => () => {},
    onChatQueueEvent: () => () => {},
    watchChanges: async () => [],
    watchStop: async () => {},
    fsTree: async () => [],
    gitDiff: async () => [],
    gitFile: async () => ({ text: '', lang: 'ts' }),
    onChangesEvent: () => () => {},
    getWorkspace: vi.fn(async () => ({ name: 'demo', path: '/ws/demo', workflowId: 'standard', stages: [], projects: [], status: 'idle' })),
  }
})

describe('WorkspaceView reattach', () => {
  it('reattaches: selected workspace without live run shows snapshot canvas and enabled composer', async () => {
    ;(window as any).forge.lastRun = vi.fn(async () => snapshot)
    ;(window as any).forge.chatHistory = vi.fn(async () => [{ id: 'm1', who: 'user', text: '历史消息', ts: '00:00:00' }])
    render(<WorkspaceView engine={idleEngine as any} providers={[]} workspacePath="/ws/demo" />)
    await waitFor(() => expect(screen.getByText('历史消息')).toBeInTheDocument())   // chat 历史恢复
    await waitFor(() => expect(screen.getByText('proj', { selector: '.agent-name' })).toBeInTheDocument())   // 快照 agent 卡
    expect((window as any).forge.lastRun).toHaveBeenCalledWith('/ws/demo')
    const composerInput = document.querySelector('#composerInput') as HTMLTextAreaElement
    expect(composerInput).not.toBeDisabled()                                         // Composer 启用
  })

  it('does not leak another workspace pending actions into the viewed workspace', async () => {
    ;(window as any).forge.lastRun = vi.fn(async () => snapshot)
    const engine = {
      run: { ...snapshot, id: 'live', workspacePath: '/ws/other', status: 'run' },
      pending: [{ id: 'p1', kind: 'confirm', agentId: 'a', agentName: 'a', wsName: 'other', title: '别的工作区的确认' }],
      resolve: vi.fn(),
    }
    render(<WorkspaceView engine={engine as any} providers={[]} workspacePath="/ws/demo" />)
    await waitFor(() => expect((window as any).forge.lastRun).toHaveBeenCalled())
    expect(screen.queryByText('别的工作区的确认')).not.toBeInTheDocument()
  })
})
