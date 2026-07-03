import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WorkspaceView } from './WorkspaceView'
import type { EngineApi } from '../state/useEngine'
import type { ProviderInfo } from '@shared/types'

const providers: ProviderInfo[] = [{ id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8' }] }]
const engine: EngineApi = {
  run: { id: 'r', workspaceName: 'ws', workspacePath: '/ws', projects: [{ name: 'web', cwd: '/ws/web' }], status: 'run', stages: [], pending: [] },
  pending: [], resolve: () => {}, cancel: () => {}
}
beforeEach(() => {
  ;(window as any).forge = {
    chatHistory: async () => [], sendChat: async () => ({}), openFiles: async () => [], savePaste: vi.fn(), onChatEvent: () => () => {}, onChatQueueEvent: () => () => {},
    watchChanges: async () => [{ path: 'a.ts', type: 'M', add: 1, del: 0 }],
    watchStop: async () => {}, fsTree: async () => [{ type: 'file', name: 'a.ts', path: 'a.ts', chg: 'M' }],
    gitDiff: async () => [{ kind: 'add', ln: 1, text: 'x' }], gitFile: async () => ({ text: 'x', lang: 'ts' }),
    onChangesEvent: () => () => {},
    getWorkspace: async () => ({ name: 'ws', path: '/ws', workflowId: 'standard', stages: [], projects: [], status: 'run' }),
  }
})

describe('WorkspaceView inspector', () => {
  it('shows changes in the 变更 tab from the active project worktree', async () => {
    render(<WorkspaceView engine={engine} providers={providers} />)
    fireEvent.click(screen.getByText('变更'))
    await waitFor(() => expect(screen.getByText('a.ts')).toBeInTheDocument())
  })
})
