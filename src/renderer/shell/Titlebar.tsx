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
  /** 点主机芯片时打开「设置 → 主机」 */
  onToggleInspector?: () => void
  onOpenSettings?: () => void
  notifs: Notif[]
  updateAvailable: boolean
  notifOpen: boolean
  onToggleNotif: () => void
  onOpenUpgrade: () => void
  onMarkAllRead: () => void
  onClearAllNotif: () => void
  onSelectNotif?: (n: Notif, index: number) => void
  canEditWorkspace?: boolean
  onEditWorkspace?: () => void
  updateInfo?: import('@shared/types').UpdateInfo | null
  openTarget?: OpenTarget | null
  defaultOpenerId?: string
  onSetDefaultOpener?: (id: string) => void
  // Windows only: drives the maximise/restore glyph. Ignored by the macOS dots.
  maximized?: boolean
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
  onClearAllNotif,
  onSelectNotif,
  canEditWorkspace,
  onEditWorkspace,
  updateInfo,
  openTarget,
  defaultOpenerId,
  onSetDefaultOpener,
  maximized,
}: TitlebarProps) {
  // The window is frameless everywhere, so we draw the controls. Where they go is platform identity,
  // not decoration: macOS puts coloured dots top-LEFT, Windows square glyphs top-RIGHT. Unknown
  // platform (unit tests, preload not injected) falls back to the macOS layout.
  const isWindows = (window.forge?.platform ?? 'darwin') === 'win32'
  // mac 把左上角让给了红绿灯,所以一切都往右排。Windows 释放了左上角,照抄 mac 的话左边空一块、
  // 右边 5 组控件加 3 个系统键挤成一团(齿轮紧挨最小化键,很容易点错)。所以 Windows 重排:
  //   · 设置挪到最左第一个
  //   · 「首页/工作区」跟着面包屑走 —— 它和面包屑都是在回答"我在哪",本来就是一类
  //   · 两个折叠按钮各自贴住它控制的那一侧(左侧栏的靠最左,右面板的靠最右、紧挨系统键)
  const settings = (
    <button className="tb-btn icon" onClick={onOpenSettings} title="设置" aria-label="设置">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    </button>
  )
  const sidebarToggle = view !== 'home' ? (
    <button className="tb-btn icon" onClick={onToggleSidebar} title="折叠侧栏">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="3" y="4" width="18" height="16" rx="2" /><line x1="9" y1="4" x2="9" y2="20" />
      </svg>
    </button>
  ) : null
  const inspectorToggle = view !== 'home' ? (
    <button className="tb-btn icon" onClick={onToggleInspector} title="折叠面板">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="3" y="4" width="18" height="16" rx="2" /><line x1="15" y1="4" x2="15" y2="20" />
      </svg>
    </button>
  ) : null
  const title = (
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
  )
  const nav = (
    <div className="tb-seg">
      <button data-go="home" className={view === 'home' ? 'on' : undefined} onClick={() => onView('home')}>首页</button>
      <button data-go="ws" className={view === 'ws' ? 'on' : undefined} onClick={() => onView('ws')}>工作区</button>
    </div>
  )
  const opener = view === 'ws' ? (
    <OpenLocationMenu
      target={openTarget ?? null}
      defaultOpenerId={defaultOpenerId ?? ''}
      onSetDefault={onSetDefaultOpener ?? (() => {})}
    />
  ) : null
  const bell = (
    <NotificationPopover
      notifs={notifs}
      updateAvailable={updateAvailable}
      info={updateInfo}
      open={notifOpen}
      onToggle={onToggleNotif}
      onOpenUpgrade={onOpenUpgrade}
      onMarkAllRead={onMarkAllRead}
      onClearAll={onClearAllNotif}
      onSelect={onSelectNotif}
    />
  )

  if (isWindows) {
    return (
      <div className="titlebar">
        {settings}
        {sidebarToggle}
        {title}
        {nav}
        <div className="tb-spacer" />
        {opener}
        {bell}
        {inspectorToggle}
        <WindowsControls maximized={!!maximized} />
      </div>
    )
  }

  return (
    <div className="titlebar">
      {/* macOS traffic-light dots — wired to real window controls (frameless window) */}
      <div className="traffic">
        <i className="r" role="button" aria-label="关闭" title="关闭" onClick={() => window.forge?.windowClose?.()} />
        <i className="y" role="button" aria-label="最小化" title="最小化" onClick={() => window.forge?.windowMinimize?.()} />
        <i className="g" role="button" aria-label="最大化" title="最大化" onClick={() => window.forge?.windowToggleMaximize?.()} />
      </div>
      {sidebarToggle}
      {title}
      <div className="tb-spacer" />
      {nav}
      {opener}
      {inspectorToggle}
      {bell}
      {settings}
    </div>
  )
}


// Windows 11 caption buttons: 46×32 hit targets in minimise / maximise / close order, close turning
// red on hover. Glyphs are inline SVG rather than the Segoe MDL2 Assets font — that font is missing
// on Windows Server and on trimmed installs, which would render the controls as tofu boxes.
function WindowsControls({ maximized }: { maximized: boolean }) {
  return (
    <div className="win-controls">
      <button aria-label="最小化" title="最小化" onClick={() => window.forge?.windowMinimize?.()}>
        <svg viewBox="0 0 10 10"><path d="M0 5h10" /></svg>
      </button>
      <button
        aria-label={maximized ? '向下还原' : '最大化'}
        title={maximized ? '向下还原' : '最大化'}
        onClick={() => window.forge?.windowToggleMaximize?.()}
      >
        {maximized
          ? <svg viewBox="0 0 10 10"><path d="M2.5 2.5V.5h7v7h-2" /><rect x="0.5" y="2.5" width="7" height="7" /></svg>
          : <svg viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" /></svg>}
      </button>
      <button className="close" aria-label="关闭" title="关闭" onClick={() => window.forge?.windowClose?.()}>
        <svg viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10" /></svg>
      </button>
    </div>
  )
}
