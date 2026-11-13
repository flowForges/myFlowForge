// 电脑操作批准卡(spec §10.3、V9)。我们渲染的可信行在上,屏幕裁片在下、带边框,行名 `屏幕`。
// - 屏幕 / 模型来源的文字(app 名、要输入的文字)只以纯文本出现:压空白、从左截断、不可见字符可见;输入的文字放在带标记的等宽块里。
// - 按钮不自动聚焦,没有任何键盘处理 —— 键盘上没有东西能批准。
// - 允许 / 继续 和浮窗同一道检查(I-2,cuPhysical.ts):真实的鼠标按下 + 带点击次数的 click,tabIndex -1;
//   键盘、AXPress(System Events 的 click button)、脚本派发都不算。拒绝 / 停止 只会收窄,键盘照样能按。
import { useRef, type MouseEvent, type ReactNode } from 'react'
import { CU_ERR, CU_KIND_LABEL, CU_RESOLVE_ERR, CU_SET_MODE_ERR, visibleText, type CuActionView } from '@shared/computerUse'
import type { CuGate } from '../../../main/computerUse/types'
import { BUTTON_LABEL, MOD_SYM, fmtPt, screenName } from './cuFormat'
import { usePhysicalPress, type IsPhysical } from './cuPhysical'

const Row = ({ k, children }: { k: string; children: ReactNode }) => (
  <div className="cu-row"><span className="cu-k">{k}</span><span className="cu-colon">: </span><span className="cu-v">{children}</span></div>
)

/** the bundle id in its own span, so it never runs into the (screen-derived) app name */
const Bundle = ({ id, lead }: { id?: string; lead?: boolean }) => (id ? <>{lead ? ' · ' : ''}<span className="cu-bundle">{screenName(id)}</span></> : null)

const MODS = new Set(Object.values(MOD_SYM))
/** `⌘⇧V` → ['⌘','⇧','V'] */
function keycaps(combo: string): string[] {
  const chars = Array.from(combo)
  let i = 0
  while (i < chars.length && MODS.has(chars[i])) i++
  const rest = chars.slice(i).join('')
  return [...chars.slice(0, i), ...(rest ? [rest] : [])]
}


function ActionRows({ a, reason }: { a: CuActionView; reason?: string }) {
  const rows: ReactNode[] = []
  const app = screenName(a.app)
  if (app || a.bundleId) rows.push(<Row key="app" k="应用">{app}{app && a.bundleId ? ' · ' : ''}<Bundle id={a.bundleId} /></Row>)
  switch (a.kind) {
    case 'click': case 'move': {
      if (a.at) rows.push(<Row key="at" k="位置">{fmtPt(a.at)}</Row>)
      const count = a.count ?? 1
      const btn = a.button && (a.button !== 'left' || count > 1) ? `${BUTTON_LABEL[a.button]}${count > 1 ? ` ×${count}` : ''}` : count > 1 ? `左键 ×${count}` : ''
      const mods = a.mods?.length ? a.mods.map((m) => MOD_SYM[m]).join('') : ''
      const parts = [btn, mods].filter(Boolean)
      if (a.kind === 'click' && parts.length) rows.push(<Row key="btn" k="按键">{parts.join(' · ')}</Row>)
      break
    }
    case 'scroll': {
      if (a.at) rows.push(<Row key="at" k="位置">{fmtPt(a.at)}</Row>)
      const dy = a.dy ?? 0, dx = a.dx ?? 0
      rows.push(<Row key="sc" k="滚动">{`${dy < 0 ? '↑' : '↓'}${Math.abs(dy)} ${dx < 0 ? '←' : '→'}${Math.abs(dx)}`}</Row>)
      break
    }
    case 'drag':
      rows.push(<Row key="from" k="从">{[fmtPt(a.at), app].filter(Boolean).join(' · ')}<Bundle id={a.bundleId} lead /></Row>)
      rows.push(<Row key="to" k="到">{[fmtPt(a.to), screenName(a.toApp)].filter(Boolean).join(' · ')}<Bundle id={a.toBundle} lead /></Row>)
      break
    case 'key': {
      const caps = keycaps(a.combo ?? '')
      rows.push(
        <Row key="keys" k="按键">
          {caps.map((c, i) => <kbd key={i} className="cu-cap">{c}</kbd>)}
          {a.repeat && a.repeat > 1 ? <span className="cu-rep"> ×{a.repeat}</span> : null}
        </Row>,
      )
      if (reason === '剪贴板') rows.push(<Row key="clip" k="剪贴板">粘贴</Row>)
      break
    }
    case 'type': {
      const text = a.text ?? ''
      rows.push(
        <Row key="text" k="文字">
          <span className="cu-text" data-untrusted="">{visibleText(text)}</span>
          <span className="cu-chip cu-count">{Array.from(text).length} 字</span>
        </Row>,
      )
      if (reason === '剪贴板') rows.push(<Row key="clip" k="剪贴板">粘贴</Row>)
      break
    }
  }
  return <>{rows}</>
}

/** a card ignores clicks this long after it mounts: a double click's second press must not land on the next gate */
export const ARM_MS = 600

export function CuGateCard({ gate, error, onResolve, isPhysical }: {
  gate: CuGate; error?: string; onResolve: (id: string, d: 'allow' | 'deny' | 'stop') => void; isPhysical?: IsPhysical
}) {
  const mountedAt = useRef(Date.now())
  const done = useRef(false)
  const press = usePhysicalPress(isPhysical)
  const allowId = `${gate.id}:allow`
  const answer = (d: 'allow' | 'deny' | 'stop') => (e: MouseEvent) => {
    if (d === 'allow' && !press.check(allowId, e)) return
    if (done.current || Date.now() - mountedAt.current < ARM_MS) return
    done.current = true
    onResolve(gate.id, d)
  }
  const allowProps = { tabIndex: -1, onMouseDown: press.down(allowId), onClick: answer('allow') }
  const other = (d: 'deny' | 'stop') => ({ onMouseDown: press.down(`${gate.id}:${d}`), onClick: answer(d) })
  const isContinue = gate.kind === 'continue'
  const a = gate.action
  return (
    <div className="cu-card" data-gate={gate.id}>
      <div className="cu-head">
        <span className="cu-title">电脑 · {isContinue ? CU_KIND_LABEL.continue : a ? CU_KIND_LABEL[a.kind] : ''}</span>
        {!isContinue && gate.reason && <span className="cu-chip cu-reason">{gate.reason}</span>}
        {error && <span className="cu-chip cu-code">{(CU_ERR as Record<string, string>)[error] ?? (CU_RESOLVE_ERR as Record<string, string>)[error] ?? (CU_SET_MODE_ERR as Record<string, string>)[error] ?? error}</span>}
      </div>
      {isContinue && gate.reason && <Row k="原因">{screenName(gate.reason)}</Row>}
      {!isContinue && a && <ActionRows a={a} reason={gate.reason} />}
      {gate.crop && (
        <div className="cu-row cu-crop-row">
          <span className="cu-k">屏幕</span><span className="cu-colon">: </span>
          <span className="cu-v"><img className="cu-crop" alt="" draggable={false} src={`data:image/jpeg;base64,${gate.crop}`} /></span>
        </div>
      )}
      <div className="cu-actions">
        {isContinue ? (
          <>
            <button type="button" className="cu-btn cu-allow" {...allowProps}>继续 100 步</button>
            <button type="button" className="cu-btn cu-stop" {...other('stop')}>停止</button>
          </>
        ) : (
          <>
            <button type="button" className="cu-btn cu-allow" {...allowProps}>允许</button>
            <button type="button" className="cu-btn cu-deny" {...other('deny')}>拒绝</button>
            <button type="button" className="cu-btn cu-stop" {...other('stop')}>停止</button>
          </>
        )}
      </div>
    </div>
  )
}
