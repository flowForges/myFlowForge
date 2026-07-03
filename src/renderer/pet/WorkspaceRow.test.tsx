import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WorkspaceRow } from './WorkspaceRow'
import type { PopupWorkspace } from './derivePopupData'

const base: PopupWorkspace = { name: 'design-system', path: '/ws/ds', sub: '2 个项目 · standard', status: 'idle', agents: [], done: false }

describe('WorkspaceRow', () => {
  it('renders the status dot, name, sub and fires onGo with the path', () => {
    const onGo = vi.fn()
    const { container } = render(<WorkspaceRow ws={{ ...base, status: 'run' }} onGo={onGo} />)
    expect(container.querySelector('.pd.run')).not.toBeNull()
    expect(container.querySelector('.pn')!.textContent).toBe('design-system')
    expect(container.querySelector('.psub')!.textContent).toBe('2 个项目 · standard')
    fireEvent.click(container.querySelector('.pp-ws')!)
    expect(onGo).toHaveBeenCalledWith('/ws/ds')
  })

  it('renders running agent chips', () => {
    const { container } = render(<WorkspaceRow ws={{ ...base, status: 'run', agents: ['设计代理', '部署代理'] }} onGo={() => {}} />)
    const chips = container.querySelectorAll('.pp-chip')
    expect(chips).toHaveLength(2)
    expect(chips[0].querySelector('.cd')).not.toBeNull()
    expect(chips[0].textContent).toContain('设计代理')
  })

  it('renders a done chip when finished with no agents', () => {
    const { container } = render(<WorkspaceRow ws={{ ...base, status: 'ok', done: true }} onGo={() => {}} />)
    const chip = container.querySelector('.pp-chip.done')!
    expect(chip.textContent).toBe('已完成')
  })

  // Task 8: scount badge
  it('shows .scount badge when sessionCount > 1 and calls onOpenPicker on click', () => {
    const onOpenPicker = vi.fn()
    const { container } = render(
      <WorkspaceRow ws={base} onGo={() => {}} sessionCount={3} onOpenPicker={onOpenPicker} />
    )
    const badge = container.querySelector('.scount')
    expect(badge).not.toBeNull()
    expect(badge!.textContent).toContain('3')
    expect(badge!.textContent).toContain('会话')
    fireEvent.click(badge!)
    expect(onOpenPicker).toHaveBeenCalled()
  })

  it('does NOT show .scount badge when sessionCount <= 1', () => {
    const { container } = render(
      <WorkspaceRow ws={base} onGo={() => {}} sessionCount={1} onOpenPicker={() => {}} />
    )
    expect(container.querySelector('.scount')).toBeNull()
  })

  it('does NOT show .scount badge when sessionCount is undefined', () => {
    const { container } = render(
      <WorkspaceRow ws={base} onGo={() => {}} />
    )
    expect(container.querySelector('.scount')).toBeNull()
  })
})
