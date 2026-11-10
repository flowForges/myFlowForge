import type { MffaiState } from '@mffai/protocol'
import { stateLabel } from '../StatusStrip'
import { Chip } from '../ui/Chip'
import { CodeChip } from '../ui/CodeChip'
import { Icon } from './icons'

/** 后台起不来时占住主区:红色电源块、标题、状态块 + 原因代码 + 版本,和 `重新启动`。没有调试按钮(R9) */
export function FaultPanel({ state, busy, onRestart, onResetTrip }: { state: MffaiState; busy: boolean; onRestart(): void; onResetTrip(): void }) {
  const sv = state.supervisor
  const incompatible = state.compatible === false
  const tripped = sv?.state === 'tripped'
  const title = incompatible ? '版本不兼容' : tripped ? '后台已熔断' : '已停止'
  const { text } = stateLabel(state)
  return (
    <section className="mffai-fault">
      <span className="mffai-faultic"><Icon name="power" size={24} /></span>
      <h2>{title}</h2>
      <div className="mffai-faultrow">
        <Chip tone="bad">{text}</Chip>
        {sv?.trippedReason && <CodeChip code={sv.trippedReason} tone="bad" />}
        {sv?.version && <Chip tone="line">{sv.version}</Chip>}
      </div>
      {!busy && (
        <button type="button" className="set-btn mffai-primary" onClick={tripped && !incompatible ? onResetTrip : onRestart}>
          <Icon name="refresh" size={14} />重新启动
        </button>
      )}
    </section>
  )
}
