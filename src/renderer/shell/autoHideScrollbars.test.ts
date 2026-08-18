import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installAutoHideScrollbars, IDLE_MS } from './autoHideScrollbars'

// 只测「滚动停止后隐藏」这一半 —— 显隐规则本身写在 global.css 里,jsdom 不解析 ::-webkit-scrollbar,
// 那部分只能在真 Chrome 里量(已量过:静止 transparent / hover 与 data-scrolling 下 var(--border-2))。
// 这里管的是这个模块唯一的职责:属性什么时候挂上、什么时候摘掉、挂在谁身上。
describe('autoHideScrollbars', () => {
  let uninstall: (() => void) | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = ''
  })
  afterEach(() => {
    uninstall?.()
    uninstall = null
    vi.useRealTimers()
  })

  function scroller(): HTMLElement {
    const el = document.createElement('div')
    el.innerHTML = '<span>inner</span>'
    document.body.appendChild(el)
    return el
  }

  it('滚动时给那个容器挂上 data-scrolling', () => {
    const el = scroller()
    uninstall = installAutoHideScrollbars()

    el.dispatchEvent(new Event('scroll', { bubbles: false }))

    expect(el.hasAttribute('data-scrolling')).toBe(true)
  })

  it('停止滚动 IDLE_MS 后摘掉', () => {
    const el = scroller()
    uninstall = installAutoHideScrollbars()
    el.dispatchEvent(new Event('scroll'))

    vi.advanceTimersByTime(IDLE_MS - 1)
    expect(el.hasAttribute('data-scrolling')).toBe(true)

    vi.advanceTimersByTime(1)
    expect(el.hasAttribute('data-scrolling')).toBe(false)
  })

  it('持续滚动会不断把计时器往后推,不会滚一半就消失', () => {
    const el = scroller()
    uninstall = installAutoHideScrollbars()

    el.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(IDLE_MS - 100)
    el.dispatchEvent(new Event('scroll'))          // 又滚了一下
    vi.advanceTimersByTime(IDLE_MS - 100)          // 累计已远超一个 IDLE_MS

    expect(el.hasAttribute('data-scrolling')).toBe(true)
    vi.advanceTimersByTime(100)
    expect(el.hasAttribute('data-scrolling')).toBe(false)
  })

  it('两个容器各算各的计时器,一个停了不影响另一个', () => {
    const a = scroller()
    const b = scroller()
    uninstall = installAutoHideScrollbars()

    a.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(IDLE_MS - 100)
    b.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(100)                    // a 到点,b 还差 IDLE_MS-100

    expect(a.hasAttribute('data-scrolling')).toBe(false)
    expect(b.hasAttribute('data-scrolling')).toBe(true)
  })

  it('捕获阶段监听:属性挂在真正滚动的那个容器上,不是挂在 document 上', () => {
    // scroll 不冒泡,所以必须靠捕获才收得到深层容器的滚动 —— 这条就是钉死那一点。
    const outer = scroller()
    const inner = document.createElement('div')
    outer.appendChild(inner)
    uninstall = installAutoHideScrollbars()

    inner.dispatchEvent(new Event('scroll'))

    expect(inner.hasAttribute('data-scrolling')).toBe(true)
    expect(outer.hasAttribute('data-scrolling')).toBe(false)
    expect(document.documentElement.hasAttribute('data-scrolling')).toBe(false)
  })

  it('卸载后不再挂属性', () => {
    const el = scroller()
    const off = installAutoHideScrollbars()
    off()

    el.dispatchEvent(new Event('scroll'))

    expect(el.hasAttribute('data-scrolling')).toBe(false)
  })
})
