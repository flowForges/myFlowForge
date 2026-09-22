import { useEffect, useRef, useState } from 'react'
import { ICN, formatBytes } from './notifications'
import { Markdown } from '../views/chat/markdown'
import type { UpdateInfo, InstallProgress, UpdateBusyItem } from '@shared/types'
import type { UpdatePhase, ApplyMode } from '../state/useUpdate'

interface UpgradeModalProps {
  open: boolean
  onClose: () => void
  info: UpdateInfo | null
  currentVersion: string
  phase: UpdatePhase
  progress: InstallProgress | null
  onStart: () => void
  /** phase==='ready' 时:还在跑的会话清单 / 是否在等它们跑完 / 怎么装 */
  busy?: UpdateBusyItem[]
  waiting?: boolean
  onApply?: (mode: ApplyMode) => void
}

interface LogLine { tk: string; text: string }

// GitHub 发布页(与主进程 updateChecker 的 UPDATE_REPO 一致)。更新失败时给用户一个可手动下载的去处。
const RELEASES_URL = 'https://github.com/flowForges/myFlowForge/releases/latest'

export function UpgradeModal({ open, onClose, info, currentVersion, phase, progress, onStart, busy = [], waiting = false, onApply = () => {} }: UpgradeModalProps) {
  const [log, setLog] = useState<LogLine[]>([])
  const stampRef = useRef(0)
  const lastLogRef = useRef<string | null>(null)
  const prevOpenRef = useRef(open)
  const logRef = useRef<HTMLDivElement>(null)

  const running = phase === 'downloading'
  const done = phase === 'done'
  const ready = phase === 'ready'
  // 交给安装者之后 app 几百毫秒内就会退出,这时候不该再给「后台下载」之类的按钮。
  const installing = running && (progress?.stage ?? '').startsWith('正在安装')

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
            <div className="vers">当前 v{currentVersion} → 最新 <b>v{info?.version ?? '—'}</b>{info ? ` · ${formatBytes(info.assetSize)}` : ''}</div>
          </div>
        </div>
        <div className="upd-body">
          {!running && !done && !ready && info && (
            <div>
              <h5>更新内容</h5>
              {/* 发布说明是 GitHub release 的 markdown 原文(开头常是一张下载表),交给对话区同一个渲染器;
                  .req-plan 提供表格/列表/代码的排版和滚动,长说明不会把按钮顶出屏幕。 */}
              <div className="upd-notes req-plan"><Markdown text={info.notes} /></div>
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
          {running && !installing && <p className="upd-hint">下载在后台进行,可点「后台下载」继续使用 app,完成后会自动提示你安装。</p>}
          {/* Windows 实测(2026-09-22,虚拟机):静默安装从退出到重新打开约 90 秒,中间屏幕上什么都没有 ——
              不提前说一声,用户会以为 app 崩了。 */}
          {installing && <p className="upd-hint">app 马上会退出,安装需要几十秒到一两分钟,装好后会自动重新打开,期间不用做任何操作。</p>}
          {ready && (
            <div className="upd-ready">
              <p className="upd-ready-title">已下载 v{info?.version ?? ''}{busy.length ? `,但还有 ${busy.length} 项正在执行:` : ',可以安装了。'}</p>
              {busy.length > 0 && (
                <ul className="upd-busy">
                  {busy.map((b, i) => <li key={i}>{b.label}</li>)}
                </ul>
              )}
              {busy.length > 0 && (
                <p className="upd-hint">
                  {waiting
                    ? '正在等它们结束,全部结束后会自动退出并安装。可以关掉这个窗口继续用。'
                    : '安装需要退出 app,会中断它们。可以等它们跑完再自动安装。'}
                </p>
              )}
            </div>
          )}
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
            ) : installing ? null : ready ? (
              busy.length === 0 ? (
                <>
                  <button className="gh" onClick={onClose}>稍后</button>
                  <button className="go" onClick={() => onApply('now')}>安装并重启</button>
                </>
              ) : waiting ? (
                <>
                  <button className="gh" onClick={() => onApply('cancel')}>取消等待</button>
                  <button className="gh upd-force" onClick={() => onApply('force')}>立即中断并安装</button>
                </>
              ) : (
                <>
                  <button className="gh" onClick={onClose}>稍后</button>
                  <button className="gh upd-force" onClick={() => onApply('force')}>中断并安装</button>
                  <button className="go" onClick={() => onApply('wait')}>跑完后自动安装</button>
                </>
              )
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
