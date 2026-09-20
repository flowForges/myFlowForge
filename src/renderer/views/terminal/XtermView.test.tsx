import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'

/**
 * ★★这份测试守的是一条:**面板收起的时候,绝对不许去动那个 pty 的尺寸。**
 *
 * 2026-09-04 用户报的三件事(终端里 `git commit` 画成 `git coomit`、重开不在最底部、
 * 重开后旧提示符被截成半行且满屏莫名换行)是**同一个根因**:
 * 面板收起用的是 `height: 0` 而不是 `display: none`,宿主元素还在布局里,ResizeObserver 照样触发,
 * FitAddon 照样量 —— 宽度不变、高度 0,于是 rows 被算成它的下限 **1**,
 * 然后 `termResize(id, cols, 1)` 把真的 pty 也改成了 1 行。
 *
 * 所以断言钉的是 `termResize` 的**调用**,不是像素。
 */

const term = {
  cols: 80, rows: 24,
  open: vi.fn(), loadAddon: vi.fn(), dispose: vi.fn(), write: vi.fn(),
  onData: vi.fn(), refresh: vi.fn(), focus: vi.fn(), scrollToBottom: vi.fn(),
  options: {} as Record<string, unknown>,
}
const fit = {
  // 真实 FitAddon 在高度 0 时会把 rows 算成下限 1 —— 这里照实模拟,否则测的就不是那个 bug。
  fit: vi.fn(() => { term.rows = (host.clientHeight > 0 ? 24 : 1); term.cols = 80 }),
}
// ★必须是构造函数(组件里是 `new Terminal(...)`),箭头函数不能 new。
vi.mock('@xterm/xterm', () => ({ Terminal: vi.fn(function () { return term }) }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(function () { return fit }) }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn(function () { return {} }) }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: vi.fn(function () { return { onContextLoss: vi.fn(), dispose: vi.fn() } }) }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

/** 宿主元素的尺寸:jsdom 不做布局,所以由这里说了算(这正是我们要控制的变量)。 */
const host = { clientWidth: 800, clientHeight: 400 }
let roCallback: (() => void) | null = null

const termResize = vi.fn(async (_id: string, _cols: number, _rows: number) => {})
const termWrite = vi.fn(async (_id: string, _d: string) => {})

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  host.clientWidth = 800; host.clientHeight = 400
  term.cols = 80; term.rows = 24
  roCallback = null
  class RO { constructor(cb: () => void) { roCallback = cb } observe() {} disconnect() {} }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO
  // jsdom 没有 matchMedia(组件用它盯 devicePixelRatio 变化)
  ;(window as unknown as { matchMedia: unknown }).matchMedia = () => ({ addEventListener() {}, removeEventListener() {} })
  Object.defineProperty(HTMLDivElement.prototype, 'clientWidth', { configurable: true, get: () => host.clientWidth })
  Object.defineProperty(HTMLDivElement.prototype, 'clientHeight', { configurable: true, get: () => host.clientHeight })
  ;(window as unknown as { forge: unknown }).forge = {
    termResize, termWrite,
    onTermData: () => () => {},
  }
})
afterEach(() => { vi.useRealTimers() })

/** 触发一次 ResizeObserver + 走完那 90ms 的防抖。 */
const resizeTick = async () => {
  await act(async () => { roCallback?.(); vi.advanceTimersByTime(120) })
}

const mount = async (visible: boolean) => {
  const { XtermView } = await import('./XtermView')
  const font = { fontFamily: 'mono', fontSize: 12 }
  const r = render(<XtermView termId="t1" active={visible} visible={visible} font={font} />)
  await act(async () => { vi.advanceTimersByTime(0) })
  return r
}

describe('★★终端:面板收起时不许动 pty 的尺寸', () => {
  it('★收起(宿主高度 0)时 ResizeObserver 触发 —— 一次 termResize 都不许发', async () => {
    await mount(true)
    termResize.mockClear()
    host.clientHeight = 0                    // 面板收起 = height:0,元素还在,只是高度没了
    await resizeTick()
    expect(termResize).not.toHaveBeenCalled()
  })

  it('★★尤其不许发 rows=1 —— 那正是把 shell 的提示符打烂的那一下', async () => {
    await mount(true)
    termResize.mockClear()
    host.clientHeight = 0
    await resizeTick()
    for (const call of termResize.mock.calls) {
      expect(call[2], `发出了 rows=${call[2]} 的 resize`).toBeGreaterThan(1)
    }
  })

  it('宽度为 0(左右布局里被压没)同样跳过', async () => {
    await mount(true)
    termResize.mockClear()
    host.clientWidth = 0
    await resizeTick()
    expect(termResize).not.toHaveBeenCalled()
  })

  it('尺寸正常时该发还是要发 —— 别把守卫写成「永远不 resize」', async () => {
    await mount(true)
    termResize.mockClear()
    await resizeTick()
    expect(termResize).toHaveBeenCalledWith('t1', 80, 24)
  })
})

describe('★重新展开面板', () => {
  it('★★visible 从 false 变 true 要滚到底 —— 原来盯的是 active,关了再开 active 没变,effect 根本不跑', async () => {
    const { XtermView } = await import('./XtermView')
    const font = { fontFamily: 'mono', fontSize: 12 }
    // 面板收着,但这一页一直是「当前页」——正是用户的场景
    const { rerender } = render(<XtermView termId="t1" active visible={false} font={font} />)
    // ★把挂载时可能排上的 rAF **全部**跑完再清计数 —— 只 advance(0) 的话它会留到下面那次
    //   advance 里才触发,于是即使 effect 盯错了依赖,计数也是「有」,测试假绿(变异验证时抓到的)。
    await act(async () => { vi.advanceTimersByTime(200) })
    term.scrollToBottom.mockClear()

    rerender(<XtermView termId="t1" active visible font={font} />)
    await act(async () => { vi.advanceTimersByTime(50) })
    expect(term.scrollToBottom).toHaveBeenCalled()
  })

  it('展开后按真实尺寸重排一次', async () => {
    const { XtermView } = await import('./XtermView')
    const font = { fontFamily: 'mono', fontSize: 12 }
    const { rerender } = render(<XtermView termId="t1" active visible={false} font={font} />)
    await act(async () => { vi.advanceTimersByTime(200) })
    termResize.mockClear()
    rerender(<XtermView termId="t1" active visible font={font} />)
    await act(async () => { vi.advanceTimersByTime(50) })
    expect(termResize).toHaveBeenCalledWith('t1', 80, 24)
  })
})
