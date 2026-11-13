import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { CU_RESOLVE_ERR } from '@shared/computerUse'
import { CuGateCard } from './CuGateCard'
import type { CuGate } from '../../../main/computerUse/types'

const key = { workspacePath: '/ws', sessionId: 's1' }
const mk = (over: Partial<CuGate>): CuGate => ({ id: 'g1', key, kind: 'action', ts: 1, ...over })
const row = (container: HTMLElement, name: string) => {
  const r = Array.from(container.querySelectorAll('.cu-row')).find((el) => el.querySelector('.cu-k')?.textContent === name)
  if (!r) throw new Error('no row ' + name)
  return r as HTMLElement
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'performance'] }); vi.setSystemTime(1_000_000) })
afterEach(() => { vi.useRealTimers() })
const settle = () => vi.setSystemTime(Date.now() + 700)
const yes = () => true
/** a press the OS reported: mousedown on the button, then its click with a click count */
const press = (el: Element) => { fireEvent.mouseDown(el); fireEvent.click(el, { detail: 1 }) }

describe('CuGateCard', () => {
  it('click: trusted rows (app with bundle id, position, button/count/mods) above a bordered crop row named 屏幕', () => {
    const { container } = render(<CuGateCard isPhysical={yes} gate={mk({
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
    const { container } = render(<CuGateCard isPhysical={yes} gate={mk({ action: { kind: 'type', app: 'Notes', bundleId: 'com.apple.Notes', text: 'hello world!' } })} onResolve={() => {}} />)
    expect(screen.getByText('电脑 · 输入')).toBeTruthy()
    expect(screen.getByText('12 字')).toBeTruthy()
    render(<CuGateCard isPhysical={yes} gate={mk({ id: 'g2', action: { kind: 'type', text } })} onResolve={() => {}} />)
    const blocks = container.ownerDocument.querySelectorAll('.cu-text')
    expect(blocks[1].textContent).toBe('a⏎b⇥c␛d')
    expect(blocks[1].hasAttribute('data-untrusted')).toBe(true)
  })

  it('key: keycap chips; paste reason adds the 剪贴板: 粘贴 row', () => {
    const { container } = render(<CuGateCard isPhysical={yes} gate={mk({ action: { kind: 'key', app: 'Notes', combo: '⌘⇧V', mods: ['cmd', 'shift'] }, reason: '剪贴板' })} onResolve={() => {}} />)
    const caps = Array.from(row(container, '按键').querySelectorAll('.cu-cap')).map((e) => e.textContent)
    expect(caps).toEqual(['⌘', '⇧', 'V'])
    expect(row(container, '剪贴板').textContent).toContain('粘贴')
    expect(container.querySelector('.cu-chip.cu-reason')?.textContent).toBe('剪贴板')
  })

  it('scroll and drag rows', () => {
    const a = render(<CuGateCard isPhysical={yes} gate={mk({ action: { kind: 'scroll', app: 'Finder', at: { x: 1, y: 2 }, dy: 3, dx: 0 } })} onResolve={() => {}} />)
    expect(row(a.container, '滚动').textContent).toContain('↓3 →0')
    const b = render(<CuGateCard isPhysical={yes} gate={mk({ id: 'g3', action: { kind: 'drag', app: 'Finder', toApp: 'Notes', at: { x: 1, y: 2 }, to: { x: 5, y: 6 } } })} onResolve={() => {}} />)
    expect(row(b.container, '从').textContent).toContain('Finder')
    expect(row(b.container, '到').textContent).toContain('Notes')
  })

  it('screen-derived names are plain text: whitespace collapsed, long values cut from the left, markup not parsed', () => {
    const name = '  x'.repeat(5) + '<b>evil</b>' + 'z'.repeat(80) + 'TAIL'
    const { container } = render(<CuGateCard isPhysical={yes} gate={mk({ action: { kind: 'click', app: name, at: { x: 1, y: 1 } } })} onResolve={() => {}} />)
    const v = row(container, '应用').textContent!
    expect(v.startsWith('应用')).toBe(true)
    expect(v.endsWith('TAIL')).toBe(true)
    expect(v).toContain('…')
    expect(container.querySelector('b')).toBeNull()
  })

  it('buttons resolve with the right decision; none is focused after mount and there is no key handler', () => {
    const onResolve = vi.fn()
    const { container } = render(<CuGateCard isPhysical={yes} gate={mk({ action: { kind: 'click', at: { x: 1, y: 1 } } })} onResolve={onResolve} />)
    expect(container.contains(document.activeElement) && document.activeElement !== document.body).toBe(false)
    container.querySelectorAll('button').forEach((b) => expect(b.hasAttribute('autofocus')).toBe(false))
    fireEvent.keyDown(container.firstChild as Element, { key: 'Enter' })
    settle()
    expect(onResolve).not.toHaveBeenCalled()
    press(screen.getByRole('button', { name: '允许' }))
    expect(onResolve.mock.calls).toEqual([['g1', 'allow']])
  })

  it.each([['允许', 'allow'], ['拒绝', 'deny'], ['停止', 'stop']])('%s resolves %s', (name, d) => {
    const onResolve = vi.fn()
    render(<CuGateCard isPhysical={yes} gate={mk({ action: { kind: 'click', at: { x: 1, y: 1 } } })} onResolve={onResolve} />)
    settle()
    press(screen.getByRole('button', { name }))
    expect(onResolve.mock.calls).toEqual([['g1', d]])
  })

  it('a card resolves once: a second click (any button) is ignored', () => {
    const onResolve = vi.fn()
    render(<CuGateCard isPhysical={yes} gate={mk({ action: { kind: 'click', at: { x: 1, y: 1 } } })} onResolve={onResolve} />)
    settle()
    press(screen.getByRole('button', { name: '允许' }))
    press(screen.getByRole('button', { name: '允许' }))
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
    expect(onResolve).toHaveBeenCalledTimes(1)
  })

  it('a double click cannot approve the next gate: card B mounts under the second click and ignores it for ~600 ms', () => {
    const onResolve = vi.fn()
    const a = mk({ id: 'A', action: { kind: 'click', at: { x: 1, y: 1 } } })
    const b = mk({ id: 'B', action: { kind: 'type', text: 'rm -rf' } })
    const { rerender } = render(<CuGateCard isPhysical={yes} key="A" gate={a} onResolve={onResolve} />)
    settle()
    press(screen.getByRole('button', { name: '允许' }))   // first click answers A
    rerender(<CuGateCard isPhysical={yes} key="B" gate={b} onResolve={onResolve} />)   // B takes its place
    press(screen.getByRole('button', { name: '允许' }))   // the second click of the double click
    expect(onResolve.mock.calls).toEqual([['A', 'allow']])
    vi.setSystemTime(Date.now() + 599)
    press(screen.getByRole('button', { name: '允许' }))
    expect(onResolve).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + 5)
    press(screen.getByRole('button', { name: '允许' }))
    expect(onResolve.mock.calls).toEqual([['A', 'allow'], ['B', 'allow']])
  })

  it('shows the refusal code from main as a chip on the card', () => {
    const { container } = render(<CuGateCard isPhysical={yes} gate={mk({ action: { kind: 'click', at: { x: 1, y: 1 } } })} error="not_pending" onResolve={() => {}} />)
    expect(container.querySelector('.cu-chip.cu-code')?.textContent).toBe(CU_RESOLVE_ERR.not_pending)   // M-14: never the raw code
  })

  it('the 应用 row has the bundle id in its own span; a drag shows the target bundle id too', () => {
    const a = render(<CuGateCard isPhysical={yes} gate={mk({ action: { kind: 'click', app: 'Safari', bundleId: 'com.apple.Safari', at: { x: 1, y: 1 } } })} onResolve={() => {}} />)
    expect(row(a.container, '应用').querySelector('.cu-bundle')?.textContent).toBe('com.apple.Safari')
    const b = render(<CuGateCard isPhysical={yes} gate={mk({ id: 'g9', action: { kind: 'drag', app: 'Finder', bundleId: 'com.apple.finder', toApp: 'Notes', toBundle: 'com.apple.Notes', at: { x: 1, y: 2 }, to: { x: 5, y: 6 } } })} onResolve={() => {}} />)
    expect(row(b.container, '到').querySelector('.cu-bundle')?.textContent).toBe('com.apple.Notes')
    expect(row(b.container, '从').querySelector('.cu-bundle')?.textContent).toBe('com.apple.finder')
  })

  it('continue gate: 继续 100 步 allows, 停止 stops', () => {
    const onResolve = vi.fn()
    render(<CuGateCard isPhysical={yes} gate={mk({ kind: 'continue', reason: '已执行 100 步' })} onResolve={onResolve} />)
    expect(screen.getByText('电脑 · 继续')).toBeTruthy()
    settle()
    press(screen.getByRole('button', { name: '继续 100 步' }))
    expect(onResolve.mock.calls).toEqual([['g1', 'allow']])
  })

  it('no explanatory text: no <p>, no <small>, no hint-like class', () => {
    const { container } = render(<CuGateCard isPhysical={yes} gate={mk({ action: { kind: 'type', app: 'A', text: 'x' }, crop: 'QQ==', reason: '终端' })} onResolve={() => {}} />)
    expect(container.querySelector('p, small')).toBeNull()
    container.querySelectorAll('*').forEach((el) => expect(String(el.getAttribute('class') ?? '')).not.toMatch(/hint|desc|help|note|tip|caption/))
    expect(within(container).queryByText(/^(提示|说明)/)).toBeNull()
  })

  describe('I-2: 允许 / 继续 take only a physical press (the overlay check)', () => {
    const btn = (name: string) => screen.getByRole('button', { name })
    it('the default check is isTrusted: a script-dispatched press (jsdom isTrusted:false) does nothing', () => {
      const onResolve = vi.fn()
      render(<CuGateCard gate={mk({ action: { kind: 'click', at: { x: 1, y: 1 } } })} onResolve={onResolve} />)
      settle()
      press(btn('允许'))
      expect(onResolve).not.toHaveBeenCalled()
    })

    it.each([['action', '允许'], ['continue', '继续 100 步']] as const)('%s gate: detail 0 (keyboard / AXPress), no mousedown, or a mousedown elsewhere does nothing', (kind, name) => {
      const onResolve = vi.fn()
      render(<CuGateCard isPhysical={yes} gate={mk({ kind, reason: kind === 'continue' ? '已执行 100 步' : undefined, action: kind === 'action' ? { kind: 'click', at: { x: 1, y: 1 } } : undefined })} onResolve={onResolve} />)
      settle()
      fireEvent.mouseDown(btn(name)); fireEvent.click(btn(name), { detail: 0 })   // AXPress / keyboard report detail 0
      fireEvent.click(btn(name), { detail: 1 })                                     // no mousedown first
      fireEvent.mouseDown(btn('停止')); fireEvent.click(btn(name), { detail: 1 })   // mousedown on another button
      expect(onResolve).not.toHaveBeenCalled()
      press(btn(name))
      expect(onResolve.mock.calls).toEqual([['g1', 'allow']])
    })

    it('a press on another gate\'s 允许 does not carry over: the mousedown is bound to this gate id', () => {
      const onResolve = vi.fn()
      const { rerender } = render(<CuGateCard isPhysical={yes} key="x" gate={mk({ id: 'A', action: { kind: 'click', at: { x: 1, y: 1 } } })} onResolve={onResolve} />)
      settle()
      fireEvent.mouseDown(btn('允许'))
      rerender(<CuGateCard isPhysical={yes} key="x" gate={mk({ id: 'B', action: { kind: 'click', at: { x: 1, y: 1 } } })} onResolve={onResolve} />)
      fireEvent.click(btn('允许'), { detail: 1 })
      expect(onResolve).not.toHaveBeenCalled()
    })

    it('keyboard: Enter on a focused 允许 does nothing (it is not focusable: tabIndex -1); 拒绝 / 停止 stay keyboard-reachable', () => {
      const onResolve = vi.fn()
      render(<CuGateCard isPhysical={yes} gate={mk({ action: { kind: 'click', at: { x: 1, y: 1 } } })} onResolve={onResolve} />)
      settle()
      expect(btn('允许').tabIndex).toBe(-1)
      expect(btn('拒绝').tabIndex).toBe(0)
      expect(btn('停止').tabIndex).toBe(0)
      btn('允许').focus()
      fireEvent.keyDown(btn('允许'), { key: 'Enter' }); fireEvent.click(btn('允许'), { detail: 0 })
      expect(onResolve).not.toHaveBeenCalled()
      btn('拒绝').focus()
      fireEvent.click(btn('拒绝'), { detail: 0 })   // keyboard activation: narrowing is safe
      expect(onResolve.mock.calls).toEqual([['g1', 'deny']])
    })

    it('停止 on the continue gate takes a keyboard click too; 继续 has tabIndex -1', () => {
      const onResolve = vi.fn()
      render(<CuGateCard isPhysical={yes} gate={mk({ kind: 'continue', reason: '已执行 100 步' })} onResolve={onResolve} />)
      settle()
      expect(btn('继续 100 步').tabIndex).toBe(-1)
      fireEvent.click(btn('停止'), { detail: 0 })
      expect(onResolve.mock.calls).toEqual([['g1', 'stop']])
    })
  })
})
