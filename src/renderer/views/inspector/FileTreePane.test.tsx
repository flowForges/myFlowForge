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

  it('starts collapsed, and 全部展开 / 全部收起 toggle every folder', () => {
    const { container } = render(<FileTreePane tree={tree} onOpen={vi.fn()} />)
    const folder = () => container.querySelector('.tree-folder[data-folder="src"]')!
    // default: seeded collapsed
    expect(folder().classList.contains('closed')).toBe(true)
    fireEvent.click(screen.getByLabelText('全部展开'))
    expect(folder().classList.contains('closed')).toBe(false)
    fireEvent.click(screen.getByLabelText('全部收起'))
    expect(folder().classList.contains('closed')).toBe(true)
  })

  it('hides dot-files by default and reveals them via the 显示隐藏文件 toggle', () => {
    const withHidden: TreeNode[] = [
      { type: 'file', name: '.env', path: '.env' },
      { type: 'file', name: 'README.md', path: 'README.md' },
    ]
    render(<FileTreePane tree={withHidden} onOpen={vi.fn()} />)
    expect(screen.getByText('README.md')).toBeInTheDocument()
    expect(screen.queryByText('.env')).not.toBeInTheDocument()   // hidden by default
    fireEvent.click(screen.getByLabelText('显示隐藏文件'))
    expect(screen.getByText('.env')).toBeInTheDocument()          // revealed
  })

  it('renders a 刷新 button only when onRefresh is provided, and calls it', () => {
    const onRefresh = vi.fn()
    const { unmount } = render(<FileTreePane tree={tree} onOpen={vi.fn()} />)
    expect(screen.queryByLabelText('刷新')).not.toBeInTheDocument()
    unmount()
    render(<FileTreePane tree={tree} onOpen={vi.fn()} onRefresh={onRefresh} />)
    fireEvent.click(screen.getByLabelText('刷新'))
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('focuses the search input when focusSignal changes (全局搜索 Cmd+Shift+F)', () => {
    const { rerender } = render(<FileTreePane tree={tree} onOpen={vi.fn()} focusSignal={0} />)
    const input = screen.getByPlaceholderText('筛选文件…')
    expect(document.activeElement).not.toBe(input)   // 起动/初始信号 0:不抢焦点
    rerender(<FileTreePane tree={tree} onOpen={vi.fn()} focusSignal={1} />)
    expect(document.activeElement).toBe(input)        // 触发后聚焦搜索框
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
