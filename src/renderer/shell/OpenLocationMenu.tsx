import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DetectedOpener, OpenTarget } from '@shared/openers'

const FOLDER_GLYPH = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="ol-ico">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
)
const CHEVRON = (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6" /></svg>
)

// Module-level cache: detect once per app session. The button remounts every time you enter a
// workspace, so caching here avoids a repeat IPC + main-process mdfind scan on each switch (the
// switch felt laggy). The on-disk cache in the main process still persists across restarts.
let cachedOpeners: DetectedOpener[] | null = null
// test-only: clear the session cache so tests don't leak detected apps into one another.
export function __resetOpenerCache() { cachedOpeners = null }

interface Props {
  // What to open: a folder, optionally with a file to reveal. null when there's no workspace.
  target: OpenTarget | null
  // The user's remembered default opener id ('' = none). App owns this via useSettings.
  defaultOpenerId: string
  onSetDefault: (id: string) => void
}

// 「打开位置」dropdown: a split button — the main part opens the current target with the default app,
// the caret expands the detected-apps list (picking one makes it the new default).
export function OpenLocationMenu({ target, defaultOpenerId, onSetDefault }: Props) {
  const [open, setOpen] = useState(false)
  const [apps, setApps] = useState<DetectedOpener[] | null>(cachedOpeners)
  const ref = useRef<HTMLSpanElement>(null)
  // The popover is portaled to <body> so a wallpaper-mode backdrop-filter on the titlebar can't trap it
  // behind the right-side inspector (both create stacking contexts; the later-painted inspector won).
  // Since it's no longer positioned relative to .open-loc, anchor it to the button's viewport rect.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const openPop = () => {
    const r = ref.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 4, left: r.left })
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    // The toolbar is fixed, but a window resize would strand the portaled pop — just close it.
    const onResize = () => setOpen(false)
    document.addEventListener('click', onDoc)
    window.addEventListener('resize', onResize)
    return () => { document.removeEventListener('click', onDoc); window.removeEventListener('resize', onResize) }
  }, [open])

  const ensureApps = async (): Promise<DetectedOpener[]> => {
    if (apps) return apps
    if (cachedOpeners) { setApps(cachedOpeners); return cachedOpeners }
    try {
      const list = (await window.forge?.detectOpeners?.()) ?? []
      cachedOpeners = list
      setApps(list)
      return list
    } catch { setApps([]); return [] }
  }

  // Preload the detected list on mount so the button can render the default opener's icon + name.
  useEffect(() => { void ensureApps() }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  const doOpen = async (id: string) => {
    if (!target) return
    const r = await window.forge?.openWith?.({ openerId: id, folder: target.folder, file: target.file })
    if (r && !r.ok) {
      // Lazy refresh: the app was deleted — drop it from the list + session cache, clear it as default.
      if (r.removedId) {
        const next = (apps ?? []).filter(a => a.id !== r.removedId)
        cachedOpeners = next
        setApps(next)
        if (r.removedId === defaultOpenerId) onSetDefault('')
      }
      window.alert(r.error ?? '打开失败')
    }
  }

  const onMain = async () => {
    const list = await ensureApps()
    if (defaultOpenerId && list.some(a => a.id === defaultOpenerId)) void doOpen(defaultOpenerId)
    else openPop()   // no valid default yet — let the user pick
  }
  const onCaret = async (e: React.MouseEvent) => { e.stopPropagation(); await ensureApps(); if (open) setOpen(false); else openPop() }
  const onPick = (id: string) => { onSetDefault(id); setOpen(false); void doOpen(id) }

  const current = apps?.find(a => a.id === defaultOpenerId) ?? null

  return (
    <span ref={ref} className={`open-loc${open ? ' open' : ''}`}>
      <button className="tb-btn open-loc-main" title="用外部软件打开当前工作区/文件" aria-label="用外部软件打开" disabled={!target} onClick={onMain}>
        {current?.icon ? <img src={current.icon} alt="" className="ol-ico" /> : FOLDER_GLYPH}
        <span className="ol-label">{current?.name ?? '打开位置'}</span>
      </button>
      <button className="tb-btn open-loc-caret" title="选择打开软件" aria-label="选择软件" aria-haspopup="menu" aria-expanded={open} onClick={onCaret}>
        {CHEVRON}
      </button>
      {open && pos && createPortal(
        <div className="open-loc-pop portaled" style={{ top: pos.top, left: pos.left }} role="menu" onClick={e => e.stopPropagation()}>
          {(apps ?? []).length === 0 && <div className="ol-empty">未检测到可用软件</div>}
          {(apps ?? []).map(a => (
            <span
              key={a.id}
              role="menuitem"
              tabIndex={0}
              className={`ol-item${a.id === defaultOpenerId ? ' on' : ''}`}
              onClick={() => onPick(a.id)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(a.id) } }}
            >
              {a.icon ? <img src={a.icon} alt="" className="ol-ico" /> : FOLDER_GLYPH}
              {a.name}
            </span>
          ))}
        </div>,
        document.body,
      )}
    </span>
  )
}
