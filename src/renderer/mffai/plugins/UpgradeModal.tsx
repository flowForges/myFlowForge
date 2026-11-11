// 升级同意的弹窗(08b spec R11):遮罩 + 760px 的框,里面是今天的 Staging(带 current)。Esc 关;点遮罩不关:
// 关掉就卸载 Staging,没确认的暂存会被取消,误点遮罩不该丢掉一次升级。弹窗自己不发任何调用。
// 开着时整个 mff-ai 视图里它盖住的东西(rail、页头、详情头、左列)都 inert,Tab 出不去;关掉后焦点由调用方放回(PluginDetail 放回头里的 升级)。
import { useEffect, useRef, type ReactNode } from 'react'
import { useInertOutside } from '../ui/inert'

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
