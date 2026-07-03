import type { ReactElement } from 'react'
import type { Toast } from './usePetToasts'

const AV: ReactElement = (
  <svg className="tv" viewBox="0 0 64 64" aria-hidden="true">
    <path d="M32 8c13 0 21 8.5 21 23 0 15-8.5 25-21 25S11 46 11 31C11 16.5 19 8 32 8Z" fill="var(--accent)" />
    <circle cx="24.5" cy="30" r="4" fill="#0b1020" />
    <circle cx="39.5" cy="30" r="4" fill="#0b1020" />
  </svg>
)
const LABEL: Record<Toast['kind'], string> = { confirm: '需要确认', input: '需要输入', done: '任务完成' }

export function PetToast({ toast, onView, onDismiss }: { toast: Toast; onView: (id: string) => void; onDismiss: (id: string) => void }) {
  return (
    <div className={`pet-toast${toast.kind === 'done' ? ' done' : ''}${toast.leaving ? ' leave' : ''}`}>
      {AV}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="tk">{LABEL[toast.kind]} · {toast.wsName}</div>
        <div className="tm">{toast.title}</div>
        {toast.kind !== 'done' && <button className="tbtn" onClick={() => onView(toast.id)}>查看并处理</button>}
      </div>
      <button className="tx" aria-label="关闭" onClick={() => onDismiss(toast.id)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
      </button>
    </div>
  )
}
