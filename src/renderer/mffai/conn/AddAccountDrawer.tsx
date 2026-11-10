// 添加账号的右侧抽屉(08b spec §2.3):遮罩 + 一块侧板,里面是 AddAccount。Esc、遮罩、× 关;关掉就卸载孩子,
// 没有提交的 key 也跟着没了。侧板是模态对话框:焦点进第一个输入项,Tab 在里面转圈,关掉回到原处。
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Icon } from '../shell/icons'

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
const FIELD = 'input:not([disabled]), select:not([disabled]), textarea:not([disabled])'

/** 页头底边到 .mffai-main 顶边的距离;量不到(jsdom、不在页里)就交给 CSS 的 --mffai-head-h */
function headTop(el: HTMLElement | null): number | null {
  const main = el?.closest('.mffai-main')
  const head = main?.querySelector(':scope > .mffai-head')
  if (!main || !head) return null
  const top = head.getBoundingClientRect().bottom - main.getBoundingClientRect().top
  return top > 0 ? top : null
}

export function AddAccountDrawer({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const [top, setTop] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (!open) return
    const measure = () => setTop(headTop(ref.current))
    measure()
    const head = ref.current?.closest('.mffai-main')?.querySelector(':scope > .mffai-head')
    if (!head || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(head)
    return () => ro.disconnect()
  }, [open])
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    const box = ref.current
    ;(box?.querySelector<HTMLElement>(`.mffai-drawer-body :is(${FIELD})`) ?? box)?.focus()
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) close.current() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); prev?.focus?.() }
  }, [open])
  const trap = (e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !ref.current) return
    const all = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
    if (!all.length) { e.preventDefault(); return }
    const first = all[0], last = all[all.length - 1], at = document.activeElement
    if (e.shiftKey && (at === first || at === ref.current)) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus() }
  }
  if (!open) return null
  const pos = top === null ? undefined : { top }
  return (
    <>
      <div className="mffai-drawer-dim" style={pos} onClick={onClose} />
      <aside ref={ref} className="mffai-drawer" role="dialog" aria-modal="true" aria-label="添加账号" tabIndex={-1} style={pos} onKeyDown={trap}>
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
