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

  it('edits an existing project branch inline (click branch pill → type → Enter)', () => {
    const onEditBranch = vi.fn()
    render(<ProjectPane
      projects={[{ id: 'p1', name: 'P1', repoUrl: 'git@x:y/p1.git', defaultBranch: 'master' }]}
      onAdd={vi.fn()} onDelete={vi.fn()} onEditBranch={onEditBranch} />)
    // the wrong "master" is shown as an editable pill
    fireEvent.click(screen.getByRole('button', { name: /master/ }))
    const input = screen.getByDisplayValue('master')
    fireEvent.change(input, { target: { value: 'main' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onEditBranch).toHaveBeenCalledWith('p1', 'main')
  })

  it('does not call onEditBranch when the branch is unchanged or blank', () => {
    const onEditBranch = vi.fn()
    render(<ProjectPane
      projects={[{ id: 'p1', name: 'P1', repoUrl: 'git@x:y/p1.git', defaultBranch: 'main' }]}
      onAdd={vi.fn()} onDelete={vi.fn()} onEditBranch={onEditBranch} />)
    fireEvent.click(screen.getByRole('button', { name: /main/ }))
    fireEvent.keyDown(screen.getByTitle(/回车保存/), { key: 'Enter' })            // unchanged
    fireEvent.click(screen.getByRole('button', { name: /main/ }))
    fireEvent.change(screen.getByTitle(/回车保存/), { target: { value: '  ' } })
    fireEvent.keyDown(screen.getByTitle(/回车保存/), { key: 'Enter' })            // blank
    expect(onEditBranch).not.toHaveBeenCalled()
  })
})
