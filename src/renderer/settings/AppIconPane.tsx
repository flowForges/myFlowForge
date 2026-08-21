import { useEffect, useState } from 'react'
import type { AppIcon, DockIcon } from '@shared/types'

interface AppIconPaneProps {
  appIcon: AppIcon
  onChange: (partial: Partial<AppIcon>) => void
}

const ICON_META: Record<DockIcon, { name: string; tone: string }> = {
  'ice-cyan': { name: 'Ice Cyan', tone: '冷静' },
  'forge-aurora': { name: 'Forge Aurora', tone: '生命感' },
  'cobalt-violet': { name: 'Cobalt Violet', tone: '高级' },
  'ember-violet': { name: 'Ember Violet', tone: 'Forge' },
  'magenta-pulse': { name: 'Magenta Pulse', tone: '创作感' },
}
const ICON_ORDER: DockIcon[] = ['ice-cyan', 'forge-aurora', 'cobalt-violet', 'ember-violet', 'magenta-pulse']
const FALLBACK_ICONS = ICON_ORDER.map(id => ({
  id,
  name: ICON_META[id].name,
  tone: ICON_META[id].tone,
  src: '',
}))

interface IconOption {
  id: DockIcon
  name: string
  tone: string
  src: string
}

function mergeIconOptions(options: Awaited<ReturnType<typeof window.forge.getAppIconOptions>>): IconOption[] {
  const byId = new Map(options.map(opt => [opt.id, opt]))
  return ICON_ORDER.map(id => ({
    id,
    name: ICON_META[id].name,
    tone: ICON_META[id].tone,
    src: byId.get(id)?.src ?? '',
  }))
}

const CHECK = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6">
    <polyline points="20 6 9 17 4 12" />
  </svg>
)

function MenuBarGlyph() {
  return (
    <div className="menu-glyph" aria-hidden="true">
      <svg viewBox="0 0 36 36" fill="none" stroke="currentColor" strokeLinecap="round">
        <path d="M18 7C17 13 17 22 17 29" strokeWidth="3.4" />
        <path d="M18 8C14 12 10 17 6 18M18 8C22 12 26 17 31 18" strokeWidth="3.1" />
        <path d="M14 16C12 20 12 24 11 28M22 16C24 20 24 24 25 28" strokeWidth="2.7" />
        <circle cx="18" cy="7" r="3.3" fill="currentColor" stroke="none" />
        <circle cx="6" cy="18" r="2.3" fill="currentColor" stroke="none" />
        <circle cx="31" cy="18" r="2.3" fill="currentColor" stroke="none" />
        <circle cx="11" cy="28" r="2.2" fill="currentColor" stroke="none" />
        <circle cx="17" cy="29" r="2.2" fill="currentColor" stroke="none" />
        <circle cx="25" cy="28" r="2.2" fill="currentColor" stroke="none" />
      </svg>
    </div>
  )
}

export function AppIconPane({ appIcon, onChange }: AppIconPaneProps) {
  const [icons, setIcons] = useState<IconOption[]>(FALLBACK_ICONS)
  useEffect(() => {
    let live = true
    void window.forge.getAppIconOptions().then(options => {
      if (live) setIcons(mergeIconOptions(options))
    })
    return () => { live = false }
  }, [])

  // 文案按平台走:Windows 上没有 Dock、没有「顶部状态栏」,照抄 macOS 的名词就是在骗人。图标选择器在
  // Windows 上也不是摆设 —— 它决定托盘显示哪一个图标(见 main/index.ts 的 buildTrayImage)。
  const isWindows = (window.forge?.platform ?? 'darwin') === 'win32'
  const statusLabel = isWindows ? '在任务栏通知区域显示 FlowForge' : '在 macOS 顶部状态栏显示 FlowForge'
  return (
    <>
      <div className="set-group">
        <h4>{isWindows ? '应用图标' : 'Dock 图标'}</h4>
        <div className="app-icon-grid">
          {icons.map(icon => (
            <button
              key={icon.id}
              className={`app-icon-choice${appIcon.dockIcon === icon.id ? ' on' : ''}`}
              onClick={() => onChange({ dockIcon: icon.id })}
            >
              {icon.src ? <img src={icon.src} alt="" /> : <span className="app-icon-placeholder" />}
              <span className="icon-name">{icon.name}</span>
              <span className="icon-tone">{icon.tone}</span>
              <span className="icon-check">{CHECK}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="set-group">
        <h4>{isWindows ? '通知区域' : '状态栏'}</h4>
        <div className="set-row">
          <MenuBarGlyph />
          <div className="info">
            <div className="t">{statusLabel}</div>
            <div className="d">{isWindows
              ? '开启后左键点托盘图标立即呼出主窗口,右键是快捷菜单。上面选的图标就是托盘显示的那一个。'
              : '开启后点击状态栏里的简约神经元图标，会立即呼出主窗口。'}</div>
          </div>
          <button
            className={`toggle${appIcon.showMenuBar ? ' on' : ''}`}
            aria-label={statusLabel}
            onClick={() => onChange({ showMenuBar: !appIcon.showMenuBar })}
          />
        </div>
      </div>
    </>
  )
}
