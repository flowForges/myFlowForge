import { useState } from 'react'
import type { Appearance } from '@shared/types'
import { WallpaperGallery } from './WallpaperGallery'

// 「壁纸背景」设置页。把内置壁纸库和所有"背景图"相关控件从「外观」页拆出来单独成页 —— 选内置壁纸、
// 上传自己的图、背景范围/可见度、首页背景,它们操作的是同一套 bgImage/bgScope/bgOpacity 状态,放在一起
// 才不至于"选图在一处、调可见度在另一处"。壁纸库放在最上面,数量再多也只挤占本页、不影响外观页其它设置。
// (窗口透明度/磨砂度属于窗口合成、不是背景图,留在「外观」。)

const BG_SCOPES: { key: NonNullable<Appearance['bgScope']>; label: string }[] = [
  { key: 'app', label: '整个应用' },
  { key: 'chat', label: '仅会话区' },
]

interface BackgroundPaneProps {
  appearance: Appearance
  onChange: (partial: Partial<Appearance>) => void
}

export function BackgroundPane({ appearance, onChange }: BackgroundPaneProps) {
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
    // Uploading your own image de-selects any built-in wallpaper.
    if (r.url) onChange({ bgImage: r.url, bgScope: bgScope === 'off' ? 'app' : bgScope, bgWallpaperId: '' })
  }
  const applyWallpaper = (url: string, id: string) =>
    onChange({ bgImage: url, bgScope: bgScope === 'off' ? 'app' : bgScope, bgWallpaperId: id })
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
    if (r.url) onChange({ homeBgImage: r.url, homeBgOn: true })
  }
  return (
    <>
      <WallpaperGallery current={appearance.bgWallpaperId ?? ''} onApply={applyWallpaper} onClear={() => onChange({ bgImage: '', bgScope: 'off', bgWallpaperId: '' })} />
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
            {bgImage && <button className="wf-pick" onClick={() => onChange({ bgImage: '', bgScope: 'off', bgWallpaperId: '' })}>清除</button>}
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
    </>
  )
}
