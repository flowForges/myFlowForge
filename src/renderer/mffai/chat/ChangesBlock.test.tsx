import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { FileDiff } from '@mffai/protocol'
import { ChangesBlock } from './ChangesBlock'
import { callError } from '../test/fakeForge'

const diffOf = (path: string, patch: Partial<FileDiff> = {}): FileDiff => ({ path, status: 'M', binary: false, truncated: false, lines: [{ kind: 'add', ln: 1, text: `+${path}` }], ...patch })

describe('ChangesBlock', () => {
  it('lists the files with their status; a click shows that file\'s diff, flags included', async () => {
    const diff = vi.fn(async (p: string) => diffOf(p, p === 'b.bin' ? { binary: true, lines: [] } : { truncated: true }))
    const load = vi.fn(async () => ({ files: [{ path: 'a.ts', status: 'M' as const }, { path: 'b.bin', status: 'A' as const }] }))
    const { container } = render(<ChangesBlock load={load} diff={diff} />)
    await screen.findByText('a.ts')
    expect([...container.querySelectorAll('.mffai-file')].map((r) => r.textContent)).toEqual(['Ma.ts', 'Ab.bin'])
    await act(async () => { fireEvent.click(screen.getByText('a.ts')) })
    expect(diff).toHaveBeenCalledWith('a.ts')
    expect(screen.getByText('+a.ts')).toBeInTheDocument()
    expect(screen.getByText('已截断')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByText('b.bin')) })
    expect(screen.getByText('二进制')).toBeInTheDocument()
    // 只能点清单里的:每次调用的路径都来自 load 的结果
    expect(diff.mock.calls.map((c) => c[0])).toEqual(['a.ts', 'b.bin'])
  })

  it('source cli: paths only, no diff; concurrent shows its chip', async () => {
    const diff = vi.fn()
    render(<ChangesBlock load={async () => ({ files: [{ path: 'x.md', status: 'M' }], source: 'cli', concurrent: true })} diff={diff} />)
    await screen.findByText('x.md')
    expect(screen.queryByRole('button', { name: /x\.md/ })).toBeNull()
    fireEvent.click(screen.getByText('x.md'))
    expect(diff).not.toHaveBeenCalled()
    expect(screen.getByText('同时有其他改动')).toBeInTheDocument()
  })

  it('a load that is unsupported shows 不支持; any other failure 失败; a failed diff 失败', async () => {
    const { unmount } = render(<ChangesBlock load={async () => { throw callError(-32601) }} diff={vi.fn()} />)
    await screen.findByText('不支持')
    unmount()
    render(<ChangesBlock load={async () => ({ files: [{ path: 'a', status: 'D' }] })} diff={async () => { throw callError(-32602, 'path not in the change list') }} />)
    const a = await screen.findByText('a')
    await act(async () => { fireEvent.click(a) })
    expect(screen.getByText('失败')).toBeInTheDocument()
  })
})
