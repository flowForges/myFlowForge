import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PetSimplePanel } from './PetSimplePanel'
import type { PendingAction } from '@shared/types'

const agent = (name: string, stage: string) => ({ name, role: 'coder', stage })
const noop = () => {}

describe('PetSimplePanel', () => {
  it('renders nothing when idle', () => {
    const { container } = render(
      <PetSimplePanel kind="idle" agents={[]} pending={[]} corner="right" collapsed={false} onToggleCollapse={noop} onResolve={noop} onJump={noop} />
    )
    expect(container.firstChild).toBeNull()
  })

  it('lists running agents and jumps on row click', () => {
    const onJump = vi.fn()
    render(
      <PetSimplePanel kind="running" agents={[agent('中国龙', '实现'), agent('Codex', '设计')]} pending={[]} corner="right" collapsed={false} onToggleCollapse={noop} onResolve={noop} onJump={onJump} />
    )
    expect(screen.getByText('2 个代理在执行')).toBeTruthy()
    expect(screen.getByText('中国龙')).toBeTruthy()
    fireEvent.click(screen.getByText('中国龙'))
    expect(onJump).toHaveBeenCalled()
  })

  it('collapses the body when collapsed', () => {
    render(
      <PetSimplePanel kind="running" agents={[agent('A', 's')]} pending={[]} corner="right" collapsed={true} onToggleCollapse={noop} onResolve={noop} onJump={noop} />
    )
    // header title still visible, agent row hidden
    expect(screen.getByText('1 个代理在执行')).toBeTruthy()
    expect(screen.queryByText('A')).toBeNull()
  })

  it('toggles collapse via the chevron', () => {
    const onToggle = vi.fn()
    render(
      <PetSimplePanel kind="running" agents={[]} pending={[]} corner="right" collapsed={false} onToggleCollapse={onToggle} onResolve={noop} onJump={noop} />
    )
    fireEvent.click(screen.getByLabelText('折叠'))
    expect(onToggle).toHaveBeenCalled()
  })

  it('renders a confirm request card and resolves', () => {
    const pending: PendingAction[] = [{ id: 'x1', kind: 'confirm', agentId: 'a1', title: '运行命令?', wsName: 'ws', agentName: 'Codex', where: 'shell' }]
    const onResolve = vi.fn()
    render(
      <PetSimplePanel kind="confirm" agents={[]} pending={pending} corner="right" collapsed={false} onToggleCollapse={noop} onResolve={onResolve} onJump={noop} />
    )
    expect(screen.getByText('需要确认')).toBeTruthy()
    fireEvent.click(screen.getByText('允许'))
    expect(onResolve).toHaveBeenCalledWith({ id: 'x1', decision: 'allow' })
  })

  it('shows a done ✓ state', () => {
    render(
      <PetSimplePanel kind="done" agents={[]} pending={[]} corner="right" collapsed={false} onToggleCollapse={noop} onResolve={noop} onJump={noop} />
    )
    expect(screen.getByText('完成')).toBeTruthy()
    expect(screen.getByText('任务已完成')).toBeTruthy()
  })
})
