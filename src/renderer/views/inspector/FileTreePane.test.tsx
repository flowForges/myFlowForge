import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FileTreePane } from './FileTreePane'
import type { TreeNode } from '@shared/types'

const tree: TreeNode[] = [
  { type: 'dir', name: 'src', path: 'src', children: [
    { type: 'file', name: 'a.ts', path: 'src/a.ts', chg: 'M' },
    { type: 'file', name: 'b.ts', path: 'src/b.ts' }
  ] },
  { type: 'file', name: 'README.md', path: 'README.md' }
]

describe('FileTreePane', () => {
  it('renders folders/files, toggles a folder, filters, and opens a file', () => {
    const onOpen = vi.fn()
    render(<FileTreePane tree={tree} onOpen={onOpen} />)
    expect(screen.getByText('src')).toBeInTheDocument()
    expect(screen.getByText('a.ts')).toBeInTheDocument()
    fireEvent.click(screen.getByText('a.ts'))
    expect(onOpen).toHaveBeenCalledWith('src/a.ts', 'M')
    fireEvent.change(screen.getByPlaceholderText('筛选文件…'), { target: { value: 'README' } })
    expect(screen.getByText('README.md')).toBeInTheDocument()
    expect(screen.queryByText('a.ts')).not.toBeInTheDocument()
  })

  it('preserves folder structure under filter (matching file keeps its parent folder)', () => {
    const onOpen = vi.fn()
    render(<FileTreePane tree={tree} onOpen={onOpen} />)
    fireEvent.change(screen.getByPlaceholderText('筛选文件…'), { target: { value: 'a.ts' } })
    // matching file is shown AND its parent folder structure is kept
    expect(screen.getByText('a.ts')).toBeInTheDocument()
    expect(screen.getByText('src')).toBeInTheDocument()
    // non-matching siblings/files are hidden
    expect(screen.queryByText('b.ts')).not.toBeInTheDocument()
    expect(screen.queryByText('README.md')).not.toBeInTheDocument()
  })
})
