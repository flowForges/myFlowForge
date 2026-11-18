// 电脑操作批准卡(spec §9.2、§10.3、V9)。门只在浮窗上答(浮窗有自己的 OverlayApp,带真正的按钮)——
// 这张卡只在主窗口渲染,没有任何可点的按钮,chip `待批准` 说清「这件事还没被回应」。
// 我们渲染的可信行在上,屏幕裁片在下、带边框,行名 `屏幕`。
// - 屏幕 / 模型来源的文字(app 名、要输入的文字)只以纯文本出现:压空白、从左截断、不可见字符可见;输入的文字放在带标记的等宽块里。
import type { ReactNode } from 'react'
import { CU_ERR, CU_KIND_LABEL, CU_RESOLVE_ERR, CU_SET_MODE_ERR, ROLE_LABEL, visibleText, type CuActionView } from '@shared/computerUse'
import type { CuGate } from '../../../main/computerUse/types'
import { BUTTON_LABEL, MOD_SYM, fmtPt, screenName } from './cuFormat'

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
  const app = screenName(typeof a.app === 'string' ? a.app : a.app?.name)
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
    // 'appKey' (语义按键,带 app) 的键帽行和 v1 'key' 一样:a.combo 已经是 prettyCombo 的输出。
    case 'key': case 'appKey': {
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
    case 'act': {
      const role = a.element ? (ROLE_LABEL[a.element.role] ?? '控件') : ''
      const name = a.element?.name ? `「${screenName(a.element.name)}」` : ''
      if (role || name) rows.push(<Row key="el" k="控件">{role}{name}</Row>)
      if (a.actLabel) rows.push(<Row key="verb" k="动作">{visibleText(a.actLabel)}</Row>)
      if (a.text !== undefined) {
        rows.push(
          <Row key="text" k="文字">
            <span className="cu-text" data-untrusted="">{visibleText(a.text)}</span>
            <span className="cu-chip cu-count">{Array.from(a.text).length} 字</span>
          </Row>,
        )
      }
      // 这几个标志改变同一个动词的含义(物理点击 / 替换原有内容 / 滚动方向与格数):事实放进「项: 值」行,不写解释。
      if (a.physical) rows.push(<Row key="phys" k="方式">移动鼠标点击</Row>)
      if (a.replace) rows.push(<Row key="rep" k="方式">替换原有内容</Row>)
      if (a.direction) {
        const arrow = { up: '↑', down: '↓', left: '←', right: '→' }[a.direction]
        rows.push(<Row key="scroll" k="滚动">{arrow} ×{a.amount ?? 1}</Row>)
      }
      break
    }
    case 'launch':
      rows.push(<Row key="verb" k="动作">打开应用</Row>)
      break
  }
  return <>{rows}</>
}

export function CuGateCard({ gate, error }: {
  gate: CuGate
  /** main 答自己的 resolve() 拒绝码(not_pending 之类);浮窗才是答这道门的地方(spec §9.2),这张卡从没有按钮。 */
  error?: string
}) {
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
        <span className="cu-chip cu-pending">待批准</span>
      </div>
    </div>
  )
}
