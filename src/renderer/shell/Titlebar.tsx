import './shell.css'
import { NotificationPopover } from './NotificationPopover'
import { OpenLocationMenu } from './OpenLocationMenu'
import type { Notif } from './notifications'
import type { OpenTarget } from '@shared/openers'

export interface TitlebarProps {
  collapsed: boolean
  onToggleSidebar: () => void
  view: 'home' | 'ws'
  onView: (v: 'home' | 'ws') => void
  crumb: string
  onToggleInspector?: () => void
  onOpenSettings?: () => void
  notifs: Notif[]
  updateAvailable: boolean
  notifOpen: boolean
  onToggleNotif: () => void
  onOpenUpgrade: () => void
  onMarkAllRead: () => void
  canEditWorkspace?: boolean
  onEditWorkspace?: () => void
  updateInfo?: import('@shared/types').UpdateInfo | null
  openTarget?: OpenTarget | null
  defaultOpenerId?: string
  onSetDefaultOpener?: (id: string) => void
}

export function Titlebar({
  onToggleSidebar,
  view,
  onView,
  crumb,
  onToggleInspector,
  onOpenSettings,
  notifs,
  updateAvailable,
  notifOpen,
  onToggleNotif,
  onOpenUpgrade,
  onMarkAllRead,
  canEditWorkspace,
  onEditWorkspace,
  updateInfo,
  openTarget,
  defaultOpenerId,
  onSetDefaultOpener,
}: TitlebarProps) {
  return (
    <div className="titlebar">
      {/* macOS traffic-light dots — wired to real window controls (frameless window) */}
      <div className="traffic">
        <i className="r" role="button" aria-label="关闭" title="关闭" onClick={() => window.forge?.windowClose?.()} />
        <i className="y" role="button" aria-label="最小化" title="最小化" onClick={() => window.forge?.windowMinimize?.()} />
        <i className="g" role="button" aria-label="最大化" title="最大化" onClick={() => window.forge?.windowToggleMaximize?.()} />
      </div>

      {/* Sidebar-collapse toggle — hidden on home (launchpad has no sidebar) */}
      {view !== 'home' && (
        <button
          className="tb-btn icon"
          onClick={onToggleSidebar}
          title="折叠侧栏"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <line x1="9" y1="4" x2="9" y2="20" />
          </svg>
        </button>
      )}

      {/* Title / breadcrumb */}
      <div className="tb-title">
        <span className="crumb">
          <button
            type="button"
            className="crumb-home"
            title="返回首页"
            onClick={() => onView('home')}
            style={{ background: 'none', border: 0, font: 'inherit', color: 'inherit', cursor: 'pointer', padding: 0 }}
          >
            Forge
          </button>{crumb ? <> / <b>{crumb}</b></> : null}
        </span>
        {view === 'ws' && canEditWorkspace && (
          <button className="tb-edit-ws" title="编辑工作区(路径锁定 · 可改名、加项目、调工作流)" onClick={onEditWorkspace}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>编辑工作区
          </button>
        )}
      </div>

      <div className="tb-spacer" />

      {/* Home / Workspace segmented control */}
      <div className="tb-seg">
        <button
          data-go="home"
          className={view === 'home' ? 'on' : undefined}
          onClick={() => onView('home')}
        >
          首页
        </button>
        <button
          data-go="ws"
          className={view === 'ws' ? 'on' : undefined}
          onClick={() => onView('ws')}
        >
          工作区
        </button>
      </div>

      {/* 「打开位置」— 用外部软件打开当前工作区/文件(仅工作区视图) */}
      {view === 'ws' && (
        <OpenLocationMenu
          target={openTarget ?? null}
          defaultOpenerId={defaultOpenerId ?? ''}
          onSetDefault={onSetDefaultOpener ?? (() => {})}
        />
      )}

      {/* Inspector toggle — hidden on home (no inspector there) */}
      {view !== 'home' && (
        <button
          className="tb-btn icon"
          onClick={onToggleInspector}
          title="折叠面板"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <line x1="15" y1="4" x2="15" y2="20" />
          </svg>
        </button>
      )}

      {/* Notification bell + popover */}
      <NotificationPopover
        notifs={notifs}
        updateAvailable={updateAvailable}
        info={updateInfo}
        open={notifOpen}
        onToggle={onToggleNotif}
        onOpenUpgrade={onOpenUpgrade}
        onMarkAllRead={onMarkAllRead}
      />

      {/* Settings gear */}
      <button
        className="tb-btn icon"
        onClick={onOpenSettings}
        title="设置"
        aria-label="设置"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
    </div>
  )
}
