import type { MffaiState } from '@mffai/protocol'

export interface StatusStripProps {
  state: MffaiState
  onRestart: () => void
  onResetTrip: () => void
  failed?: boolean
}

function label(s: MffaiState): { text: string; tone: 'ok' | 'bad' | 'wait' } {
  if (s.compatible === false) return { text: '版本不兼容', tone: 'bad' }
  switch (s.supervisor?.state) {
    case 'running': return { text: '运行中', tone: 'ok' }
    case 'starting': return { text: '启动中', tone: 'wait' }
    case 'stopping': return { text: '已停止', tone: 'bad' }
    case 'restarting': return { text: '重启中', tone: 'wait' }
    case 'tripped': return { text: '已熔断', tone: 'bad' }
    default: return s.running ? { text: '运行中', tone: 'ok' } : { text: '已停止', tone: 'bad' }
  }
}

export function StatusStrip({ state, onRestart, onResetTrip, failed }: StatusStripProps) {
  const { text, tone } = label(state)
  const tripped = state.supervisor?.state === 'tripped'
  const incompatible = state.compatible === false
  return (
    <div className="mffai-strip">
      <span className={`mffai-dot ${tone}`} />
      <b>{text}</b>
      {state.supervisor?.version && <span>{state.supervisor.version}</span>}
      {state.pluginsActive != null && <span>{state.pluginsActive} 插件</span>}
      {state.rssMb != null && <span>{state.rssMb} MB</span>}
      {(tripped || incompatible) && (
        <button className="set-btn" onClick={incompatible ? onRestart : onResetTrip}>重新启动</button>
      )}
      {failed && <span className="mffai-fail">失败</span>}
    </div>
  )
}
