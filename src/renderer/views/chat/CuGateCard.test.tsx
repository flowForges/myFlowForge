import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { CuGateCard } from './CuGateCard'
import type { CuGate } from '../../../main/computerUse/types'

const key = { workspacePath: '/ws', sessionId: 's1' }
const mk = (over: Partial<CuGate>): CuGate => ({ id: 'g1', key, kind: 'action', ts: 1, ...over })
const row = (container: HTMLElement, name: string) => {
  const r = Array.from(container.querySelectorAll('.cu-row')).find((el) => el.querySelector('.cu-k')?.textContent === name)
  if (!r) throw new Error('no row ' + name)
  return r as HTMLElement
}

describe('CuGateCard', () => {
  it('click: trusted rows (app with bundle id, position, button/count/mods) above a bordered crop row named 屏幕', () => {
    const { container } = render(<CuGateCard gate={mk({
      action: { kind: 'click', app: 'Safari', bundleId: 'com.apple.Safari', at: { x: 812, y: 433 }, button: 'left', count: 2, mods: ['cmd'] },
      crop: 'QUJD', reason: '始终询问',
    })} onResolve={() => {}} />)
    expect(screen.getByText('电脑 · 点击')).toBeTruthy()
    expect(row(container, '应用').textContent).toContain('Safari · com.apple.Safari')
    expect(row(container, '位置').textContent).toContain('(812, 433)')
    expect(row(container, '按键').textContent).toContain('左键 ×2 · ⌘')
    expect(container.querySelector('.cu-chip.cu-reason')?.textContent).toBe('始终询问')
    const crop = row(container, '屏幕')
    const img = crop.querySelector('img') as HTMLImageElement
    expect(img.src).toBe('data:image/jpeg;base64,QUJD')
    expect(crop.querySelector('.cu-crop')).toBeTruthy()
    // trusted rows come first, the crop row last
    const rows = Array.from(container.querySelectorAll('.cu-row'))
    expect(rows[rows.length - 1]).toBe(crop)
  })

  it('type: marked text block with ⏎ ⇥ ␛ and the N 字 chip', () => {
    const text = 'a\nb\tc\u001bd'
    const { container } = render(<CuGateCard gate={mk({ action: { kind: 'type', app: 'Notes', bundleId: 'com.apple.Notes', text: 'hello world!' } })} onResolve={() => {}} />)
    expect(screen.getByText('电脑 · 输入')).toBeTruthy()
    expect(screen.getByText('12 字')).toBeTruthy()
    render(<CuGateCard gate={mk({ id: 'g2', action: { kind: 'type', text } })} onResolve={() => {}} />)
    const blocks = container.ownerDocument.querySelectorAll('.cu-text')
    expect(blocks[1].textContent).toBe('a⏎b⇥c␛d')
    expect(blocks[1].hasAttribute('data-untrusted')).toBe(true)
  })

  it('key: keycap chips; paste reason adds the 剪贴板: 粘贴 row', () => {
    const { container } = render(<CuGateCard gate={mk({ action: { kind: 'key', app: 'Notes', combo: '⌘⇧V', mods: ['cmd', 'shift'] }, reason: '剪贴板' })} onResolve={() => {}} />)
    const caps = Array.from(row(container, '按键').querySelectorAll('.cu-cap')).map((e) => e.textContent)
    expect(caps).toEqual(['⌘', '⇧', 'V'])
    expect(row(container, '剪贴板').textContent).toContain('粘贴')
    expect(container.querySelector('.cu-chip.cu-reason')?.textContent).toBe('剪贴板')
  })

  it('scroll and drag rows', () => {
    const a = render(<CuGateCard gate={mk({ action: { kind: 'scroll', app: 'Finder', at: { x: 1, y: 2 }, dy: 3, dx: 0 } })} onResolve={() => {}} />)
    expect(row(a.container, '滚动').textContent).toContain('↓3 →0')
    const b = render(<CuGateCard gate={mk({ id: 'g3', action: { kind: 'drag', app: 'Finder', toApp: 'Notes', at: { x: 1, y: 2 }, to: { x: 5, y: 6 } } })} onResolve={() => {}} />)
    expect(row(b.container, '从').textContent).toContain('Finder')
    expect(row(b.container, '到').textContent).toContain('Notes')
  })

  it('screen-derived names are plain text: whitespace collapsed, long values cut from the left, markup not parsed', () => {
    const name = '  x'.repeat(5) + '<b>evil</b>' + 'z'.repeat(80) + 'TAIL'
    const { container } = render(<CuGateCard gate={mk({ action: { kind: 'click', app: name, at: { x: 1, y: 1 } } })} onResolve={() => {}} />)
    const v = row(container, '应用').textContent!
    expect(v.startsWith('应用')).toBe(true)
    expect(v.endsWith('TAIL')).toBe(true)
    expect(v).toContain('…')
    expect(container.querySelector('b')).toBeNull()
  })

  it('buttons resolve with the right decision; none is focused after mount and there is no key handler', () => {
    const onResolve = vi.fn()
    const { container } = render(<CuGateCard gate={mk({ action: { kind: 'click', at: { x: 1, y: 1 } } })} onResolve={onResolve} />)
    expect(container.contains(document.activeElement) && document.activeElement !== document.body).toBe(false)
    container.querySelectorAll('button').forEach((b) => expect(b.hasAttribute('autofocus')).toBe(false))
    fireEvent.keyDown(container.firstChild as Element, { key: 'Enter' })
    expect(onResolve).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '允许' }))
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    expect(onResolve.mock.calls).toEqual([['g1', 'allow'], ['g1', 'deny'], ['g1', 'stop']])
  })

  it('continue gate: 继续 100 步 allows, 停止 stops', () => {
    const onResolve = vi.fn()
    render(<CuGateCard gate={mk({ kind: 'continue', reason: '已执行 100 步' })} onResolve={onResolve} />)
    expect(screen.getByText('电脑 · 继续')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '继续 100 步' }))
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    expect(onResolve.mock.calls).toEqual([['g1', 'allow'], ['g1', 'stop']])
  })

  it('no explanatory text: no <p>, no <small>, no hint-like class', () => {
    const { container } = render(<CuGateCard gate={mk({ action: { kind: 'type', app: 'A', text: 'x' }, crop: 'QQ==', reason: '终端' })} onResolve={() => {}} />)
    expect(container.querySelector('p, small')).toBeNull()
    container.querySelectorAll('*').forEach((el) => expect(String(el.getAttribute('class') ?? '')).not.toMatch(/hint|desc|help|note|tip|caption/))
    expect(within(container).queryByText(/^(提示|说明)/)).toBeNull()
  })
})
