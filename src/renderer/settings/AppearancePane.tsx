import { useState } from 'react'
import type { Appearance, Terminal } from '@shared/types'

const BG_SCOPES: { key: NonNullable<Appearance['bgScope']>; label: string }[] = [
  { key: 'app', label: '整个应用' },
  { key: 'chat', label: '仅会话区' },
]

interface AppearancePaneProps {
  appearance: Appearance
  onChange: (partial: Partial<Appearance>) => void
  terminal: Terminal
  onTerminalChange: (partial: Partial<Terminal>) => void
}

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

const TEXT_WEIGHTS: { key: NonNullable<Appearance['textWeight']>; label: string }[] = [
  { key: 'normal', label: '标准' },
  { key: 'medium', label: '适中(更清晰)' },
]

export function AppearancePane({ appearance, onChange, terminal, onTerminalChange }: AppearancePaneProps) {
  const opacity = appearance.windowOpacity ?? 1
  const blur = appearance.blurAmount ?? 0
  const appFont = appearance.fontFamily ?? ''
  const textWeight = appearance.textWeight ?? 'medium'
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
  // 首页背景(独立于上面的应用/会话区背景)
  const homeBgImage = appearance.homeBgImage ?? ''
  const homeBgOn = appearance.homeBgOn ?? false
  const homeBgOpacity = appearance.homeBgOpacity ?? 0.35
  const [homeBgErr, setHomeBgErr] = useState('')
  const pickHomeBg = async () => {
    setHomeBgErr('')
    const r = await window.forge.pickBgImage?.()
    if (!r) return
    if (r.error) { setHomeBgErr(r.error); return }
    // First upload turns the home background on.
    if (r.dataUrl) onChange({ homeBgImage: r.dataUrl, homeBgOn: true })
  }
  return (
    <>
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
            <div className="t">紧凑密度</div>
            <div className="d">减小列表与卡片间距,单屏显示更多信息</div>
          </div>
          <button
            className={`toggle${appearance.density === 'compact' ? ' on' : ''}`}
            aria-label="紧凑密度"
            onClick={() => onChange({ density: appearance.density === 'compact' ? 'comfortable' : 'compact' })}
          />
        </div>
      </div>
      <div className="set-group">
        <h4>字体</h4>
        <div className="set-row">
          <div className="info">
            <div className="t">应用字体</div>
            <div className="d">整个应用界面的字体族,支持逗号分隔的备选字体。留空 = 跟随系统字体</div>
          </div>
          <input
            className="sel"
            type="text"
            placeholder="跟随系统"
            value={appFont}
            onChange={e => onChange({ fontFamily: e.target.value })}
          />
        </div>
        <div className="set-row">
          <div className="info">
            <div className="t">文本字重</div>
            <div className="d">「适中」把正文基础字重略微加实、渲染更清晰,不会加粗标题等本就较重的文本</div>
          </div>
          <div className="seg">
            {TEXT_WEIGHTS.map(({ key, label }) => (
              <button key={key} className={`wf-pick${textWeight === key ? ' on' : ''}`} onClick={() => onChange({ textWeight: key })}>{label}</button>
            ))}
          </div>
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
        <h4>背景图</h4>
        <div className="set-row">
          <div className="info">
            <div className="t">应用 / 会话区背景</div>
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
            <div className="t">首页背景图</div>
            <div className="d">
              为首页单独设置一张背景图 · 与上面的应用/会话区背景各自独立,可同可不同 · 在首页盖过「整个应用」背景
              {homeBgErr && <span style={{ color: 'var(--del)', marginLeft: 6 }}>{homeBgErr}</span>}
            </div>
          </div>
          <div className="seg">
            {homeBgImage && (
              <button
                className={`toggle${homeBgOn ? ' on' : ''}`}
                aria-label="启用首页背景"
                onClick={() => onChange({ homeBgOn: !homeBgOn })}
              />
            )}
            <button className="wf-pick" onClick={() => void pickHomeBg()}>{homeBgImage ? '更换图片' : '上传图片'}</button>
            {homeBgImage && <button className="wf-pick" onClick={() => onChange({ homeBgImage: '', homeBgOn: false })}>清除</button>}
          </div>
        </div>
        {homeBgImage && homeBgOn && (
          <div className="set-row">
            <div className="info">
              <div className="t">首页背景可见度</div>
              <div className="d">图片越明显,首页正文对比越低 · 建议保持较低值以便阅读</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: '180px', justifyContent: 'flex-end' }}>
              <input
                type="range"
                aria-label="首页背景可见度"
                min={0.05}
                max={1}
                step={0.05}
                value={homeBgOpacity}
                onChange={e => onChange({ homeBgOpacity: Number(e.target.value) })}
                style={{ flex: '1 1 auto', maxWidth: '160px' }}
              />
              <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: '12px', color: 'var(--muted)', width: '38px', textAlign: 'right' }}>
                {Math.round(homeBgOpacity * 100)}%
              </span>
            </div>
          </div>
        )}
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
