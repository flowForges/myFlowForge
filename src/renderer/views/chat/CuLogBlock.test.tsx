import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, waitFor, act, renderHook } from '@testing-library/react'
import { CuTurnBlock, useCuTurnOpen } from './CuLogBlock'
import type { CuLogEntry } from '../../../main/computerUse/types'

const e = (over: Partial<CuLogEntry>): CuLogEntry => ({ ts: Date.UTC(2026, 10, 12, 8, 5, 9), turn: 1, op: 'click', result: 'allowed', ...over })

describe('CuLogBlock', () => {
  it('renders nothing for an empty log', () => {
    const { container } = render(<CuTurnBlock open onToggle={() => {}} rows={[]} thumb={async () => null} />)
    expect(container.firstChild).toBeNull()
  })

  it('one row per entry with action, target app and a result chip', () => {
    const entries = [
      e({ op: 'click', app: 'Safari', at: { x: 812, y: 433 }, result: 'allowed' }),
      e({ op: 'type', app: 'Notes', textLen: 12, result: 'auto' }),
      e({ op: 'key', combo: '⌘⇧T', result: 'denied' }),
      e({ op: 'click', result: 'blocked', code: 'blocked_app' }),
      e({ op: 'screenshot', result: 'failed', code: 'user_active' }),
    ]
    const { container } = render(<CuTurnBlock open onToggle={() => {}} rows={entries} thumb={async () => null} />)
    const rows = container.querySelectorAll('.cu-log-row')
    expect(rows).toHaveLength(5)
    expect(rows[0].textContent).toContain('点击 (812, 433)')
    expect(rows[0].textContent).toContain('Safari')
    expect(rows[0].querySelector('.cu-res')?.textContent).toBe('已允许')
    expect(rows[1].textContent).toContain('输入 12 字')
    expect(rows[1].querySelector('.cu-res')?.textContent).toBe('自动')
    expect(rows[2].textContent).toContain('⌘⇧T')
    expect(rows[2].querySelector('.cu-res')?.textContent).toBe('已拒绝')
    expect(rows[3].querySelector('.cu-res')?.textContent).toBe('已拦截')
    expect(rows[4].textContent).toContain('截图')
    expect(rows[4].querySelector('.cu-res')?.textContent).toBe('失败')
  })

  it('typed text never appears in the log: only 输入 N 字, even if an entry still carries a preview', () => {
    const { container } = render(<CuTurnBlock open onToggle={() => {}} rows={[e({ op: 'type', textLen: 5, textPreview: 'hunter2' })]} thumb={async () => null} />)
    expect(container.querySelector('.cu-text')).toBeNull()
    expect(container.textContent).not.toContain('hunter2')
    expect(container.textContent).toContain('输入 5 字')
  })

  it('semantic act row: verb + role + element name, from actLabel/element (Task 10)', () => {
    const entries = [
      e({ op: 'act', app: 'WorkBuddy', bundleId: 'com.example.workbuddy', element: { role: 'button', name: '新建会话' }, actLabel: '点击', result: 'auto', delivery: 'delivered_verified' }),
      e({ op: 'act', app: 'WorkBuddy', element: { role: 'textfield', name: '输入消息' }, actLabel: '输入', result: 'auto', delivery: 'delivered_unverified' }),
    ]
    const { container } = render(<CuTurnBlock open onToggle={() => {}} rows={entries} thumb={async () => null} />)
    const rows = container.querySelectorAll('.cu-log-row')
    expect(rows[0].textContent).toContain('点击 按钮「新建会话」')
    expect(rows[0].textContent).toContain('WorkBuddy')
    expect(rows[0].querySelector('.cu-res')?.textContent).toBe('已确认')
    expect(rows[1].textContent).toContain('输入 输入框「输入消息」')
    expect(rows[1].querySelector('.cu-res')?.textContent).toBe('未确认')
  })

  it('result chip: delivered_without_effect and uncertain also show 未确认; everything else keeps its usual chip', () => {
    const entries = [
      e({ op: 'act', result: 'auto', delivery: 'delivered_without_effect' }),
      e({ op: 'act', result: 'failed', delivery: 'uncertain', code: 'uncertain' }),
      e({ op: 'launch', result: 'denied' }),
      e({ op: 'act', result: 'blocked', code: 'blocked_app' }),
    ]
    const { container } = render(<CuTurnBlock open onToggle={() => {}} rows={entries} thumb={async () => null} />)
    const rows = container.querySelectorAll('.cu-log-row')
    expect(rows[0].querySelector('.cu-res')?.textContent).toBe('未确认')
    expect(rows[1].querySelector('.cu-res')?.textContent).toBe('未确认')
    expect(rows[2].querySelector('.cu-res')?.textContent).toBe('已拒绝')
    expect(rows[3].querySelector('.cu-res')?.textContent).toBe('已拦截')
  })

  it('element names in the log are plain text too: whitespace collapsed, markup not parsed', () => {
    const { container } = render(<CuTurnBlock open onToggle={() => {}} rows={[e({ op: 'act', element: { role: 'button', name: 'a\n\n<b>b</b>' }, actLabel: '点击' })]} thumb={async () => null} />)
    expect(container.querySelector('b')).toBeNull()
    expect(container.textContent).not.toContain('\n')
  })


  it('fetches a thumb only for rows that have one; clicking it opens the Lightbox with that image', async () => {
    // actionLog.thumb() answers raw base64; the block builds the data URL itself
    const thumb = vi.fn(async (f: string) => (f === '00000001.jpg' ? 'ZZZ' : null))
    const { container } = render(<CuTurnBlock open onToggle={() => {}} rows={[e({ thumb: '00000001.jpg' }), e({ op: 'type' })]} thumb={thumb} />)
    await waitFor(() => expect(container.querySelector('img.cu-thumb')).toBeTruthy())
    expect(thumb).toHaveBeenCalledTimes(1)
    expect(thumb).toHaveBeenCalledWith('00000001.jpg')
    fireEvent.click(container.querySelector('button.cu-thumb-btn')!)
    const big = document.querySelector('.lightbox-img') as HTMLImageElement
    expect(big.src).toBe('data:image/jpeg;base64,ZZZ')
    fireEvent.click(screen.getByLabelText('关闭'))
    expect(document.querySelector('.lightbox')).toBeNull()
  })

  it('a thumb answer that is not plain base64 is dropped: no https:, no data: of another type, no quotes', async () => {
    for (const bad of ['https://evil.example/x.png', 'data:image/svg+xml;base64,AAA', 'AAA" onerror="x', '']) {
      const thumb = vi.fn(async () => bad)
      const { container, unmount } = render(<CuTurnBlock open onToggle={() => {}} rows={[e({ thumb: '00000001.jpg' })]} thumb={thumb} />)
      await waitFor(() => expect(thumb).toHaveBeenCalled())
      await new Promise((r) => setTimeout(r, 0))
      expect(container.querySelector('img')).toBeNull()
      unmount()
    }
  })

  it('no explanatory text', () => {
    const { container } = render(<CuTurnBlock open onToggle={() => {}} rows={[e({ app: 'A' })]} thumb={async () => null} />)
    expect(container.querySelector('p, small')).toBeNull()
    container.querySelectorAll('*').forEach((el) => expect(String(el.getAttribute('class') ?? '')).not.toMatch(/hint|desc|help|note|tip|caption/))
  })

  // rc3 issue 2: the header toggles the block; collapsed shows only the header
  it('the header is a button (电脑 · N 步 + chevron) with aria-expanded; collapsed renders no rows', () => {
    const onToggle = vi.fn()
    const { container, rerender } = render(<CuTurnBlock rows={[e({}), e({})]} open={false} onToggle={onToggle} thumb={async () => null} />)
    const head = screen.getByRole('button', { name: /电脑 · 2 步/ })
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(head.querySelector('.cu-log-caret')).toBeTruthy()
    expect(container.querySelectorAll('.cu-log-row')).toHaveLength(0)
    fireEvent.click(head)
    expect(onToggle).toHaveBeenCalledTimes(1)
    rerender(<CuTurnBlock rows={[e({}), e({})]} open onToggle={onToggle} thumb={async () => null} />)
    expect(screen.getByRole('button', { name: /电脑 · 2 步/ }).getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelectorAll('.cu-log-row')).toHaveLength(2)
  })

  it('useCuTurnOpen: follows the default until the user toggles, then remembers the toggle', () => {
    const { result } = renderHook(() => useCuTurnOpen())
    expect(result.current.isOpen('k', true)).toBe(true)
    expect(result.current.isOpen('k', false)).toBe(false)
    act(() => result.current.toggle('k', true))
    expect(result.current.isOpen('k', true)).toBe(false)
    expect(result.current.isOpen('k', false)).toBe(false) // the running turn finished: the user's choice still wins
    act(() => result.current.toggle('k', false))
    expect(result.current.isOpen('k', false)).toBe(true)
    expect(result.current.isOpen('other', false)).toBe(false)
  })

  it('a running block collapses on click and stays collapsed (wired through the hook)', () => {
    function Harness() {
      const o = useCuTurnOpen()
      const [n] = useState(0)
      return <CuTurnBlock rows={[e({ ts: n + 1 })]} open={o.isOpen('t', true)} onToggle={() => o.toggle('t', true)} thumb={async () => null} />
    }
    const { container } = render(<Harness />)
    expect(container.querySelectorAll('.cu-log-row')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: /电脑 · 1 步/ }))
    expect(container.querySelectorAll('.cu-log-row')).toHaveLength(0)
  })
})
