import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useHost } from './useHostKey'
import './pathpicker.css'

type Kind = 'directory' | 'file'
type Req = { kind: Kind; title: string; resolve: (p: string | null) => void }
type BrowseEntry = { name: string; path: string; dir: boolean }
type BrowseResult = { path: string; parent: string | null; entries: BrowseEntry[]; isWorkspace: boolean; error?: string }

const Ctx = createContext<{ pick: (kind: Kind, title?: string) => Promise<string | null> } | null>(null)

/**
 * 统一的「选一个路径」入口。
 *
 * ★本机时走系统原生对话框(体验更好、有收藏夹和搜索);**连着远程主机时走服务端目录浏览器** ——
 * 因为要定位的目录在**那台**机器上,本机的对话框里根本没有它。这正是设计文档 14.7
 * 第 2 难「手机上怎么选目录」在桌面端的同一个答案。
 */
export function usePathPicker() {
  const ctx = useContext(Ctx)
  // ★没有 provider 时**不抛**,退回到原生对话框 —— 也就是拆分之前的行为。
  //   宠物窗、以及一堆只渲染局部组件的测试都不在 provider 里;为了一个「选路径」的增强
  //   让那些界面整个白掉是完全不划算的。同一个教训在 useHostKey 上刚栽过一次。
  return ctx ?? NATIVE_ONLY
}

const NATIVE_ONLY = {
  pick: (kind: Kind) => (kind === 'directory' ? window.forge.pickDirectory() : window.forge.pickFile()),
}

export function PathPickerProvider({ children }: { children: ReactNode }) {
  const { key: hostKey, label: hostLabel } = useHost()
  const [req, setReq] = useState<Req | null>(null)

  const pick = useCallback(async (kind: Kind, title?: string): Promise<string | null> => {
    if (hostKey === 'local') {
      // 本机:原生对话框。
      return kind === 'directory' ? window.forge.pickDirectory() : window.forge.pickFile()
    }
    return new Promise<string | null>((resolve) => {
      setReq({ kind, title: title ?? (kind === 'directory' ? '选择目录' : '选择文件'), resolve })
    })
  }, [hostKey])

  const done = useCallback((p: string | null) => {
    setReq((r) => { r?.resolve(p); return null })
  }, [])

  return (
    <Ctx.Provider value={{ pick }}>
      {children}
      {req && <RemoteBrowser req={req} hostLabel={hostLabel} onDone={done} />}
    </Ctx.Provider>
  )
}

const FOLDER = <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="glyph"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
const FILE = <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="glyph"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg>

function RemoteBrowser({ req, hostLabel, onDone }: { req: Req; hostLabel: string; onDone: (p: string | null) => void }) {
  const [cur, setCur] = useState<BrowseResult | null>(null)
  const [roots, setRoots] = useState<BrowseEntry[]>([])
  const [showHidden, setShowHidden] = useState(false)
  const [busy, setBusy] = useState(true)
  const live = useRef(true)

  const go = useCallback(async (path: string) => {
    setBusy(true)
    try {
      const r = await window.forge.fsBrowse({ path, showHidden, filesToo: req.kind === 'file' })
      if (live.current) setCur(r)
    } finally { if (live.current) setBusy(false) }
  }, [showHidden, req.kind])

  useEffect(() => {
    live.current = true
    void window.forge.fsBrowseRoots().then((r) => { if (live.current) setRoots(r) })
    void go('')
    return () => { live.current = false }
  }, [go])

  // Esc 取消 —— 一个占满屏幕的选择器必须能一键退出。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDone(null) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onDone])

  const canSelectCurrent = req.kind === 'directory' && !!cur && !cur.error

  return (
    <div className="pp-backdrop" onClick={() => onDone(null)}>
      <div className="pp-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={req.title}>
        <div className="pp-head">
          <h3>{req.title}</h3>
          {/* ★说清是在浏览哪台机器 —— 远程时最容易搞错的就是「这是谁的文件系统」。 */}
          <div className="where">正在浏览「{hostLabel}」上的目录</div>
        </div>

        <div className="pp-roots">
          {roots.map((r) => (
            <button key={r.path} className="set-btn" onClick={() => void go(r.path)}>{r.name}</button>
          ))}
        </div>

        <div className="pp-crumb">
          <button className="set-btn" disabled={!cur?.parent || busy} onClick={() => cur?.parent && void go(cur.parent)}>← 上一层</button>
          <span className="path" title={cur?.path ?? ''}>{cur?.path ?? '…'}</span>
        </div>

        {cur?.error && <div className="pp-err">{cur.error}</div>}

        <div className="pp-list">
          {!cur?.error && (cur?.entries.length ?? 0) === 0 && !busy && <div className="pp-empty">这个目录是空的</div>}
          {cur?.entries.map((e) => (
            <div
              key={e.path}
              className={`pp-item${e.dir ? '' : ' file'}`}
              role="button"
              tabIndex={0}
              onClick={() => (e.dir ? void go(e.path) : req.kind === 'file' && onDone(e.path))}
              onKeyDown={(k) => { if (k.key === 'Enter') { e.dir ? void go(e.path) : req.kind === 'file' && onDone(e.path) } }}
            >
              {e.dir ? FOLDER : FILE}
              <span>{e.name}</span>
            </div>
          ))}
        </div>

        <div className="pp-foot">
          <label className="pp-hidden" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--fg-2)' }}>
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
            显示隐藏项
          </label>
          <span className="grow" />
          <button className="set-btn" onClick={() => onDone(null)}>取消</button>
          {req.kind === 'directory' && (
            <button className="set-btn primary" disabled={!canSelectCurrent} onClick={() => cur && onDone(cur.path)}>
              选择这个目录{cur?.isWorkspace ? '(已是工作区)' : ''}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
