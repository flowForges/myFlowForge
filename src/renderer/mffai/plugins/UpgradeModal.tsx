// 升级同意的弹窗(08b spec R11):遮罩 + 760px 的框,里面是今天的 Staging(带 current)。Esc 关;点遮罩不关:
// 关掉就卸载 Staging,没确认的暂存会被取消,误点遮罩不该丢掉一次升级。弹窗自己不发任何调用。
import { useEffect, useRef, type ReactNode } from 'react'

export function UpgradeModal({ children, onClose }: { children: ReactNode; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    ref.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) close.current() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); prev?.focus?.() }
  }, [])
  return (
    <div className="mffai-umodal-scrim">
      <div ref={ref} className="mffai-modal mffai-umodal" role="dialog" aria-modal="true" aria-label="升级" tabIndex={-1}>
        {children}
      </div>
    </div>
  )
}
