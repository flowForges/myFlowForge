import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { WorkspaceView } from './WorkspaceView'
import type { EngineApi } from '../state/useEngine'
import type { ProviderInfo } from '@shared/types'

const providers: ProviderInfo[] = [
  { id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8' }] }
]

const wsWithStages = {
  name: 'ws', path: '/ws', workflowId: 'standard', status: 'idle',
  stages: [
    { key: 'requirement', provider: 'claude', model: 'opus-4.8' },
    { key: 'develop', provider: 'claude', model: 'opus-4.8' },
  ],
  projects: [{ repoId: 'r1', name: 'web', branch: 'feat/cool', provider: 'claude', model: 'opus-4.8' }],
}

const getWorkspaceMock = vi.fn(async () => wsWithStages)
const runWorkspaceMock = vi.fn(async () => {})
const sendChatMock = vi.fn(async () => ({}))
let emitChat: (e: any) => void = () => {}

const forgeBase = {
  chatHistory: async () => [], sendChat: sendChatMock, openFiles: async () => [], savePaste: vi.fn(),
  onChatEvent: (cb: any) => { emitChat = cb; return () => {} }, onChatQueueEvent: () => () => {},
  sessionList: async () => ({ sessions: [{ id: 's-1', title: '新会话', mode: 'chat', createdAt: 0 }], activeSessionId: 's-1' }),
  sessionSwitch: vi.fn(), sessionNew: vi.fn(), sessionClose: vi.fn(), sessionRename: vi.fn(),
  watchChanges: async () => [], watchStop: async () => {}, fsTree: async () => [],
  gitDiff: async () => [], gitFile: async () => ({ text: '', lang: 'ts' }),
  onChangesEvent: () => () => {},
  lastRun: async () => null,
  getWorkspace: getWorkspaceMock,
  runWorkspace: runWorkspaceMock,
}

beforeEach(() => {
  getWorkspaceMock.mockClear()
  runWorkspaceMock.mockClear()
  sendChatMock.mockClear()
  ;(window as any).forge = { ...forgeBase }
  ;(window as any).confirm = vi.fn(() => true)
})

// No live run → chat mode
const idleEngine: EngineApi = { run: null, pending: [], resolve: () => {}, cancel: () => {} }

// Live run for /ws → workflow mode
const liveEngine: EngineApi = {
  run: { id: 'r', workspaceName: 'ws', workspacePath: '/ws', status: 'run', projects: [], stages: [], pending: [] },
  pending: [], resolve: () => {}, cancel: () => {}
}

describe('WorkspaceView 对话模式/工作流模式 inspector', () => {
  it('shows chat mode (inspector.chat class + 对话模式 text) when no run is live; 发起工作流 button is GONE', async () => {
    const { container } = render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    const aside = container.querySelector('aside.inspector')!
    expect(aside).toBeTruthy()
    await waitFor(() => expect(aside.classList.contains('chat')).toBe(true))
    expect(screen.getByText('当前工作流')).toBeInTheDocument()
    expect(screen.queryByText('发起工作流')).toBeNull()
  })

  it('shows workflow mode (no chat class) when a run is live for this workspace', async () => {
    const { container } = render(<WorkspaceView engine={liveEngine} providers={providers} workspacePath="/ws" />)
    const aside = container.querySelector('aside.inspector')!
    expect(aside).toBeTruthy()
    expect(aside.classList.contains('chat')).toBe(false)
    // Inspector tabs (workflow mode) should be visible
    expect(screen.getByText('代理')).toBeInTheDocument()
  })

  it('does not show the removed workflow-conversion card in chat mode', async () => {
    const { container } = render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(screen.getByText('当前工作流')).toBeInTheDocument())
    // The old manual "把这次对话转为工作流" conversion card is gone.
    expect(screen.queryByText('把这次对话转为工作流')).toBeNull()
    // Stage names now appear (read-only) in the new 当前工作流 overview CTA's .ic-stages.
    const stages = container.querySelector('.ic-cta .ic-stages')!
    expect(stages).toHaveTextContent('需求评估')
    expect(stages).toHaveTextContent('代码开发')
  })

  it('displays session info (branch, path) from workspace config in chat mode', async () => {
    render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(screen.getByText('feat/cool')).toBeInTheDocument())
    expect(screen.getByText('/ws')).toBeInTheDocument()
  })

  it('shows loaded skills and rules in the right chat inspector, not inline under the LLM message', async () => {
    const { container } = render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(screen.getByText('当前工作流')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('新会话')).toBeInTheDocument())
    act(() => {
      emitChat({
        workspacePath: '/ws',
        sessionId: 's-1',
        type: 'assistant-start',
        id: 'a1',
        model: 'Claude Code · opus-4.8',
        context: {
          skills: [{ name: 'conversation', path: '内置对话能力' }],
          rules: [{ name: 'Project interaction rule', path: 'project memory' }],
        },
      })
    })

    const inspector = container.querySelector('#mainChat')!
    expect(inspector).toHaveTextContent('已加载 SKILL / RULE / MCP')
    expect(inspector).toHaveTextContent('conversation')
    expect(inspector).toHaveTextContent('Project interaction rule')
    const chat = container.querySelector('.chat')!
    expect(chat.querySelector('.ctx-stack')).toBeNull()
  })

  it('forceChat resets to false when a run becomes live (workflow mode auto-activates on run)', async () => {
    // Start with idle (chat mode), then simulate a run becoming live for this ws
    const idleE: EngineApi = { run: null, pending: [], resolve: () => {}, cancel: () => {} }
    const { container, rerender } = render(<WorkspaceView engine={idleE} providers={providers} workspacePath="/ws" />)
    const aside = container.querySelector('aside.inspector')!
    await waitFor(() => expect(aside.classList.contains('chat')).toBe(true))

    // Simulate run becoming live
    act(() => {
      rerender(<WorkspaceView engine={liveEngine} providers={providers} workspacePath="/ws" />)
    })
    await waitFor(() => expect(aside.classList.contains('chat')).toBe(false))
  })

  it('mode-changed=workflow event switches inspector from chat to workflow view', async () => {
    const live: EngineApi = { run: { id: 'r', workspaceName: 'ws', workspacePath: '/ws', status: 'run', projects: [], stages: [], pending: [] } as any, pending: [], resolve: () => {}, cancel: () => {} }
    const { container, rerender } = render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    const aside = container.querySelector('aside.inspector')!
    await waitFor(() => expect(aside.classList.contains('chat')).toBe(true))
    act(() => { rerender(<WorkspaceView engine={live} providers={providers} workspacePath="/ws" />) })
    act(() => { emitChat({ workspacePath: '/ws', sessionId: 's-1', type: 'mode-changed', mode: 'workflow', runId: 'r' }) })
    await waitFor(() => expect(aside.classList.contains('chat')).toBe(false))
  })

  it('shows a right-inspector workflow pending card while a proposed workflow waits for approval', async () => {
    const { container } = render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(screen.getByText('当前工作流')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('新会话')).toBeInTheDocument())

    act(() => {
      emitChat({
        workspacePath: '/ws',
        sessionId: 's-1',
        type: 'plan-request', allProjects: [],
        id: 'pl-1',
        approach: '先评估需求,再开发',
        stages: [{ name: '需求评估', agents: 1 }, { name: '代码开发', agents: 2 }],
        task: '按工作流实现登录',
      })
    })

    const inspector = container.querySelector('#mainChat')!
    expect(inspector).toHaveTextContent('工作流待确认')
    expect(inspector).toHaveTextContent('需求评估')
    expect(inspector).toHaveTextContent('代码开发')
  })

  it('scrolls the chat to the bottom when a plan approval card appears', async () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => { cb(0); return 1 })
    const { container } = render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(screen.getByText('新会话')).toBeInTheDocument())
    const scroller = container.querySelector('.chat-scroll') as HTMLDivElement
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 2400 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 600 })
    scroller.scrollTop = 0

    act(() => {
      emitChat({
        workspacePath: '/ws',
        sessionId: 's-1',
        type: 'plan-request', allProjects: [],
        id: 'pl-scroll',
        approach: '执行方案',
        stages: [{ name: '设计', agents: 1 }],
      })
    })

    expect(scroller.scrollTop).toBe(2400)
    raf.mockRestore()
  })

  it('clicking a 快捷指令 chip seeds the composer textarea with the prompt', async () => {
    render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(screen.getByText('当前工作流')).toBeInTheDocument())
    fireEvent.click(screen.getByText('梳理仓库架构'))
    const ta = document.querySelector('#composerInput') as HTMLTextAreaElement
    await waitFor(() => expect(ta.value).toBe('梳理这个仓库的整体架构,画出模块依赖关系'))
  })

  it('clicking 编辑工作流 calls onEditWorkspace', async () => {
    const onEditWorkspace = vi.fn()
    render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" onEditWorkspace={onEditWorkspace} />)
    await waitFor(() => expect(screen.getByText('当前工作流')).toBeInTheDocument())
    fireEvent.click(screen.getByText('编辑工作流'))
    expect(onEditWorkspace).toHaveBeenCalledTimes(1)
  })

  it('本次对话引用 shows the empty state when no message references a file', async () => {
    const { container } = render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(screen.getByText('当前工作流')).toBeInTheDocument())
    const inspector = container.querySelector('#mainChat')!
    expect(inspector).toHaveTextContent('暂无引用文件')
    expect(inspector.querySelector('.ic-ref')).toBeNull()
  })

  it('本次对话引用 lists the unique attached files across the session messages', async () => {
    ;(window as any).forge = {
      ...forgeBase,
      chatHistory: async () => [
        { id: 'u1', who: 'user', text: 'look', ts: '00:00', files: [
          { name: 'app.ts', path: '/ws/app.ts', size: 10 },
          { name: 'style.css', path: '/ws/style.css', size: 20 },
        ] },
        { id: 'a1', who: 'ai', text: 'ok', ts: '00:01' },
        // duplicate (same path+name) must be deduped
        { id: 'u2', who: 'user', text: 'again', ts: '00:02', files: [
          { name: 'app.ts', path: '/ws/app.ts', size: 10 },
          { name: 'readme.md', path: '/ws/readme.md', size: 30 },
        ] },
      ],
    }
    const { container } = render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(screen.getByText('当前工作流')).toBeInTheDocument())
    const inspector = container.querySelector('#mainChat')!
    await waitFor(() => expect(inspector.querySelectorAll('.ic-ref').length).toBe(3))
    expect(inspector).toHaveTextContent('app.ts')
    expect(inspector).toHaveTextContent('style.css')
    expect(inspector).toHaveTextContent('readme.md')
    expect(inspector).not.toHaveTextContent('暂无引用文件')
  })

  // 「上下文用量」卡片已移除:该数字是本地近似值(逐轮 usage token ÷ 硬编码窗口),取不到 CLI session
  // 的真实剩余上下文,展示不准,故不再显示,相关渲染测试一并删除。
})
