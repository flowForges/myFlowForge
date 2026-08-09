import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useChat } from './useChat'
import type { ChatEvent, ChatGateSnapshot, ChatMessage } from '@shared/types'

interface QueueEvent { workspacePath: string; busy: boolean; queue: { id: string; text: string; source: string; sessionId: string }[]; running: { id: string; text: string; sessionId: string } | null; runningTurns: { id: string; text: string; sessionId: string }[]; runningSessionId: string | null; runningSessionIds: string[] }
let handler: ((e: ChatEvent) => void) | null = null
let queueHandler: ((e: QueueEvent) => void) | null = null
const history: ChatMessage[] = [{ id: 'h1', who: 'user', text: 'old', ts: '0' }]
let queueSnapshot: QueueEvent = { workspacePath: '/ws', busy: false, queue: [], running: null, runningTurns: [], runningSessionId: null, runningSessionIds: [] }
let gateSnapshot: ChatGateSnapshot = { confirms: [], asks: [] }

beforeEach(() => {
  handler = null
  queueHandler = null
  queueSnapshot = { workspacePath: '/ws', busy: false, queue: [], running: null, runningTurns: [], runningSessionId: null, runningSessionIds: [] }
  gateSnapshot = { confirms: [], asks: [] }
  ;(window as any).forge = {
    chatHistory: vi.fn(async () => history),
    chatQueueState: vi.fn(async () => queueSnapshot),
    chatGateState: vi.fn(async () => gateSnapshot),
    sendChat: vi.fn(async () => ({})),
    onChatEvent: (cb: (e: ChatEvent) => void) => { handler = cb; return () => { handler = null } },
    onChatQueueEvent: (cb: (e: QueueEvent) => void) => { queueHandler = cb; return () => { queueHandler = null } },
    chatCancelQueued: vi.fn(async () => ({})),
    chatClearQueue: vi.fn(async () => ({})),
    chatStop: vi.fn(async () => ({}))
  }
})

describe('useChat', () => {
  it('loads history for the workspace, then assembles a streamed assistant reply', async () => {
    const { result } = renderHook(() => useChat('/ws', 's1'))
    await waitFor(() => expect(result.current.messages).toHaveLength(1))
    expect(result.current.messages[0].text).toBe('old')

    act(() => { handler!({ workspacePath: '/ws', sessionId: 's1', type: 'user', message: { id: 'u1', who: 'user', text: 'hi', ts: '1' } }) })
    act(() => { handler!({ workspacePath: '/ws', sessionId: 's1', type: 'assistant-start', id: 'a1', model: 'Claude Code · opus-4.8' }) })
    act(() => { handler!({ workspacePath: '/ws', sessionId: 's1', type: 'think-delta', id: 'a1', text: 'pondering' }) })
    act(() => { handler!({ workspacePath: '/ws', sessionId: 's1', type: 'assistant-delta', id: 'a1', text: 'Hel' }) })
    act(() => { handler!({ workspacePath: '/ws', sessionId: 's1', type: 'assistant-delta', id: 'a1', text: 'lo' }) })

    await waitFor(() => expect(result.current.messages.find(m => m.id === 'a1')?.text).toBe('Hello'))
    expect(result.current.streamingIds.has('a1')).toBe(true)

    act(() => { handler!({ workspacePath: '/ws', sessionId: 's1', type: 'done', message: { id: 'a1', who: 'ai', text: 'Hello', model: 'Claude Code · opus-4.8', ts: '2', think: { label: '已思考', steps: ['pondering'] } } }) })
    await waitFor(() => expect(result.current.streamingIds.size).toBe(0))
    expect(result.current.messages.map(m => m.id)).toEqual(['h1', 'u1', 'a1'])
  })

  it('joins a turn mid-flight: assembles delta/done even when assistant-start was missed', async () => {
    // The chat view mounted AFTER the turn began (e.g. a pet command sent while on the home view), so it
    // never saw assistant-start. delta/think/done must still create + fill the reply, not silently drop it.
    const { result } = renderHook(() => useChat('/ws', 's1'))
    await waitFor(() => expect(result.current.messages).toHaveLength(1))
    act(() => { handler!({ workspacePath: '/ws', sessionId: 's1', type: 'think-delta', id: 'a9', text: '分析中' }) })
    act(() => { handler!({ workspacePath: '/ws', sessionId: 's1', type: 'assistant-delta', id: 'a9', text: '结果' }) })
    expect(result.current.messages.find(m => m.id === 'a9')?.text).toBe('结果')
    expect(result.current.streamingIds.has('a9')).toBe(true)
    act(() => { handler!({ workspacePath: '/ws', sessionId: 's1', type: 'done', message: { id: 'a9', who: 'ai', text: '最终结果', model: 'Claude Code · opus-4.8', ts: '2' } }) })
    await waitFor(() => expect(result.current.streamingIds.size).toBe(0))
    expect(result.current.messages.find(m => m.id === 'a9')?.text).toBe('最终结果')
  })

  it('appends a done message arrived without any prior event (turn finished before the view opened mid-tick)', () => {
    const { result } = renderHook(() => useChat('/ws', 's1'))
    act(() => { handler!({ workspacePath: '/ws', sessionId: 's1', type: 'done', message: { id: 'z1', who: 'ai', text: '只有结果', model: 'm', ts: '2' } }) })
    expect(result.current.messages.some(m => m.id === 'z1')).toBe(true)
  })

  it('renders an error message in place of the streaming placeholder on error', async () => {
    const { result } = renderHook(() => useChat('/ws', 's1'))
    await waitFor(() => expect(result.current.messages.length).toBeGreaterThanOrEqual(0))
    act(() => { handler!({ workspacePath: '/ws', sessionId: 's1', type: 'assistant-start', id: 'a1', model: 'Claude Code · opus-4.8' }) })
    act(() => { handler!({ workspacePath: '/ws', sessionId: 's1', type: 'error', id: 'a1', error: 'boom' }) })
    await waitFor(() => expect(result.current.streamingIds.size).toBe(0))
    const m = result.current.messages.find(x => x.id === 'a1')!
    expect(m.text).toContain('错误: boom')
    expect(m.think).toBeUndefined()
  })

  it('tracks multiple concurrently-streaming ids independently', () => {
    const { result } = renderHook(() => useChat('/ws', 's1'))
    act(() => { handler!({ workspacePath: '/ws', sessionId: 's1', type: 'assistant-start', id: 'a1', model: 'Claude Code · opus-4.8' }) })
    act(() => { handler!({ workspacePath: '/ws', sessionId: 's1', type: 'assistant-start', id: 'b1', model: 'Claude Code · opus-4.8' }) })
    expect(result.current.streamingIds.has('a1')).toBe(true)
    expect(result.current.streamingIds.has('b1')).toBe(true)
    act(() => { handler!({ workspacePath: '/ws', sessionId: 's1', type: 'done', message: { id: 'a1', who: 'ai', text: '...', model: 'Claude Code · opus-4.8', ts: '2' } }) })
    expect(result.current.streamingIds.has('a1')).toBe(false)
    expect(result.current.streamingIds.has('b1')).toBe(true)
  })

  it('ignores events for a different workspace, applies events for the current workspace', async () => {
    const { result } = renderHook(() => useChat('/ws', 's1'))
    await waitFor(() => expect(result.current.messages).toHaveLength(1))

    // Event for a different workspace — must be silently ignored
    act(() => { handler!({ workspacePath: '/other', sessionId: 's1', type: 'user', message: { id: 'u-other', who: 'user', text: 'leak!', ts: '1' } }) })
    act(() => { handler!({ workspacePath: '/other', sessionId: 's1', type: 'assistant-start', id: 'a-other', model: 'Claude Code · opus-4.8' }) })
    expect(result.current.messages).toHaveLength(1)
    expect(result.current.streamingIds.size).toBe(0)

    // Event for the correct workspace — must still apply normally
    act(() => { handler!({ workspacePath: '/ws', sessionId: 's1', type: 'user', message: { id: 'u1', who: 'user', text: 'hello', ts: '2' } }) })
    expect(result.current.messages).toHaveLength(2)
    expect(result.current.messages[1].id).toBe('u1')
  })

  it('keeps applying events after the active workspace changes (no stale closure)', async () => {
    const { result, rerender } = renderHook(
      ({ ws }: { ws: string | undefined }) => useChat(ws, 's1'),
      { initialProps: { ws: '/ws1' as string | undefined } }
    )
    await waitFor(() => expect(result.current.messages).toHaveLength(1))

    // Switch to a different workspace; history reloads for the new path.
    rerender({ ws: '/ws2' })
    await waitFor(() => expect((window as any).forge.chatHistory).toHaveBeenCalledWith('/ws2', 's1'))

    // A live event for the NEW workspace must apply — not be dropped by a stale closure.
    act(() => { handler!({ workspacePath: '/ws2', sessionId: 's1', type: 'user', message: { id: 'u2', who: 'user', text: 'hi2', ts: '1' } }) })
    expect(result.current.messages.some(m => m.id === 'u2')).toBe(true)

    // And events for the OLD workspace must now be ignored.
    act(() => { handler!({ workspacePath: '/ws1', sessionId: 's1', type: 'user', message: { id: 'u-old', who: 'user', text: 'stale', ts: '2' } }) })
    expect(result.current.messages.some(m => m.id === 'u-old')).toBe(false)
  })

  it('clears old messages immediately when the active session changes', async () => {
    let resolveHistory: (messages: ChatMessage[]) => void = () => {}
    ;(window as any).forge.chatHistory = vi.fn((_ws: string, sid: string) => {
      if (sid === 's1') return Promise.resolve([{ id: 'old', who: 'user', text: '旧会话内容', ts: '0' }])
      return new Promise<ChatMessage[]>(resolve => { resolveHistory = resolve })
    })
    const { result, rerender } = renderHook(
      ({ sid }: { sid: string }) => useChat('/ws', sid),
      { initialProps: { sid: 's1' } }
    )
    await waitFor(() => expect(result.current.messages.map(m => m.id)).toEqual(['old']))

    rerender({ sid: 's2' })
    expect(result.current.messages).toEqual([])

    await act(async () => { resolveHistory([]) })
    expect(result.current.messages).toEqual([])
  })

  it('starts with busy=false and an empty queue', () => {
    const { result } = renderHook(() => useChat('/ws', 's1'))
    expect(result.current.busy).toBe(false)
    expect(result.current.queue).toEqual([])
  })

  it('applies a queue event for the active workspace, ignores one for a different workspace', async () => {
    const { result } = renderHook(() => useChat('/ws', 's1'))
    await waitFor(() => expect(queueHandler).not.toBeNull())

    // Event for a different workspace — ignored
    act(() => { queueHandler!({ workspacePath: '/other', busy: true, queue: [{ id: 'x', text: 'leak', source: '你', sessionId: 's1' }], running: null, runningTurns: [], runningSessionId: 's1', runningSessionIds: ['s1'] }) })
    expect(result.current.busy).toBe(false)
    expect(result.current.queue).toEqual([])

    // Event for the active workspace — applied
    act(() => { queueHandler!({ workspacePath: '/ws', busy: true, queue: [{ id: 'q1', text: 'task one', source: '你', sessionId: 's1' }], running: null, runningTurns: [{ id: 'r0', text: 'running', sessionId: 's1' }], runningSessionId: 's1', runningSessionIds: ['s1'] }) })
    expect(result.current.busy).toBe(true)
    expect(result.current.queue).toEqual([{ id: 'q1', text: 'task one', source: '你' }])
  })

  it('re-seeds the queue from the main-side snapshot on mount (switch away and back keeps queued items)', async () => {
    // The queue event only fires when the queue CHANGES, so on switch-back the view must pull the
    // current snapshot — otherwise a message queued behind a running turn silently disappears.
    queueSnapshot = {
      workspacePath: '/ws', busy: true,
      queue: [{ id: 'q9', text: '排队的指令', source: '你', sessionId: 's1' }],
      running: { id: 'r9', text: '正在跑', sessionId: 's1' },
      runningTurns: [{ id: 'r9', text: '正在跑', sessionId: 's1' }],
      runningSessionId: 's1', runningSessionIds: ['s1'],
    }
    const { result } = renderHook(() => useChat('/ws', 's1'))
    await waitFor(() => expect(result.current.queue).toEqual([{ id: 'q9', text: '排队的指令', source: '你' }]))
    expect(result.current.busy).toBe(true)
    expect(result.current.running).toEqual({ id: 'r9', text: '正在跑' })
  })

  it('resets busy/queue when the active workspace changes', async () => {
    const { result, rerender } = renderHook(
      ({ ws }: { ws: string | undefined }) => useChat(ws, 's1'),
      { initialProps: { ws: '/ws1' as string | undefined } }
    )
    await waitFor(() => expect(queueHandler).not.toBeNull())
    act(() => { queueHandler!({ workspacePath: '/ws1', busy: true, queue: [{ id: 'q1', text: 't', source: '你', sessionId: 's1' }], running: null, runningTurns: [{ id: 'r0', text: 't0', sessionId: 's1' }], runningSessionId: 's1', runningSessionIds: ['s1'] }) })
    expect(result.current.busy).toBe(true)

    rerender({ ws: '/ws2' })
    expect(result.current.busy).toBe(false)
    expect(result.current.queue).toEqual([])
  })

  it('sets running from queue event and clears it when running is null', async () => {
    const { result } = renderHook(() => useChat('/ws', 's1'))
    await waitFor(() => expect(queueHandler).not.toBeNull())

    // running item arrives
    act(() => { queueHandler!({ workspacePath: '/ws', busy: true, queue: [], running: { id: 'r1', text: '跑着的', sessionId: 's1' }, runningTurns: [{ id: 'r1', text: '跑着的', sessionId: 's1' }], runningSessionId: 's1', runningSessionIds: ['s1'] }) })
    expect(result.current.running).toEqual({ id: 'r1', text: '跑着的' })

    // busy ends, running clears
    act(() => { queueHandler!({ workspacePath: '/ws', busy: false, queue: [], running: null, runningTurns: [], runningSessionId: null, runningSessionIds: [] }) })
    expect(result.current.running).toBeNull()
  })

  it('resets running to null when workspace changes', async () => {
    const { result, rerender } = renderHook(
      ({ ws }: { ws: string | undefined }) => useChat(ws, 's1'),
      { initialProps: { ws: '/ws1' as string | undefined } }
    )
    await waitFor(() => expect(queueHandler).not.toBeNull())
    act(() => { queueHandler!({ workspacePath: '/ws1', busy: true, queue: [], running: { id: 'r1', text: '跑着的', sessionId: 's1' }, runningTurns: [{ id: 'r1', text: '跑着的', sessionId: 's1' }], runningSessionId: 's1', runningSessionIds: ['s1'] }) })
    expect(result.current.running).toEqual({ id: 'r1', text: '跑着的' })

    rerender({ ws: '/ws2' })
    expect(result.current.running).toBeNull()
  })

  it('stop() calls chatStop with the current workspacePath + sessionId (scoped to the active session)', async () => {
    const { result } = renderHook(() => useChat('/ws', 's1'))
    await waitFor(() => expect(queueHandler).not.toBeNull())
    act(() => { result.current.stop() })
    expect((window as any).forge.chatStop).toHaveBeenCalledWith({ workspacePath: '/ws', sessionId: 's1' })
  })

  it('scopes busy/queue/running to THIS session — idle session sees nothing of another running session', async () => {
    // Session s2 is running (with a queued s2 item); s1 is idle. The workspace-wide event carries both
    // lanes, but each session view must only reflect its own.
    const evt: QueueEvent = {
      workspacePath: '/ws',
      busy: true,
      queue: [{ id: 'q2', text: 's2 queued', source: '你', sessionId: 's2' }],
      running: { id: 'r2', text: 's2 running', sessionId: 's2' },
      runningTurns: [{ id: 'r2', text: 's2 running', sessionId: 's2' }],
      runningSessionId: 's2',
      runningSessionIds: ['s2'],
    }

    // idle session s1
    const s1 = renderHook(() => useChat('/ws', 's1'))
    await waitFor(() => expect(queueHandler).not.toBeNull())
    act(() => { queueHandler!(evt) })
    expect(s1.result.current.busy).toBe(false)
    expect(s1.result.current.queue).toEqual([])
    expect(s1.result.current.running).toBeNull()
    s1.unmount()

    // running session s2
    const s2 = renderHook(() => useChat('/ws', 's2'))
    await waitFor(() => expect(queueHandler).not.toBeNull())
    act(() => { queueHandler!(evt) })
    expect(s2.result.current.busy).toBe(true)
    expect(s2.result.current.queue).toEqual([{ id: 'q2', text: 's2 queued', source: '你' }])
    expect(s2.result.current.running).toEqual({ id: 'r2', text: 's2 running' })
  })

  it('cancelQueued and clearQueue call the bridge with the workspace path', async () => {
    const { result } = renderHook(() => useChat('/ws', 's1'))
    await waitFor(() => expect(queueHandler).not.toBeNull())
    act(() => { result.current.cancelQueued('q1') })
    expect((window as any).forge.chatCancelQueued).toHaveBeenCalledWith({ workspacePath: '/ws', id: 'q1' })
    act(() => { result.current.clearQueue() })
    expect((window as any).forge.chatClearQueue).toHaveBeenCalledWith({ workspacePath: '/ws' })
  })
})

// ★真机 bug:侧栏和宠物一直喊「待确认」,聊天里却没有卡片,那一轮永远挂着。
// 门是主进程的 Promise(一直阻塞 provider),卡片只是 useChat 的 state —— 切会话/离开再回来会清空 state,
// 门却还在。当初给队列补了 chatQueueState 重新播种,门被漏掉了。
describe('useChat — 重新挂载时把主进程还挂着的门拉回来', () => {
  it('挂载时从 chatGateState 重建本会话的确认卡', async () => {
    gateSnapshot = { confirms: [{ id: 'cc-7', sessionId: 's1', title: 'Bash 请求执行', where: 'git status', ts: '2026-08-09T05:09:21.477Z' }], asks: [] }
    const { result } = renderHook(() => useChat('/ws', 's1'))
    await waitFor(() => expect(result.current.confirms).toHaveLength(1))
    expect(result.current.confirms[0]).toMatchObject({ id: 'cc-7', title: 'Bash 请求执行', where: 'git status' })
    // ts 必须是门【原本】的时间,卡片才会落回时间线里它原来的位置
    expect(result.current.confirms[0].ts).toBe('2026-08-09T05:09:21.477Z')
  })

  it('只重建本会话的门,别的会话的不串过来', async () => {
    gateSnapshot = { confirms: [{ id: 'cc-1', sessionId: 'other', title: '别的会话', ts: 't' }], asks: [{ id: 'ca-1', sessionId: 'other', title: '别的提问', ts: 't' }] }
    const { result } = renderHook(() => useChat('/ws', 's1'))
    await waitFor(() => expect(result.current.messages).toHaveLength(1))
    expect(result.current.confirms).toHaveLength(0)
    expect(result.current.asks).toHaveLength(0)
  })

  it('提问门(ask)同样能重建,选项和发起者都带回来', async () => {
    gateSnapshot = { confirms: [], asks: [{ id: 'ca-3', sessionId: 's1', title: '选哪个?', options: [{ t: 'A', d: '甲' }], agentName: '子代理', ts: 't3' }] }
    const { result } = renderHook(() => useChat('/ws', 's1'))
    await waitFor(() => expect(result.current.asks).toHaveLength(1))
    expect(result.current.asks[0]).toMatchObject({ id: 'ca-3', title: '选哪个?', agentName: '子代理' })
    expect(result.current.asks[0].options).toEqual([{ t: 'A', d: '甲' }])
  })

  it('快照与 live 事件撞车时不画出两张卡(按 id 去重)', async () => {
    gateSnapshot = { confirms: [{ id: 'cc-9', sessionId: 's1', title: '同一个门', ts: 't' }], asks: [] }
    const { result } = renderHook(() => useChat('/ws', 's1'))
    await waitFor(() => expect(result.current.confirms).toHaveLength(1))
    act(() => { handler!({ workspacePath: '/ws', sessionId: 's1', type: 'confirm-request', id: 'cc-9', title: '同一个门' }) })
    expect(result.current.confirms.filter(c => c.id === 'cc-9')).toHaveLength(1)
  })

  it('换会话时清掉上一个会话的提问卡(asks 之前漏在重置之外)', async () => {
    const { result, rerender } = renderHook(({ sid }: { sid: string }) => useChat('/ws', sid), { initialProps: { sid: 's1' } })
    await waitFor(() => expect(result.current.messages).toHaveLength(1))
    act(() => { handler!({ workspacePath: '/ws', sessionId: 's1', type: 'ask-request', id: 'ca-8', title: '留在 s1 的提问' }) })
    expect(result.current.asks).toHaveLength(1)
    rerender({ sid: 's2' })
    await waitFor(() => expect(result.current.asks).toHaveLength(0))
  })

  it('拿不到快照时不影响聊天视图(live 事件照常)', async () => {
    ;(window as any).forge.chatGateState = vi.fn(async () => { throw new Error('boom') })
    const { result } = renderHook(() => useChat('/ws', 's1'))
    await waitFor(() => expect(result.current.messages).toHaveLength(1))
    act(() => { handler!({ workspacePath: '/ws', sessionId: 's1', type: 'confirm-request', id: 'cc-live', title: '仍然可用' }) })
    expect(result.current.confirms).toHaveLength(1)
  })
})
