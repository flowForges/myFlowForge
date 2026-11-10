// 会话列表(08 §7.1、§7.2;08b §4.3):按 今天 / 昨天 / 更早 分组,两行:来源色块、标题;
// 副行 = 目录 / Telegram 名字 / 来源,加 群聊、挂起;右边是时间或运行圈,待批红点。窄列只用 CSS 藏副行。
// 双击标题或行菜单改名,行菜单删除(有开着的轮时灰掉)。行菜单悬停或聚焦时出现。
import { useEffect, useRef, useState } from 'react'
import type { SessionOrigin, SessionSummary } from '@mffai/protocol'
import { fmtRelTime } from '@shared/relTime'
import { Chip } from '../ui/Chip'
import { Icon, type IconName } from '../shell/icons'
import { label } from '../labels'

const KNOWN: readonly SessionOrigin[] = ['app', 'im', 'schedule', 'acp']
/** 不认识的来源和内核 originOf 一样归到定时 */
export const originKind = (o: string): SessionOrigin => (KNOWN.includes(o as SessionOrigin) ? (o as SessionOrigin) : 'schedule')

const ICONS: Record<SessionOrigin, IconName> = { app: 'monitor', im: 'send', acp: 'code', schedule: 'clock' }

export function OriginIcon({ origin }: { origin: string }) {
  const k = originKind(origin)
  return <span className="mffai-origin" data-origin={k} role="img" aria-label={label('origin', k)}><Icon name={ICONS[k]} size={13} /></span>
}

/** 本地时区的 今天 / 昨天 / 更早 */
export function dayGroup(t: number, now: number): '今天' | '昨天' | '更早' {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  const today = d.getTime()
  d.setDate(d.getDate() - 1)
  return t >= today ? '今天' : t >= d.getTime() ? '昨天' : '更早'
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
  const kind = originKind(s.origin)
  return (
    <li className={`mffai-sess${on ? ' on' : ''}`} role="option" aria-selected={on} onClick={() => { if (editing === null) onSelect() }}>
      <OriginIcon origin={s.origin} />
      <span className="mffai-sess-main">
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
        <span className="mffai-sess-sub">
          {kind === 'app' ? (s.cwd && <span className="mffai-sess-cwd">{s.cwd}</span>)
            : kind === 'im' ? <><span className="mffai-sess-via">Telegram</span>{imName && <> · <span className="mffai-sess-im">{imName}</span></>}</>
            : <span className="mffai-sess-via">{label('origin', kind)}</span>}
          {s.audience === 'group' && <Chip tone="line">群聊</Chip>}
          {s.open?.parked && <Chip tone="warn">挂起</Chip>}
        </span>
      </span>
      {failed && <span className="mffai-fail">失败</span>}
      <span className="mffai-sess-right">
        {running
          ? <span className="mffai-sess-run"><span className="mffai-spin" aria-hidden="true" /><span className="mffai-vh">运行中</span></span>
          : <span className="mffai-sess-time">{fmtRelTime(s.updatedAt, Date.now())}</span>}
        {s.pendingApprovals > 0 && <span className="mffai-sess-dot" aria-label={`待批 ${s.pendingApprovals}`}>{s.pendingApprovals}</span>}
      </span>
      <span className="mffai-sess-menu">
        <button className="mffai-sess-more" aria-label="更多" aria-haspopup="menu" aria-expanded={menuOpen}
          onClick={(e) => { e.stopPropagation(); setMenu(!menuOpen) }}><Icon name="more" size={14} /></button>
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
  // 坏的 updatedAt(NaN、Infinity)排到最后,不打乱其余的顺序,也不让同一个组头出现两次
  const key = (x: SessionSummary) => (Number.isFinite(x.updatedAt) ? x.updatedAt : Number.NEGATIVE_INFINITY)
  const sorted = [...sessions].sort((a, b) => { const x = key(a), y = key(b); return x === y ? 0 : y > x ? 1 : -1 })
  const now = Date.now()
  let group: string | undefined
  return (
    <ul className="mffai-sesslist" role="listbox" aria-label="会话">
      {sorted.flatMap((s) => {
        const g = dayGroup(s.updatedAt, now)
        const head = g !== group ? <li key={`#${g}`} className="mffai-sessgh" role="presentation">{g}</li> : null
        group = g
        const row = (
          <Row key={s.id} s={s} on={s.id === active} imName={imNames?.get(s.id)}
            onSelect={() => onSelect(s.id)} onRename={(t) => onRename(s.id, t)} onDelete={() => onDelete(s)}
            menuOpen={menu === s.id} setMenu={(o) => setMenu(o ? s.id : null)} />
        )
        return head ? [head, row] : [row]
      })}
    </ul>
  )
}
