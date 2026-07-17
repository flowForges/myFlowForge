import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Run2EventCard } from './Run2EventCard'
import type { RunEvent } from '../../main/run/events'
import type { GateDecision, LaneDecision } from '../../main/run/decisions'

describe('Run2EventCard', () => {
  it('auth: renders title+where, fires authorize/deny via onLane', () => {
    const onGate = vi.fn<(id: string, d: GateDecision) => void>()
    const onLane = vi.fn<(id: string, d: LaneDecision) => void>()
    const event: RunEvent = { id: 'e1', kind: 'auth', laneId: 'l1', stageKey: 'dev', title: '需要写文件权限', where: 'src/foo.ts' }
    render(<Run2EventCard event={event} onGate={onGate} onLane={onLane} />)

    expect(screen.getByText('需要写文件权限')).toBeInTheDocument()
    expect(screen.getByText('src/foo.ts')).toBeInTheDocument()

    fireEvent.click(screen.getByText('批准'))
    expect(onLane).toHaveBeenCalledWith('e1', { type: 'authorize' })

    fireEvent.click(screen.getByText('拒绝'))
    expect(onLane).toHaveBeenCalledWith('e1', { type: 'deny' })
    expect(onGate).not.toHaveBeenCalled()
  })

  it('auth: renders without where when absent', () => {
    const onGate = vi.fn()
    const onLane = vi.fn()
    const event: RunEvent = { id: 'e1b', kind: 'auth', laneId: 'l1', stageKey: 'dev', title: '需要权限' }
    const { container } = render(<Run2EventCard event={event} onGate={onGate} onLane={onLane} />)
    expect(container.querySelector('.req-file')).toBeNull()
  })

  it('question: submits typed value or abort', () => {
    const onGate = vi.fn()
    const onLane = vi.fn<(id: string, d: LaneDecision) => void>()
    const event: RunEvent = { id: 'e2', kind: 'question', laneId: 'l1', stageKey: 'dev', title: '用什么命名风格?', placeholder: '例如 camelCase' }
    render(<Run2EventCard event={event} onGate={onGate} onLane={onLane} />)

    expect(screen.getByText('用什么命名风格?')).toBeInTheDocument()
    const input = screen.getByPlaceholderText('例如 camelCase') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'snake_case' } })
    fireEvent.click(screen.getByText('提交'))
    expect(onLane).toHaveBeenCalledWith('e2', { type: 'answer', value: 'snake_case' })

    fireEvent.click(screen.getByText('终止'))
    expect(onLane).toHaveBeenCalledWith('e2', { type: 'abort' })

    // skipLane button should not exist
    expect(screen.queryByText('跳过本泳道')).toBeNull()
  })

  it('doubt: renders note as informational (no action buttons)', () => {
    const onGate = vi.fn()
    const onLane = vi.fn<(id: string, d: LaneDecision) => void>()
    const event: RunEvent = { id: 'e3', kind: 'doubt', laneId: 'l1', stageKey: 'dev', note: '这个依赖版本似乎不兼容' }
    render(<Run2EventCard event={event} onGate={onGate} onLane={onLane} />)

    expect(screen.getByText('这个依赖版本似乎不兼容')).toBeInTheDocument()
    expect(screen.queryByText('升级为方案问题')).toBeNull()
    expect(onLane).not.toHaveBeenCalled()
  })

  it('failure: renders error+attempts, fires retry/skipLane via onLane', () => {
    const onGate = vi.fn()
    const onLane = vi.fn<(id: string, d: LaneDecision) => void>()
    const event: RunEvent = { id: 'e4', kind: 'failure', laneId: 'l1', stageKey: 'dev', error: '测试失败: TypeError', attempts: 2 }
    render(<Run2EventCard event={event} onGate={onGate} onLane={onLane} />)

    expect(screen.getByText('测试失败: TypeError')).toBeInTheDocument()
    expect(screen.getByText(/2/)).toBeInTheDocument()

    fireEvent.click(screen.getByText('重跑'))
    expect(onLane).toHaveBeenCalledWith('e4', { type: 'retry' })

    fireEvent.click(screen.getByText('跳过'))
    expect(onLane).toHaveBeenCalledWith('e4', { type: 'skipLane' })
  })

  it('gate: renders markdown body + docs, fires advance/redo/jumpBack via onGate', () => {
    const onGate = vi.fn<(id: string, d: GateDecision) => void>()
    const onLane = vi.fn()
    const event: RunEvent = {
      id: 'e5', kind: 'gate', stageKey: 'design',
      body: '## 方案\n采用 **网关** 架构。',
      docs: [{ path: 'docs/技术方案.md', kind: 'doc' }],
    }
    const { container } = render(<Run2EventCard event={event} onGate={onGate} onLane={onLane} />)

    const plan = container.querySelector('.req-plan')
    expect(plan).toBeTruthy()
    expect(plan?.querySelector('h2')?.textContent).toBe('方案')
    expect(screen.getByText('docs/技术方案.md')).toBeInTheDocument()

    fireEvent.click(screen.getByText('通过'))
    expect(onGate).toHaveBeenCalledWith('e5', { type: 'advance' })

    fireEvent.click(screen.getByText('打回本阶段'))
    expect(onGate).toHaveBeenCalledWith('e5', { type: 'redo' })

    fireEvent.click(screen.getByText('回退到方案'))
    expect(onGate).toHaveBeenCalledWith('e5', { type: 'jumpBack', targetKey: 'design' })
    expect(onLane).not.toHaveBeenCalled()
  })

  it('gate: free-text feedback submits as a redo carrying feedback', () => {
    const onGate = vi.fn<(id: string, d: GateDecision) => void>()
    const onLane = vi.fn()
    const event: RunEvent = { id: 'e6', kind: 'gate', stageKey: 'design', body: '# 方案' }
    render(<Run2EventCard event={event} onGate={onGate} onLane={onLane} />)

    const input = screen.getByPlaceholderText(/意见|反馈|补充/) as HTMLInputElement
    fireEvent.change(input, { target: { value: '再补充一下边界情况' } })
    fireEvent.click(screen.getByText('提交意见'))
    expect(onGate).toHaveBeenCalledWith('e6', { type: 'redo', feedback: '再补充一下边界情况' })
  })
})
