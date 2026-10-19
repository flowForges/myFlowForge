import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, within, act } from '@testing-library/react'
import type { EngineApi } from '../state/useEngine'
import type { ProviderInfo, SessionsFile, ChatMessage, ChatEvent } from '@shared/types'

// 渲染计数:Message 每渲染一次,它里面的 Markdown 就被调用一次。用一个不 memo 的替身数次数。
const mdRenders = new Map<string, number>()
vi.mock('./chat/markdown', () => ({
  Markdown: ({ text }: { text: string }) => {
    mdRenders.set(text, (mdRenders.get(text) ?? 0) + 1)
    return <div>{text}</div>
  },
}))

import { WorkspaceView } from './WorkspaceView'

const providers: ProviderInfo[] = [{ id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8' }] }]
const engine: EngineApi = { run: undefined, pending: [], resolve: vi.fn(), cancel: vi.fn() } as any
const history: ChatMessage[] = [
  { id: 'u1', who: 'user', text: '问题', ts: new Date(1_700_000_000_000).toISOString() },
  { id: 'a1', who: 'ai', text: '已经答完的回答', ts: new Date(1_700_000_001_000).toISOString() },
] as ChatMessage[]
const file: SessionsFile = { sessions: [{ id: 's1', title: '会话', mode: 'chat', createdAt: 0 }], activeSessionId: 's1' }
let emit: (e: ChatEvent) => void = () => {}

beforeEach(() => {
  mdRenders.clear()
  ;(window as any).forge = {
    sessionList: vi.fn(async () => file),
    sessionSwitch: vi.fn(async () => file),
    sessionNew: vi.fn(async () => file),
    sessionClose: vi.fn(async () => file),
    sessionRename: vi.fn(async () => file),
    chatHistory: vi.fn(async () => history),
    chatToolOutput: vi.fn(async () => ({ output: '' })),
    sendChat: vi.fn(async () => ({})),
    onChatEvent: (cb: (e: ChatEvent) => void) => { emit = cb; return () => {} },
    onChatQueueEvent: () => () => {},
    chatCancelQueued: vi.fn(async () => ({})),
    chatClearQueue: vi.fn(async () => ({})),
    lastRun: vi.fn(async () => null),
    getWorkspace: vi.fn(async () => ({ projects: [{ branch: 'main' }], stages: [{ key: 'develop', provider: 'claude', model: 'opus-4.8' }] })),
    changesMulti: vi.fn(async () => ({ total: 0, add: 0, del: 0, byProject: [] })),
    watchChanges: vi.fn(async () => []),
    watchStop: vi.fn(async () => undefined),
    fsTree: vi.fn(async () => []),
    onChangesEvent: vi.fn(() => () => {}),
    savePaste: vi.fn(async () => ({})),
  }
})

describe('WorkspaceView — memo(Message) 真的生效', () => {
  it('★另一条消息在流式输出时,已经答完的那条不重渲染', async () => {
    const { container } = render(<WorkspaceView engine={engine} providers={providers} workspacePath="/ws" />)
    const inner = () => within(container.querySelector('.chat-inner') as HTMLElement)
    await waitFor(() => expect(inner().getByText('已经答完的回答')).toBeTruthy(), { timeout: 15_000 })
    const base = { workspacePath: '/ws', sessionId: 's1' }
    act(() => { emit({ ...base, type: 'assistant-start', id: 'a2' } as ChatEvent) })
    act(() => { emit({ ...base, type: 'assistant-delta', id: 'a2', text: '正在' } as ChatEvent) })
    await waitFor(() => expect(inner().getByText('正在')).toBeTruthy())
    const before = mdRenders.get('已经答完的回答')!
    act(() => { emit({ ...base, type: 'assistant-delta', id: 'a2', text: '写' } as ChatEvent) })
    act(() => { emit({ ...base, type: 'assistant-delta', id: 'a2', text: '回答' } as ChatEvent) })
    await waitFor(() => expect(inner().getByText('正在写回答')).toBeTruthy())
    expect(mdRenders.get('已经答完的回答')).toBe(before) // 修前:每个 delta 都会把它重画一遍
  }, 60_000)
})
