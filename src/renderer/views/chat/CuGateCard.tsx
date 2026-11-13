// 电脑操作批准卡(spec §10.3、V9)。我们渲染的可信行在上,屏幕裁片在下、带边框,行名 `屏幕`。
// - 屏幕 / 模型来源的文字(app 名、要输入的文字)只以纯文本出现:压空白、从左截断、不可见字符可见;输入的文字放在带标记的等宽块里。
// - 按钮不自动聚焦,没有任何键盘处理 —— 键盘上没有东西能批准。
import type { ReactNode } from 'react'
import { CU_KIND_LABEL, visibleText, type CuActionView } from '@shared/computerUse'
import type { CuGate } from '../../../main/computerUse/types'
import { BUTTON_LABEL, MOD_SYM, fmtPt, screenName } from './cuFormat'

const Row = ({ k, children }: { k: string; children: ReactNode }) => (
  <div className="cu-row"><span className="cu-k">{k}</span><span className="cu-colon">: </span><span className="cu-v">{children}</span></div>
)

const MODS = new Set(Object.values(MOD_SYM))
/** `⌘⇧V` → ['⌘','⇧','V'] */
function keycaps(combo: string): string[] {
  const chars = Array.from(combo)
  let i = 0
  while (i < chars.length && MODS.has(chars[i])) i++
  const rest = chars.slice(i).join('')
  return [...chars.slice(0, i), ...(rest ? [rest] : [])]
}

const withApp = (p: string, app?: string, bundle?: string) => [p, screenName(app), bundle ? screenName(bundle) : ''].filter(Boolean)

function ActionRows({ a, reason }: { a: CuActionView; reason?: string }) {
  const rows: ReactNode[] = []
  const app = screenName(a.app)
  if (app || a.bundleId) rows.push(<Row key="app" k="应用">{[app, a.bundleId ? screenName(a.bundleId) : ''].filter(Boolean).join(' · ')}</Row>)
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
      rows.push(<Row key="from" k="从">{withApp(fmtPt(a.at), a.app).join(' · ')}</Row>)
      rows.push(<Row key="to" k="到">{withApp(fmtPt(a.to), a.toApp).join(' · ')}</Row>)
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

export function CuGateCard({ gate, onResolve }: { gate: CuGate; onResolve: (id: string, d: 'allow' | 'deny' | 'stop') => void }) {
  const isContinue = gate.kind === 'continue'
  const a = gate.action
  return (
    <div className="cu-card" data-gate={gate.id}>
      <div className="cu-head">
        <span className="cu-title">电脑 · {isContinue ? CU_KIND_LABEL.continue : a ? CU_KIND_LABEL[a.kind] : ''}</span>
        {!isContinue && gate.reason && <span className="cu-chip cu-reason">{gate.reason}</span>}
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
            <button type="button" className="cu-btn cu-allow" onClick={() => onResolve(gate.id, 'allow')}>继续 100 步</button>
            <button type="button" className="cu-btn cu-stop" onClick={() => onResolve(gate.id, 'stop')}>停止</button>
          </>
        ) : (
          <>
            <button type="button" className="cu-btn cu-allow" onClick={() => onResolve(gate.id, 'allow')}>允许</button>
            <button type="button" className="cu-btn cu-deny" onClick={() => onResolve(gate.id, 'deny')}>拒绝</button>
            <button type="button" className="cu-btn cu-stop" onClick={() => onResolve(gate.id, 'stop')}>停止</button>
          </>
        )}
      </div>
    </div>
  )
}
