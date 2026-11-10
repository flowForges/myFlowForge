import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'

const GAP = 6
const EDGE = 8

/** 卡片放在按钮旁:默认在下方、右边对齐;下面放不下翻到上方,左边出界改成左边对齐;最后夹在视口里 */
export function placeNear(a: DOMRect, w: number, h: number, vw: number, vh: number): { top: number; left: number } {
  let top = a.bottom + GAP
  if (top + h > vh - EDGE && a.top - GAP - h >= EDGE) top = a.top - GAP - h
  let left = a.right - w
  if (left < EDGE) left = a.left
  const clamp = (v: number, max: number) => Math.max(EDGE, Math.min(v, max))
  return { top: clamp(top, vh - EDGE - h), left: clamp(left, vw - EDGE - w) }
}

// 自己的确认框,只复用 .confirm-* 样式:shell/ActionConfirm 带一段说明文字,这里只有"项:值"行(08 §6.4)。
export function Confirm({ title, rows, keep, confirmLabel, danger, busy, requireTyped, typedLabel = '逐字输入', anchor, onCancel, onConfirm, children }: {
  title: string
  /** 项、值,可选第三格放这一行的按钮(如 `去合并`) */
  rows: readonly (readonly [string, ReactNode, ReactNode?])[]
  /** 不删、留着的东西,每条一行 `保留` */
  keep?: readonly string[]
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  /** 要逐字输入这段文字(两边都按 NFC 比),确认按钮才可用 */
  requireTyped?: string
  /** 输入框的无障碍名:不能是答案本身 */
  typedLabel?: string
  onCancel: () => void
  onConfirm: () => void
  /** 行下面的状态块(`失败`、`不支持`) */
  children?: ReactNode
  /** 触发它的按钮:量得到位置就把卡片贴在按钮旁(遮罩透明),量不到就照旧居中 */
  anchor?: HTMLElement | null
}) {
  const [typed, setTyped] = useState('')
  const card = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  useLayoutEffect(() => {
    if (!anchor) { setPos(null); return }
    const place = () => {
      const a = anchor.getBoundingClientRect()
      if (!a.width && !a.height) { setPos(null); return }
      const c = card.current?.getBoundingClientRect()
      setPos(placeNear(a, c?.width ?? 0, c?.height ?? 0, window.innerWidth, window.innerHeight))
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchor])
  // 贴在按钮旁时:焦点进卡片(要逐字输入就进输入框,否则进 取消),关掉后回到按钮
  useEffect(() => {
    if (!anchor) return
    const box = card.current
    ;(box?.querySelector<HTMLElement>('.mffai-typed') ?? box?.querySelector<HTMLElement>('.confirm-cancel'))?.focus()
    return () => { if (anchor.isConnected) anchor.focus() }
  }, [anchor])
  const busyRef = useRef(busy)
  busyRef.current = busy
  const onKey = (e: KeyboardEvent) => {
    if (!anchor || e.key !== 'Escape') return
    e.stopPropagation()
    if (!busyRef.current) onCancel()
  }
  const style: CSSProperties | undefined = pos ? { top: pos.top, left: pos.left } : undefined
  const blocked = busy || (requireTyped !== undefined && typed.normalize('NFC') !== requireTyped.normalize('NFC'))
  const all: readonly (readonly [string, ReactNode, ReactNode?])[] = [...rows, ...(keep ?? []).map((k) => ['保留', k] as const)]
  return (
    <div className={pos ? 'confirm-overlay on mffai-anchored' : 'confirm-overlay on'} onClick={onCancel} onKeyDown={onKey}>
      <div ref={card} style={style} className="confirm-card mffai-confirm" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="confirm-title">{title}</div>
        {all.length > 0 && (
          <div className="mffai-confirm-rows">
            {all.map(([k, v, action], i) => (
              <div key={i} className="mffai-confirm-row"><span className="mffai-k">{k}</span><span className="mffai-v">{v}</span>{action}</div>
            ))}
          </div>
        )}
        {children}
        {requireTyped !== undefined && (
          <input className="mffai-typed" aria-label={typedLabel} value={typed} onChange={(e) => setTyped(e.target.value)} />
        )}
        <div className="confirm-actions">
          <button className="confirm-cancel" onClick={onCancel}>取消</button>
          <button className={danger ? 'confirm-danger' : 'confirm-ok'} disabled={blocked} onClick={() => { if (!blocked) onConfirm() }}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
