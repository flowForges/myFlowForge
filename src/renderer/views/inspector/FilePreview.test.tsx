import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FilePreview } from './FilePreview'

beforeEach(() => {
  ;(window as any).forge = {
    gitDiff: vi.fn(async () => [
      { kind: 'ctx', ln: 1, text: 'a' },
      { kind: 'add', ln: 2, text: 'B' },
      { kind: 'del', ln: 2, text: 'b' }
    ]),
    gitFile: vi.fn(async () => ({ text: 'const x = 1\nconst y = 2', lang: 'ts' }))
  }
})

describe('FilePreview', () => {
  it('shows the diff by default and switches to full text', async () => {
    const onClose = vi.fn()
    render(<FilePreview open cwd="/w" file="src/a.ts" type="M" onClose={onClose} />)
    expect(screen.getByText('src/a.ts')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('B')).toBeInTheDocument())
    expect((window as any).forge.gitDiff).toHaveBeenCalledWith('/w', 'src/a.ts')
    fireEvent.click(screen.getByText('全文'))
    await waitFor(() => expect((window as any).forge.gitFile).toHaveBeenCalledWith('/w', 'src/a.ts'))
    fireEvent.click(screen.getByTitle('返回'))
    expect(onClose).toHaveBeenCalled()
  })
  it('renders a .md file as formatted markdown in full mode', async () => {
    ;(window as any).forge.gitFile = vi.fn(async () => ({ text: '# Title', lang: 'markdown' }))
    const { container } = render(
      <FilePreview open cwd="/w" file="docs/readme.md" type="M" onClose={() => {}} />
    )
    fireEvent.click(screen.getByText('全文'))
    await waitFor(() => expect(container.querySelector('.pv-md h1')).toBeInTheDocument())
    expect(container.querySelector('.pv-md h1')?.textContent).toBe('Title')
    // markdown path should NOT render the raw '#' as code-line text
    expect(screen.queryByText('# Title')).not.toBeInTheDocument()
  })
  it('opens directly in full markdown when initialMode="full" (design doc open)', async () => {
    ;(window as any).forge.gitFile = vi.fn(async () => ({ text: '# 技术方案', lang: 'markdown' }))
    const { container } = render(
      <FilePreview open cwd="/w" file="docs/plan.md" type="M" initialMode="full" onClose={() => {}} />
    )
    // No click on 全文 needed — content renders formatted immediately.
    await waitFor(() => expect(container.querySelector('.pv-md h1')?.textContent).toBe('技术方案'))
    expect((window as any).forge.gitFile).toHaveBeenCalledWith('/w', 'docs/plan.md')
  })
  it('renders nothing interactive when closed', () => {
    const { container } = render(<FilePreview open={false} cwd="/w" file="" type="M" onClose={() => {}} />)
    const el = container.querySelector('.preview')
    expect(el?.className.includes('on')).toBe(false)
  })
})
