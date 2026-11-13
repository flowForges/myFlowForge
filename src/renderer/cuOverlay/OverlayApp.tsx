// The always-on-top computer-use indicator (spec §10.3/§10.4, V9). A pill `● 电脑 · <title> · <mode>` with 停止; with a
// pending gate, a mini card: the trusted line (reason chip, action, bundle id) above the crop, then 允许 / 拒绝 (or
// 继续 100 步 / 停止 for the step gate).
//
// - No autoFocus and no key handler anywhere: nothing on the keyboard can approve.
// - 允许 / 继续 only count for a physical press: the OS-reported (isTrusted) mousedown on that same button within the
//   last second, then its click with a click count (cuPhysical.ts, shared with the main card and the mode menu).
//   Script-dispatched or keyboard-activated clicks do nothing.
//   Stop / deny / collapse are always safe and take any click.
// - Screen-derived strings (app names) render as plain text, whitespace collapsed, long values cut from the left.
import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { CU_KIND_LABEL, COMPUTER_USE_CHIP, visibleText, type CuActionView, type CuOverlayState } from '@shared/computerUse'
import { BUTTON_LABEL as BUTTON, MOD_SYM, fmtPt as pt, screenName } from '../views/chat/cuFormat'
import { usePhysicalPress, type IsPhysical } from '../views/chat/cuPhysical'
import './overlay.css'

export interface CuOverlayApi {
  onState(cb: (s: CuOverlayState) => void): () => void
  resolve(id: string, decision: 'allow' | 'deny' | 'stop'): unknown
  stop(): unknown
  collapseMain(): unknown
}

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

export function OverlayApp({ api, isPhysical }: { api: CuOverlayApi; isPhysical?: IsPhysical }) {
  const [state, setState] = useState<CuOverlayState | null>(null)
  const [flash, setFlash] = useState(false)
  const press = usePhysicalPress(isPhysical)
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

  const onDown = press.down
  const approve = (gateId: string, btn: string) => (e: MouseEvent) => { if (press.check(btn, e)) api.resolve(gateId, 'allow') }
  const bundle = gate?.kind === 'action' ? screenName(gate.action?.bundleId) : ''

  return (
    <div className={`cuo${gate ? ' cuo-open' : ''}`}>
      <div className={`cuo-pill${flash ? ' cuo-flash' : ''}`}>
        <span className="cuo-dot">●</span>
        <span className="cuo-title">电脑 · {screenName(session.title)}</span>
        <span className="cuo-sep"> · </span>
        <span className="cuo-chip">{COMPUTER_USE_CHIP[session.mode].replace(/^电脑 · /, '')}</span>
        {state.hotkeyFailed && <span className="cuo-chip cuo-chip-warn">急停键未注册</span>}
        {state.ownBlocked && <button type="button" tabIndex={-1} className="cuo-btn cuo-collapse" onClick={() => api.collapseMain()}>收起主窗口</button>}
        <button type="button" tabIndex={-1} className="cuo-btn cuo-stop" onClick={() => api.stop()}>停止</button>
      </div>
      {gate && (
        <div className="cuo-card">
          <div className="cuo-head">
            {gate.kind === 'action' && gate.reason && <span className="cuo-chip cuo-reason">{gate.reason}</span>}
            <span className="cuo-line">{gate.kind === 'continue' ? (gate.reason ?? '') : gate.action ? actionLine(gate.action) : ''}</span>
          </div>
          {bundle && <div className="cuo-bundle">{bundle}</div>}
          {gate.crop && <img className="cuo-crop" alt="" draggable={false} src={`data:image/jpeg;base64,${gate.crop}`} />}
          <div className="cuo-actions">
            {gate.kind === 'continue' ? (
              <>
                <button type="button" tabIndex={-1} className="cuo-btn cuo-allow" onMouseDown={onDown(`${gate.id}:allow`)} onClick={approve(gate.id, `${gate.id}:allow`)}>继续 100 步</button>
                <button type="button" tabIndex={-1} className="cuo-btn cuo-deny" onMouseDown={onDown(`${gate.id}:deny`)} onClick={() => api.resolve(gate.id, 'stop')}>停止</button>
              </>
            ) : (
              <>
                <button type="button" tabIndex={-1} className="cuo-btn cuo-allow" onMouseDown={onDown(`${gate.id}:allow`)} onClick={approve(gate.id, `${gate.id}:allow`)}>允许</button>
                <button type="button" tabIndex={-1} className="cuo-btn cuo-deny" onMouseDown={onDown(`${gate.id}:deny`)} onClick={() => api.resolve(gate.id, 'deny')}>拒绝</button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
