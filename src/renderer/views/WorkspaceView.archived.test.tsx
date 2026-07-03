import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ArchiveNote } from './ArchiveNote'

describe('ArchiveNote', () => {
  it('shows created + archived times', () => {
    render(<ArchiveNote createdAt={1718000000000} archivedAt={1718600000000} />)
    expect(screen.getByText(/已归档/)).toBeInTheDocument()
    expect(screen.getByText(/创建/)).toBeInTheDocument()
  })

  it('renders archive note banner', () => {
    render(<ArchiveNote createdAt={1718000000000} archivedAt={1718600000000} />)
    const note = document.querySelector('.ws-archive-note')
    expect(note).toBeTruthy()
  })

  it('renders dash when archivedAt is null', () => {
    render(<ArchiveNote createdAt={1718000000000} archivedAt={null} />)
    expect(screen.getByText(/已归档/)).toBeInTheDocument()
  })
})
