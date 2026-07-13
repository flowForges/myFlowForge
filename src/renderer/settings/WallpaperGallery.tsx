import { useEffect, useState } from 'react'
import type { WallpaperCatalog, WallpaperItem } from '@shared/wallpaper'

interface WallpaperGalleryProps {
  current: string                                  // appearance.bgWallpaperId — highlights the applied tile
  onApply: (url: string, id: string) => void       // caller sets bgImage + bgScope + bgWallpaperId
}

const CHECK = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
)

// Built-in wallpaper gallery. Lists the public jsDelivr catalog, shows on-disk-cached thumbnails, and on
// click downloads the full image and hands its forge-bg:// URL back to be set as the background. No
// activation code — this is available to everyone and never touches the NSFW Worker.
export function WallpaperGallery({ current, onApply }: WallpaperGalleryProps) {
  const [catalog, setCatalog] = useState<WallpaperCatalog | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [thumbs, setThumbs] = useState<Record<string, string>>({}) // id → forge-bg:// URL (on-disk cache)

  const load = () => {
    setErr(''); setCatalog(null); setThumbs({})
    void window.forge?.wallpaperCatalog?.().then(r => {
      if (!r) { setErr('加载失败'); setCatalog({ wallpapers: [] }); return }
      if ('error' in r) { setErr(r.error); setCatalog({ wallpapers: [] }); return }
      setCatalog(r)
      for (const w of r.wallpapers) void loadThumb(w)
    }).catch(() => { setErr('加载失败'); setCatalog({ wallpapers: [] }) })
  }
  const loadThumb = async (w: WallpaperItem) => {
    const r = await window.forge?.wallpaperPreview?.(w)
    if (r && 'url' in r) setThumbs(prev => ({ ...prev, [w.id]: r.url }))
  }
  useEffect(load, [])

  const apply = async (w: WallpaperItem) => {
    setBusy(w.id); setErr('')
    try {
      const r = await window.forge?.wallpaperInstall?.(w)
      if (!r || 'error' in r) { setErr(r && 'error' in r ? r.error : '应用失败'); return }
      onApply(r.url, w.id)
    } finally { setBusy(null) }
  }

  // Preserve catalog order within each category (the catalog is authored fj… then cm…).
  const cats: string[] = []
  const byCat: Record<string, WallpaperItem[]> = {}
  for (const w of catalog?.wallpapers ?? []) {
    if (!byCat[w.cat]) { byCat[w.cat] = []; cats.push(w.cat) }
    byCat[w.cat].push(w)
  }

  const tile = (w: WallpaperItem) => {
    const thumb = thumbs[w.id]
    const busyThis = busy === w.id
    const on = !!current && current === w.id
    return (
      <button
        key={w.id}
        className={`wp-tile${on ? ' on' : ''}`}
        disabled={busyThis || !!busy}
        title={w.desc || w.name}
        onClick={() => void apply(w)}
      >
        <div className="wp-thumb">
          {thumb ? <img src={thumb} alt="" /> : <span className="wp-thumb-ph">加载中…</span>}
          {busyThis && (
            <div className="wp-loading"><span className="wp-spin" />下载中…</div>
          )}
        </div>
        <div className="wp-name">{w.name}</div>
        {on && !busyThis && <span className="wp-check">{CHECK}</span>}
      </button>
    )
  }

  return (
    <div className="set-group">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h4 style={{ margin: 0 }}>内置壁纸</h4>
        <button className="wf-pick" style={{ fontSize: 11, padding: '2px 8px' }} onClick={load}>刷新</button>
      </div>
      <p className="set-desc">
        精选壁纸,点一张即下载并设为应用背景(下方可调背景范围与可见度)。图片按需从网络下载,不占安装包。
        {err && <span style={{ color: 'var(--del)', marginLeft: 6 }}>{err}</span>}
      </p>
      {!catalog && <p className="set-desc">加载中…</p>}
      {catalog && catalog.wallpapers.length === 0 && !err && <p className="set-desc">暂无可用壁纸。</p>}
      {cats.map(cat => (
        <div key={cat} className="wp-group">
          <div className="wp-group-h">{cat}</div>
          <div className="wp-grid">{byCat[cat].map(tile)}</div>
        </div>
      ))}
    </div>
  )
}
