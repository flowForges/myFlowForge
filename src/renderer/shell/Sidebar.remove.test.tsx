import { it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Sidebar } from './Sidebar'
import type { AgentState } from '@shared/types'

const base = { activeId: '', onSelect: () => {}, onNew: () => {}, collapsed: false }
const activeGroup = [{ key: 'recent', label: '最近', items: [{ id: '/w', name: 'w', sub: '核心', status: 'idle' as AgentState }] }]
// Reveal label is OS-aware (Windows has no Finder) — compute it the same way the component does.
const REVEAL_LABEL = /Mac/i.test(navigator.userAgent) ? '在 Finder 中显示'
  : /Win/i.test(navigator.userAgent) ? '在资源管理器中显示'
  : '打开所在文件夹'

// Row actions now live behind a ⋯「更多操作」dropdown (icon+text), replacing the cramped icon row.
const openMenu = () => fireEvent.click(screen.getByTitle('更多操作'))

it('active item exposes reveal (open folder) + remove (list-only), distinct from 永久删除', () => {
  const onReveal = vi.fn(), onRemove = vi.fn(), onDelete = vi.fn()
  render(<Sidebar {...base} groups={activeGroup} onReveal={onReveal} onRemove={onRemove} onDelete={onDelete} />)

  // reveal — OS-aware label
  openMenu()
  fireEvent.click(screen.getByText(REVEAL_LABEL))
  expect(onReveal).toHaveBeenCalledWith('/w')

  // 移除 — keeps files
  openMenu()
  fireEvent.click(screen.getByText(/从列表移除/))
  expect(onRemove).toHaveBeenCalledWith('/w')

  // 永久删除 still present and separate
  openMenu()
  fireEvent.click(screen.getByText(/永久删除/))
  expect(onDelete).toHaveBeenCalledWith('/w')
})

it('does not render the actions menu when no action handlers are present', () => {
  render(<Sidebar {...base} groups={activeGroup} />)
  expect(screen.queryByTitle('更多操作')).toBeNull()
})
