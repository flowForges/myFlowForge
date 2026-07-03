import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FileBrowser } from './FileBrowser'
import type { TreeNode } from '@shared/types'

const tree: TreeNode[] = [
  { name: 'src', path: 'src', type: 'dir', children: [
    { name: 'a.ts', path: 'src/a.ts', type: 'file', chg: 'M' },
  ] },
]

beforeEach(() => {
  ;(window as any).forge = {
    gitDiff: vi.fn(async () => [{ kind: 'add', ln: 1, text: 'hello' }]),
    gitFile: vi.fn(async () => ({ text: 'x', lang: 'ts' })),
  }
})

describe('FileBrowser', () => {
  it('shows an empty hint when nothing is selected, and the tree on the left', () => {
    render(<FileBrowser tree={tree} projects={[]} activeCwd={undefined} onSelectProject={() => {}}
      preview={null} onOpen={() => {}} onClose={() => {}} />)
    expect(screen.getByText('从左侧选择一个文件查看内容')).toBeInTheDocument()
    // tree file is present in the left column
    expect(screen.getByText('a.ts')).toBeInTheDocument()
  })

  it('opens a file from the tree via onOpen', () => {
    const onOpen = vi.fn()
    render(<FileBrowser tree={tree} projects={[]} activeCwd={undefined} onSelectProject={() => {}}
      preview={null} onOpen={onOpen} onClose={() => {}} />)
    fireEvent.click(screen.getByText('a.ts'))
    expect(onOpen).toHaveBeenCalledWith('src/a.ts', 'M')
  })

  it('renders the embedded preview (no ← back button) when a file is selected', async () => {
    render(<FileBrowser tree={tree} projects={[]} activeCwd={undefined} onSelectProject={() => {}}
      preview={{ file: 'src/a.ts', type: 'M', cwd: '/w' }} onOpen={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('hello')).toBeInTheDocument())
    // embedded mode hides the preview's own back button (the tree/close are the affordances)
    expect(screen.queryByTitle('返回')).toBeNull()
  })

  it('source="changes" renders the changes list on the left instead of the file tree', () => {
    const changes = [{ path: 'src/a.ts', type: 'M' as const, add: 3, del: 1 }]
    render(<FileBrowser tree={tree} projects={[]} activeCwd={undefined} onSelectProject={() => {}}
      source="changes" changes={changes} onOpenChange={() => {}}
      preview={null} onOpen={() => {}} onClose={() => {}} />)
    // changes rows present, tree rows absent
    expect(document.querySelector('.chg-item')).not.toBeNull()
    expect(document.querySelector('.tree-row')).toBeNull()
    expect(screen.getByText('本次会话变更 · 1 个文件')).toBeInTheDocument()
  })

  it('source="changes" opens a file via onOpenChange with its group cwd, and highlights the active row', () => {
    const onOpenChange = vi.fn()
    const groups = [
      { name: 'web', cwd: '/w/web', changes: [{ path: 'app.tsx', type: 'M' as const, add: 1, del: 1 }] },
      { name: 'api', cwd: '/w/api', changes: [{ path: 'main.go', type: 'A' as const, add: 5, del: 0 }] },
    ]
    render(<FileBrowser tree={tree} projects={[]} activeCwd={undefined} onSelectProject={() => {}}
      source="changes" changes={[]} groups={groups} onOpenChange={onOpenChange}
      preview={{ file: 'app.tsx', type: 'M', cwd: '/w/web' }} onOpen={() => {}} onClose={() => {}} />)
    fireEvent.click(screen.getByText('main.go'))
    expect(onOpenChange).toHaveBeenCalledWith('main.go', 'A', '/w/api')
    // the currently previewed file row carries the selected state
    const on = document.querySelector('.chg-item.on')
    expect(on).not.toBeNull()
    expect(on!.getAttribute('data-file')).toBe('app.tsx')
  })

  it('defaults to the file tree when source is omitted (back-compat)', () => {
    render(<FileBrowser tree={tree} projects={[]} activeCwd={undefined} onSelectProject={() => {}}
      preview={null} onOpen={() => {}} onClose={() => {}} />)
    expect(document.querySelector('.chg-item')).toBeNull()
    expect(screen.getByText('a.ts')).toBeInTheDocument()
  })

  it('closes on the 关闭 button and on Escape', () => {
    const onClose = vi.fn()
    render(<FileBrowser tree={tree} projects={[]} activeCwd={undefined} onSelectProject={() => {}}
      preview={null} onOpen={() => {}} onClose={onClose} />)
    fireEvent.click(screen.getByLabelText('关闭文件浏览'))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
