import { useEffect, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useTerminals } from '../../state/useTerminals'
import { useHost, useHostReadySeq } from '../../state/useHostKey'
import { XtermView } from './XtermView'
import './terminal.css'

const ICON_TERM = (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="4 7 9 12 4 17"/><line x1="12" y1="17" x2="20" y2="17"/></svg>)
const ICON_PLUS = (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>)
const ICON_TRASH = (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>)
const ICON_CLOSE = (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>)

export function TerminalPanel({ open, dual, focused, onHandleDown, workspaceCwd, font, onRequestClose }: {
  open: boolean
  dual?: boolean
  focused?: boolean
  onHandleDown?: (e: ReactPointerEvent) => void
  workspaceCwd: string | undefined
  font: { fontFamily: string; fontSize: number }
  onRequestClose: () => void
}) {
  const { key: hostKey, label: hostLabel } = useHost()
  // ★`seq` 一起传进去:断线重连之后 host 上那些 pty 已经被收掉了,标签页要跟着变成「已退出」。
  const readySeq = useHostReadySeq()
  const term = useTerminals(() => workspaceCwd, { key: hostKey, seq: readySeq })

  // When the panel is opened, target the CURRENT workspace: focus its existing tab or spawn one
  // rooted there. Fires on the open edge (not on every workspace switch) so a terminal in workspace
  // X always lands in X instead of a stale tab stuck at ~.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) { term.openForWorkspace(workspaceCwd) }
    wasOpen.current = open
  }, [open, workspaceCwd])

  const active = term.tabs.find(t => t.id === term.activeId)

  // C1: Always render (never early-return); use open/dual class to toggle visibility
  return (
    <div className={`term${open ? ' open' : ''}${dual ? ' dual' : ''}${focused ? ' focused' : ''}`} id="termPanel">
      {onHandleDown && <div className="panel-resizer" data-resize-panel="term" onPointerDown={onHandleDown} role="separator" aria-orientation="horizontal" title="拖动调整高度" />}
      <div className="term-head">
        <span className="tt">{ICON_TERM}终端</span>
        {/* ★终端现在**跟着 host 走**(term:* 进了方法表):连哪台,开的就是哪台的 shell。
            这枚芯片因此从警告变成了标识 —— 但它一个字都不能省:一个看起来一模一样的黑框里
            敲 `rm -rf`,「这是哪台机器」是屏幕上唯一能回答这个问题的东西。 */}
        {hostKey !== 'local' && (
          <span className="term-localtag" title={`这个终端跑在「${hostLabel}」上,不是本机`}>
            {hostLabel}
          </span>
        )}
        <div className="term-tabs">
          {term.tabs.map(t => (
            <span key={t.id} className={`term-tab${t.id === term.activeId ? ' on' : ''}`} onClick={() => term.selectTab(t.id)}>
              <span className="tdot" /><span className="tnm">{t.title}{t.exited ? ' (已退出)' : ''}{t.error ? ` — ${t.error}` : ''}</span>
              <span className="tx" onClick={e => { e.stopPropagation(); term.closeTab(t.id) }}>×</span>
            </span>
          ))}
        </div>
        <button
          className="term-newtab"
          title={term.tabs.length >= 12 ? '已达上限(最多 12 个终端)' : '新建终端'}
          disabled={term.tabs.length >= 12}
          onClick={() => void term.newTab()}
        >{ICON_PLUS}</button>
        <div className="term-act">
          <span className="term-cwd" title="当前目录">{active?.cwd ?? '~'}</span>
          <button className="lg-btn" title="清屏 (clear)" onClick={() => active && window.forge.termWrite(active.id, 'clear\n')}>{ICON_TRASH}清屏</button>
          <button className="lg-btn" title="关闭 (⌃`)" onClick={onRequestClose}>{ICON_CLOSE}</button>
        </div>
      </div>
      {/* ★遍历的是 allTabs 而不是 tabs:切到别的主机时,那台的 xterm 实例必须**留着**(只是不显示)。
          卸载 = term.dispose() = 回滚缓冲全没,切回来是一块空屏。 */}
      <div className="term-body">
        {term.allTabs.map(t => (
          <XtermView key={t.id} termId={t.id} active={t.id === term.activeId} visible={open && t.id === term.activeId} font={font} />
        ))}
        {active?.error && (
          <div className="term-error">{active.error}</div>
        )}
      </div>
    </div>
  )
}
