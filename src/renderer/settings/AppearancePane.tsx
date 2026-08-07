import { useEffect, useState } from 'react'
import type { Appearance, Terminal } from '@shared/types'
import { vibrancyMaterial } from '@shared/vibrancy'
import { FontPicker } from './FontPicker'
import { SkinsPane } from './SkinsPane'

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
  const skinActive = !!appearance.activeSkin   // 套了皮肤 → 基础主题(明暗/配色)被接管,下面那段变灰提示
  const autoWp = !!appearance.autoWallpaperTheme // 跟随壁纸配色 → 明暗 + 中性色 + 强调色全被接管(比皮肤更强)
  const themeTakenOver = skinActive || autoWp
  const customAccent = appearance.accentCustom ?? ''
  const blur = appearance.blurAmount ?? 0
  // 磨砂度改动是否真需要重启:应用内面板毛玻璃是实时 CSS,不需要;只有「桌面背景磨砂(原生 vibrancy)」需要,
  // 而它是建窗时定死的。所以只在当前磨砂级别落到与「启动时窗口实际用的级别」不同的 vibrancy 档位时,才提示重启
  // ——同档位内拖动、或压根没改,都不提示,避免那颗一直挂着的「没用的重启按钮」。
  const [baselineBlur, setBaselineBlur] = useState<number | null>(null)
  useEffect(() => { window.forge?.appVibrancyBaseline?.().then(setBaselineBlur).catch(() => {}) }, [])
  const restartPending = baselineBlur != null && vibrancyMaterial(baselineBlur) !== vibrancyMaterial(blur)
  const appFont = appearance.fontFamily ?? ''
  const textWeight = appearance.textWeight ?? WEIGHT_SUGGESTED
  const chatLineHeight = appearance.chatLineHeight ?? CHAT_LH_SUGGESTED
  const chatLetterSpacing = appearance.chatLetterSpacing ?? 0
  return (
    <>
      {/* 主题皮肤画廊置于外观页最顶:一键成套预设(接管配色)。选「默认」时,下面的手动主题/强调色才是主控。 */}
      <SkinsPane appearance={appearance} onChange={onChange} />
      <div className={`set-group${themeTakenOver ? ' set-group-overridden' : ''}`}>
        <h4>基础主题</h4>
        {autoWp
          ? <p className="skins-sub" style={{ margin: '-4px 0 12px' }}>明暗与配色<b style={{ color: 'var(--fg-2)' }}>已被「跟随壁纸配色」接管</b> —— 深浅基调按壁纸亮度自动判定。关掉上方那个开关后,这里的手动挡才生效。</p>
          : skinActive
            ? <p className="skins-sub" style={{ margin: '-4px 0 12px' }}>明暗与配色<b style={{ color: 'var(--fg-2)' }}>已被主题皮肤接管</b> —— 点上方「恢复默认外观」清掉皮肤后,这里的手动挡才生效(自定义强调色仍可随时覆盖皮肤)。</p>
            : <p className="skins-sub" style={{ margin: '-4px 0 12px' }}>没套皮肤(或想在皮肤之外微调)时,这里是手动挡:明暗基调 + 强调色。</p>}
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
        {autoWp && <p className="skins-sub" style={{ margin: '-4px 0 12px' }}>强调色<b style={{ color: 'var(--fg-2)' }}>已被「跟随壁纸配色」接管</b> —— 取的是壁纸里最鲜艳的那抹点缀色。只有壁纸接近灰度时,才回落到这里选的颜色。</p>}
        <div className="accent-row" style={autoWp ? { opacity: .4 } : undefined}>
          {ACCENTS.map(({ key, label, color }) => (
            <button key={key} className={`accent-sw${appearance.accent === key ? ' on' : ''}`} title={label} onClick={() => onChange({ accent: key })}>
              <i style={{ background: color }} />{ACK}
            </button>
          ))}
          {/* 自定义强调色:一颗打开系统色卡(原生 <input type=color>)的色板,选中即写 accent='custom'+accentCustom。
              未选时显示彩虹环示意「自选」,选中后显示所选色。 */}
          <label className={`accent-sw accent-sw-custom${appearance.accent === 'custom' ? ' on' : ''}`} title="自定义(用色卡自选)">
            <i style={appearance.accent === 'custom' && customAccent
              ? { background: customAccent }
              : { background: 'conic-gradient(from 90deg, #f43f5e, #f59e0b, #84cc16, #06b6d4, #6366f1, #d946ef, #f43f5e)' }} />
            {ACK}
            <input
              type="color"
              className="accent-color-input"
              aria-label="自定义强调色"
              value={/^#[0-9a-fA-F]{6}$/.test(customAccent) ? customAccent : '#3b82f6'}
              onChange={e => onChange({ accent: 'custom', accentCustom: e.target.value })}
            />
          </label>
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
        {restartPending && (
          <div className="set-row">
            <div className="info">
              <div className="d" style={{ color: 'var(--muted)' }}>桌面背景磨砂已改变,需重启才能应用到窗口</div>
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
