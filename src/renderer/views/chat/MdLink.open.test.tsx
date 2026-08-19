import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MdLink } from './MdLink'
import { OpenFileCtx } from './openFile'
import type { OpenFileApi, OpenFileResult } from './openFile'

const api = (open: (href: string) => Promise<OpenFileResult>): OpenFileApi => ({ bases: ['/w'], open })

beforeEach(() => {
  ;(window as any).forge = { openExternal: vi.fn(async () => ({ ok: true })) }
})

describe('MdLink 打开工作区文件', () => {
  it('相对路径链接点击 → 交给 OpenFileCtx,不导航', () => {
    const open = vi.fn(async () => 'ok' as const)
    render(
      <OpenFileCtx.Provider value={api(open)}>
        <MdLink href="docs/design.md">设计文档</MdLink>
      </OpenFileCtx.Provider>,
    )
    const a = screen.getByText('设计文档')
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    a.dispatchEvent(ev)
    expect(open).toHaveBeenCalledWith('docs/design.md')
    // 硬要求:绝不能真导航(相对路径会把整个 SPA 走白屏)
    expect(ev.defaultPrevented).toBe(true)
    expect((window as any).forge.openExternal).not.toHaveBeenCalled()
  })

  it('http 链接仍然外开,不走文件通道', () => {
    const open = vi.fn(async () => 'ok' as const)
    render(
      <OpenFileCtx.Provider value={api(open)}>
        <MdLink href="https://example.com/a">站点</MdLink>
      </OpenFileCtx.Provider>,
    )
    fireEvent.click(screen.getByText('站点'))
    expect((window as any).forge.openExternal).toHaveBeenCalledWith('https://example.com/a')
    expect(open).not.toHaveBeenCalled()
  })

  it('没有 ctx 时保持原来的静默 no-op(零回归)', () => {
    render(<MdLink href="docs/design.md">设计文档</MdLink>)
    const a = screen.getByText('设计文档')
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    a.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect((window as any).forge.openExternal).not.toHaveBeenCalled()
  })

  it('打不开时挂一条提示,2 秒后自己消失', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      render(
        <OpenFileCtx.Provider value={api(async () => 'missing')}>
          <MdLink href="docs/nope.md">缺的文档</MdLink>
        </OpenFileCtx.Provider>,
      )
      fireEvent.click(screen.getByText('缺的文档'))
      await waitFor(() => expect(screen.getByText('文件不存在')).toBeInTheDocument())
      await act(async () => { vi.advanceTimersByTime(2100) })
      expect(screen.queryByText('文件不存在')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('越界给的是「不在工作区内」而不是「文件不存在」', async () => {
    render(
      <OpenFileCtx.Provider value={api(async () => 'outside')}>
        <MdLink href="../../../etc/hosts">看这个</MdLink>
      </OpenFileCtx.Provider>,
    )
    fireEvent.click(screen.getByText('看这个'))
    await waitFor(() => expect(screen.getByText('不在工作区内')).toBeInTheDocument())
  })

  it('mailto: 不当文件,不触发打开', () => {
    const open = vi.fn(async () => 'ok' as const)
    render(
      <OpenFileCtx.Provider value={api(open)}>
        <MdLink href="mailto:a@b.com">邮件</MdLink>
      </OpenFileCtx.Provider>,
    )
    fireEvent.click(screen.getByText('邮件'))
    expect(open).not.toHaveBeenCalled()
    expect((window as any).forge.openExternal).not.toHaveBeenCalled()
  })
})
