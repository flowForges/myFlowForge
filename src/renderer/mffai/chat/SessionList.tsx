// 会话列表(08 §7.1、§7.2):来源图标、标题、相对时间、待批红点、运行中、挂起、群聊、Telegram 名字;
// 双击标题或行菜单改名,行菜单删除(有开着的轮时灰掉,块上已经是 运行中)。
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { SessionOrigin, SessionSummary } from '@mffai/protocol'
import { fmtRelTime } from '@shared/relTime'
import { ThinkSpinner } from '../../views/chat/Spinners'
import { Chip } from '../ui/Chip'
import { label } from '../labels'

const KNOWN: readonly SessionOrigin[] = ['app', 'im', 'schedule', 'acp']
/** 不认识的来源和内核 originOf 一样归到定时 */
export const originKind = (o: string): SessionOrigin => (KNOWN.includes(o as SessionOrigin) ? (o as SessionOrigin) : 'schedule')

const svg = (children: ReactNode) => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)
const ICONS: Record<SessionOrigin, ReactNode> = {
  app: svg(<><rect x="3" y="4" width="18" height="12" rx="2" /><line x1="8" y1="20" x2="16" y2="20" /><line x1="12" y1="16" x2="12" y2="20" /></>),
  im: svg(<path d="M21 4 3 11l6 2 2 6 3-4 5 4z" />),
  acp: svg(<><polyline points="8 7 3 12 8 17" /><polyline points="16 7 21 12 16 17" /></>),
  schedule: svg(<><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" /></>),
}

export function OriginIcon({ origin }: { origin: string }) {
  const k = originKind(origin)
  return <span className="mffai-origin" data-origin={k} role="img" aria-label={label('origin', k)}>{ICONS[k]}</span>
}

function Row({ s, on, imName, onSelect, onRename, onDelete, menuOpen, setMenu }: {
  s: SessionSummary
  on: boolean
  imName?: string
  onSelect: () => void
  onRename: (title: string) => Promise<boolean>
  onDelete: () => void
  menuOpen: boolean
  setMenu: (open: boolean) => void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const inflight = useRef(false)
  const begin = () => { setMenu(false); setFailed(false); setEditing(s.title) }
  const save = async () => {
    const t = (editing ?? '').trim()
    if (inflight.current) return
    if (!t || t === s.title) { setEditing(null); return }
    inflight.current = true
    setSaving(true)
    const ok = await onRename(t).catch(() => false)
    inflight.current = false
    setSaving(false)
    if (ok) { setEditing(null); setFailed(false) } else setFailed(true)
  }
  const running = !!s.open && !s.open.parked
  return (
    <li className={`mffai-sess${on ? ' on' : ''}`} role="option" aria-selected={on} onClick={() => { if (editing === null) onSelect() }}>
      <OriginIcon origin={s.origin} />
      {editing === null ? (
        <span className="mffai-sess-title" onDoubleClick={(e) => { e.stopPropagation(); begin() }}>{s.title}</span>
      ) : (
        <input
          className="mffai-sess-edit" aria-label="标题" autoFocus value={editing} disabled={saving}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setEditing(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void save() }
            if (e.key === 'Escape') { e.preventDefault(); setEditing(null); setFailed(false) }
          }}
        />
      )}
      {failed && <span className="mffai-fail">失败</span>}
      {originKind(s.origin) === 'im' && imName && <span className="mffai-sess-im">{imName}</span>}
      {s.audience === 'group' && <Chip>群聊</Chip>}
      {running && <Chip tone="ok"><ThinkSpinner size={11} />运行中</Chip>}
      {s.open?.parked && <Chip tone="warn">挂起</Chip>}
      {s.pendingApprovals > 0 && <span className="mffai-sess-dot" aria-label={`待批 ${s.pendingApprovals}`}>{s.pendingApprovals}</span>}
      <span className="mffai-sess-time">{fmtRelTime(s.updatedAt, Date.now())}</span>
      <span className="mffai-sess-menu">
        <button className="mffai-sess-more" aria-label="更多" aria-haspopup="menu" aria-expanded={menuOpen}
          onClick={(e) => { e.stopPropagation(); setMenu(!menuOpen) }}>⋯</button>
        {menuOpen && (
          <span className="mffai-sess-pop" role="menu" onClick={(e) => e.stopPropagation()}>
            <button className="menu-item" role="menuitem" onClick={begin}>改名</button>
            <button className="menu-item" role="menuitem" disabled={!!s.open} onClick={() => { if (s.open) return; setMenu(false); onDelete() }}>删除</button>
          </span>
        )}
      </span>
    </li>
  )
}

export function SessionList({ sessions, active, imNames, onSelect, onRename, onDelete }: {
  sessions: readonly SessionSummary[]
  active?: string
  imNames?: ReadonlyMap<string, string>
  onSelect: (sessionId: string) => void
  /** 真表示存好了 */
  onRename: (sessionId: string, title: string) => Promise<boolean>
  onDelete: (s: SessionSummary) => void
}) {
  const [menu, setMenu] = useState<string | null>(null)
  useEffect(() => {
    if (menu === null) return
    const close = () => setMenu(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [menu])
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
  return (
    <ul className="mffai-sesslist" role="listbox" aria-label="会话">
      {sorted.map((s) => (
        <Row key={s.id} s={s} on={s.id === active} imName={imNames?.get(s.id)}
          onSelect={() => onSelect(s.id)} onRename={(t) => onRename(s.id, t)} onDelete={() => onDelete(s)}
          menuOpen={menu === s.id} setMenu={(o) => setMenu(o ? s.id : null)} />
      ))}
    </ul>
  )
}
