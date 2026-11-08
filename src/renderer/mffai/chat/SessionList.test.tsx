import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { SessionList } from './SessionList'
import { summary } from '../test/sessions'

const rows = () => [...document.querySelectorAll('.mffai-sess')] as HTMLElement[]
const rowOf = (title: string) => rows().find((r) => r.querySelector('.mffai-sess-title')?.textContent === title)!

function mount(p: Partial<Parameters<typeof SessionList>[0]> = {}) {
  const props = {
    sessions: [
      summary('a', { title: '本机', updatedAt: 3, pendingApprovals: 2 }),
      summary('b', { title: '手机', origin: 'im', audience: 'group', updatedAt: 9, open: { turnId: 't', parked: true } }),
      summary('c', { title: '编辑器', origin: 'acp', updatedAt: 5, open: { turnId: 't', parked: false } }),
      summary('d', { title: '定时', origin: 'schedule', updatedAt: 1 }),
    ],
    imNames: new Map([['b', 'Alice']]),
    active: 'a',
    onSelect: vi.fn(), onRename: vi.fn(async () => true), onDelete: vi.fn(),
    ...p,
  }
  render(<SessionList {...props} />)
  return props
}

describe('SessionList', () => {
  it('rows newest first with origin icons, 群聊, the Telegram name, the pending dot, 挂起 and 运行中', () => {
    mount()
    expect(rows().map((r) => r.querySelector('.mffai-sess-title')!.textContent)).toEqual(['手机', '编辑器', '本机', '定时'])
    expect(rows().map((r) => r.querySelector('.mffai-origin')!.getAttribute('data-origin'))).toEqual(['im', 'acp', 'app', 'schedule'])
    expect(rows().map((r) => r.querySelector('.mffai-origin')!.getAttribute('aria-label'))).toEqual(['IM 渠道', '编辑器', '本机', '定时'])
    const im = rowOf('手机')
    expect(within(im).getByText('群聊')).toBeInTheDocument()
    expect(within(im).getByText('Alice')).toBeInTheDocument()
    expect(within(im).getByText('挂起')).toBeInTheDocument()
    expect(within(im).queryByText('运行中')).toBeNull()
    expect(within(rowOf('编辑器')).getByText('运行中')).toBeInTheDocument()
    expect(within(rowOf('编辑器')).queryByText('挂起')).toBeNull()
    const dot = rowOf('本机').querySelector('.mffai-sess-dot')!
    expect(dot.textContent).toBe('2')
    expect(dot.getAttribute('aria-label')).toBe('待批 2')
    expect(rowOf('定时').querySelector('.mffai-sess-dot')).toBeNull()
    expect(within(rowOf('本机')).queryByText('群聊')).toBeNull()
    expect(rowOf('本机').className).toContain('on')
    expect(rowOf('手机').className).not.toContain('on')
  })

  it('an unknown origin uses the schedule icon and never throws', () => {
    mount({ sessions: [summary('x', { title: 'x' })].map((s) => ({ ...s, origin: 'pager' as never })) })
    expect(rows()[0].querySelector('.mffai-origin')!.getAttribute('data-origin')).toBe('schedule')
  })

  it('a click selects', () => {
    const p = mount()
    fireEvent.click(rowOf('手机'))
    expect(p.onSelect).toHaveBeenCalledWith('b')
  })

  it('rename by double click: Enter saves the trimmed title, Esc cancels', async () => {
    const p = mount()
    fireEvent.doubleClick(rowOf('本机').querySelector('.mffai-sess-title')!)
    const input = screen.getByRole('textbox', { name: '标题' }) as HTMLInputElement
    expect(input.value).toBe('本机')
    expect(input.getAttribute('placeholder')).toBeNull()
    fireEvent.change(input, { target: { value: '  新名字 ' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(p.onRename).not.toHaveBeenCalled()

    fireEvent.doubleClick(rowOf('本机').querySelector('.mffai-sess-title')!)
    fireEvent.change(screen.getByRole('textbox', { name: '标题' }), { target: { value: '  新名字 ' } })
    await act(async () => { fireEvent.keyDown(screen.getByRole('textbox', { name: '标题' }), { key: 'Enter' }) })
    expect(p.onRename).toHaveBeenCalledWith('a', '新名字')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('rename from the row menu; a failed save keeps the editor open with 失败', async () => {
    const p = mount({ onRename: vi.fn(async () => false) })
    fireEvent.click(within(rowOf('定时')).getByRole('button', { name: '更多' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '改名' }))
    const input = screen.getByRole('textbox', { name: '标题' })
    fireEvent.change(input, { target: { value: 'x' } })
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    expect(p.onRename).toHaveBeenCalledWith('d', 'x')
    expect(screen.getByRole('textbox', { name: '标题' })).toBeInTheDocument()
    expect(screen.getByText('失败')).toBeInTheDocument()
  })

  it('an empty or unchanged title does not call rename', async () => {
    const p = mount()
    for (const v of ['   ', '本机']) {
      fireEvent.doubleClick(rowOf('本机').querySelector('.mffai-sess-title')!)
      fireEvent.change(screen.getByRole('textbox', { name: '标题' }), { target: { value: v } })
      await act(async () => { fireEvent.keyDown(screen.getByRole('textbox', { name: '标题' }), { key: 'Enter' }) })
      expect(screen.queryByRole('textbox')).toBeNull()
    }
    expect(p.onRename).not.toHaveBeenCalled()
  })

  it('删除 from the row menu; disabled while a turn is open', () => {
    const p = mount()
    fireEvent.click(within(rowOf('编辑器')).getByRole('button', { name: '更多' }))
    const del = screen.getByRole('menuitem', { name: '删除' }) as HTMLButtonElement
    expect(del.disabled).toBe(true)
    fireEvent.click(del)
    expect(p.onDelete).not.toHaveBeenCalled()
    fireEvent.click(within(rowOf('本机')).getByRole('button', { name: '更多' }))
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    expect(p.onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }))
    expect(p.onSelect).not.toHaveBeenCalled()
  })
})
