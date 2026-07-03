import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WorkspaceView } from './WorkspaceView'
import type { EngineApi } from '../state/useEngine'
import type { ProviderInfo, PendingAction, ChatEvent } from '@shared/types'

const providers: ProviderInfo[] = [{ id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8' }] }]

const pending: PendingAction[] = [
  { id: 'pc', kind: 'confirm', agentId: 'a1', agentName: 'Refactor', wsName: 'ws', provider: 'claude', role: '重构', title: '覆盖文件?' },
  {
    id: 'ps', kind: 'select', agentId: 'a2', agentName: 'Planner', wsName: 'ws', provider: 'codex', role: '方案',
    title: '选择策略', options: [{ t: '逐文件', d: '分批' }, { t: '全量', d: '最快' }],
  },
]

const resolve = vi.fn()
const engine: EngineApi = {
  run: { id: 'r', workspaceName: 'ws', workspacePath: '/ws', status: 'run', projects: [], stages: [], pending },
  pending, resolve, cancel: () => {},
}

let chatHandler: ((e: ChatEvent) => void) | null = null
beforeEach(() => {
  resolve.mockClear()
  chatHandler = null
  ;(window as any).forge = {
    chatHistory: async () => [],
    sendChat: async () => ({}), openFiles: async () => [], savePaste: vi.fn(),
    onChatEvent: (cb: (e: ChatEvent) => void) => { chatHandler = cb; return () => {} },
    onChatQueueEvent: () => () => {},
    watchChanges: async () => [], watchStop: async () => {}, fsTree: async () => [],
    gitDiff: async () => [], gitFile: async () => ({ text: '', lang: 'ts' }),
    onChangesEvent: () => () => {}, chatResolve: vi.fn(),
    getWorkspace: async () => ({ name: 'ws', path: '/ws', workflowId: 'standard', stages: [], projects: [], status: 'run' }),
  }
})

describe('WorkspaceView ReqCard wiring', () => {
  it('renders live run pending (confirm + select) as .msg-req cards in the chat stream', async () => {
    const { container } = render(<WorkspaceView engine={engine} providers={providers} />)
    await waitFor(() => expect(container.querySelectorAll('.chat-inner .msg-req').length).toBe(2))
    expect(container.querySelector('.chat-inner .msg-req.k-confirm')).toBeTruthy()
    expect(container.querySelector('.chat-inner .msg-req.k-select')).toBeTruthy()
    // confirm allow fires engine.resolve
    fireEvent.click(screen.getByText('允许并继续'))
    expect(resolve).toHaveBeenCalledWith({ id: 'pc', decision: 'allow' })
    // select option click carries choice index
    fireEvent.click(screen.getByText('全量'))
    expect(resolve).toHaveBeenCalledWith({ id: 'ps', decision: 'allow', choice: 1 })
  })

  it('renders chat plan-request as a PlanCard and routes 批准并执行 to chatResolve', async () => {
    const { container } = render(<WorkspaceView engine={engine} providers={providers} />)
    await waitFor(() => expect(chatHandler).not.toBeNull())
    chatHandler!({
      workspacePath: '/ws', sessionId: 'default', type: 'plan-request', id: 'pl1',
      approach: '逐文件迁移 tokens', task: '重构主题',
      stages: [{ name: '开发', agents: 3 }],
    } as ChatEvent)
    await waitFor(() => expect(screen.getByText('方案待批准')).toBeInTheDocument())
    expect(screen.getByText('逐文件迁移 tokens')).toBeInTheDocument()
    expect(container.querySelector(`.chat-inner .msg-req[data-req="pl1"]`)).toBeTruthy()
    expect(screen.getByText(/并行3代理/)).toBeInTheDocument()

    fireEvent.click(screen.getByText('批准并执行'))
    expect((window as any).forge.chatResolve).toHaveBeenCalledWith({ id: 'pl1', decision: 'allow', value: undefined, workspacePath: '/ws' })

    // plan-resolved removes the card
    chatHandler!({ workspacePath: '/ws', sessionId: 'default', type: 'plan-resolved', id: 'pl1' } as ChatEvent)
    await waitFor(() => expect(screen.queryByText('方案待批准')).toBeNull())
  })

  it('does not render an inspector 待你处理 / .pp-act section', () => {
    const { container } = render(<WorkspaceView engine={engine} providers={providers} />)
    expect(screen.queryByText('待你处理')).toBeNull()
    expect(container.querySelector('.pp-act')).toBeNull()
    // the request cards live in the chat stream, never in the inspector pane
    expect(container.querySelector('#pane-agents .msg-req')).toBeNull()
  })

  it('renders chat confirm-request as a ReqCard attributed to 主代理', async () => {
    const { container } = render(<WorkspaceView engine={engine} providers={providers} />)
    await waitFor(() => expect(chatHandler).not.toBeNull())
    chatHandler!({ workspacePath: '/ws', sessionId: 'default', type: 'confirm-request', id: 'cc1', title: '聊天确认?' } as ChatEvent)
    await waitFor(() => expect(screen.getByText('聊天确认?')).toBeInTheDocument())
    // 3 cards total now: 2 pending + 1 chat confirm
    await waitFor(() => expect(container.querySelectorAll('.chat-inner .msg-req').length).toBe(3))
    // the chat confirm card attributes to 主代理 in its head .who span
    const whoTexts = Array.from(container.querySelectorAll('.chat-inner .msg-req .req-from .who')).map(e => e.textContent)
    expect(whoTexts).toContain('主代理')
  })
})
