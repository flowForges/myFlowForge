import { useState, type ReactNode } from 'react'

// 自己的确认框,只复用 .confirm-* 样式:shell/ActionConfirm 带一段说明文字,这里只有"项:值"行(08 §6.4)。
export function Confirm({ title, rows, keep, confirmLabel, danger, busy, requireTyped, typedLabel = '逐字输入', onCancel, onConfirm, children }: {
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
}) {
  const [typed, setTyped] = useState('')
  const blocked = busy || (requireTyped !== undefined && typed.normalize('NFC') !== requireTyped.normalize('NFC'))
  const all: readonly (readonly [string, ReactNode, ReactNode?])[] = [...rows, ...(keep ?? []).map((k) => ['保留', k] as const)]
  return (
    <div className="confirm-overlay on" onClick={onCancel}>
      <div className="confirm-card mffai-confirm" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
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
