import { useEffect, useMemo, useRef, useState } from 'react'
import { FONT_CATALOG, type FontCatalogEntry } from '@shared/fontCatalog'
import { injectDownloadedFontFaces } from '../theme/fontFaces'

// queryLocalFonts (Local Font Access API) isn't in the default TS lib; declare the slice we use.
type LocalFont = { family: string }
function queryLocalFonts(): Promise<LocalFont[]> {
  const q = (window as unknown as { queryLocalFonts?: () => Promise<LocalFont[]> }).queryLocalFonts
  return q ? q() : Promise.resolve([])
}

const fmtSize = (bytes: number): string =>
  bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(bytes >= 10_000_000 ? 0 : 1)} MB` : `${Math.round(bytes / 1000)} KB`

interface FontPickerProps {
  value: string
  onChange: (family: string) => void
  // mono = terminal mode: only offer monospace catalog fonts, wrap a picked family with a monospace
  // fallback (terminals need fixed-width fonts to keep columns aligned), and drop the follow-system row.
  mono?: boolean
}

// Searchable font picker: pick from downloaded fonts, locally-installed system fonts (via
// queryLocalFonts), or download a free catalog font on demand. Falls back to a manual comma-separated
// stack for advanced users. In default (proportional) mode, empty value = follow the system font stack;
// in mono mode it's scoped to monospace fonts for the terminal.
export function FontPicker({ value, onChange, mono = false }: FontPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [localFonts, setLocalFonts] = useState<string[] | null>(null)
  const [downloaded, setDownloaded] = useState<{ id: string; family: string }[]>([])
  const [progress, setProgress] = useState<Record<string, { done: number; total: number }>>({})
  const [err, setErr] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Load downloaded fonts once; keep progress events flowing so bars update live during a download.
  useEffect(() => {
    void injectDownloadedFontFaces().then(setDownloaded)
    const off = window.forge?.onFontDownloadProgress?.(p => setProgress(prev => ({ ...prev, [p.id]: { done: p.done, total: p.total } })))
    return () => { off?.() }
  }, [])

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  // queryLocalFonts needs a user gesture + permission — call it when the user opens the picker.
  const openPicker = () => {
    setOpen(true); setErr('')
    if (localFonts === null) {
      queryLocalFonts()
        .then(fonts => setLocalFonts([...new Set(fonts.map(f => f.family))].sort((a, b) => a.localeCompare(b))))
        .catch(() => setLocalFonts([]))
    }
  }

  // Terminal picker shows only monospace catalog fonts; app picker shows only proportional ones.
  const inMode = (id: string) => {
    const cat = FONT_CATALOG.find(e => e.id === id)?.category
    return mono ? cat === 'mono' : cat !== 'mono'
  }
  const downloadedIds = new Set(downloaded.map(d => d.id))
  const downloadable = FONT_CATALOG.filter(e => !downloadedIds.has(e.id) && (mono ? e.category === 'mono' : e.category !== 'mono'))

  const q = query.trim().toLowerCase()
  const match = (s: string) => !q || s.toLowerCase().includes(q)
  const shownLocal = useMemo(
    () => (localFonts ?? []).filter(match).slice(0, 200),
    [localFonts, q],
  )
  const shownDownloaded = downloaded.filter(d => match(d.family) && inMode(d.id))
  const shownDownloadable = downloadable.filter(e => match(e.family) || match(e.label))

  // Terminals need a monospace fallback so a picked (or later-missing) font still keeps columns aligned.
  const pick = (family: string) => {
    onChange(family && mono ? `'${family}', ui-monospace, monospace` : family)
    setOpen(false); setQuery('')
  }

  const download = async (entry: FontCatalogEntry) => {
    setErr('')
    setProgress(prev => ({ ...prev, [entry.id]: { done: 0, total: 0 } }))
    try {
      const r = await window.forge?.fontsDownload?.(entry.id)
      if (r?.error) { setErr(`${entry.label}:${r.error}`); return }
      const list = await injectDownloadedFontFaces()
      setDownloaded(list)
      pick(entry.family) // auto-apply the just-downloaded font
    } catch {
      setErr(`${entry.label}:下载失败`)
    } finally {
      setProgress(prev => { const n = { ...prev }; delete n[entry.id]; return n })
    }
  }

  return (
    <div className="font-picker" ref={rootRef}>
      <button className="sel fp-trigger" onClick={() => (open ? setOpen(false) : openPicker())} title={value || '跟随系统'}>
        <span style={value ? { fontFamily: `'${value.split(',')[0].replace(/['"]/g, '').trim()}', system-ui, sans-serif` } : undefined}>
          {value || '跟随系统'}
        </span>
        <svg className="fp-caret" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="6 9 12 15 18 9" /></svg>
      </button>

      {open && (
        <div className="fp-pop">
          <input className="fp-search" autoFocus placeholder="搜索字体…" value={query} onChange={e => setQuery(e.target.value)} />
          {mono && <div className="fp-note">终端建议用等宽字体,否则输出的列可能对不齐。已装的 Nerd Font 会出现在「本机字体」中可直接选。</div>}
          {err && <div className="fp-err">{err}</div>}
          <div className="fp-list">
            {!mono && (
              <button className="fp-item" onClick={() => pick('')}>
                <span className="fp-name">跟随系统</span>
                {!value && <span className="fp-cur">当前</span>}
              </button>
            )}

            {shownDownloaded.length > 0 && <div className="fp-sec">已下载</div>}
            {shownDownloaded.map(d => (
              <button key={d.id} className="fp-item" onClick={() => pick(d.family)}>
                <span className="fp-name" style={{ fontFamily: `'${d.family}', system-ui, sans-serif` }}>{d.family}</span>
                <span className="fp-preview" style={{ fontFamily: `'${d.family}', system-ui, sans-serif` }}>Aa 字体 123</span>
              </button>
            ))}

            {shownDownloadable.length > 0 && <div className="fp-sec">可下载(免费 · 用时才下)</div>}
            {shownDownloadable.map(e => {
              const p = progress[e.id]
              const busy = !!p
              const pct = p && p.total > 0 ? Math.round((p.done / p.total) * 100) : 0
              return (
                <div key={e.id} className="fp-item fp-dl-row">
                  <span className="fp-name">{e.label}</span>
                  {e.cjk && <span className="fp-badge">较大</span>}
                  <span className="fp-size">{fmtSize(e.approxBytes)}</span>
                  <button className="fp-dl" disabled={busy} onClick={() => void download(e)}>
                    {busy ? (p!.total > 0 ? `${pct}%` : '下载中…') : '下载'}
                  </button>
                </div>
              )
            })}

            {shownLocal.length > 0 && <div className="fp-sec">本机字体</div>}
            {localFonts === null && <div className="fp-hint">正在读取本机字体…</div>}
            {localFonts !== null && shownLocal.length === 0 && shownDownloaded.length === 0 && q && (
              <div className="fp-hint">无匹配字体</div>
            )}
            {shownLocal.map(f => (
              <button key={f} className="fp-item" onClick={() => pick(f)}>
                <span className="fp-name" style={{ fontFamily: `'${f}', system-ui, sans-serif` }}>{f}</span>
                {f === value && <span className="fp-cur">当前</span>}
              </button>
            ))}
          </div>

          <div className="fp-adv">
            <button className="fp-adv-toggle" onClick={() => setAdvanced(a => !a)}>
              {advanced ? '收起手动输入' : '手动输入字体族(高级)'}
            </button>
            {advanced && (
              <input
                className="fp-adv-input"
                placeholder={mono ? "如: 'MesloLGS NF', ui-monospace, monospace" : "如: 'PingFang SC', 'Inter', sans-serif"}
                value={value}
                onChange={e => onChange(e.target.value)}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
