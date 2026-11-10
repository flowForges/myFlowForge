// 添加账号的右侧抽屉(08b spec §2.3):遮罩 + 一块侧板,里面是 AddAccount。Esc、遮罩、× 关;关掉就卸载孩子,
// 没有提交的 key 也跟着没了。
import { useEffect, useRef, type ReactNode } from 'react'
import { Icon } from '../shell/icons'

export function AddAccountDrawer({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    ref.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) close.current() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); prev?.focus?.() }
  }, [open])
  if (!open) return null
  return (
    <>
      <div className="mffai-drawer-dim" onClick={onClose} />
      <aside ref={ref} className="mffai-drawer" aria-label="添加账号" tabIndex={-1}>
        <div className="mffai-drawer-head">
          <Icon name="plus" size={15} />
          <span className="mffai-drawer-title">添加账号</span>
          <span className="mffai-spring" />
          <button className="mffai-iconbtn" aria-label="关闭" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div className="mffai-drawer-body">{children}</div>
      </aside>
    </>
  )
}
