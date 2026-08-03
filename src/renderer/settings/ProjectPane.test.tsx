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

  it('edits a project alias inline (click 加别名 → type → Enter), and allows clearing it', () => {
    const onEditAlias = vi.fn()
    const { rerender } = render(<ProjectPane
      projects={[{ id: 'p1', name: 'P1', repoUrl: 'git@x:y/p1.git', defaultBranch: 'main' }]}
      onAdd={vi.fn()} onDelete={vi.fn()} onEditAlias={onEditAlias} />)
    fireEvent.click(screen.getByRole('button', { name: /加别名/ }))     // empty alias → 加别名 affordance
    const input = screen.getByPlaceholderText('别名')
    fireEvent.change(input, { target: { value: '核心后台' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onEditAlias).toHaveBeenCalledWith('p1', '核心后台')
    // a set alias renders as the pill label and a blank value clears it
    rerender(<ProjectPane
      projects={[{ id: 'p1', name: 'P1', repoUrl: 'git@x:y/p1.git', defaultBranch: 'main', alias: '核心后台' }]}
      onAdd={vi.fn()} onDelete={vi.fn()} onEditAlias={onEditAlias} />)
    fireEvent.click(screen.getByRole('button', { name: /核心后台/ }))
    const input2 = screen.getByDisplayValue('核心后台')
    fireEvent.change(input2, { target: { value: '' } })
    fireEvent.keyDown(input2, { key: 'Enter' })
    expect(onEditAlias).toHaveBeenCalledWith('p1', '')                 // blank clears (valid, unlike branch)
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
