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

const gatePending: PendingAction[] = [
  {
    id: 'pg', kind: 'confirm', agentId: 'a3', agentName: 'Designer', wsName: 'ws', provider: 'claude',
    role: '技术方案设计', title: '技术方案设计完成', reworkable: true,
  },
]

const resolve = vi.fn()
const engine: EngineApi = {
  run: { id: 'r', workspaceName: 'ws', workspacePath: '/ws', status: 'run', projects: [], stages: [], pending },
  pending, resolve, cancel: () => {},
}

const gateResolve = vi.fn()
const gateEngine: EngineApi = {
  run: { id: 'r2', workspaceName: 'ws', workspacePath: '/ws', status: 'run', projects: [], stages: [], pending: gatePending },
  pending: gatePending, resolve: gateResolve, cancel: () => {},
}

let chatHandler: ((e: ChatEvent) => void) | null = null
beforeEach(() => {
  resolve.mockClear()
  gateResolve.mockClear()
  chatHandler = null
  ;(window as any).forge = {
    chatHistory: async () => [],
    sendChat: vi.fn(async () => ({})), openFiles: async () => [], savePaste: vi.fn(),
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
      workspacePath: '/ws', sessionId: 'default', type: 'plan-request', allProjects: [], id: 'pl1',
      approach: '逐文件迁移 tokens', task: '重构主题',
      stages: [{ key: '开发', name: '开发', agents: 3, perProject: false, projects: [] }],
    } as ChatEvent)
    await waitFor(() => expect(screen.getByText('方案待批准')).toBeInTheDocument())
    expect(screen.getByText('逐文件迁移 tokens')).toBeInTheDocument()
    expect(container.querySelector(`.chat-inner .msg-req[data-req="pl1"]`)).toBeTruthy()
    expect(screen.getByText('开发', { selector: '.plan-stage-name' })).toBeInTheDocument()

    fireEvent.click(screen.getByText('批准并执行'))
    expect((window as any).forge.chatResolve).toHaveBeenCalledWith(expect.objectContaining({ id: 'pl1', decision: 'allow', workspacePath: '/ws' }))

    // plan-resolved removes the card
    chatHandler!({ workspacePath: '/ws', sessionId: 'default', type: 'plan-resolved', id: 'pl1' } as ChatEvent)
    await waitFor(() => expect(screen.queryByText('方案待批准')).toBeNull())
  })

  it('修改方向… seeds the main composer with a quote marker + banner, and the next send routes to chatResolve as modify (Task 15)', async () => {
    const { container } = render(<WorkspaceView engine={engine} providers={providers} />)
    await waitFor(() => expect(chatHandler).not.toBeNull())
    chatHandler!({
      workspacePath: '/ws', sessionId: 'default', type: 'plan-request', allProjects: [], id: 'pl1',
      approach: '逐文件迁移 tokens', task: '重构主题',
      stages: [{ key: '开发', name: '开发', agents: 3, perProject: false, projects: [] }],
    } as ChatEvent)
    await waitFor(() => expect(screen.getByText('方案待批准')).toBeInTheDocument())

    // No banner yet, no inline textarea
    expect(container.querySelector('.supplement-banner')).toBeNull()
    fireEvent.click(screen.getByText('修改方向…'))

    // Banner appears + composer is seeded with the quote marker
    await waitFor(() => expect(container.querySelector('.supplement-banner')).toBeTruthy())
    expect(container.querySelector('.supplement-banner')?.textContent).toContain('补充中：针对【方案】')
    const ta = container.querySelector('#composerInput') as HTMLTextAreaElement
    await waitFor(() => expect(ta.value).toContain('针对【技术方案·方案】补充'))

    // Card is unaffected — allow/deny still work, and the plan card is still visible
    expect(screen.getByText('方案待批准')).toBeInTheDocument()

    // Typing a supplement and sending routes to chatResolve as 'modify', NOT a normal chat message.
    fireEvent.change(ta, { target: { value: ta.value + '改成全量替换' } })
    fireEvent.click(container.querySelector('#sendBtn') as HTMLButtonElement)
    await waitFor(() => expect((window as any).forge.chatResolve).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pl1', decision: 'modify', value: expect.stringContaining('改成全量替换') }),
    ))
    expect((window as any).forge.sendChat).not.toHaveBeenCalled()

    // Banner clears after send
    await waitFor(() => expect(container.querySelector('.supplement-banner')).toBeNull())
  })

  it('修改方向… banner can be cancelled — 取消 clears pendingSupplement and the next send goes to normal chat', async () => {
    const { container } = render(<WorkspaceView engine={engine} providers={providers} />)
    await waitFor(() => expect(chatHandler).not.toBeNull())
    chatHandler!({
      workspacePath: '/ws', sessionId: 'default', type: 'plan-request', allProjects: [], id: 'pl1',
      approach: '逐文件迁移 tokens', task: '重构主题',
      stages: [{ key: '开发', name: '开发', agents: 3, perProject: false, projects: [] }],
    } as ChatEvent)
    await waitFor(() => expect(screen.getByText('方案待批准')).toBeInTheDocument())
    fireEvent.click(screen.getByText('修改方向…'))
    await waitFor(() => expect(container.querySelector('.supplement-banner')).toBeTruthy())

    // '取消' also appears as the plan card's deny button — target the banner's cancel button specifically.
    fireEvent.click(container.querySelector('.supplement-cancel') as HTMLButtonElement)
    expect(container.querySelector('.supplement-banner')).toBeNull()

    const ta = container.querySelector('#composerInput') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '普通聊天消息' } })
    fireEvent.click(container.querySelector('#sendBtn') as HTMLButtonElement)
    await waitFor(() => expect((window as any).forge.sendChat).toHaveBeenCalled())
    expect((window as any).forge.chatResolve).not.toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'modify' }),
    )
  })

  it('does not render an inspector 待你处理 / .pp-act section', () => {
    const { container } = render(<WorkspaceView engine={engine} providers={providers} />)
    expect(screen.queryByText('待你处理')).toBeNull()
    expect(container.querySelector('.pp-act')).toBeNull()
    // the request cards live in the chat stream, never in the inspector pane
    expect(container.querySelector('#pane-agents .msg-req')).toBeNull()
  })

  it('stage-gate 打回重做… seeds the composer with a quote marker + banner, and the next send routes to the orchestrator resolve (modify), not chat.send (Task 16)', async () => {
    const { container } = render(<WorkspaceView engine={gateEngine} providers={providers} />)
    await waitFor(() => expect(container.querySelector('.chat-inner .msg-req.k-confirm')).toBeTruthy())

    expect(container.querySelector('.supplement-banner')).toBeNull()
    fireEvent.click(screen.getByText('打回重做…'))

    await waitFor(() => expect(container.querySelector('.supplement-banner')).toBeTruthy())
    expect(container.querySelector('.supplement-banner')?.textContent).toContain('补充中：针对【技术方案设计】')
    const ta = container.querySelector('#composerInput') as HTMLTextAreaElement
    await waitFor(() => expect(ta.value).toContain('针对【技术方案·技术方案设计】补充'))

    fireEvent.change(ta, { target: { value: ta.value + '鉴权边界要再探一遍' } })
    fireEvent.click(container.querySelector('#sendBtn') as HTMLButtonElement)
    await waitFor(() => expect(gateResolve).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pg', decision: 'modify', value: expect.stringContaining('鉴权边界要再探一遍') }),
    ))
    expect((window as any).forge.sendChat).not.toHaveBeenCalled()
    expect((window as any).forge.chatResolve).not.toHaveBeenCalled()

    // Banner clears after send
    await waitFor(() => expect(container.querySelector('.supplement-banner')).toBeNull())
  })

  it('允许 on the stage-gate this supplement targets clears the banner too', async () => {
    const { container } = render(<WorkspaceView engine={gateEngine} providers={providers} />)
    await waitFor(() => expect(container.querySelector('.chat-inner .msg-req.k-confirm')).toBeTruthy())
    fireEvent.click(screen.getByText('打回重做…'))
    await waitFor(() => expect(container.querySelector('.supplement-banner')).toBeTruthy())

    fireEvent.click(screen.getByText('允许并继续'))
    expect(gateResolve).toHaveBeenCalledWith({ id: 'pg', decision: 'allow' })
    expect(container.querySelector('.supplement-banner')).toBeNull()
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
