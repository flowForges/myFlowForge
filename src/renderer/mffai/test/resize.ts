// jsdom 没有 ResizeObserver(08b R4)。面板布局的测试装这个桩,显式给 .mffai-main 一个宽度。
// 回调同步触发,并包在 act 里,setMainWidth 之后 DOM 已经是新布局。
import { act } from '@testing-library/react'

type Cb = (entries: ResizeObserverEntry[], observer: ResizeObserver) => void

function entry(target: Element, width: number): ResizeObserverEntry {
  const size = [{ inlineSize: width, blockSize: 0 }] as unknown as ReadonlyArray<ResizeObserverSize>
  return {
    target,
    contentRect: { x: 0, y: 0, top: 0, left: 0, width, height: 0, right: width, bottom: 0, toJSON: () => ({}) } as DOMRectReadOnly,
    borderBoxSize: size,
    contentBoxSize: size,
    devicePixelContentBoxSize: size,
  }
}

export function installResize(): { setMainWidth(px: number | undefined): void; uninstall(): void } {
  const g = globalThis as { ResizeObserver?: unknown }
  const had = 'ResizeObserver' in g
  const prev = g.ResizeObserver
  const live = new Set<Stub>()
  let width: number | undefined

  const isMain = (el: Element) => el.classList.contains('mffai-main')

  class Stub {
    readonly targets = new Set<Element>()
    constructor(private readonly cb: Cb) { live.add(this) }
    observe(el: Element) {
      this.targets.add(el)
      if (width !== undefined && isMain(el)) this.fire([el])
    }
    unobserve(el: Element) { this.targets.delete(el) }
    disconnect() { this.targets.clear(); live.delete(this) }
    fire(els: Element[]) {
      const w = width ?? 0
      act(() => { this.cb(els.map((el) => entry(el, w)), this as unknown as ResizeObserver) })
    }
  }

  g.ResizeObserver = Stub
  return {
    setMainWidth(px) {
      width = px
      for (const o of [...live]) {
        const mains = [...o.targets].filter(isMain)
        if (mains.length) o.fire(mains)
      }
    },
    uninstall() {
      live.clear()
      if (had) g.ResizeObserver = prev
      else delete g.ResizeObserver
    },
  }
}
