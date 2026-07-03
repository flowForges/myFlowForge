import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ArchiveNote } from './ArchiveNote'

describe('ArchiveNote', () => {
  it('renders archive note with formatted createdAt and archivedAt', () => {
    render(<ArchiveNote createdAt={1700000000000} archivedAt={1700086400000} />)
    expect(screen.getByText(/已归档/)).toBeInTheDocument()
  })

  it('renders dash when archivedAt is null', () => {
    render(<ArchiveNote createdAt={1700000000000} archivedAt={null} />)
    expect(screen.getByText(/—/)).toBeInTheDocument()
  })
})
