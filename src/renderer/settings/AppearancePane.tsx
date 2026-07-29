import type { Appearance, Terminal } from '@shared/types'
import { FontPicker } from './FontPicker'

// 「外观」页只留与背景图无关的外观设置:主题、强调色、界面(窗口透明度/磨砂度/密度)、字体、终端字体。
// 内置壁纸库与所有背景图控件已拆到独立的「壁纸背景」页(BackgroundPane),两者操作同一套背景状态、放一起更顺。

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

// 正文基础字重滑块的范围与建议值。步进 25,建议 450(原「适中」)。
const WEIGHT_MIN = 300
const WEIGHT_MAX = 600
const WEIGHT_STEP = 25
const WEIGHT_SUGGESTED = 450
// 会话区行距建议值(偏舒展,接近 codex 观感)。
const CHAT_LH_SUGGESTED = 1.7

export function AppearancePane({ appearance, onChange, terminal, onTerminalChange }: AppearancePaneProps) {
  const opacity = appearance.windowOpacity ?? 1
  const blur = appearance.blurAmount ?? 0
  const appFont = appearance.fontFamily ?? ''
  const textWeight = appearance.textWeight ?? WEIGHT_SUGGESTED
  const chatLineHeight = appearance.chatLineHeight ?? CHAT_LH_SUGGESTED
  const chatLetterSpacing = appearance.chatLetterSpacing ?? 0
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
            <div className="d">从本机已装字体中选择,或按需下载免费字体(不占安装包)。留空 = 跟随系统字体</div>
          </div>
          <FontPicker value={appFont} onChange={family => onChange({ fontFamily: family })} />
        </div>
        <div className="set-row">
          <div className="info">
            <div className="t">文本字重</div>
            <div className="d">正文基础字重 · 数值越大越实、越清晰,只作用于正文,不会加粗标题等本就较重的文本 · 建议 {WEIGHT_SUGGESTED}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: '180px', justifyContent: 'flex-end' }}>
            <input
              type="range"
              aria-label="文本字重"
              min={WEIGHT_MIN}
              max={WEIGHT_MAX}
              step={WEIGHT_STEP}
              value={textWeight}
              onChange={e => onChange({ textWeight: Number(e.target.value) })}
              style={{ flex: '1 1 auto', maxWidth: '160px' }}
            />
            <button
              type="button"
              className="wf-pick"
              title={`恢复建议字重 ${WEIGHT_SUGGESTED}`}
              onClick={() => onChange({ textWeight: WEIGHT_SUGGESTED })}
              style={{ fontVariantNumeric: 'tabular-nums', fontSize: '12px', minWidth: '46px', textAlign: 'center', opacity: textWeight === WEIGHT_SUGGESTED ? 0.6 : 1 }}
            >
              {textWeight}
            </button>
          </div>
        </div>
        <div className="set-row">
          <div className="info">
            <div className="t">应用字号</div>
            <div className="d">整个应用界面的字体大小(px),不含会话区与终端 · 可精确到 0.5,如 11、11.5、12</div>
          </div>
          <input
            className="sel"
            type="number"
            aria-label="应用字号"
            value={appearance.fontSize ?? 14}
            step={0.5}
            min={9}
            max={24}
            onChange={e => onChange({ fontSize: Number(e.target.value) })}
          />
        </div>
        <div className="set-row">
          <div className="info">
            <div className="t">会话区字号</div>
            <div className="d">会话消息(输入与输出)的字体大小(px),独立于应用字号</div>
          </div>
          <input
            className="sel"
            type="number"
            aria-label="会话区字号"
            value={appearance.chatFontSize ?? 14}
            step={0.5}
            min={9}
            max={24}
            onChange={e => onChange({ chatFontSize: Number(e.target.value) })}
          />
        </div>
        <div className="set-row">
          <div className="info">
            <div className="t">会话区行距</div>
            <div className="d">会话消息的行间距(倍数)· 越大越透气、越舒展。建议 {CHAT_LH_SUGGESTED}(接近 codex 的观感)</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: '180px', justifyContent: 'flex-end' }}>
            <input
              type="range"
              aria-label="会话区行距"
              min={1.3}
              max={2.2}
              step={0.05}
              value={chatLineHeight}
              onChange={e => onChange({ chatLineHeight: Number(e.target.value) })}
              style={{ flex: '1 1 auto', maxWidth: '160px' }}
            />
            <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: '12px', color: 'var(--muted)', width: '38px', textAlign: 'right' }}>
              {chatLineHeight.toFixed(2)}
            </span>
          </div>
        </div>
        <div className="set-row">
          <div className="info">
            <div className="t">会话区字间距</div>
            <div className="d">会话消息字符的横向间距(em)· 0 = 默认。轻微加一点可让西文更透气,中文一般保持 0</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: '180px', justifyContent: 'flex-end' }}>
            <input
              type="range"
              aria-label="会话区字间距"
              min={-0.02}
              max={0.08}
              step={0.005}
              value={chatLetterSpacing}
              onChange={e => onChange({ chatLetterSpacing: Number(e.target.value) })}
              style={{ flex: '1 1 auto', maxWidth: '160px' }}
            />
            <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: '12px', color: 'var(--muted)', width: '46px', textAlign: 'right' }}>
              {chatLetterSpacing.toFixed(3)}em
            </span>
          </div>
        </div>
      </div>
      <div className="set-group">
        <h4>终端字体</h4>
        <div className="set-row">
          <div className="info">
            <div className="t">字体族</div>
            <div className="d">终端专用,须等宽字体;可选本机字体或下载免费等宽字体。独立于应用字体</div>
          </div>
          <FontPicker mono value={terminal.fontFamily} onChange={family => onTerminalChange({ fontFamily: family })} />
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
