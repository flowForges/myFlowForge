import { useEffect, useRef, useState } from 'react'
import type { WallpaperCatalog, WallpaperItem } from '@shared/wallpaper'

interface WallpaperGalleryProps {
  current: string                                  // appearance.bgWallpaperId — highlights the applied tile
  onApply: (url: string, id: string) => void       // caller sets bgImage + bgScope + bgWallpaperId
  onClear?: () => void                             // 再次点击已选中的壁纸 → 取消选择,恢复无背景图
}

const CHECK = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
)

// One wallpaper tile. Thumbnails are loaded LAZILY — only when the tile scrolls into view — so a gallery
// of 100+ wallpapers doesn't fire 100 thumbnail requests the moment the pane opens. `onShow` is called
// once, the first time the tile is (near) visible. Where IntersectionObserver is unavailable (jsdom in
// tests, ancient engines) we fall back to loading eagerly on mount so nothing silently stays blank.
function WallpaperTile({ w, thumb, busy, anyBusy, on, onPick, onShow }: {
  w: WallpaperItem
  thumb: string | undefined
  busy: boolean
  anyBusy: boolean
  on: boolean
  onPick: () => void
  onShow: () => void
}) {
  const ref = useRef<HTMLButtonElement | null>(null)
  const shownRef = useRef(false)
  useEffect(() => {
    if (shownRef.current) return
    const fire = () => { if (!shownRef.current) { shownRef.current = true; onShow() } }
    if (typeof IntersectionObserver === 'undefined') { fire(); return }
    const el = ref.current
    if (!el) { fire(); return }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { fire(); io.disconnect() }
    }, { rootMargin: '200px' })   // start fetching a bit before the tile actually enters the viewport
    io.observe(el)
    return () => io.disconnect()
    // onShow identity is stable per render but we only ever fire once (shownRef guard), so deps are fine.
  }, [onShow])
  return (
    <button
      ref={ref}
      className={`wp-tile${on ? ' on' : ''}`}
      disabled={busy || anyBusy}
      title={on ? '已选中 · 再次点击取消,恢复无背景' : (w.desc || w.name)}
      onClick={onPick}
    >
      <div className="wp-thumb">
        {thumb ? <img src={thumb} alt="" /> : <span className="wp-thumb-ph">加载中…</span>}
        {busy && (
          <div className="wp-loading"><span className="wp-spin" />下载中…</div>
        )}
      </div>
      <div className="wp-name">{w.name}</div>
      {on && !busy && <span className="wp-check">{CHECK}</span>}
    </button>
  )
}

// Built-in wallpaper gallery. Lists the public jsDelivr catalog, shows on-disk-cached thumbnails, and on
// click downloads the full image and hands its forge-bg:// URL back to be set as the background. No
// activation code — this is available to everyone and never touches the NSFW Worker.
export function WallpaperGallery({ current, onApply, onClear }: WallpaperGalleryProps) {
  const [catalog, setCatalog] = useState<WallpaperCatalog | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [thumbs, setThumbs] = useState<Record<string, string>>({}) // id → forge-bg:// URL (on-disk cache)
  // 当前分类('' = 全部)。壁纸到两三百张之后,纵向堆叠所有分类要滚很久 —— chips 让「我想看风景」一步到位。
  // 缩略图本来就是懒加载的,所以「全部」也不会一次打几百个请求;分类解决的是**找**的问题,不是加载的问题。
  const [cat, setCat] = useState('')
  const requested = useRef<Set<string>>(new Set())                 // ids whose thumb load已发起(去重,不重复请求)

  const load = () => {
    setErr(''); setCatalog(null); setThumbs({}); requested.current = new Set()
    void window.forge?.wallpaperCatalog?.().then(r => {
      if (!r) { setErr('加载失败'); setCatalog({ wallpapers: [] }); return }
      if ('error' in r) { setErr(r.error); setCatalog({ wallpapers: [] }); return }
      setCatalog(r)
      // Thumbnails are NOT bulk-loaded here — each tile requests its own when it scrolls into view.
    }).catch(() => { setErr('加载失败'); setCatalog({ wallpapers: [] }) })
  }
  // Load one thumbnail on demand (called by a tile when it becomes visible). Idempotent per id.
  const requestThumb = async (w: WallpaperItem) => {
    if (requested.current.has(w.id) || thumbs[w.id]) return
    requested.current.add(w.id)
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
  // 选中的分类若在刷新后消失(目录换了批次),回落到全部,别卡在一个空列表上。
  const activeCat = cat && byCat[cat] ? cat : ''
  const shownCats = activeCat ? [activeCat] : cats
  const total = catalog?.wallpapers.length ?? 0

  return (
    <div className="set-group">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h4 style={{ margin: 0 }}>内置壁纸</h4>
        <button className="wf-pick" style={{ fontSize: 11, padding: '2px 8px' }} onClick={load}>刷新</button>
      </div>
      <p className="set-desc">
        精选壁纸,点一张即下载并设为应用背景(下方可调背景范围与可见度)。<b>再次点击已选中的那张即可取消,恢复无背景图</b>。图片按需从网络下载,不占安装包。
        {err && <span style={{ color: 'var(--del)', marginLeft: 6 }}>{err}</span>}
      </p>
      <p className="set-desc" style={{ color: 'var(--faint)', fontSize: 11 }}>
        免责声明:以上图片均来源于网络,版权归原作者所有,仅供个人学习交流使用,请勿用于商业用途;如涉及侵权请联系删除。
      </p>
      {!catalog && <p className="set-desc">加载中…</p>}
      {catalog && catalog.wallpapers.length === 0 && !err && <p className="set-desc">暂无可用壁纸。</p>}
      {cats.length > 1 && (
        <div className="wp-cats">
          <button className={`wp-cat${activeCat === '' ? ' on' : ''}`} onClick={() => setCat('')}>
            全部<span className="wp-cat-n">{total}</span>
          </button>
          {cats.map(c => (
            <button key={c} className={`wp-cat${activeCat === c ? ' on' : ''}`} onClick={() => setCat(c)}>
              {c}<span className="wp-cat-n">{byCat[c].length}</span>
            </button>
          ))}
        </div>
      )}
      {shownCats.map(cat => (
        <div key={cat} className="wp-group">
          {/* 只选了一类时不必再顶一个同名标题 —— chips 已经写着当前在看哪类。 */}
          {!activeCat && <div className="wp-group-h">{cat}</div>}
          <div className="wp-grid">
            {byCat[cat].map(w => (
              <WallpaperTile
                key={w.id}
                w={w}
                thumb={thumbs[w.id]}
                busy={busy === w.id}
                anyBusy={!!busy}
                on={!!current && current === w.id}
                onPick={() => (current === w.id ? onClear?.() : void apply(w))}
                onShow={() => void requestThumb(w)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
