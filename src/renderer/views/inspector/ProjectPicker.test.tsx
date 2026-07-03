import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ProjectPicker, ALL_PROJECTS } from './ProjectPicker'

const projects = [{ name: 'web', cwd: '/w/web' }, { name: 'api', cwd: '/w/api' }]

describe('ProjectPicker', () => {
  it('renders a 全部项目 option plus each project and reports selection', () => {
    const onSelect = vi.fn()
    render(<ProjectPicker projects={projects} activeCwd={ALL_PROJECTS} onSelect={onSelect} />)
    expect(screen.getByRole('option', { name: '全部项目' })).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '/w/api' } })
    expect(onSelect).toHaveBeenCalledWith('/w/api')
  })
  it('selecting 全部项目 reports the ALL_PROJECTS sentinel', () => {
    const onSelect = vi.fn()
    render(<ProjectPicker projects={projects} activeCwd="/w/web" onSelect={onSelect} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: ALL_PROJECTS } })
    expect(onSelect).toHaveBeenCalledWith(ALL_PROJECTS)
  })
  it('renders nothing for a single project', () => {
    const { container } = render(<ProjectPicker projects={[projects[0]]} activeCwd="/w/web" onSelect={() => {}} />)
    expect(container.firstChild).toBeNull()
  })
})
