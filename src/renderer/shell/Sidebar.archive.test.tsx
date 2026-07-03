import { it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Sidebar } from './Sidebar'
import type { AgentState } from '@shared/types'

const base = { activeId: '', onSelect: () => {}, onNew: () => {}, collapsed: false }

it('archived item shows restore (in ⋯ menu) + delete, no pin', () => {
  const onRestore = vi.fn(), onDelete = vi.fn()
  render(<Sidebar {...base}
    groups={[{ key: 'archived', label: '归档工作区', items: [{ id: '/w', name: 'w', sub: '核心', status: 'idle' as AgentState, archived: true }] }]}
    onPin={() => {}} onRestore={onRestore} onDelete={onDelete} />)
  fireEvent.click(screen.getByTitle('更多操作'))
  fireEvent.click(screen.getByText('恢复工作区'))
  expect(onRestore).toHaveBeenCalledWith('/w')
  expect(screen.queryByTitle('置顶')).toBeNull()
})
