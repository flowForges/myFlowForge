import { useState } from 'react'
import type { PendingAction, ResolvePayload } from '@shared/types'

export function PendingActionCard({ action, onResolve }: { action: PendingAction; onResolve: (p: ResolvePayload) => void }) {
  const [value, setValue] = useState('')
  return (
    <div className="pp-act" data-act={action.id}>
      <div className="ah"><span className="k">{action.kind === 'confirm' ? '需确认' : '需输入'}</span>{action.wsName}</div>
      <div className="am">{action.title}</div>
      {action.kind === 'confirm' && action.where
        ? <div className="aw">{action.agentName} · <b>{action.where}</b></div>
        : <div className="aw">{action.agentName}</div>}
      {action.kind === 'confirm'
        ? <div className="arow">
            <button className="a-ok" onClick={() => onResolve({ id: action.id, decision: 'allow' })}>允许</button>
            <button className="a-no" onClick={() => onResolve({ id: action.id, decision: 'deny' })}>拒绝</button>
          </div>
        : <div className="ain">
            <input type="text" placeholder={action.kind === 'input' ? (action.placeholder ?? '') : ''} value={value} onChange={e => setValue(e.target.value)} />
            <button className="a-ok" onClick={() => onResolve({ id: action.id, decision: 'allow', value })}>提交</button>
          </div>}
    </div>
  )
}
