import type { Appearance } from '@shared/types'
import { BUILTIN_SKINS } from '@shared/skins'
import { paletteSwatches, wallpaperSourceFor } from '../theme/wallpaperPalette'
import { useWallpaperPalette } from '../theme/wallpaperSample'

interface SkinsPaneProps {
  appearance: Appearance
  onChange: (partial: Partial<Appearance>) => void
}

// 主题皮肤画廊。皮肤卡可切换:点一次套用(置 activeSkin,applyTheme 打 data-skin,skins.css 覆盖整套 token +
// motif),再点同一张即取消(清 activeSkin,回你原本的基础主题)。右上「恢复默认外观」也可一键清掉。皮肤是
// 叠加层,不改写其它外观设置。
// 顶部另有「跟随壁纸配色」——从壁纸算出的自动皮肤,打开后接管手选皮肤(下面的画廊变灰)。
export function SkinsPane({ appearance, onChange }: SkinsPaneProps) {
  const active = appearance.activeSkin ?? null
  const autoOn = !!appearance.autoWallpaperTheme
  const src = wallpaperSourceFor(appearance)
  // always:true —— 即便开关没开也先算一份,好在卡片上预览「打开会变成什么样」(结果有缓存,代价可忽略)。
  const palette = useWallpaperPalette(appearance, { always: true })
  const swatches = palette ? paletteSwatches(palette) : null

  return (
    <div className="set-group skins-pane">
      <div className="skins-head">
        <div>
          <h4>主题皮肤</h4>
          <p className="skins-sub">一键把整窗换成一套成套设计的配色与氛围 · 即时生效,不改功能与排版。<b style={{ color: 'var(--fg-2)' }}>再点一次已选皮肤即可取消</b>,或点右侧「恢复默认外观」。</p>
        </div>
        <button
          className="skin-reset"
          onClick={() => onChange({ activeSkin: null, autoWallpaperTheme: false })}
          disabled={!active && !autoOn}
          title={active || autoOn ? '取消皮肤与壁纸配色,回到你的基础主题' : '当前就是基础主题(未套皮肤)'}
        >恢复默认外观</button>
      </div>

      {/* 跟随壁纸配色:算出来的「自动皮肤」。壁纸只提供两个色相,明度阶梯照抄已验证的内置主题,故不会失明。 */}
      <div className={`wp-auto${autoOn ? ' on' : ''}`}>
        <div className="wp-auto-row">
          <div className="info">
            <div className="t">跟随壁纸配色</div>
            <div className="d">
              从当前壁纸取主调色与点缀色,自动生成一整套配色(深浅基调也跟着壁纸走)· 换壁纸即重算,关掉即还原
              {!src && <b style={{ color: 'var(--fg-2)' }}> · 需要先在「壁纸背景」页设一张壁纸</b>}
            </div>
          </div>
          <button
            className={`toggle${autoOn ? ' on' : ''}`}
            aria-label="跟随壁纸配色"
            aria-pressed={autoOn}
            disabled={!src}
            onClick={() => onChange({ autoWallpaperTheme: !autoOn })}
          />
        </div>
        {src && (
          <div className="wp-auto-prev">
            {swatches
              ? <>
                  <div className="wp-auto-sw">{swatches.map((c, i) => <i key={i} style={{ background: c }} />)}</div>
                  <span className="wp-auto-meta">
                    {palette!.base === 'dark' ? '深色基调' : '浅色基调'}
                    {palette!.hueAccent == null
                      ? ' · 壁纸接近灰度,只染中性色、保留你的强调色'
                      : palette!.hueAccent === palette!.hueBg
                        ? ' · 壁纸只有一种色调,强调色用同色相'
                        : ' · 底色取主调、强调色取壁纸里最鲜艳的那抹'}
                  </span>
                </>
              : <span className="wp-auto-meta">正在从壁纸取色…</span>}
          </div>
        )}
      </div>

      {autoOn && (
        <p className="skins-sub" style={{ margin: '14px 0 -2px' }}>
          下面的成套皮肤<b style={{ color: 'var(--fg-2)' }}>已被壁纸配色接管</b> —— 关掉上面的开关后才可选。
        </p>
      )}
      <div className={`skins-grid${autoOn ? ' skins-grid-off' : ''}`}>
        {BUILTIN_SKINS.map(s => (
          <button
            key={s.id}
            className={`skin-card${active === s.id ? ' on' : ''}`}
            disabled={autoOn}
            onClick={() => onChange({ activeSkin: active === s.id ? null : s.id })}
            aria-pressed={active === s.id}
            title={autoOn ? '已被「跟随壁纸配色」接管' : active === s.id ? `再点一次取消「${s.name}」皮肤` : `套用「${s.name}」皮肤`}
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
