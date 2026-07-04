import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PetSimplePanel } from './PetSimplePanel'
import type { PendingAction } from '@shared/types'

const ws = (name: string, path: string) => ({ name, path })
const noop = () => {}

describe('PetSimplePanel', () => {
  it('renders nothing when idle', () => {
    const { container } = render(
      <PetSimplePanel kind="idle" runningWorkspaces={[]} pending={[]} corner="right" collapsed={false} onToggleCollapse={noop} onResolve={noop} onJump={noop} />
    )
    expect(container.firstChild).toBeNull()
  })

  it('lists running workspaces (not agents) and jumps to that workspace on row click', () => {
    const onJump = vi.fn()
    render(
      <PetSimplePanel kind="running" runningWorkspaces={[ws('blog', '/w/blog'), ws('api', '/w/api')]} pending={[]} corner="right" collapsed={false} onToggleCollapse={noop} onResolve={noop} onJump={onJump} />
    )
    expect(screen.getByText('2 个工作区在执行')).toBeTruthy()
    expect(screen.getByText('blog')).toBeTruthy()
    fireEvent.click(screen.getByText('blog'))
    expect(onJump).toHaveBeenCalledWith('/w/blog')
  })

  it('collapses the body when collapsed', () => {
    render(
      <PetSimplePanel kind="running" runningWorkspaces={[ws('blog', '/w/blog')]} pending={[]} corner="right" collapsed={true} onToggleCollapse={noop} onResolve={noop} onJump={noop} />
    )
    expect(screen.getByText('1 个工作区在执行')).toBeTruthy()
    expect(screen.queryByText('blog')).toBeNull()
  })

  it('toggles collapse via the chevron', () => {
    const onToggle = vi.fn()
    render(
      <PetSimplePanel kind="running" runningWorkspaces={[]} pending={[]} corner="right" collapsed={false} onToggleCollapse={onToggle} onResolve={noop} onJump={noop} />
    )
    fireEvent.click(screen.getByLabelText('折叠'))
    expect(onToggle).toHaveBeenCalled()
  })

  it('renders a confirm request card and resolves', () => {
    const pending: PendingAction[] = [{ id: 'x1', kind: 'confirm', agentId: 'a1', title: '运行命令?', wsName: 'ws', agentName: 'Codex', where: 'shell' }]
    const onResolve = vi.fn()
    render(
      <PetSimplePanel kind="confirm" runningWorkspaces={[]} pending={pending} corner="right" collapsed={false} onToggleCollapse={noop} onResolve={onResolve} onJump={noop} />
    )
    expect(screen.getByText('需要确认')).toBeTruthy()
    fireEvent.click(screen.getByText('允许'))
    expect(onResolve).toHaveBeenCalledWith({ id: 'x1', decision: 'allow' })
  })

  it('shows a done ✓ state', () => {
    render(
      <PetSimplePanel kind="done" runningWorkspaces={[]} pending={[]} corner="right" collapsed={false} onToggleCollapse={noop} onResolve={noop} onJump={noop} />
    )
    expect(screen.getByText('完成')).toBeTruthy()
    expect(screen.getByText('任务已完成')).toBeTruthy()
  })
})
