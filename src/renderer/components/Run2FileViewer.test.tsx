import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { Run2FileViewer } from './Run2FileViewer'

describe('Run2FileViewer', () => {
  const originalForge = (window as any).forge

  afterEach(() => {
    ;(window as any).forge = originalForge
  })

  it('renders markdown content for a .md path', async () => {
    const readFile = vi.fn().mockResolvedValue({ content: '# Hello' })
    ;(window as any).forge = { run2: { readFile } }
    const onClose = vi.fn()
    render(<Run2FileViewer path="design.md" cwd="/tmp/proj" onClose={onClose} />)

    expect(readFile).toHaveBeenCalledWith({ path: 'design.md', cwd: '/tmp/proj' })
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Hello' })).toBeInTheDocument())
    expect(screen.getByText('design.md')).toBeInTheDocument()
  })

  it('renders plain text in a <pre><code> for non-markdown paths', async () => {
    const readFile = vi.fn().mockResolvedValue({ content: 'const x = 1' })
    ;(window as any).forge = { run2: { readFile } }
    render(<Run2FileViewer path="index.ts" cwd="/tmp/proj" onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('const x = 1')).toBeInTheDocument())
    expect(screen.getByText('const x = 1').closest('pre')).toBeTruthy()
  })

  it('renders an error message when the read fails', async () => {
    const readFile = vi.fn().mockResolvedValue({ error: '路径越界' })
    ;(window as any).forge = { run2: { readFile } }
    render(<Run2FileViewer path="../etc/passwd" cwd="/tmp/proj" onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('路径越界')).toBeInTheDocument())
  })

  it('shows a truncation notice when the response is truncated', async () => {
    const readFile = vi.fn().mockResolvedValue({ content: 'x'.repeat(10), truncated: true })
    ;(window as any).forge = { run2: { readFile } }
    render(<Run2FileViewer path="big.txt" cwd="/tmp/proj" onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByText(/截断|truncat/i)).toBeInTheDocument())
  })

  it('calls onClose when the close button is clicked', async () => {
    const readFile = vi.fn().mockResolvedValue({ content: 'hi' })
    ;(window as any).forge = { run2: { readFile } }
    const onClose = vi.fn()
    render(<Run2FileViewer path="a.txt" cwd="/tmp/proj" onClose={onClose} />)
    await waitFor(() => expect(screen.getByText('hi')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /关闭|close/i }))
    expect(onClose).toHaveBeenCalled()
  })

  it('is defensive when window.forge.run2.readFile is absent', async () => {
    ;(window as any).forge = {}
    render(<Run2FileViewer path="a.txt" cwd="/tmp/proj" onClose={vi.fn()} />)
    // Should not throw; some error/empty state renders instead of a crash.
    await waitFor(() => expect(screen.queryByText('a.txt')).toBeInTheDocument())
  })
})
