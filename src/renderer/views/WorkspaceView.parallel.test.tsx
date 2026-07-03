import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import { WorkspaceView } from './WorkspaceView'
import type { EngineApi } from '../state/useEngine'
import type { ProviderInfo, RunState, AgentRuntime } from '@shared/types'

const providers: ProviderInfo[] = [
  { id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8' }] }
]

function agent(id: string): AgentRuntime {
  return { id, name: id, role: 'r', provider: 'claude', model: 'opus-4.8', state: 'run', logs: [] }
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

describe('WorkspaceView parallel swimlane', () => {
  it('renders a parallel stage with conc-tag when a stage has multiple agents', () => {
    const run: RunState = {
      id: 'r', workspaceName: 'ws', workspacePath: '/ws', status: 'run',
      projects: [{ name: 'web', cwd: '/ws/web' }],
      stages: [{ key: 's1', name: 'Stage 1', state: 'run', agents: [agent('a1'), agent('a2')] }],
      pending: []
    }
    const { container } = render(<WorkspaceView engine={makeEngine(run)} providers={providers} />)
    const stage = container.querySelector('.stage')!
    expect(stage).toBeTruthy()
    expect(stage.classList.contains('parallel')).toBe(true)
    const tag = stage.querySelector('.conc-tag')
    expect(tag).toBeTruthy()
    expect(tag!.textContent).toContain('2 个代理同时执行')
    expect(tag!.querySelector('.conc-pulse')).toBeTruthy()
  })

  it('does not render conc-tag or parallel class for a single-agent stage', () => {
    const run: RunState = {
      id: 'r', workspaceName: 'ws', workspacePath: '/ws', status: 'run',
      projects: [{ name: 'web', cwd: '/ws/web' }],
      stages: [{ key: 's1', name: 'Stage 1', state: 'run', agents: [agent('a1')] }],
      pending: []
    }
    const { container } = render(<WorkspaceView engine={makeEngine(run)} providers={providers} />)
    const stage = container.querySelector('.stage')!
    expect(stage).toBeTruthy()
    expect(stage.classList.contains('parallel')).toBe(false)
    expect(stage.querySelector('.conc-tag')).toBeNull()
  })
})
