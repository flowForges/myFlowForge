import { useState } from 'react'

interface UnlockModalProps {
  onClose: () => void
  onUnlock: (code: string) => void
}

// The hidden activation entry for gated extra content. It's not surfaced anywhere in the UI — it's
// opened only by a secret shortcut (Cmd/Ctrl+Shift+Alt+U, see App.tsx). Enter a valid code to unlock;
// the "扩展内容" settings pane then appears.
export function UnlockModal({ onClose, onUnlock }: UnlockModalProps) {
  const [code, setCode] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const c = code.trim()
    if (!c) return
    setBusy(true); setErr('')
    try {
      const r = await window.forge.nsfwValidate?.(c)
      if (r?.ok) { onUnlock(c); onClose() }
      else setErr(r?.error ?? '激活失败')
    } catch { setErr('激活失败') }
    finally { setBusy(false) }
  }

  return (
    <div className="unlock-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="unlock-modal" role="dialog" aria-label="输入激活码">
        <div className="unlock-title">输入激活码</div>
        <input
          className="sel unlock-input"
          autoFocus
          placeholder="激活码"
          value={code}
          onChange={e => setCode(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void submit(); else if (e.key === 'Escape') onClose() }}
        />
        {err && <div className="unlock-err">{err}</div>}
        <div className="unlock-actions">
          <button className="wf-pick" onClick={onClose}>取消</button>
          <button className="wf-pick on" disabled={busy || !code.trim()} onClick={() => void submit()}>{busy ? '激活中…' : '激活'}</button>
        </div>
      </div>
    </div>
  )
}
