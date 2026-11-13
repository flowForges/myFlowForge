// The always-on-top computer-use indicator (spec §10.3/§10.4, V9). A pill `● 电脑 · <title> · <mode>` with 停止; with a
// pending gate, a mini card: the crop, one action line, 允许 / 拒绝 (or 继续 100 步 / 停止 for the step gate).
//
// - No autoFocus and no key handler anywhere: nothing on the keyboard can approve.
// - 允许 / 继续 only count for a physical press: the OS-reported (isTrusted) mousedown on that same button within the
//   last second, then its click with a click count. Script-dispatched or keyboard-activated clicks do nothing.
//   Stop / deny / collapse are always safe and take any click.
// - Screen-derived strings (app names) render as plain text, whitespace collapsed, long values cut from the left.
import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { CU_KIND_LABEL, COMPUTER_USE_CHIP, visibleText, type CuActionView, type CuOverlayState, type Mod } from '@shared/computerUse'
import { collapseWhitespace } from '@shared/browserUse'
import './overlay.css'

export interface CuOverlayApi {
  onState(cb: (s: CuOverlayState) => void): () => void
  resolve(id: string, decision: 'allow' | 'deny' | 'stop'): unknown
  stop(): unknown
  collapseMain(): unknown
}

const PHYSICAL_MS = 1000
const NAME_MAX = 40
const MOD_SYM: Record<Mod, string> = { cmd: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧' }
const BUTTON: Record<'left' | 'right' | 'middle', string> = { left: '左键', right: '右键', middle: '中键' }

/** plain, single-line, cut from the left so the distinguishing tail survives */
function screenName(s: string | undefined): string {
  if (!s) return ''
  const t = Array.from(visibleText(collapseWhitespace(s)))
  return t.length > NAME_MAX ? '…' + t.slice(t.length - (NAME_MAX - 1)).join('') : t.join('')
}
const pt = (p?: { x: number; y: number }) => (p ? `(${Math.round(p.x)}, ${Math.round(p.y)})` : '')

/** the mini card's one line */
export function actionLine(v: CuActionView): string {
  const parts: string[] = []
  const app = screenName(v.app)
  switch (v.kind) {
    case 'click': {
      parts.push(`${CU_KIND_LABEL.click} ${pt(v.at)}`)
      const count = v.count ?? 1
      if (v.button && (v.button !== 'left' || count > 1)) parts.push(`${BUTTON[v.button]}${count > 1 ? ` ×${count}` : ''}`)
      if (v.mods?.length) parts.push(v.mods.map((m) => MOD_SYM[m]).join(''))
      if (app) parts.push(app)
      break
    }
    case 'move':
      parts.push(`${CU_KIND_LABEL.move} ${pt(v.at)}`)
      if (app) parts.push(app)
      break
    case 'drag': {
      parts.push(`${CU_KIND_LABEL.drag} ${pt(v.at)} → ${pt(v.to)}`)
      const to = screenName(v.toApp)
      if (app || to) parts.push(`${app} → ${to}`)
      break
    }
    case 'scroll': {
      const dy = v.dy ?? 0, dx = v.dx ?? 0
      parts.push(`${CU_KIND_LABEL.scroll} ${dy < 0 ? '↑' : '↓'}${Math.abs(dy)} ${dx < 0 ? '←' : '→'}${Math.abs(dx)}`)
      if (app) parts.push(app)
      break
    }
    case 'type': {
      const text = v.text ?? ''
      parts.push(`${CU_KIND_LABEL.type} ${Array.from(text).length} 字`, visibleText(text))
      if (app) parts.push(app)
      break
    }
    case 'key':
      parts.push(`${CU_KIND_LABEL.key} ${v.combo ?? ''}`.trim())
      if (app) parts.push(app)
      break
  }
  return parts.join(' · ')
}

const trusted = (e: MouseEvent) => e.nativeEvent.isTrusted === true

export function OverlayApp({ api, isPhysical = trusted }: { api: CuOverlayApi; isPhysical?: (e: MouseEvent) => boolean }) {
  const [state, setState] = useState<CuOverlayState | null>(null)
  const [flash, setFlash] = useState(false)
  const down = useRef<{ id: string; t: number } | null>(null)
  const lastSeq = useRef(0)

  useEffect(() => api.onState(setState), [api])
  useEffect(() => {
    const seq = state?.actionSeq ?? 0
    if (seq === lastSeq.current) return
    lastSeq.current = seq
    setFlash(true)
    const h = setTimeout(() => setFlash(false), 300)
    return () => clearTimeout(h)
  }, [state?.actionSeq])

  if (!state?.session) return null
  const { session, gate } = state

  const onDown = (id: string) => (e: MouseEvent) => { down.current = isPhysical(e) ? { id, t: performance.now() } : null }
  const physical = (id: string, e: MouseEvent): boolean => {
    const d = down.current
    down.current = null
    return !!d && d.id === id && isPhysical(e) && e.detail > 0 && performance.now() - d.t <= PHYSICAL_MS
  }
  const approve = (gateId: string, btn: string) => (e: MouseEvent) => { if (physical(btn, e)) api.resolve(gateId, 'allow') }

  return (
    <div className={`cuo${gate ? ' cuo-open' : ''}`}>
      <div className={`cuo-pill${flash ? ' cuo-flash' : ''}`}>
        <span className="cuo-dot">●</span>
        <span className="cuo-title">电脑 · {screenName(session.title)}</span>
        <span className="cuo-sep"> · </span>
        <span className="cuo-chip">{COMPUTER_USE_CHIP[session.mode].replace(/^电脑 · /, '')}</span>
        {state.ownBlocked && <button type="button" tabIndex={-1} className="cuo-btn cuo-collapse" onClick={() => api.collapseMain()}>收起主窗口</button>}
        <button type="button" tabIndex={-1} className="cuo-btn cuo-stop" onClick={() => api.stop()}>停止</button>
      </div>
      {gate && (
        <div className="cuo-card">
          {gate.crop && <img className="cuo-crop" alt="" draggable={false} src={`data:image/jpeg;base64,${gate.crop}`} />}
          <div className="cuo-line">{gate.kind === 'continue' ? (gate.reason ?? '') : gate.action ? actionLine(gate.action) : ''}</div>
          <div className="cuo-actions">
            {gate.kind === 'continue' ? (
              <>
                <button type="button" tabIndex={-1} className="cuo-btn cuo-allow" onMouseDown={onDown('allow')} onClick={approve(gate.id, 'allow')}>继续 100 步</button>
                <button type="button" tabIndex={-1} className="cuo-btn cuo-deny" onMouseDown={onDown('deny')} onClick={() => api.resolve(gate.id, 'stop')}>停止</button>
              </>
            ) : (
              <>
                <button type="button" tabIndex={-1} className="cuo-btn cuo-allow" onMouseDown={onDown('allow')} onClick={approve(gate.id, 'allow')}>允许</button>
                <button type="button" tabIndex={-1} className="cuo-btn cuo-deny" onMouseDown={onDown('deny')} onClick={() => api.resolve(gate.id, 'deny')}>拒绝</button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
