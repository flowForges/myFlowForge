import type { MffaiState, Quota, StatusResult } from '@mffai/protocol'
import { Chip } from './ui/Chip'
import { label as codeLabel } from './labels'
import { Icon } from './shell/icons'

/** 状态条要的后台数据(MffaiView 取):status、待批审批数、默认模型和它的额度 */
export interface StripInfo {
  status?: StatusResult
  pending?: number
  model?: { account: string; model: string; quota?: Quota | null }
}

export interface StatusStripProps {
  state: MffaiState
  info?: StripInfo
  /** 宿主的重启:有 proxyStale 时它整个重拉后台(Task 4) */
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

const LEVEL_TONE = { full: 'ok', partial: 'warn', none: 'bad' } as const

export function StatusStrip({ state, info, onRestart, onResetTrip, failed }: StatusStripProps) {
  const { text, tone } = label(state)
  const tripped = state.supervisor?.state === 'tripped'
  const incompatible = state.compatible === false
  // 启用了但监管不在(启动失败 / 被杀):重新启动 = 拉起
  const gone = state.enabled && !state.supervisor
  // 宿主正在做串行操作时不给按钮(01 followups 那一秒的闪)
  const busy = !!state.op
  const status = info?.status
  const sandbox = status?.sandbox ?? state.sandbox
  const dev = status?.plugins.filter((p) => p.trust === 'dev').map((p) => p.id) ?? []
  const quota = info?.model?.quota
  return (
    <div className="mffai-strip">
      <div className="mffai-stpill">
        <span className={`mffai-dot ${tone}`} />
        <b>{text}</b>
        <span className="mffai-pillv">
          {state.supervisor?.version && <span title={state.supervisor.version}>{state.supervisor.version}</span>}
          {state.rssMb != null && <span>{state.rssMb} MB</span>}
          {state.pluginsActive != null && <span>{state.pluginsActive} 插件</span>}
        </span>
        {(sandbox || info?.model) && <span className="mffai-sep" />}
        {sandbox && (
          <Chip sq tone={LEVEL_TONE[sandbox.level] ?? 'muted'} title={sandbox.missing.length ? sandbox.missing.join(' ') : undefined}>
            <Icon name={sandbox.level === 'full' ? 'shieldok' : sandbox.level === 'partial' ? 'shieldx' : 'shield'} size={12} />{codeLabel('level', sandbox.level)}
          </Chip>
        )}
        {info?.model && <Chip sq tone="acc" title={`${info.model.account} · ${info.model.model}`}>{`${info.model.account} · ${info.model.model}`}</Chip>}
        {quota && 'windows' in quota && quota.windows.map((w) => <span key={w.label} className="mffai-quota">{`${w.label} ${w.usedPercent}%`}</span>)}
      </div>
      {!!info?.pending && <Chip tone="warn">{`待处理 ${info.pending}`}</Chip>}
      {dev.length > 0 && <Chip tone="bad" title={dev.join(' ')}>开发插件 · 完全访问</Chip>}
      {status?.problems?.includes('dev_crashed') && <Chip tone="warn">开发插件已跳过</Chip>}
      {status?.dbUnprotected && <Chip tone="warn">数据库未收紧</Chip>}
      {status?.secretsBackend === 'plaintext-file' && <Chip tone="warn">明文存储</Chip>}
      {state.proxyStale && <Chip tone="warn">代理已改</Chip>}
      {state.proxyStale && !busy && <button className="set-btn" onClick={onRestart}>重启</button>}
      {(tripped || incompatible || gone) && !busy && (
        <button className="set-btn" onClick={tripped && !incompatible ? onResetTrip : onRestart}>重新启动</button>
      )}
      {failed && <span className="mffai-fail">失败</span>}
    </div>
  )
}
