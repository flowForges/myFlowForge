import { useEffect, useRef, useState, type ReactNode } from 'react'

interface SettingsModalProps {
  open: boolean
  onClose: () => void
  renderPane: (key: string) => ReactNode
  initialPane?: string
}

interface NavEntry {
  key: string
  label: string
  icon: ReactNode
}

const NAV: NavEntry[] = [
  {
    key: 'appearance',
    label: '外观和通知',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="12" r="5" />
        <path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
      </svg>
    ),
  },
  {
    key: 'project',
    label: '项目设置',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
  {
    key: 'appIcon',
    label: '应用图标',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="4" y="4" width="16" height="16" rx="5" />
        <path d="M12 7c0 4-.2 7-.3 10M12 7c-2.1 2.3-4.1 4.4-6.2 5.1M12 7c2.1 2.3 4.2 4.4 6.5 5.1" />
        <circle cx="12" cy="7" r="1.7" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    key: 'workflow',
    label: '工作流',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="5" cy="6" r="2.4" />
        <circle cx="5" cy="18" r="2.4" />
        <circle cx="19" cy="12" r="2.4" />
        <path d="M7.4 6H13a3 3 0 0 1 3 3v.5M7.4 18H13a3 3 0 0 0 3-3v-.5" />
      </svg>
    ),
  },
  {
    key: 'skills',
    label: 'Skill',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
      </svg>
    ),
  },
  {
    key: 'loads',
    label: '加载项',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M4 5h16M4 12h16M4 19h16" />
        <circle cx="8" cy="5" r="1.7" fill="currentColor" stroke="none" />
        <circle cx="14" cy="12" r="1.7" fill="currentColor" stroke="none" />
        <circle cx="10" cy="19" r="1.7" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    key: 'providers',
    label: '编码代理',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="3" y="4" width="18" height="14" rx="2" />
        <polyline points="7 9 9.5 11.5 7 14" />
        <line x1="12.5" y1="14" x2="16" y2="14" />
      </svg>
    ),
  },
  {
    key: 'agents',
    label: '终端代理',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </svg>
    ),
  },
  {
    key: 'pet',
    label: '宠物',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M12 4c5 0 8 3.4 8 9 0 5.6-3 8-8 8s-8-2.4-8-8c0-5.6 3-9 8-9Z" />
        <circle cx="9.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
        <circle cx="14.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    key: 'plugins',
    label: '插件',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M12 2l2 4h4l-3 3 1 4-4-2-4 2 1-4-3-3h4z" />
        <path d="M9 15l-4 4M15 15l4 4" />
      </svg>
    ),
  },
  {
    key: 'sessions',
    label: '原生会话',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 5h18M3 12h18M3 19h18"/></svg>
    ),
  },
  {
    key: 'debug',
    label: '调试日志',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M9 3h6M12 3v4M6.5 9a5.5 5.5 0 0 1 11 0v4a5.5 5.5 0 0 1-11 0z" /><path d="M3 13h3.5M17.5 13H21M4 7l2.5 1.5M20 7l-2.5 1.5M4 19l2.6-1.6M20 19l-2.6-1.6" /></svg>
    ),
  },
]

export function SettingsModal({ open, onClose, renderPane, initialPane }: SettingsModalProps) {
  const [active, setActive] = useState(initialPane ?? 'appearance')
  const prevOpenRef = useRef(open)
  useEffect(() => {
    const wasOpen = prevOpenRef.current
    prevOpenRef.current = open
    if (open && !wasOpen) {
      // false → true transition: reset active pane to the requested initialPane
      setActive(initialPane ?? 'appearance')
    }
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, initialPane])

  return (
    <div
      className={`settings-overlay${open ? ' on' : ''}`}
      id="settingsOverlay"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="settings">
        <div className="set-head">
          <button className="set-back" id="setBack" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="19" y1="12" x2="5" y2="12" />
              <polyline points="12 19 5 12 12 5" />
            </svg>
            返回
          </button>
          <span className="set-title">设置</span>
          <button className="set-x" id="setClose" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="set-body">
          <nav className="set-nav">
            {NAV.map(n => (
              <button key={n.key} className={n.key === active ? 'on' : undefined} data-set={n.key} onClick={() => setActive(n.key)}>
                {n.icon}
                {n.label}
              </button>
            ))}
          </nav>
          <div className="set-pane on" id={`set-${active}`}>
            {renderPane(active)}
          </div>
        </div>
      </div>
    </div>
  )
}
