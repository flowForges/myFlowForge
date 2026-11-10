// 对话页的会话列(08b §4.3、§4.4):新会话主按钮、来源筛选(全部 / 本机 / Telegram / 定时)、分组的会话列表。
// 筛选只在已加载的列表上按 origin 过滤,本地状态,不持久化,不重新拉列表(R17);定时含未知来源。
// 窄列(主区 < 1200):副行用 CSS 藏;筛选收进漏斗按钮,点开是同一组分段按钮浮在下面(同一份 DOM)。
import { useEffect, useRef, useState } from 'react'
import type { SessionSummary } from '@mffai/protocol'
import { Chip } from '../ui/Chip'
import { Icon, type IconName } from '../shell/icons'
import { SessionList, originKind } from './SessionList'

type Filter = 'all' | 'app' | 'im' | 'schedule'
/** 全部是字;其余是和行上来源色块同一套图标,名字在 aria-label 上(列表里的 本机 / 定时 文字不和它们撞) */
const FILTERS: readonly (readonly [Filter, string, IconName | undefined])[] = [
  ['all', '全部', undefined], ['app', '本机', 'monitor'], ['im', 'Telegram', 'send'], ['schedule', '定时', 'clock'],
]
const keep = (f: Filter, s: SessionSummary) => f === 'all' || originKind(s.origin) === f

export function SessionColumn({ sessions, active, imNames, unsupported, narrow, onNew, onSelect, onRename, onDelete }: {
  sessions: readonly SessionSummary[]
  active?: string
  imNames?: ReadonlyMap<string, string>
  unsupported: boolean
  narrow: boolean
  onNew: () => void
  onSelect: (sessionId: string) => void
  onRename: (sessionId: string, title: string) => Promise<boolean>
  onDelete: (s: SessionSummary) => void
}) {
  const [filter, setFilter] = useState<Filter>('all')
  const [open, setOpen] = useState(false)
  const pop = narrow && open
  const btnRef = useRef<HTMLButtonElement>(null)
  const segRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!pop) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      btnRef.current?.focus()
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || segRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [pop])

  return (
    <aside className={`mffai-sesscol${narrow ? ' narrow' : ''}`}>
      <div className="mffai-sesscol-top">
        <button className="set-btn mffai-primary mffai-sesscol-new" onClick={onNew}><Icon name="edit" size={13} />新会话</button>
        {narrow && (
          <button ref={btnRef} className={`set-btn mffai-sesscol-filter${filter !== 'all' ? ' on' : ''}`} aria-label="筛选"
            aria-haspopup="true" aria-expanded={pop} onClick={() => setOpen(!open)}>
            <Icon name="filter" size={13} />
          </button>
        )}
      </div>
      <div ref={segRef} className={`mffai-seg sm mffai-sessfilter${pop ? ' open' : ''}`} role="group" aria-label="来源">
        {FILTERS.map(([k, t, icon]) => (
          <button key={k} data-filter={k} aria-pressed={filter === k} aria-label={icon ? t : undefined} title={icon ? t : undefined}
            onClick={() => { setFilter(k); setOpen(false) }}>
            {icon ? <Icon name={icon} size={13} /> : t}
          </button>
        ))}
      </div>
      {unsupported
        ? <Chip>不支持</Chip>
        : <SessionList sessions={sessions.filter((s) => keep(filter, s))} active={active} imNames={imNames}
            onSelect={onSelect} onRename={onRename} onDelete={onDelete} />}
    </aside>
  )
}
