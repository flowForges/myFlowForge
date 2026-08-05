import type { Appearance } from '@shared/types'
import { BUILTIN_SKINS } from '@shared/skins'

interface SkinsPaneProps {
  appearance: Appearance
  onChange: (partial: Partial<Appearance>) => void
}

// 主题皮肤画廊。皮肤卡可切换:点一次套用(置 activeSkin,applyTheme 打 data-skin,skins.css 覆盖整套 token +
// motif),再点同一张即取消(清 activeSkin,回你原本的基础主题)。右上「恢复默认外观」也可一键清掉。皮肤是
// 叠加层,不改写其它外观设置。
export function SkinsPane({ appearance, onChange }: SkinsPaneProps) {
  const active = appearance.activeSkin ?? null
  return (
    <div className="set-group skins-pane">
      <div className="skins-head">
        <div>
          <h4>主题皮肤</h4>
          <p className="skins-sub">一键把整窗换成一套成套设计的配色与氛围 · 即时生效,不改功能与排版。<b style={{ color: 'var(--fg-2)' }}>再点一次已选皮肤即可取消</b>,或点右侧「恢复默认外观」。</p>
        </div>
        <button
          className="skin-reset"
          onClick={() => onChange({ activeSkin: null })}
          disabled={!active}
          title={active ? '取消皮肤,回到你的基础主题' : '当前就是基础主题(未套皮肤)'}
        >恢复默认外观</button>
      </div>

      <div className="skins-grid">
        {BUILTIN_SKINS.map(s => (
          <button
            key={s.id}
            className={`skin-card${active === s.id ? ' on' : ''}`}
            onClick={() => onChange({ activeSkin: active === s.id ? null : s.id })}
            aria-pressed={active === s.id}
            title={active === s.id ? `再点一次取消「${s.name}」皮肤` : `套用「${s.name}」皮肤`}
          >
            {/* 迷你窗预览:侧栏(panel)+ 主区(bg)+ accent 药丸 + accent2 圆点 */}
            <div className="skin-prev" style={{ background: s.swatches[0] }}>
              <div className="skin-prev-side" style={{ background: s.swatches[1] }} />
              <div className="skin-prev-pill" style={{ background: s.swatches[2] }} />
              <div className="skin-prev-dot" style={{ background: s.swatches[3] }} />
            </div>
            <div className="skin-info">
              <div className="skin-nm">
                <b>{s.name}</b><span className="skin-en">{s.en}</span>
                <span className="skin-tag">{s.tag}</span>
              </div>
              <p className="skin-vibe">{s.vibe}</p>
              <div className="skin-sw">
                {s.swatches.map((hex, i) => <i key={i} style={{ background: hex }} />)}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
