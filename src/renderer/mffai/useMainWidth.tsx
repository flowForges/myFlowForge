// 主区宽度(08b §4.4、R4、R5):ResizeObserver 量 .mffai-main。量不到(没有 ResizeObserver,或宽 0,即 jsdom)是 undefined。
import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

const WidthCtx = createContext<number | undefined>(undefined)

export function MainWidthProvider({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState<number | undefined>(undefined)
  useLayoutEffect(() => {
    const el = ref.current
    const RO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver
    if (!el || typeof RO !== 'function') return
    const ro = new RO((entries) => {
      const e = entries[entries.length - 1]
      if (!e) return
      const w = e.borderBoxSize?.[0]?.inlineSize ?? e.contentRect.width
      setWidth(w > 0 ? w : undefined)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <div ref={ref} className="mffai-main">
      <WidthCtx.Provider value={width}>{children}</WidthCtx.Provider>
    </div>
  )
}

export function useMainWidth(): number | undefined {
  return useContext(WidthCtx)
}
