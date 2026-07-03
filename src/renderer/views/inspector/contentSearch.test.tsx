import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FileTreePane } from './FileTreePane'
import { ChangesPane } from './ChangesPane'
import type { TreeNode, ChangeItem } from '@shared/types'

const tree: TreeNode[] = [
  { type: 'file', name: 'a.ts', path: 'a.ts', chg: 'M' },
]

beforeEach(() => {
  ;(window as unknown as { forge: unknown }).forge = {
    searchContent: vi.fn().mockResolvedValue({
      hits: [{ file: 'src/a.ts', line: 12, preview: 'const hello = 1' }],
      truncated: false,
    }),
  }
})
afterEach(() => vi.restoreAllMocks())

describe('FileTreePane content search', () => {
  it('has no 内容 toggle without a searchRoot', () => {
    render(<FileTreePane tree={tree} onOpen={vi.fn()} />)
    expect(screen.queryByRole('tab', { name: '内容' })).not.toBeInTheDocument()
  })

  it('switches to content mode, greps, renders hits, and opens on click', async () => {
    const onOpen = vi.fn()
    render(<FileTreePane tree={tree} onOpen={onOpen} searchRoot="/repo" />)
    fireEvent.click(screen.getByRole('tab', { name: '内容' }))
    fireEvent.change(screen.getByPlaceholderText('搜索文件内容…'), { target: { value: 'hello' } })
    await waitFor(() => expect(window.forge.searchContent).toHaveBeenCalledWith({ root: '/repo', query: 'hello', files: undefined }))
    const hit = await screen.findByText('const hello = 1')
    fireEvent.click(hit)
    expect(onOpen).toHaveBeenCalledWith('src/a.ts', 'M', '/repo')
  })
})

describe('ChangesPane search', () => {
  const changes: ChangeItem[] = [
    { path: 'src/a.ts', type: 'M', add: 3, del: 1 },
    { path: 'src/b.ts', type: 'A', add: 9, del: 0 },
  ]

  it('filters change rows by filename', () => {
    render(<ChangesPane changes={changes} cwd="/repo" onOpen={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('筛选变更文件…'), { target: { value: 'b.ts' } })
    expect(screen.getByText('b.ts')).toBeInTheDocument()
    expect(screen.queryByText('a.ts')).not.toBeInTheDocument()
  })

  it('content search greps only the changed files', async () => {
    const onOpen = vi.fn()
    render(<ChangesPane changes={changes} cwd="/repo" onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('tab', { name: '内容' }))
    fireEvent.change(screen.getByPlaceholderText('搜索变更内容…'), { target: { value: 'hello' } })
    await waitFor(() =>
      expect(window.forge.searchContent).toHaveBeenCalledWith({ root: '/repo', query: 'hello', files: ['src/a.ts', 'src/b.ts'] })
    )
    const hit = await screen.findByText('const hello = 1')
    fireEvent.click(hit)
    // hit file 'src/a.ts' matches a change → its type (M) is carried through
    expect(onOpen).toHaveBeenCalledWith('src/a.ts', 'M', '/repo')
  })
})
