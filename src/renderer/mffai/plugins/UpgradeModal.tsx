// 升级同意的弹窗(08b spec R11):遮罩 + 760px 的框,里面是今天的 Staging(带 current)。Esc 关;点遮罩不关:
// 关掉就卸载 Staging,没确认的暂存会被取消,误点遮罩不该丢掉一次升级。弹窗自己不发任何调用。
// 开着时插件页里它盖住的东西(详情头、左列)都 inert,Tab 出不去;关掉后焦点由调用方放回(PluginDetail 放回头里的 升级)。
import { useEffect, useRef, type ReactNode, type RefObject } from 'react'

/**
 * 把 el 以外、root(最近的 .mffai-plugins,没有就 body)以内的东西设成 inert:从 el 往上每一层的兄弟都设。
 * 只动自己设的,卸载时还原。首装整页(A)和升级弹窗(B)共用。
 */
export function useInertOutside(ref: RefObject<HTMLElement | null>, on = true) {
  useEffect(() => {
    const el = ref.current
    if (!on || !el) return
    const root = el.closest('.mffai-plugins') ?? document.body
    const set: Element[] = []
    for (let node: Element = el; node !== root && node.parentElement; node = node.parentElement) {
      for (const sib of node.parentElement.children) {
        if (sib === node || sib.hasAttribute('inert')) continue
        sib.setAttribute('inert', '')
        set.push(sib)
      }
      if (node.parentElement === root) break
    }
    return () => { for (const s of set) s.removeAttribute('inert') }
  }, [ref, on])
}

export function UpgradeModal({ children, onClose }: { children: ReactNode; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null)
  const scrim = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useInertOutside(scrim)
  useEffect(() => {
    ref.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) close.current() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  return (
    <div ref={scrim} className="mffai-umodal-scrim">
      <div ref={ref} className="mffai-modal mffai-umodal" role="dialog" aria-modal="true" aria-label="升级" tabIndex={-1}>
        {children}
      </div>
    </div>
  )
}
