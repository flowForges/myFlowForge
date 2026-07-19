import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RunEventCard } from './RunEventCard'
import type { RunEvent } from '../../main/run/events'
import type { FrozenRunCard } from '../views/chat/runCards'

describe('RunEventCard', () => {
  it('renders null when neither event nor frozen is given', () => {
    const { container } = render(<RunEventCard onGate={vi.fn()} onLane={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  it('gate: renders body + 通过/打回本阶段/回退到某阶段, and 通过 fires resolveGate advance', () => {
    const onGate = vi.fn()
    const event: RunEvent = { id: 'g1', kind: 'gate', stageKey: 'design', body: '## 方案\n采用网关架构' }
    render(<RunEventCard event={event} onGate={onGate} onLane={vi.fn()} />)

    expect(document.querySelector('.msg-req')?.classList.contains('k-gate')).toBe(true)
    expect(screen.getByText('通过')).toBeInTheDocument()
    expect(screen.getByText('打回本阶段')).toBeInTheDocument()
    expect(screen.getByText('回退到某阶段')).toBeInTheDocument()
    // body rendered as markdown
    expect(screen.getByText('方案')).toBeInTheDocument()

    fireEvent.click(screen.getByText('通过'))
    expect(onGate).toHaveBeenCalledWith('g1', { type: 'advance' })
  })

  it('gate: 打回本阶段 sends redo with typed feedback', () => {
    const onGate = vi.fn()
    const event: RunEvent = { id: 'g2', kind: 'gate', stageKey: 'design', body: 'x' }
    render(<RunEventCard event={event} onGate={onGate} onLane={vi.fn()} />)
    const fb = screen.getByPlaceholderText('补充说明（可选，打回/回退时附带）')
    fireEvent.change(fb, { target: { value: '再调整一下接口命名' } })
    fireEvent.click(screen.getByText('打回本阶段'))
    expect(onGate).toHaveBeenCalledWith('g2', { type: 'redo', feedback: '再调整一下接口命名' })
  })

  it('gate: 回退到某阶段 reveals a target-key input and sends jumpBack once filled', () => {
    const onGate = vi.fn()
    const event: RunEvent = { id: 'g3', kind: 'gate', stageKey: 'impl', body: 'x' }
    render(<RunEventCard event={event} onGate={onGate} onLane={vi.fn()} />)
    fireEvent.click(screen.getByText('回退到某阶段'))
    const targetInput = screen.getByPlaceholderText('回退目标阶段 key')
    fireEvent.change(targetInput, { target: { value: 'design' } })
    fireEvent.click(screen.getByText('确认回退'))
    expect(onGate).toHaveBeenCalledWith('g3', { type: 'jumpBack', targetKey: 'design', feedback: undefined })
  })

  it('auth: renders title+where and 批准/拒绝 route through resolveLane', () => {
    const onLane = vi.fn()
    const event: RunEvent = { id: 'a1', kind: 'auth', laneId: 'l1', stageKey: 'impl', title: '执行 rm -rf tmp/', where: 'apps/web' }
    render(<RunEventCard event={event} onGate={vi.fn()} onLane={onLane} />)

    expect(screen.getByText('执行 rm -rf tmp/ · apps/web')).toBeInTheDocument()
    fireEvent.click(screen.getByText('批准'))
    expect(onLane).toHaveBeenCalledWith('a1', { type: 'authorize' })
    fireEvent.click(screen.getByText('拒绝'))
    expect(onLane).toHaveBeenCalledWith('a1', { type: 'deny' })
  })

  it('failure: renders error+attempts and 重跑/跳过 route through resolveLane', () => {
    const onLane = vi.fn()
    const event: RunEvent = { id: 'f1', kind: 'failure', laneId: 'l2', stageKey: 'impl', error: '构建失败', attempts: 2 }
    render(<RunEventCard event={event} onGate={vi.fn()} onLane={onLane} />)

    expect(screen.getByText('构建失败（已重试 2 次）')).toBeInTheDocument()
    fireEvent.click(screen.getByText('重跑'))
    expect(onLane).toHaveBeenCalledWith('f1', { type: 'retry' })
    fireEvent.click(screen.getByText('跳过'))
    expect(onLane).toHaveBeenCalledWith('f1', { type: 'skipLane' })
  })

  it('doubt: renders note + FOUR actions; 回退改方案→jumpBack, 驳回继续→dismiss', () => {
    const onLane = vi.fn()
    const event: RunEvent = { id: 'd1', kind: 'doubt', laneId: 'l3', stageKey: 'impl', note: '这个方案好像漏了鉴权' }
    render(<RunEventCard event={event} onGate={vi.fn()} onLane={onLane} />)

    expect(document.querySelector('.msg-req')?.classList.contains('k-doubt')).toBe(true)
    expect(document.querySelector('.msg-req')?.classList.contains('k-confirm')).toBe(false)
    expect(screen.getByText('这个方案好像漏了鉴权')).toBeInTheDocument()
    expect(screen.getByText('回退改方案')).toBeInTheDocument()
    expect(screen.getByText('驳回继续')).toBeInTheDocument()
    expect(screen.getByText('补充说明后继续')).toBeInTheDocument()
    expect(screen.getByText('终止运行')).toBeInTheDocument()

    fireEvent.click(screen.getByText('回退改方案'))
    expect(onLane).toHaveBeenCalledWith('d1', { type: 'jumpBack' })

    fireEvent.click(screen.getByText('驳回继续'))
    expect(onLane).toHaveBeenCalledWith('d1', { type: 'dismiss' })
  })

  it('doubt: 补充说明后继续 sends redo with typed feedback, 终止运行 sends abort', () => {
    const onLane = vi.fn()
    const event: RunEvent = { id: 'd2', kind: 'doubt', laneId: 'l4', stageKey: 'impl', note: '存疑' }
    render(<RunEventCard event={event} onGate={vi.fn()} onLane={onLane} />)
    const fb = screen.getByPlaceholderText('补充说明（继续时可选附带）')
    fireEvent.change(fb, { target: { value: '已确认鉴权在网关层做' } })
    fireEvent.click(screen.getByText('补充说明后继续'))
    expect(onLane).toHaveBeenCalledWith('d2', { type: 'redo', feedback: '已确认鉴权在网关层做' })

    fireEvent.click(screen.getByText('终止运行'))
    expect(onLane).toHaveBeenCalledWith('d2', { type: 'abort' })
  })

  it('question: renders title + input, submits answer', () => {
    const onLane = vi.fn()
    const event: RunEvent = { id: 'q1', kind: 'question', laneId: 'l5', stageKey: 'impl', title: '用哪个目录名？', placeholder: 'src/foo' }
    render(<RunEventCard event={event} onGate={vi.fn()} onLane={onLane} />)
    const input = screen.getByPlaceholderText('src/foo')
    fireEvent.change(input, { target: { value: 'src/bar' } })
    fireEvent.click(screen.getByText('提交'))
    expect(onLane).toHaveBeenCalledWith('q1', { type: 'answer', value: 'src/bar' })
  })

  it('frozen: renders decision record with NO buttons', () => {
    const frozen: FrozenRunCard = {
      id: 'g1', kind: 'gate', stageKey: 'design', title: '技术方案设计完成',
      decision: '通过', at: 1720000000000, ts: 1,
    }
    const { container } = render(<RunEventCard frozen={frozen} onGate={vi.fn()} onLane={vi.fn()} />)
    expect(screen.getByText('技术方案设计完成')).toBeInTheDocument()
    expect(screen.getByText('决定：通过')).toBeInTheDocument()
    expect(container.querySelectorAll('button')).toHaveLength(0)
    const card = container.querySelector('.msg-req')
    expect(card?.classList.contains('k-gate')).toBe(true)
    expect(card?.classList.contains('done')).toBe(true)
  })
})
