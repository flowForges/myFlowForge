import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CuLogBlock } from './CuLogBlock'
import type { CuLogEntry } from '../../../main/computerUse/types'

const e = (over: Partial<CuLogEntry>): CuLogEntry => ({ ts: Date.UTC(2026, 10, 12, 8, 5, 9), turn: 1, op: 'click', result: 'allowed', ...over })

describe('CuLogBlock', () => {
  it('renders nothing for an empty log', () => {
    const { container } = render(<CuLogBlock entries={[]} thumb={async () => null} />)
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
    const { container } = render(<CuLogBlock entries={entries} thumb={async () => null} />)
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
    const { container } = render(<CuLogBlock entries={[e({ op: 'type', textLen: 5, textPreview: 'hunter2' })]} thumb={async () => null} />)
    expect(container.querySelector('.cu-text')).toBeNull()
    expect(container.textContent).not.toContain('hunter2')
    expect(container.textContent).toContain('输入 5 字')
  })

  it('one block per turn', () => {
    const { container } = render(<CuLogBlock entries={[e({ turn: 1 }), e({ turn: 2 }), e({ turn: 2 })]} thumb={async () => null} />)
    expect(container.querySelectorAll('.cu-log')).toHaveLength(2)
  })

  it('fetches a thumb only for rows that have one; clicking it opens the Lightbox with that image', async () => {
    // actionLog.thumb() answers raw base64; the block builds the data URL itself
    const thumb = vi.fn(async (f: string) => (f === '00000001.jpg' ? 'ZZZ' : null))
    const { container } = render(<CuLogBlock entries={[e({ thumb: '00000001.jpg' }), e({ op: 'type' })]} thumb={thumb} />)
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
      const { container, unmount } = render(<CuLogBlock entries={[e({ thumb: '00000001.jpg' })]} thumb={thumb} />)
      await waitFor(() => expect(thumb).toHaveBeenCalled())
      await new Promise((r) => setTimeout(r, 0))
      expect(container.querySelector('img')).toBeNull()
      unmount()
    }
  })

  it('no explanatory text', () => {
    const { container } = render(<CuLogBlock entries={[e({ app: 'A' })]} thumb={async () => null} />)
    expect(container.querySelector('p, small')).toBeNull()
    container.querySelectorAll('*').forEach((el) => expect(String(el.getAttribute('class') ?? '')).not.toMatch(/hint|desc|help|note|tip|caption/))
  })
})
