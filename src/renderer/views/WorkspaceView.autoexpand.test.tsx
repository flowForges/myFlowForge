import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { WorkspaceView } from './WorkspaceView'
import type { EngineApi } from '../state/useEngine'
import type { ProviderInfo, RunState, AgentRuntime, AgentState } from '@shared/types'

const providers: ProviderInfo[] = [
  { id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8' }] }
]

function agent(id: string, state: AgentState, logText: string): AgentRuntime {
  return {
    id, name: id, role: 'r', provider: 'claude', model: 'opus-4.8', state,
    logs: [{ ts: '09:42:01', text: logText, level: 'accent' }],
  }
}

function makeEngine(run: RunState): EngineApi {
  return { run, pending: [], resolve: () => {}, cancel: () => {} }
}

beforeEach(() => {
  ;(window as any).forge = {
    chatHistory: async () => [], sendChat: async () => ({}), openFiles: async () => [], savePaste: vi.fn(),
    onChatEvent: () => () => {}, onChatQueueEvent: () => () => {}, watchChanges: async () => [], watchStop: async () => {},
    fsTree: async () => [], gitDiff: async () => [], gitFile: async () => ({ text: '', lang: 'ts' }),
    onChangesEvent: () => () => {},
    getWorkspace: async () => ({ name: 'ws', path: '/ws', workflowId: 'standard', stages: [], projects: [], status: 'run' }),
  }
})

describe('WorkspaceView auto-expand running agent', () => {
  it('shows a running agent log without a manual toggle, hides a non-running one', () => {
    const run: RunState = {
      id: 'r', workspaceName: 'ws', workspacePath: '/ws', status: 'run',
      projects: [{ name: 'web', cwd: '/ws/web' }],
      stages: [
        { key: 's1', name: 'Stage 1', state: 'ok', agents: [agent('done', 'ok', '已完成日志')] },
        { key: 's2', name: 'Stage 2', state: 'run', agents: [agent('live', 'run', '执行中的日志')] },
      ],
      pending: []
    }
    render(<WorkspaceView engine={makeEngine(run)} providers={providers} />)
    // running agent auto-expands → its log is visible
    expect(screen.getByText('执行中的日志')).toBeInTheDocument()
    // non-running agent stays collapsed
    expect(screen.queryByText('已完成日志')).not.toBeInTheDocument()
  })
})
