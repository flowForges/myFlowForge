import { useState } from 'react'
import type { Appearance, Terminal, CloseAction, Notifications } from '@shared/types'

const BG_SCOPES: { key: NonNullable<Appearance['bgScope']>; label: string }[] = [
  { key: 'app', label: '整个应用' },
  { key: 'chat', label: '仅会话区' },
]

interface AppearancePaneProps {
  appearance: Appearance
  onChange: (partial: Partial<Appearance>) => void
  notifications: Notifications
  onNotificationsChange: (partial: Partial<Notifications>) => void
  terminal: Terminal
  onTerminalChange: (partial: Partial<Terminal>) => void
  closeAction: CloseAction
  onCloseActionChange: (v: CloseAction) => void
}

const NOTIFY_TYPES: { key: 'confirm' | 'input' | 'done'; t: string; d: string }[] = [
  { key: 'confirm', t: '需要确认时', d: '子代理请求确认操作(如写文件、门控方案)' },
  { key: 'input', t: '需要输入时', d: '子代理请求补充输入' },
  { key: 'done', t: '执行完成时', d: '工作流整体执行完成' },
]

const CHECK = (
  <svg className="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <polyline points="20 6 9 17 4 12" />
  </svg>
)

const THEMES: { key: Appearance['theme']; label: string }[] = [
  { key: 'dark', label: '深色' },
  { key: 'light', label: '浅色' },
  { key: 'auto', label: '跟随系统' },
  { key: 'midnight', label: '午夜蓝' },
  { key: 'sepia', label: '暖褐' },
  { key: 'forest', label: '森林绿' }
]

// Ordered roughly around the hue wheel so the swatch row reads as a spectrum.
const ACCENTS: { key: Appearance['accent']; label: string; color: string }[] = [
  { key: 'blue', label: '电光蓝', color: 'oklch(72% .15 235)' },
  { key: 'indigo', label: '靛蓝', color: 'oklch(68% .16 278)' },
  { key: 'violet', label: '紫罗兰', color: 'oklch(72% .16 300)' },
  { key: 'magenta', label: '品红', color: 'oklch(72% .19 340)' },
  { key: 'rose', label: '玫红', color: 'oklch(70% .17 12)' },
  { key: 'orange', label: '橙', color: 'oklch(74% .16 55)' },
  { key: 'amber', label: '琥珀', color: 'oklch(80% .14 75)' },
  { key: 'lime', label: '青柠', color: 'oklch(82% .17 128)' },
  { key: 'emerald', label: '翡翠绿', color: 'oklch(74% .15 160)' },
  { key: 'teal', label: '蓝绿', color: 'oklch(76% .12 190)' },
  { key: 'cyan', label: '青蓝', color: 'oklch(76% .12 205)' },
  { key: 'graphite', label: '石墨灰', color: 'oklch(78% .02 250)' },
]
const ACK = (
  <svg className="ck" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
)

const CLOSE_ACTIONS: { key: CloseAction; label: string }[] = [
  { key: 'ask', label: '询问' },
  { key: 'hide', label: '缩小到 Dock' },
  { key: 'quit', label: '退出应用' },
]

export function AppearancePane({ appearance, onChange, notifications, onNotificationsChange, terminal, onTerminalChange, closeAction, onCloseActionChange }: AppearancePaneProps) {
  const opacity = appearance.windowOpacity ?? 1
  const blur = appearance.blurAmount ?? 0
  const bgImage = appearance.bgImage ?? ''
  const bgScope = appearance.bgScope ?? 'off'
  const bgOpacity = appearance.bgOpacity ?? 0.35
  const [bgErr, setBgErr] = useState('')
  const pickBg = async () => {
    setBgErr('')
    const r = await window.forge.pickBgImage?.()
    if (!r) return
    if (r.error) { setBgErr(r.error); return }
    // First upload turns the feature on (default to whole-app); later uploads keep the current scope.
    if (r.dataUrl) onChange({ bgImage: r.dataUrl, bgScope: bgScope === 'off' ? 'app' : bgScope })
  }
  return (
    <>
      <div className="set-group">
        <h4>通知</h4>
        <div className="set-row">
          <div className="info">
            <div className="t">系统通知</div>
            <div className="d">需要确认/输入或执行完成时,若 App 不在前台则发送系统通知,点击可跳回对应会话</div>
          </div>
          <button
            className={`toggle${notifications.enabled ? ' on' : ''}`}
            aria-label="系统通知"
            onClick={() => onNotificationsChange({ enabled: !notifications.enabled })}
          />
        </div>
        {NOTIFY_TYPES.map(({ key, t, d }) => (
          <div className="set-row" key={key} style={{ opacity: notifications.enabled ? 1 : 0.45 }}>
            <div className="info">
              <div className="t">{t}</div>
              <div className="d">{d}</div>
            </div>
            <button
              className={`toggle${notifications[key] ? ' on' : ''}`}
              aria-label={t}
              disabled={!notifications.enabled}
              onClick={() => onNotificationsChange({ [key]: !notifications[key] })}
            />
          </div>
        ))}
      </div>
      <div className="set-group">
        <h4>窗口</h4>
        <div className="set-row">
          <div className="info">
            <div className="t">关闭窗口时</div>
            <div className="d">缩小到 Dock 后应用继续在后台运行,可随时从 Dock 图标回来</div>
          </div>
          <div className="seg" id="closeAction">
            {CLOSE_ACTIONS.map(({ key, label }) => (
              <button
                key={key}
                className={`wf-pick${closeAction === key ? ' on' : ''}`}
                onClick={() => onCloseActionChange(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="set-group">
        <h4>主题</h4>
        <div className="theme-cards" id="themeCards">
          {THEMES.map(({ key, label }) => (
            <button
              key={key}
              className={`theme-card ${key}${appearance.theme === key ? ' on' : ''}`}
              data-theme-set={key}
              onClick={() => onChange({ theme: key })}
            >
              <div className="swatch"><span className="a" /><span className="b" /></div>
              <div className="tc-foot">{label}{CHECK}</div>
            </button>
          ))}
        </div>
      </div>
      <div className="set-group">
        <h4>强调色</h4>
        <div className="accent-row">
          {ACCENTS.map(({ key, label, color }) => (
            <button key={key} className={`accent-sw${appearance.accent === key ? ' on' : ''}`} title={label} onClick={() => onChange({ accent: key })}>
              <i style={{ background: color }} />{ACK}
            </button>
          ))}
        </div>
      </div>
      <div className="set-group">
        <h4>界面</h4>
        <div className="set-row">
          <div className="info">
            <div className="t">窗口透明度</div>
            <div className="d">整窗透明,透出桌面与背后的窗口 · 实时生效,无需重启。100% = 完全不透明</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: '180px', justifyContent: 'flex-end' }}>
            <input
              type="range"
              aria-label="窗口透明度"
              min={0.3}
              max={1}
              step={0.02}
              value={opacity}
              onChange={e => onChange({ windowOpacity: Number(e.target.value) })}
              style={{ flex: '1 1 auto', maxWidth: '160px' }}
            />
            <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: '12px', color: 'var(--muted)', width: '38px', textAlign: 'right' }}>
              {Math.round(opacity * 100)}%
            </span>
          </div>
        </div>
        <div className="set-row">
          <div className="info">
            <div className="t">磨砂度</div>
            <div className="d">毛玻璃质感 · 透出并模糊桌面与背后内容。0 = 关闭。应用内面板即时生效;桌面背景磨砂(原生毛玻璃)需重启生效</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: '180px', justifyContent: 'flex-end' }}>
            <input
              type="range"
              aria-label="磨砂度"
              min={0}
              max={1}
              step={0.05}
              value={blur}
              onChange={e => onChange({ blurAmount: Number(e.target.value) })}
              style={{ flex: '1 1 auto', maxWidth: '160px' }}
            />
            <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: '12px', color: 'var(--muted)', width: '38px', textAlign: 'right' }}>
              {Math.round(blur * 100)}%
            </span>
          </div>
        </div>
        {blur > 0 && (
          <div className="set-row">
            <div className="info">
              <div className="d" style={{ color: 'var(--muted)' }}>桌面背景磨砂在下次启动时应用</div>
            </div>
            <button className="wf-pick" onClick={() => window.forge.appRelaunch()}>立即重启生效</button>
          </div>
        )}
        <div className="set-row">
          <div className="info">
            <div className="t">背景图</div>
            <div className="d">
              上传一张图片作为背景 · 可铺满整个应用或仅会话区 · 拖动调节可见度。空 = 关闭
              {bgErr && <span style={{ color: 'var(--del)', marginLeft: 6 }}>{bgErr}</span>}
            </div>
          </div>
          <div className="seg">
            <button className="wf-pick" onClick={() => void pickBg()}>{bgImage ? '更换图片' : '上传图片'}</button>
            {bgImage && <button className="wf-pick" onClick={() => onChange({ bgImage: '', bgScope: 'off' })}>清除</button>}
          </div>
        </div>
        {bgImage && (
          <>
            <div className="set-row">
              <div className="info">
                <div className="t">背景范围</div>
                <div className="d">整个应用:侧栏 / 首页 / 会话区都透出图片;仅会话区:只在对话区透出</div>
              </div>
              <div className="seg">
                {BG_SCOPES.map(({ key, label }) => (
                  <button key={key} className={`wf-pick${bgScope === key ? ' on' : ''}`} onClick={() => onChange({ bgScope: key })}>{label}</button>
                ))}
              </div>
            </div>
            <div className="set-row">
              <div className="info">
                <div className="t">背景可见度</div>
                <div className="d">图片越明显,正文对比越低 · 建议保持较低值以便阅读</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: '180px', justifyContent: 'flex-end' }}>
                <input
                  type="range"
                  aria-label="背景可见度"
                  min={0.05}
                  max={1}
                  step={0.05}
                  value={bgOpacity}
                  onChange={e => onChange({ bgOpacity: Number(e.target.value) })}
                  style={{ flex: '1 1 auto', maxWidth: '160px' }}
                />
                <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: '12px', color: 'var(--muted)', width: '38px', textAlign: 'right' }}>
                  {Math.round(bgOpacity * 100)}%
                </span>
              </div>
            </div>
          </>
        )}
        <div className="set-row">
          <div className="info">
            <div className="t">紧凑密度</div>
            <div className="d">减小列表与卡片间距,单屏显示更多信息</div>
          </div>
          <button
            className={`toggle${appearance.density === 'compact' ? ' on' : ''}`}
            aria-label="紧凑密度"
            onClick={() => onChange({ density: appearance.density === 'compact' ? 'comfortable' : 'compact' })}
          />
        </div>
        <div className="set-row">
          <div className="info">
            <div className="t">字号</div>
            <div className="d">界面与代码字体大小</div>
          </div>
          <select
            className="sel"
            value={appearance.fontSize}
            onChange={e => onChange({ fontSize: e.target.value as Appearance['fontSize'] })}
          >
            <option value="small">小</option>
            <option value="medium">中(默认)</option>
            <option value="large">大</option>
          </select>
        </div>
      </div>
      <div className="set-group">
        <h4>终端字体</h4>
        <div className="set-row">
          <div className="info">
            <div className="t">字体族</div>
            <div className="d">终端字体系列,支持逗号分隔的备选字体</div>
          </div>
          <input
            className="sel"
            type="text"
            value={terminal.fontFamily}
            onChange={e => onTerminalChange({ fontFamily: e.target.value })}
          />
        </div>
        <div className="set-row">
          <div className="info">
            <div className="t">字号</div>
            <div className="d">终端字体大小(px)</div>
          </div>
          <input
            className="sel"
            type="number"
            value={terminal.fontSize}
            step={0.5}
            min={8}
            max={32}
            onChange={e => onTerminalChange({ fontSize: Number(e.target.value) })}
          />
        </div>
      </div>
    </>
  )
}
