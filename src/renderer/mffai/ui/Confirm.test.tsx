import { describe, it, expect, vi, afterEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Confirm } from './Confirm'

describe('Confirm', () => {
  it('renders item: value rows and keep rows, confirm and cancel', () => {
    const onConfirm = vi.fn(), onCancel = vi.fn()
    const { container } = render(
      <Confirm title="删除会话" rows={[['会话', '修 bug'], ['运行', '2']]} keep={['仓库里的 worktree 登记']}
        confirmLabel="删除" danger onCancel={onCancel} onConfirm={onConfirm} />,
    )
    expect(container.querySelector('.confirm-overlay')).not.toBeNull()
    expect(container.querySelector('.confirm-card')).not.toBeNull()
    expect(screen.getByRole('dialog')).toHaveTextContent('删除会话')
    const rows = [...container.querySelectorAll('.mffai-confirm-row')].map((r) => [...r.children].map((c) => c.textContent))
    expect(rows).toEqual([['会话', '修 bug'], ['运行', '2'], ['保留', '仓库里的 worktree 登记']])
    expect(screen.getByText('删除').className).toBe('confirm-danger')
    fireEvent.click(screen.getByText('删除'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('取消'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('not danger -> neutral button', () => {
    render(<Confirm title="t" rows={[]} confirmLabel="好" onCancel={() => {}} onConfirm={() => {}} />)
    expect(screen.getByText('好').className).toBe('confirm-ok')
  })

  it('requireTyped: disabled until the exact text, a near miss stays disabled', () => {
    const onConfirm = vi.fn()
    render(<Confirm title="信任" rows={[]} confirmLabel="信任" requireTyped="plugin.json" onCancel={() => {}} onConfirm={onConfirm} />)
    const btn = screen.getByRole('button', { name: '信任' }) as HTMLButtonElement
    const input = screen.getByRole('textbox')
    expect(input.getAttribute('placeholder')).toBeNull()
    expect(input.getAttribute('aria-label')).not.toContain('plugin.json')
    expect(btn.disabled).toBe(true)
    for (const near of ['plugin.jso', 'plugin.json ', ' plugin.json', 'Plugin.json', 'plugin.jsonx']) {
      fireEvent.change(input, { target: { value: near } })
      expect(btn.disabled, near).toBe(true)
      fireEvent.click(btn)
    }
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'plugin.json' } })
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('busy disables confirm', () => {
    render(<Confirm title="t" rows={[]} confirmLabel="好" busy onCancel={() => {}} onConfirm={() => {}} />)
    expect((screen.getByText('好') as HTMLButtonElement).disabled).toBe(true)
  })

  describe('anchored to a button', () => {
    const rect = (x: number, y: number, w: number, h: number) => ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON: () => ({}) }) as DOMRect
    const viewport = (w: number, h: number) => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: w })
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: h })
    }
    const anchorAt = (r: DOMRect) => {
      const a = document.createElement('button')
      a.getBoundingClientRect = () => r
      document.body.appendChild(a)
      return a
    }
    const CARD = { w: 460, h: 200 }
    const orig = HTMLElement.prototype.getBoundingClientRect
    const iw = window.innerWidth, ih = window.innerHeight
    afterEach(() => { HTMLElement.prototype.getBoundingClientRect = orig; viewport(iw, ih); document.body.innerHTML = '' })
    const sizeCards = () => {
      HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
        return this.classList.contains('confirm-card') ? rect(0, 0, CARD.w, CARD.h) : orig.call(this)
      }
    }

    it('near the bottom-right corner the card stays inside the viewport; confirm, cancel and an outside click unchanged', () => {
      viewport(1280, 800)
      sizeCards()
      const onConfirm = vi.fn(), onCancel = vi.fn()
      const { container } = render(<Confirm title="合并" rows={[['运行', 'r1']]} confirmLabel="合并" anchor={anchorAt(rect(1200, 700, 80, 30))} onCancel={onCancel} onConfirm={onConfirm} />)
      const overlay = container.querySelector('.confirm-overlay')!
      expect(overlay.classList.contains('mffai-anchored')).toBe(true)
      const card = container.querySelector('.confirm-card') as HTMLElement
      const top = parseFloat(card.style.top), left = parseFloat(card.style.left)
      expect(Number.isFinite(top) && Number.isFinite(left)).toBe(true)
      expect(top).toBeGreaterThanOrEqual(0)
      expect(left).toBeGreaterThanOrEqual(0)
      expect(top + CARD.h).toBeLessThanOrEqual(800)
      expect(left + CARD.w).toBeLessThanOrEqual(1280)
      // 下面放不下 → 翻到按钮上方
      expect(top + CARD.h).toBeLessThanOrEqual(700)
      expect(screen.getByText('合并', { selector: 'button' }).className).toBe('confirm-ok')
      fireEvent.click(screen.getByText('合并', { selector: 'button' }))
      expect(onConfirm).toHaveBeenCalledTimes(1)
      fireEvent.click(screen.getByText('取消'))
      expect(onCancel).toHaveBeenCalledTimes(1)
      fireEvent.click(overlay)
      expect(onCancel).toHaveBeenCalledTimes(2)
    })

    it('with room below, the card sits under the button, right edges aligned', () => {
      viewport(1280, 800)
      sizeCards()
      const { container } = render(<Confirm title="t" rows={[]} confirmLabel="好" anchor={anchorAt(rect(600, 100, 80, 30))} onCancel={() => {}} onConfirm={() => {}} />)
      const card = container.querySelector('.confirm-card') as HTMLElement
      expect(parseFloat(card.style.top)).toBeGreaterThanOrEqual(130)
      expect(parseFloat(card.style.left) + CARD.w).toBe(680)
    })

    it('near the left edge it flips to align left', () => {
      viewport(1280, 800)
      sizeCards()
      const { container } = render(<Confirm title="t" rows={[]} confirmLabel="好" anchor={anchorAt(rect(20, 100, 80, 30))} onCancel={() => {}} onConfirm={() => {}} />)
      const card = container.querySelector('.confirm-card') as HTMLElement
      expect(parseFloat(card.style.left)).toBe(20)
    })

    it('a zero rect (jsdom, detached) renders centred as today', () => {
      const { container } = render(<Confirm title="t" rows={[]} confirmLabel="好" anchor={anchorAt(rect(0, 0, 0, 0))} onCancel={() => {}} onConfirm={() => {}} />)
      expect(container.querySelector('.confirm-overlay')!.className).toBe('confirm-overlay on')
      expect((container.querySelector('.confirm-card') as HTMLElement).getAttribute('style')).toBeNull()
      const { container: c2 } = render(<Confirm title="t" rows={[]} confirmLabel="好" anchor={null} onCancel={() => {}} onConfirm={() => {}} />)
      expect(c2.querySelector('.confirm-overlay')!.className).toBe('confirm-overlay on')
    })

    it('requireTyped near miss stays disabled with an anchor; busy too', () => {
      viewport(1280, 800)
      sizeCards()
      const onConfirm = vi.fn()
      const { rerender } = render(<Confirm title="信任" rows={[]} confirmLabel="信任" requireTyped="plugin.json" anchor={anchorAt(rect(1200, 700, 80, 30))} onCancel={() => {}} onConfirm={onConfirm} />)
      const btn = screen.getByRole('button', { name: '信任' }) as HTMLButtonElement
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'plugin.jso' } })
      expect(btn.disabled).toBe(true)
      fireEvent.click(btn)
      expect(onConfirm).not.toHaveBeenCalled()
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'plugin.json' } })
      expect(btn.disabled).toBe(false)
      rerender(<Confirm title="信任" rows={[]} confirmLabel="信任" requireTyped="plugin.json" busy anchor={anchorAt(rect(1200, 700, 80, 30))} onCancel={() => {}} onConfirm={onConfirm} />)
      expect((screen.getByRole('button', { name: '信任' }) as HTMLButtonElement).disabled).toBe(true)
    })
  })
})
