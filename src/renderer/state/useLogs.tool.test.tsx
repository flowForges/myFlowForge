import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useLogs } from './useLogs'
import type { ChatEvent } from '@shared/types'

// 主代理的工具调用要进「执行」页签。这条线原先完全没接:对话区执行块显示「共 21 步」,而实时日志里只有
// 一条指令 + 一条输出,看着像 AI 什么都没干。

let fire: (e: ChatEvent) => void = () => {}
beforeEach(() => {
  ;(window as unknown as Record<string, unknown>)['forge'] = {
    onChatEvent: (cb: (e: ChatEvent) => void) => { fire = cb; return () => {} },
    onChangesEvent: () => () => {},
    onRun2Log: () => () => {},
    onRun2Event: () => () => {},
    onEngineEvent: () => () => {},
  }
  vi.restoreAllMocks()
})

const tool = (id: string, status: 'run' | 'ok' | 'error', title: string, output?: string): ChatEvent =>
  ({ workspacePath: '/ws', sessionId: 's1', type: 'tool-activity', id: 'a1', tool: { id, title, status, output } }) as ChatEvent

describe('实时日志 · 工具调用', () => {
  it('★ 工具调用进「执行」级别,不再只有指令和输出', () => {
    const { result } = renderHook(() => useLogs())
    act(() => { fire(tool('t1', 'run', '调用 shell: git status')) })
    const execs = result.current.logs.filter(l => l.level === 'exec')
    expect(execs).toHaveLength(1)
    expect(execs[0].text).toContain('git status')
  })

  it('同一次调用就地更新,不刷成两行', () => {
    const { result } = renderHook(() => useLogs())
    act(() => { fire(tool('t1', 'run', '调用 shell: git status')) })
    act(() => { fire(tool('t1', 'ok', '调用 shell: git status', 'nothing to commit')) })
    const execs = result.current.logs.filter(l => l.level === 'exec')
    expect(execs).toHaveLength(1)
    expect(execs[0].text).toContain('nothing to commit')
    expect(execs[0].streaming).toBe(false)      // 跑完了,不该还挂着流式标记
  })

  it('多个工具各占一行', () => {
    const { result } = renderHook(() => useLogs())
    act(() => { fire(tool('t1', 'run', '调用 A')) })
    act(() => { fire(tool('t2', 'run', '调用 B')) })
    expect(result.current.logs.filter(l => l.level === 'exec')).toHaveLength(2)
  })

  it('超长输出被截断 —— 日志是滚动流,不是阅读器', () => {
    const { result } = renderHook(() => useLogs())
    act(() => { fire(tool('t1', 'ok', '调用 rg', 'x'.repeat(5000))) })
    const line = result.current.logs.find(l => l.level === 'exec')!
    expect(line.text.length).toBeLessThan(600)
    expect(line.text).toContain('…')
  })

  it('运行中的行标为 streaming', () => {
    const { result } = renderHook(() => useLogs())
    act(() => { fire(tool('t1', 'run', '调用 shell')) })
    expect(result.current.logs.find(l => l.level === 'exec')?.streaming).toBe(true)
  })
})
