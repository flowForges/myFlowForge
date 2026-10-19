import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useChat } from './useChat'
import { ToolBlock } from '../views/chat/ToolBlock'
import { ToolOutputCtx } from '../views/chat/toolOutput'
import type { ChatEvent, ChatMessage, ToolActivity } from '@shared/types'

// Task 5:流式增量按动画帧合并 + 实时事件里的大段工具输出按历史同一阈值摘掉。

let handler: ((e: ChatEvent) => void) | null = null
let frames: FrameRequestCallback[] = []
let resolveHistory: (h: ChatMessage[]) => void = () => {}

const ev = (e: Record<string, unknown>) => handler!({ workspacePath: '/ws', sessionId: 's1', ...e } as ChatEvent)
const runFrame = () => act(() => { const fs = frames; frames = []; fs.forEach(f => f(0)) })

beforeEach(() => {
  handler = null
  frames = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  ;(window as any).forge = {
    chatHistory: vi.fn(() => new Promise<ChatMessage[]>(r => { resolveHistory = r })),
    chatQueueState: vi.fn(async () => ({ workspacePath: '/ws', queue: [], runningTurns: [], runningSessionIds: [] })),
    chatGateState: vi.fn(async () => ({ confirms: [], asks: [] })),
    onChatEvent: (cb: (e: ChatEvent) => void) => { handler = cb; return () => { handler = null } },
    onChatQueueEvent: () => () => {},
  }
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

async function mountLoaded(history: ChatMessage[] = []) {
  let renders = 0
  const hook = renderHook(() => { renders++; return useChat('/ws', 's1') })
  await act(async () => { resolveHistory(history) })
  return { ...hook, renders: () => renders }
}

describe('useChat — 流式增量按帧合并', () => {
  it('一帧里 50 个增量只触发一次状态更新,拼出来的正文一个字不差', async () => {
    const { result, renders } = await mountLoaded()
    act(() => { ev({ type: 'assistant-start', id: 'a1', model: 'm' }) })
    const before = renders()
    act(() => {
      for (let i = 0; i < 50; i++) ev({ type: 'assistant-delta', id: 'a1', text: `${i},` })
      for (let i = 0; i < 3; i++) ev({ type: 'think-delta', id: 'a1', text: `t${i}` })
    })
    expect(renders()).toBe(before) // 还在攒,没有重渲
    runFrame()
    expect(renders()).toBe(before + 1)
    const a1 = result.current.messages.find(m => m.id === 'a1')!
    expect(a1.text).toBe(Array.from({ length: 50 }, (_, i) => `${i},`).join(''))
    expect(a1.think?.steps).toEqual(['t0', 't1', 't2'])
  })

  it('★窗口隐藏(rAF 停了)时兜底计时器照样把增量落进 state', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 1) // 永不回调
    const { result } = await mountLoaded()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    act(() => { ev({ type: 'assistant-delta', id: 'a1', text: '藏着也要到' }) })
    expect(result.current.messages.find(m => m.id === 'a1')).toBeUndefined()
    act(() => { vi.advanceTimersByTime(100) })
    expect(result.current.messages.find(m => m.id === 'a1')?.text).toBe('藏着也要到')
    expect(result.current.streamingIds.has('a1')).toBe(true)
  })

  it('非增量事件到来前先把攒着的刷掉:顺序和逐条处理时一样', async () => {
    const { result } = await mountLoaded()
    act(() => {
      ev({ type: 'assistant-delta', id: 'a1', text: 'Hel' })
      ev({ type: 'assistant-delta', id: 'a1', text: 'lo' })
      ev({ type: 'user', message: { id: 'u2', who: 'user', text: 'next', ts: '1' } })
      ev({ type: 'assistant-delta', id: 'a1', text: '!' })
      ev({ type: 'error', id: 'a1', error: 'boom' })
    })
    expect(result.current.messages.map(m => m.id)).toEqual(['a1', 'u2'])
    expect(result.current.messages[0].text).toBe('Hello!')
    expect(result.current.streamingIds.has('a1')).toBe(false)
  })

  it('★历史回来时攒着的增量不再叠上去(它们已经在历史那条在途消息里了)', async () => {
    const { result } = renderHook(() => useChat('/ws', 's1'))
    act(() => { ev({ type: 'assistant-delta', id: 'a1', text: 'abc' }) })
    await act(async () => { resolveHistory([{ id: 'a1', who: 'ai', text: 'abc', ts: '' }]) })
    runFrame()
    expect(result.current.messages.find(m => m.id === 'a1')?.text).toBe('abc')
  })
})

describe('useChat — 实时工具输出按历史同一阈值摘掉', () => {
  const big = Array.from({ length: 900 }, (_, i) => `line ${i}`).join('\n') // > 4KB
  const tool = (output: string): ToolActivity => ({ id: 't1', title: '调用 Bash: npm test', status: 'ok', output })

  it('tool-activity 超过 4KB:state 里只留 outputOmitted + 原始行数;小的照旧内联', async () => {
    const { result } = await mountLoaded()
    act(() => { ev({ type: 'tool-activity', id: 'a1', tool: tool(big) }) })
    const t = result.current.messages.find(m => m.id === 'a1')!.tools![0]
    expect(t.output).toBeUndefined()
    expect(t.outputOmitted).toBe(true)
    expect(t.outputLines).toBe(900)

    act(() => { ev({ type: 'tool-activity', id: 'a1', tool: { ...tool('短输出'), id: 't2' } }) })
    const t2 = result.current.messages.find(m => m.id === 'a1')!.tools![1]
    expect(t2.output).toBe('短输出')
    expect(t2.outputOmitted).toBeUndefined()
  })

  it('done 带回来的落盘消息同样摘掉', async () => {
    const { result } = await mountLoaded()
    act(() => { ev({ type: 'done', message: { id: 'a1', who: 'ai', text: 'ok', ts: '2', tools: [tool(big)] } }) })
    const t = result.current.messages.find(m => m.id === 'a1')!.tools![0]
    expect(t.output).toBeUndefined()
    expect(t.outputOmitted).toBe(true)
  })

  it('★实时这一轮的大段输出点开时 ToolBlock 去取全文并显示', async () => {
    const { result } = await mountLoaded()
    act(() => { ev({ type: 'tool-activity', id: 'a1', tool: tool(big) }) })
    const live = result.current.messages.find(m => m.id === 'a1')!
    const load = vi.fn().mockResolvedValue(big)
    render(
      <ToolOutputCtx.Provider value={{ load }}>
        <ToolBlock tools={live.tools!} stateKey="a1" messageId="a1" />
      </ToolOutputCtx.Provider>,
    )
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /调用 Bash/ })) })
    await waitFor(() => expect(screen.getByText(/line 899/)).toBeTruthy())
    expect(load).toHaveBeenCalledWith('a1', 't1')
  })
})
