import { describe, it, expect, vi } from 'vitest'
import type { ChatEvent } from '@shared/types'
import { createLogStore } from './logStore'
import { MAX_LINE_CHARS } from './logReducer'

// 手动「帧」:schedule 只记下回调,由测试决定什么时候过一帧。
function manualFrames() {
  const pending: (() => void)[] = []
  const schedule = (cb: () => void) => { pending.push(cb); return () => { const i = pending.indexOf(cb); if (i >= 0) pending.splice(i, 1) } }
  const tick = () => { for (const cb of pending.splice(0)) cb() }
  return { schedule, tick, pending }
}

const ev = (e: Record<string, unknown>) => ({ workspacePath: '/ws', sessionId: 's1', ...e }) as ChatEvent

describe('logStore', () => {
  it('★ 一帧内 100 条事件只通知一次', () => {
    const f = manualFrames()
    const store = createLogStore(f.schedule)
    const listener = vi.fn()
    store.subscribe(listener)
    store.handleChat(ev({ type: 'assistant-start', id: 'm1', model: 'x' }))
    for (let i = 0; i < 99; i++) store.handleChat(ev({ type: 'assistant-delta', id: 'm1', text: `t${i}` }))
    expect(listener).not.toHaveBeenCalled()
    expect(store.getSnapshot().logs).toHaveLength(0)     // 还没过帧,快照不动
    expect(f.pending).toHaveLength(1)                     // 只排了一帧
    f.tick()
    expect(listener).toHaveBeenCalledTimes(1)
    const [line] = store.getSnapshot().logs
    expect(line.text).toContain('t0')
    expect(line.text).toContain('t98')
    expect(store.getSnapshot().busy).toBe(true)
  })

  it('没有变化不通知', () => {
    const f = manualFrames()
    const store = createLogStore(f.schedule)
    const listener = vi.fn()
    store.subscribe(listener)
    store.handleChat(ev({ type: 'assistant-delta', id: 'unknown-but-empty', text: '' }))
    f.tick()
    listener.mockClear()
    store.handleChat(ev({ type: 'phase', id: 'm1', phase: 'think' }))
    f.tick()
    expect(listener).not.toHaveBeenCalled()
  })

  it('★ 超长单行截断并挂省略号,之后的增量不再往后接', () => {
    const store = createLogStore(manualFrames().schedule)
    store.handleChat(ev({ type: 'assistant-start', id: 'm1', model: 'x' }))
    store.handleChat(ev({ type: 'assistant-delta', id: 'm1', text: 'a'.repeat(MAX_LINE_CHARS + 500) }))
    store.handleChat(ev({ type: 'assistant-delta', id: 'm1', text: 'TAIL' }))
    store.flush()
    const text = store.getSnapshot().logs[0].text
    expect(text).toHaveLength(MAX_LINE_CHARS + 1)
    expect(text.endsWith('…')).toBe(true)
    expect(text).not.toContain('TAIL')
  })

  it('超长的整行(push)也截断', () => {
    const store = createLogStore(manualFrames().schedule)
    store.handleChat(ev({ type: 'user', message: { id: 'u1', role: 'user', text: 'b'.repeat(MAX_LINE_CHARS * 3) } }))
    store.flush()
    expect(store.getSnapshot().logs[0].text).toHaveLength(MAX_LINE_CHARS + 1)
  })

  it('★ 出错收尾:流式行和运行中的工具行不再挂 streaming,后续同 id 增量另起新行', () => {
    const store = createLogStore(manualFrames().schedule)
    store.handleChat(ev({ type: 'assistant-start', id: 'm1', model: 'x' }))
    store.handleChat(ev({ type: 'assistant-delta', id: 'm1', text: 'hi' }))
    store.handleChat(ev({ type: 'tool-activity', id: 'm1', tool: { id: 't1', title: '调用 shell', status: 'run' } }))
    store.handleChat(ev({ type: 'error', id: 'm1', error: 'boom' }))
    store.flush()
    const { logs, busy } = store.getSnapshot()
    expect(busy).toBe(false)
    expect(logs.filter(l => l.streaming)).toHaveLength(0)
    expect(logs.at(-1)?.text).toBe('错误: boom')
    // streamingLines 条目已清:同 id 的迟到增量不会再写回已收尾的那行
    store.handleChat(ev({ type: 'assistant-delta', id: 'm1', text: 'late' }))
    store.flush()
    expect(store.getSnapshot().logs.find(l => l.id === 'stream-m1')?.text).toBe('hi')
  })

  it('clear 清空行并忘掉流式行', () => {
    const store = createLogStore(manualFrames().schedule)
    store.handleChat(ev({ type: 'assistant-start', id: 'm1', model: 'x' }))
    store.flush()
    store.clear()
    store.handleChat(ev({ type: 'assistant-delta', id: 'm1', text: 'x' }))
    store.flush()
    const { logs } = store.getSnapshot()
    expect(logs).toHaveLength(1)
    expect(logs[0].id).toBe('stream-out-m1')
  })
})
