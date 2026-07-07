import { useEffect, useRef, useState } from 'react'
import { ICN, formatBytes, sanitize } from './notifications'
import type { UpdateInfo, InstallProgress } from '@shared/types'
import type { UpdatePhase } from '../state/useUpdate'

interface UpgradeModalProps {
  open: boolean
  onClose: () => void
  info: UpdateInfo | null
  currentVersion: string
  phase: UpdatePhase
  progress: InstallProgress | null
  onStart: () => void
}

interface LogLine { tk: string; text: string }

// GitHub 发布页(与主进程 updateChecker 的 UPDATE_REPO 一致)。更新失败时给用户一个可手动下载的去处。
const RELEASES_URL = 'https://github.com/xzghua/myFlowForge/releases/latest'

export function UpgradeModal({ open, onClose, info, currentVersion, phase, progress, onStart }: UpgradeModalProps) {
  const [log, setLog] = useState<LogLine[]>([])
  const stampRef = useRef(0)
  const lastLogRef = useRef<string | null>(null)
  const prevOpenRef = useRef(open)
  const logRef = useRef<HTMLDivElement>(null)

  const running = phase === 'downloading'
  const done = phase === 'done'

  // Reset accumulated log on the closed → open transition.
  useEffect(() => {
    const wasOpen = prevOpenRef.current
    prevOpenRef.current = open
    if (open && !wasOpen) { setLog([]); stampRef.current = 0; lastLogRef.current = null }
  }, [open])

  // Append a log line when a progress event carries one (dedupe identical consecutive logs).
  useEffect(() => {
    if (progress?.log && progress.log !== lastLogRef.current) {
      lastLogRef.current = progress.log
      stampRef.current += 0.4 + (stampRef.current % 1.3)
      const tk = stampRef.current.toFixed(1) + 's'
      const text = progress.log
      setLog(prev => [...prev, { tk, text }])
    }
  }, [progress])

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight }, [log])

  useEffect(() => {
    if (!open) return
    // Esc always closes: during a download it just minimizes to background (the download runs in the
    // main process and keeps going); the modal reopens automatically when it finishes.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const pct = progress?.pct ?? 0
  const stage = progress?.stage ?? '准备中…'

  return (
    <div
      className={'upd-overlay' + (open ? ' on' : '')}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="upd-sheet">
        <div className="upd-hero">
          <div className="upd-mark">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>
          </div>
          <div>
            <h2>有可用更新</h2>
            <div className="vers">当前 v{currentVersion} → 最新 <b>v{info?.version ?? '—'}</b>{info ? ` · ${formatBytes(info.dmgSize)}` : ''}</div>
          </div>
        </div>
        <div className="upd-body">
          {!running && !done && info && (
            <div>
              <h5>更新内容</h5>
              <ul className="upd-notes">
                {info.notes.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 8).map((l, i) => (
                  <li key={i} dangerouslySetInnerHTML={{ __html: sanitize(l.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '')) }} />
                ))}
              </ul>
            </div>
          )}
          <div className={'upd-prog' + (running ? ' on' : '')}>
            <div className="upd-bar"><i style={{ width: pct + '%' }} /></div>
            <div className="pmeta"><span className="stage">{stage}</span><span className="pct">{pct}%</span></div>
            <div className="upd-log" ref={logRef}>
              {log.map((l, i) => (
                <div key={i} className={'ll' + (running && i === log.length - 1 ? ' cur' : '')}>
                  <span className="tk">{l.tk}</span><span className="mk">›</span><span>{l.text}</span>
                </div>
              ))}
            </div>
          </div>
          {running && <p className="upd-hint">下载在后台进行,可点「后台下载」继续使用 app,完成后会自动提示你安装。</p>}
          <div className={'upd-done' + (done ? ' on' : '')}>
            <span className="dk">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><polyline points="20 6 9 17 4 12" /></svg>
              已下载 v{info?.version ?? ''}
            </span>
            <p>下载的是一个 <b>.dmg 安装器</b>,已自动为你打开。请在弹出的窗口里把 <b>myFlowForge</b> 拖到「应用程序」,然后重新打开即可用上新版本。</p>
          </div>
          {phase === 'error' && (
            <div className="upd-done on">
              <p>更新失败,请稍后重试,或手动到 GitHub 下载最新版本:</p>
              <button
                type="button"
                className="upd-ghlink"
                onClick={() => { void window.forge.openExternal(RELEASES_URL) }}
                title="在浏览器中打开 GitHub 发布页"
              >{RELEASES_URL}</button>
            </div>
          )}
        </div>
        <div className="upd-foot">
          <div className="upd-actions">
            {done ? (
              <button className="go" onClick={onClose}>完成</button>
            ) : running ? (
              <button className="gh" onClick={onClose}>后台下载(继续使用)</button>
            ) : (
              <>
                <button className="gh" onClick={onClose}>稍后</button>
                <button className="go" onClick={onStart} disabled={!info}>
                  <span dangerouslySetInnerHTML={{ __html: ICN.up }} />立即升级
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
