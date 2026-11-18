import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { CuOverlayState } from '@shared/computerUse'
import { OverlayApp, actionLine, type CuOverlayApi } from './OverlayApp'

function harness(physical = false) {
  let push: (s: CuOverlayState) => void = () => {}
  const api = {
    onState: (cb: (s: CuOverlayState) => void) => { push = cb; return () => {} },
    resolve: vi.fn<(id: string, d: 'allow' | 'deny' | 'stop') => void>(), stop: vi.fn<() => void>(), openMain: vi.fn<() => void>(),
  } satisfies CuOverlayApi
  const r = render(<OverlayApp api={api} isPhysical={() => physical} />)
  return { ...r, api, push: (s: CuOverlayState) => act(() => push(s)) }
}

const ON: CuOverlayState = { session: { workspacePath: '/w', sessionId: 's', title: '修 bug', mode: 'ask' }, gate: null, actionSeq: 0, hotkeyFailed: false }
const CLICK: CuOverlayState = {
  ...ON,
  gate: { id: 'cug.1', kind: 'action', crop: 'Y3JvcA==', action: { kind: 'click', at: { x: 812, y: 433 }, app: 'Safari', bundleId: 'com.apple.Safari', button: 'left', count: 2, mods: ['cmd'] } },
}
const CONT: CuOverlayState = { ...ON, gate: { id: 'cug.2', kind: 'continue', reason: '已执行 100 步 · 继续 100 步' } }

/** a press the OS reported: mousedown on the button, then its click */
const press = (el: Element) => { fireEvent.mouseDown(el); fireEvent.click(el, { detail: 1 }) }

describe('OverlayApp', () => {
  it('renders nothing before a state with a session arrives', () => {
    const t = harness()
    expect(t.container.innerHTML).toBe('')
    t.push({ ...ON, session: null })
    expect(t.container.innerHTML).toBe('')
  })

  it('the pill: ● 电脑 · <title> · <mode chip>, 打开主窗口 and 停止, which stops everything', () => {
    const t = harness()
    t.push(ON)
    expect(t.container.querySelector('.cuo-pill')!.textContent).toBe('●电脑 · 修 bug · 每次询问打开主窗口停止')
    expect(t.container.querySelector('.cuo-chip')!.textContent).toBe('每次询问')
    t.push({ ...ON, session: { ...ON.session!, mode: 'allow' } })
    expect(t.container.querySelector('.cuo-chip')!.textContent).toBe('放行')
    fireEvent.click(screen.getByText('停止'))
    expect(t.api.stop).toHaveBeenCalledTimes(1)
  })

  it('a pending gate shows the crop, one action line and 允许 / 拒绝', () => {
    const t = harness(true)
    t.push(CLICK)
    expect(t.container.querySelector('img.cuo-crop')!.getAttribute('src')).toBe('data:image/jpeg;base64,Y3JvcA==')
    expect(t.container.querySelector('.cuo-line')!.textContent).toBe('点击 (812, 433) · 左键 ×2 · ⌘ · Safari')
    press(screen.getByText('允许'))
    expect(t.api.resolve).toHaveBeenCalledWith('cug.1', 'allow')
    press(screen.getByText('拒绝'))
    expect(t.api.resolve).toHaveBeenLastCalledWith('cug.1', 'deny')
  })

  it('允许 needs a physical press: a synthetic click, a click without its mousedown, or a keypress does nothing', () => {
    const t = harness(false)
    t.push(CLICK)
    const allow = screen.getByText('允许')
    press(allow)
    expect(t.api.resolve).not.toHaveBeenCalled()
    const t2 = harness(true)
    t2.push(CLICK)
    const allow2 = t2.container.querySelectorAll('button.cuo-allow')[0]
    fireEvent.click(allow2, { detail: 1 })
    fireEvent.keyDown(allow2, { key: 'Enter' })
    fireEvent.keyUp(allow2, { key: 'Enter' })
    fireEvent.click(allow2, { detail: 0 })   // keyboard activation reports detail 0
    expect(t2.api.resolve).not.toHaveBeenCalled()
    // mousedown on 拒绝, click on 允许: not the same press
    fireEvent.mouseDown(t2.container.querySelector('button.cuo-deny')!)
    fireEvent.click(allow2, { detail: 1 })
    expect(t2.api.resolve).not.toHaveBeenCalled()
  })

  it('M-1: a press is keyed by the gate: mousedown on one gate\'s 允许, click after the next gate replaced it, does nothing', () => {
    const t = harness(true)
    t.push(CLICK)
    fireEvent.mouseDown(screen.getByText('允许'))
    t.push({ ...CLICK, gate: { ...CLICK.gate!, id: 'cug.9' } })
    fireEvent.click(screen.getByText('允许'), { detail: 1 })
    expect(t.api.resolve).not.toHaveBeenCalled()
    press(screen.getByText('允许'))
    expect(t.api.resolve).toHaveBeenCalledWith('cug.9', 'allow')
  })

  it('M-3: a stop hotkey the OS refused shows as a chip in the pill', () => {
    const t = harness()
    t.push(ON)
    expect(t.container.querySelector('.cuo-chip-warn')).toBeNull()
    t.push({ ...ON, hotkeyFailed: true })
    expect(t.container.querySelector('.cuo-chip-warn')!.textContent).toBe('急停键未注册')
  })

  it('a stale mousedown (over a second) does not count', () => {
    const now = vi.spyOn(performance, 'now')
    now.mockReturnValue(1000)
    const t = harness(true)
    t.push(CLICK)
    const allow = screen.getByText('允许')
    fireEvent.mouseDown(allow)
    now.mockReturnValue(2500)
    fireEvent.click(allow, { detail: 1 })
    expect(t.api.resolve).not.toHaveBeenCalled()
    now.mockRestore()
  })

  it('the continue gate: its reason, 继续 100 步 (allow) and 停止 (stop)', () => {
    const t = harness(true)
    t.push(CONT)
    expect(t.container.querySelector('.cuo-line')!.textContent).toBe('已执行 100 步 · 继续 100 步')
    expect(t.container.querySelector('img')).toBeNull()
    press(screen.getByText('继续 100 步'))
    expect(t.api.resolve).toHaveBeenCalledWith('cug.2', 'allow')
    const stops = screen.getAllByText('停止')
    press(stops[stops.length - 1])
    expect(t.api.resolve).toHaveBeenLastCalledWith('cug.2', 'stop')
  })

  it('打开主窗口 is always in the pill and calls openMain; 收起主窗口 is gone', () => {
    const t = harness()
    t.push(ON)
    expect(screen.queryByText('收起主窗口')).toBeNull()
    fireEvent.click(screen.getByText('打开主窗口'))
    expect(t.api.openMain).toHaveBeenCalledTimes(1)
    t.push(CLICK)
    expect(screen.getAllByText('打开主窗口')).toHaveLength(1)
    expect(screen.queryByText('收起主窗口')).toBeNull()
  })

  it('no button has focus after mount, none has autofocus, and no explanatory text elements (Review Focus 17)', () => {
    const t = harness()
    t.push(CLICK)
    expect(document.activeElement === document.body || document.activeElement === null).toBe(true)
    for (const b of t.container.querySelectorAll('button')) expect(b.hasAttribute('autofocus')).toBe(false)
    expect(t.container.querySelector('p, small')).toBeNull()
    for (const el of t.container.querySelectorAll('[class]')) expect(el.className).not.toMatch(/hint|desc|help|note|tip|caption/)
  })

  it('screen-derived strings render as plain text, whitespace collapsed, long values cut from the left', () => {
    const t = harness()
    const app = 'Evil\n\n<b>App</b>' + 'x'.repeat(80) + 'TAIL'
    t.push({ ...CLICK, gate: { ...CLICK.gate!, action: { kind: 'click', at: { x: 1, y: 2 }, app } } })
    const line = t.container.querySelector('.cuo-line')!
    expect(line.querySelector('b')).toBeNull()
    expect(line.textContent).not.toContain('\n')
    expect(line.textContent!.endsWith('TAIL')).toBe(true)
    expect(line.textContent).toContain('…')
  })
})

describe('actionLine', () => {
  it('covers every kind; typed text shows with control characters made visible', () => {
    expect(actionLine({ kind: 'move', at: { x: 1, y: 2 } })).toBe('移动 (1, 2)')
    expect(actionLine({ kind: 'drag', at: { x: 1, y: 2 }, to: { x: 3, y: 4 }, app: 'Finder', toApp: 'Finder' })).toBe('拖动 (1, 2) → (3, 4) · Finder → Finder')
    expect(actionLine({ kind: 'scroll', at: { x: 1, y: 2 }, dy: 3, dx: 0, app: 'Notes' })).toBe('滚动 ↓3 →0 · Notes')
    expect(actionLine({ kind: 'scroll', at: { x: 1, y: 2 }, dy: -2, dx: -1 })).toBe('滚动 ↑2 ←1')
    expect(actionLine({ kind: 'type', text: 'a\nb\tc', app: 'TextEdit' })).toBe('输入 5 字 · a⏎b⇥c · TextEdit')
    expect(actionLine({ kind: 'key', combo: '⌘⇧T', app: 'Safari' })).toBe('按键 ⌘⇧T · Safari')
  })

  it('T10 fix round 1 (reviewer finding 1): the semantic kinds read as a full sentence, not just elementPhrase — launch/focus get a verb, appKey shows its combo, act shows its typed text and flags', () => {
    expect(actionLine({ kind: 'launch', app: { name: 'Terminal', bundleId: 'com.apple.Terminal' }, actLabel: '打开' })).toBe('打开 Terminal')
    expect(actionLine({ kind: 'focus', app: { name: 'Finder', bundleId: 'com.apple.finder' }, actLabel: '聚焦' })).toBe('聚焦 Finder')

    const key = actionLine({ kind: 'appKey', app: { name: 'Notes', bundleId: 'com.apple.Notes' }, actLabel: '按键', combo: '⌘⇧V' })
    expect(key).toBe('在 Notes 中按键 · ⌘⇧V')
    expect(key).toContain('⌘⇧V')

    const click = actionLine({ kind: 'act', app: { name: 'WorkBuddy', bundleId: 'x' }, element: { role: 'button', name: '新建会话' }, actLabel: '点击' })
    expect(click).toBe('在 WorkBuddy 中点击 按钮「新建会话」')

    const typed = actionLine({ kind: 'act', app: { name: 'WorkBuddy', bundleId: 'x' }, element: { role: 'textfield', name: '输入消息' }, actLabel: '输入', text: '你好' })
    expect(typed).toContain('你好')
    expect(typed).toContain('2 字')

    const physical = actionLine({ kind: 'act', app: { name: 'WorkBuddy', bundleId: 'x' }, element: { role: 'button' }, actLabel: '点击', physical: true })
    expect(physical).toContain('移动鼠标点击')

    const replace = actionLine({ kind: 'act', app: { name: 'WorkBuddy', bundleId: 'x' }, element: { role: 'textfield' }, actLabel: '设置', replace: true })
    expect(replace).toContain('替换原有内容')

    const scroll = actionLine({ kind: 'act', app: { name: 'WorkBuddy', bundleId: 'x' }, element: { role: 'list' }, actLabel: '滚动', direction: 'down', amount: 3 })
    expect(scroll).toContain('↓ ×3')
  })

  it('M-13: the mini card puts the trusted line (reason chip, action, bundle id) above the crop', () => {
    const t = harness(true)
    t.push({ ...CLICK, gate: { ...CLICK.gate!, reason: '终端', action: { ...CLICK.gate!.action!, bundleId: 'com.googlecode.iterm2' } } })
    const card = t.container.querySelector('.cuo-card')!
    expect(card.querySelector('.cuo-chip.cuo-reason')!.textContent).toBe('终端')
    expect(card.querySelector('.cuo-bundle')!.textContent).toBe('com.googlecode.iterm2')
    const order = Array.from(card.querySelectorAll('.cuo-line, .cuo-bundle, .cuo-reason, img.cuo-crop')).map((e) => e.className.split(' ').at(-1))
    expect(order.indexOf('cuo-crop')).toBe(order.length - 1)
    // the continue gate has no reason chip: its reason is the line itself
    t.push(CONT)
    expect(t.container.querySelector('.cuo-reason')).toBeNull()
    expect(t.container.querySelector('.cuo-line')!.textContent).toBe('已执行 100 步 · 继续 100 步')
  })

  it('M-13: a hostile bundle id is plain text, collapsed and cut from the left', () => {
    const t = harness(true)
    const bad = '<b>x</b>\n' + 'y'.repeat(80) + 'TAIL'
    t.push({ ...CLICK, gate: { ...CLICK.gate!, action: { ...CLICK.gate!.action!, bundleId: bad } } })
    const v = t.container.querySelector('.cuo-bundle')!.textContent!
    expect(v.endsWith('TAIL')).toBe(true)
    expect(v.startsWith('…')).toBe(true)
    expect(t.container.querySelector('.cuo-card b')).toBeNull()
  })
})
