// 通用二次确认弹层 —— 用于归档/移除等有一定风险、执行前需要用户确认的操作。
// 复用 DeleteConfirm 的 .confirm-* 视觉;danger=true 时用红色确认按钮(删除),否则用中性主按钮。
export function ActionConfirm({
  kicker,
  title,
  copy,
  name,
  confirmLabel,
  danger,
  onCancel,
  onConfirm,
}: {
  kicker?: string
  title: string
  copy: string
  name?: string
  confirmLabel: string
  danger?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="confirm-overlay on" onClick={onCancel}>
      <div className="confirm-card" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
        {kicker && <div className={`confirm-k${danger ? '' : ' neutral'}`}>{kicker}</div>}
        <div className="confirm-title">{title}</div>
        <div className="confirm-copy">{copy}</div>
        {name && <div className="confirm-name">{name}</div>}
        <div className="confirm-actions">
          <button className="confirm-cancel" onClick={onCancel}>取消</button>
          <button className={danger ? 'confirm-danger' : 'confirm-ok'} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
