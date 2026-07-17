import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { WorkspaceView } from './WorkspaceView'
import type { EngineApi } from '../state/useEngine'
import type { ProviderInfo, ChatMessage, ChatQueueEvent } from '@shared/types'

const providers: ProviderInfo[] = [{ id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8' }] }]
const engine: EngineApi = {
  run: { id: 'r', workspaceName: 'ws', workspacePath: '/ws', status: 'run', projects: [], stages: [], pending: [] },
  pending: [], resolve: () => {}, cancel: () => {}
}
const sendChat = vi.fn(async (_payload: { workspacePath: string; text: string }) => ({}))
const chatCancelQueued = vi.fn(async () => ({}))
const chatClearQueue = vi.fn(async () => ({}))
const chatStop = vi.fn(async () => ({}))
let queueCb: ((e: ChatQueueEvent) => void) | null = null
beforeEach(() => {
  sendChat.mockClear(); chatCancelQueued.mockClear(); chatClearQueue.mockClear(); chatStop.mockClear(); queueCb = null
  ;(window as any).forge = {
    chatHistory: async () => [{ id: 'h1', who: 'user', text: '历史消息', ts: '0' } as ChatMessage],
    lastRun: async () => null,
    sendChat, openFiles: async () => [], savePaste: vi.fn(),
    onChatEvent: () => () => {},
    onChatQueueEvent: (cb: (e: ChatQueueEvent) => void) => { queueCb = cb; return () => { queueCb = null } },
    chatCancelQueued, chatClearQueue, chatStop,
    watchChanges: async () => [], watchStop: async () => {}, fsTree: async () => [],
    gitDiff: async () => [], gitFile: async () => ({ text: '', lang: 'ts' }),
    onChangesEvent: () => () => {},
    getWorkspace: async () => ({ name: 'ws', path: '/ws', workflowId: 'standard', stages: [], projects: [], status: 'run' }),
  }
})

describe('WorkspaceView chat', () => {
  it('renders chat history and sends a message with the workspace path', async () => {
    render(<WorkspaceView engine={engine} providers={providers} />)
    await waitFor(() => expect(screen.getByText('历史消息')).toBeInTheDocument())
    const ta = screen.getByPlaceholderText(/给主代理下达任务/)
    fireEvent.change(ta, { target: { value: 'hi' } })
    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(sendChat).toHaveBeenCalled())
    expect(sendChat.mock.calls[0][0].workspacePath).toBe('/ws')
    expect(sendChat.mock.calls[0][0].text).toBe('hi')
  })
})

describe('WorkspaceView chat-first-message run start', () => {
  // No live run for this workspace: a stashed pendingStartOpts means the first composer message
  // starts the run (seeded with the text) instead of going to chat.
  const idleEngine: EngineApi = { run: null, pending: [], resolve: () => {}, cancel: () => {} }

  it('starts the run with the message text and does NOT chat.send when pendingStartOpts is set and no live run', async () => {
    const onStartRun = vi.fn()
    render(
      <WorkspaceView
        engine={idleEngine}
        providers={providers}
        workspacePath="/ws"
        pendingStartOpts={{ workspacePath: '/ws', runId: 'r', stages: [], developProjects: [] } as any}
        onStartRun={onStartRun}
      />
    )
    const ta = screen.getByPlaceholderText(/给主代理下达任务/)
    fireEvent.change(ta, { target: { value: '给blog加评论系统' } })
    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(onStartRun).toHaveBeenCalled())
    expect(onStartRun.mock.calls[0][0].workspacePath).toBe('/ws')
    expect(onStartRun.mock.calls[0][1]).toBe('给blog加评论系统')
    expect(sendChat).not.toHaveBeenCalled()
  })

  it('falls through to chat.send when there is no pendingStartOpts', async () => {
    const onStartRun = vi.fn()
    render(<WorkspaceView engine={engine} providers={providers} workspacePath="/ws" onStartRun={onStartRun} />)
    const ta = screen.getByPlaceholderText(/给主代理下达任务/)
    fireEvent.change(ta, { target: { value: 'hi' } })
    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(sendChat).toHaveBeenCalled())
    expect(onStartRun).not.toHaveBeenCalled()
  })

  it('falls through to chat.send when a run is already live for this workspace (even if pendingStartOpts lingers)', async () => {
    const onStartRun = vi.fn()
    render(
      <WorkspaceView
        engine={engine}
        providers={providers}
        workspacePath="/ws"
        pendingStartOpts={{ workspacePath: '/ws', runId: 'r', stages: [], developProjects: [] } as any}
        onStartRun={onStartRun}
      />
    )
    const ta = screen.getByPlaceholderText(/给主代理下达任务/)
    fireEvent.change(ta, { target: { value: 'hi' } })
    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(sendChat).toHaveBeenCalled())
    expect(onStartRun).not.toHaveBeenCalled()
  })
})

describe('WorkspaceView task-queue panel', () => {
  async function emitQueue() {
    const { container } = render(<WorkspaceView engine={engine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(queueCb).toBeTypeOf('function'))
    act(() => queueCb!({
      workspacePath: '/ws',
      busy: true,
      queue: [
        { id: 'q1', text: '改主色调', source: '你' },
        { id: 'q2', text: '修复登录', source: '宠物' }
      ],
      running: null,
      runningSessionId: null
    }))
    return container
  }

  it('renders the .task-queue.show panel with a head + one .tq-item per queued instruction', async () => {
    const container = await emitQueue()
    await waitFor(() => expect(container.querySelector('.task-queue.show')).toBeInTheDocument())
    expect(container.querySelector('.tq-head')!.textContent).toContain('队列中 2 条指令')
    expect(container.querySelectorAll('.tq-item')).toHaveLength(2)
  })

  it('shows .tq-src only for a non-你 source (第二条 来自宠物)', async () => {
    const container = await emitQueue()
    await waitFor(() => expect(container.querySelectorAll('.tq-item')).toHaveLength(2))
    const items = container.querySelectorAll('.tq-item')
    expect(items[0].querySelector('.tq-src')).toBeNull()
    expect(items[1].querySelector('.tq-src')!.textContent).toBe('来自宠物')
  })

  it('clicking a .tq-x cancels that queued instruction by id', async () => {
    const container = await emitQueue()
    await waitFor(() => expect(container.querySelectorAll('.tq-item')).toHaveLength(2))
    fireEvent.click(container.querySelectorAll('.tq-x')[0])
    expect(chatCancelQueued).toHaveBeenCalledWith({ workspacePath: '/ws', id: 'q1' })
  })

  it('clicking 全部取消 clears the whole queue', async () => {
    const container = await emitQueue()
    await waitFor(() => expect(container.querySelector('.tq-clear')).toBeInTheDocument())
    fireEvent.click(container.querySelector('.tq-clear')!)
    expect(chatClearQueue).toHaveBeenCalledWith({ workspacePath: '/ws' })
  })

  it('renders no .task-queue when the queue is empty', async () => {
    const { container } = render(<WorkspaceView engine={engine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(queueCb).toBeTypeOf('function'))
    expect(container.querySelector('.task-queue')).toBeNull()
  })

  it('clicking .tq-x seeds the composer textarea with that item text AND calls chatCancelQueued', async () => {
    const container = await emitQueue()
    await waitFor(() => expect(container.querySelectorAll('.tq-item')).toHaveLength(2))
    fireEvent.click(container.querySelectorAll('.tq-x')[0])
    const ta = container.querySelector('textarea')!
    await waitFor(() => expect(ta.value).toBe('改主色调'))
    expect(chatCancelQueued).toHaveBeenCalledWith({ workspacePath: '/ws', id: 'q1' })
  })
})
