import { it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WsMenu } from './WsMenu'

const items = (onA: () => void, onB: () => void) => [
  { key: 'a', label: '操作甲', icon: <i />, onClick: onA },
  { key: 'b', label: '删除乙', icon: <i />, danger: true, onClick: onB },
]

// jsdom 不做布局,getBoundingClientRect 恒为 0 —— 但翻转判定是纯算术,把按钮矩形与弹层高度
// 桩掉就能验。按 class 分派:.ws-menu-btn 给按钮矩形,.ws-menu-pop 给弹层高度。
const realRect = Element.prototype.getBoundingClientRect
function stubGeometry(btn: { top: number; bottom: number; right: number }, popHeight: number) {
  Element.prototype.getBoundingClientRect = function () {
    if ((this as HTMLElement).classList?.contains('ws-menu-btn')) {
      return { top: btn.top, bottom: btn.bottom, left: btn.right - 26, right: btn.right, width: 26, height: btn.bottom - btn.top } as DOMRect
    }
    if ((this as HTMLElement).classList?.contains('ws-menu-pop')) {
      return { top: 0, bottom: popHeight, left: 0, right: 180, width: 180, height: popHeight } as DOMRect
    }
    return realRect.call(this)
  }
}
afterEach(() => { Element.prototype.getBoundingClientRect = realRect })

const pop = () => document.querySelector('.ws-menu-pop') as HTMLElement

it('is closed by default and opens on click, revealing icon+text items', () => {
  render(<WsMenu items={items(() => {}, () => {})} />)
  expect(screen.queryByText('操作甲')).toBeNull()
  fireEvent.click(screen.getByTitle('更多操作'))
  expect(screen.getByText('操作甲')).toBeInTheDocument()
  expect(screen.getByText('删除乙')).toBeInTheDocument()
})

it('runs the item handler and closes the menu', () => {
  const onA = vi.fn()
  render(<WsMenu items={items(onA, () => {})} />)
  fireEvent.click(screen.getByTitle('更多操作'))
  fireEvent.click(screen.getByText('操作甲'))
  expect(onA).toHaveBeenCalledOnce()
  // menu closes after choosing an item
  expect(screen.queryByText('操作甲')).toBeNull()
})

it('closes on outside click without firing any handler', () => {
  const onA = vi.fn()
  render(<div><WsMenu items={items(onA, () => {})} /><button>外部</button></div>)
  fireEvent.click(screen.getByTitle('更多操作'))
  expect(screen.getByText('操作甲')).toBeInTheDocument()
  fireEvent.click(screen.getByText('外部'))
  expect(screen.queryByText('操作甲')).toBeNull()
  expect(onA).not.toHaveBeenCalled()
})

// ---- 弹层定位:侧栏是 overflow-y:auto 的滚动容器,absolute 弹层会被它裁掉(工作区靠底部时看不见) ----

it('portals the popup to <body> so the sidebar scroller cannot clip it', () => {
  stubGeometry({ top: 100, bottom: 120, right: 240 }, 230)
  const { container } = render(<WsMenu items={items(() => {}, () => {})} />)
  fireEvent.click(screen.getByTitle('更多操作'))
  expect(pop()).toBeTruthy()
  // 关键:弹层不再是 .ws-menu 的后代(否则任何祖先的 overflow 都能裁它)
  expect(container.contains(pop())).toBe(false)
  expect(pop().closest('.ws-menu')).toBeNull()
  expect(pop().parentElement).toBe(document.body)
})

it('drops downward when there is room below the button', () => {
  stubGeometry({ top: 100, bottom: 120, right: 240 }, 230)
  render(<WsMenu items={items(() => {}, () => {})} />)
  fireEvent.click(screen.getByTitle('更多操作'))
  expect(pop().style.top).toBe('124px')      // 按钮底边 + 4
  expect(pop().style.bottom).toBe('')
  expect(pop().style.right).toBe(`${window.innerWidth - 240}px`)
})

it('flips upward when the button sits near the bottom (the reported bug)', () => {
  // 视口 768:按钮底边 700,下方只剩 68px,放不下 230px 的菜单;上方有 696px。
  stubGeometry({ top: 680, bottom: 700, right: 240 }, 230)
  render(<WsMenu items={items(() => {}, () => {})} />)
  fireEvent.click(screen.getByTitle('更多操作'))
  expect(pop().style.bottom).toBe(`${window.innerHeight - 680 + 4}px`)   // 贴在按钮上沿
  expect(pop().style.top).toBe('')
})

it('clamps the popup height to the available space instead of overflowing', () => {
  // 上下都放不下 700px 的菜单 → 取空间更大的一侧并限高滚动
  stubGeometry({ top: 300, bottom: 320, right: 240 }, 700)
  render(<WsMenu items={items(() => {}, () => {})} />)
  fireEvent.click(screen.getByTitle('更多操作'))
  const maxH = parseFloat(pop().style.maxHeight)
  expect(maxH).toBeGreaterThan(0)
  expect(maxH).toBeLessThanOrEqual(window.innerHeight)
})

it('falls back to the row when the ⋯ button is display:none (collapsed sidebar right-click)', () => {
  Element.prototype.getBoundingClientRect = function () {
    const el = this as HTMLElement
    // 折叠态:.ws-actions display:none → 按钮量出全 0
    if (el.classList?.contains('ws-menu-btn')) return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 } as DOMRect
    if (el.classList?.contains('ws-item')) return { top: 200, bottom: 232, left: 8, right: 60, width: 52, height: 32 } as DOMRect
    if (el.classList?.contains('ws-menu-pop')) return { top: 0, bottom: 230, left: 0, right: 180, width: 180, height: 230 } as DOMRect
    return realRect.call(this)
  }
  render(
    <button className="ws-item"><WsMenu items={items(() => {}, () => {})} open onOpenChange={() => {}} /></button>,
  )
  expect(pop().style.top).toBe('236px')                                  // 行底边 + 4
  expect(pop().style.right).toBe(`${window.innerWidth - 60}px`)
})

it('closes when the sidebar scrolls (a fixed popup would otherwise strand)', () => {
  stubGeometry({ top: 100, bottom: 120, right: 240 }, 230)
  render(<WsMenu items={items(() => {}, () => {})} />)
  fireEvent.click(screen.getByTitle('更多操作'))
  expect(screen.getByText('操作甲')).toBeInTheDocument()
  fireEvent.scroll(document, {})
  expect(screen.queryByText('操作甲')).toBeNull()
})
