import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ProjectPane } from './ProjectPane'

describe('ProjectPane', () => {
  it('lists projects and adds a new one', () => {
    const onAdd = vi.fn(); const onDelete = vi.fn()
    render(<ProjectPane projects={[{ id: 'p1', name: 'P1', repoUrl: 'git@x:y/p1.git', defaultBranch: 'main' }]} onAdd={onAdd} onDelete={onDelete} />)
    expect(screen.getByText('P1')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText(/git@|https|仓库/i), { target: { value: 'git@x:y/p2.git' } })
    fireEvent.click(screen.getByRole('button', { name: /添加|新增/ }))
    expect(onAdd).toHaveBeenCalled()
  })
})
