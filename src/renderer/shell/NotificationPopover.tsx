import { useEffect, useRef } from 'react'
import { ICN, badgeText, unreadCount, formatBytes, releaseSummary, type Notif } from './notifications'
import type { UpdateInfo } from '@shared/types'

export interface NotificationPopoverProps {
  notifs: Notif[]
  updateAvailable: boolean
  info?: UpdateInfo | null
  open: boolean
  onToggle: () => void
  onOpenUpgrade: () => void
  onMarkAllRead: () => void
  onSelect?: (n: Notif, index: number) => void
}

export function NotificationPopover({
  notifs,
  updateAvailable,
  info,
  open,
  onToggle,
  onOpenUpgrade,
  onMarkAllRead,
  onSelect,
}: NotificationPopoverProps) {
  const ref = useRef<HTMLDivElement>(null)
  const unread = unreadCount(notifs)
  const badge = badgeText(unread, updateAvailable)

  // Outside-click closes the popover (mirrors proto: close when click is outside the bell+popover container).
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onToggle()
    }
    document.addEventListener('click', onDoc)
    return () => document.removeEventListener('click', onDoc)
  }, [open, onToggle])

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        className={'tb-btn icon tb-bell' + (badge !== '0' ? ' has' : '')}
        title="通知"
        onClick={onToggle}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        <span className="nb-badge">{badge}</span>
      </button>

      <div className={'notif-pop' + (open ? ' on' : '')}>
        <div className="notif-head">
          <h3>通知</h3>
          <span className="nh-count">{unread ? unread + ' 条未读' : '已全部读完'}</span>
          <button className="nh-act" onClick={onMarkAllRead}>全部已读</button>
        </div>
        <div>
          {updateAvailable && (
            // Render whenever an update is flagged, even if `info` is still missing or
            // partial. The bell badge counts `updateAvailable`, so gating this card on a
            // fully-populated `info` (as before) let the badge appear while the popover
            // stayed blank on a fresh install. Fields are read defensively with graceful
            // fallbacks so incomplete release metadata never produces empty/garbage text.
            <div className="notif-up">
              <div className="nu-tag">新版本可用</div>
              <h4>
                {info?.version ? `Forge v${info.version}` : '有可用更新'}
                {info && info.dmgSize > 0 ? <span> · {formatBytes(info.dmgSize)}</span> : null}
              </h4>
              <p>{(info && releaseSummary(info.notes)) || '点击查看详情并升级到最新版本。'}</p>
              <button className="nu-btn" onClick={onOpenUpgrade}>
                <span dangerouslySetInnerHTML={{ __html: ICN.up }} />查看并升级
              </button>
            </div>
          )}
        </div>
        <div className="notif-list">
          {notifs.length ? (
            notifs.map((n, i) => {
              // Every notif is clickable to mark it read; the `clickable` affordance (pointer/hover) is
              // reserved for those that actually navigate somewhere (a workspace or a settings pane).
              const interactive = !!onSelect
              const navigates = !!(n.wsPath || n.wsName || n.settingsPane)
              return (
                <div
                  key={i}
                  className={'notif-item' + (n.unread ? ' unread' : '') + (navigates ? ' clickable' : '')}
                  role={interactive ? 'button' : undefined}
                  tabIndex={interactive ? 0 : undefined}
                  onClick={interactive ? () => onSelect?.(n, i) : undefined}
                >
                  <div className={'ni-ic ' + n.cls} dangerouslySetInnerHTML={{ __html: ICN[n.ic] }} />
                  <div className="ni-b">
                    <div className="ni-t" dangerouslySetInnerHTML={{ __html: n.t }} />
                    <div className="ni-m">{n.m}</div>
                  </div>
                </div>
              )
            })
          ) : (
            <div className="notif-empty">暂无通知</div>
          )}
        </div>
      </div>
    </div>
  )
}
