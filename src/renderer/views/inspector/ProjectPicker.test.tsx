import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ProjectPicker, ALL_PROJECTS } from './ProjectPicker'

const projects = [{ name: 'web', cwd: '/w/web' }, { name: 'api', cwd: '/w/api' }]

describe('ProjectPicker', () => {
  it('opens the custom dropdown, renders 全部项目 + each project, and reports selection', () => {
    const onSelect = vi.fn()
    render(<ProjectPicker projects={projects} activeCwd={ALL_PROJECTS} onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button', { name: /全部项目/ }))   // open (trigger shows active label)
    expect(screen.getByRole('option', { name: '全部项目' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('option', { name: 'api' }))
    expect(onSelect).toHaveBeenCalledWith('/w/api')
  })
  it('selecting 全部项目 reports the ALL_PROJECTS sentinel', () => {
    const onSelect = vi.fn()
    render(<ProjectPicker projects={projects} activeCwd="/w/web" onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button', { name: /web/ }))        // open
    fireEvent.click(screen.getByRole('option', { name: '全部项目' }))
    expect(onSelect).toHaveBeenCalledWith(ALL_PROJECTS)
  })
  it('renders nothing for a single project', () => {
    const { container } = render(<ProjectPicker projects={[projects[0]]} activeCwd="/w/web" onSelect={() => {}} />)
    expect(container.firstChild).toBeNull()
  })
})
