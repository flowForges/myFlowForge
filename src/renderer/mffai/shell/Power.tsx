import { useEffect, useRef, useState } from 'react'
import type { MffaiState } from '@mffai/protocol'
import type { StripInfo } from '../StatusStrip'
import { stateLabel } from '../StatusStrip'
import { Chip } from '../ui/Chip'
import { Icon } from './icons'

export type PowerTone = 'run' | 'off' | 'bad' | 'wait'

/** 电源键的颜色:停用 = off;宿主在做操作、启动中、重启中 = wait;熔断、不兼容、已停止 = bad;其余 run */
export function powerTone(s: MffaiState): PowerTone {
  if (s.op) return 'wait'
  if (!s.enabled) return 'off'
  if (s.compatible === false || s.supervisor?.state === 'tripped') return 'bad'
  const sv = s.supervisor?.state
  if (sv === 'starting' || sv === 'restarting') return 'wait'
  return s.running ? 'run' : 'bad'
}

/** 和页头同条件的异常块 */
function anomalies(state: MffaiState, info?: StripInfo): { text: string; tone: 'warn' | 'bad'; title?: string }[] {
  const status = info?.status
  const dev = status?.plugins.filter((p) => p.trust === 'dev').map((p) => p.id) ?? []
  return [
    ...(dev.length > 0 ? [{ text: '开发插件 · 完全访问', tone: 'bad' as const, title: dev.join(' ') }] : []),
    ...(status?.problems?.includes('dev_crashed') ? [{ text: '开发插件已跳过', tone: 'warn' as const }] : []),
    ...(status?.dbUnprotected ? [{ text: '数据库未收紧', tone: 'warn' as const }] : []),
    ...(status?.secretsBackend === 'plaintext-file' ? [{ text: '明文存储', tone: 'warn' as const }] : []),
    ...(state.proxyStale ? [{ text: '代理已改', tone: 'warn' as const }] : []),
  ]
}

const CHIP_TONE = { ok: 'ok', bad: 'bad', wait: 'warn' } as const

export function PowerButton({ state, info, onEnable, onDisable, onAutostart, onRestart, onResetTrip }: {
  state: MffaiState
  info?: StripInfo
  onEnable(): void
  onDisable(): void
  onAutostart(on: boolean): void
  onRestart(): void
  onResetTrip(): void
}) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const tone = powerTone(state)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus() } }
    const onDown = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown) }
  }, [open])

  const sv = state.supervisor
  const status = info?.status
  const plugins = status ? status.plugins.length : state.pluginsActive
  const broken = status ? status.plugins.filter((p) => p.state !== 'active').length : 0
  const tripped = sv?.state === 'tripped'
  const busy = !!state.op
  const chips = anomalies(state, info)
  const head = state.enabled ? stateLabel(state) : { text: '未启用', tone: 'off' as const }
  return (
    <div
      className="mffai-powerwrap"
      ref={wrap}
      onBlur={(e) => { const n = e.relatedTarget as Node | null; if (open && !(n && wrap.current?.contains(n))) setOpen(false) }}
    >
      <button
        ref={btn}
        type="button"
        className={`mffai-power${tone === 'run' ? '' : ` ${tone}`}${open ? ' open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="后台"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="power" size={18} />
      </button>
      {open && (
        <div className="mffai-powerpop" role="dialog" aria-label="后台" tabIndex={-1}>
          <div className="mffai-prow mffai-phead">
            <span className={`mffai-dot ${head.tone === 'off' ? '' : head.tone}`} />
            <b>后台</b>
            <Chip tone={head.tone === 'off' ? 'muted' : CHIP_TONE[head.tone]}>{head.text}</Chip>
            <span className="mffai-head-spring" />
            <label className="mffai-switch">
              <input
                type="checkbox"
                role="switch"
                aria-label="后台"
                checked={state.enabled && tone !== 'off'}
                disabled={busy}
                onChange={(e) => { if (e.target.checked) onEnable(); else onDisable() }}
              />
            </label>
          </div>
          {state.enabled && (
            <div className="mffai-kv">
              {sv?.version && <><span className="mffai-k">版本</span><span className="mffai-v">{sv.version}</span></>}
              {state.rssMb != null && <><span className="mffai-k">内存</span><span className="mffai-v">{`${state.rssMb} MB`}</span></>}
              {plugins != null && (
                <>
                  <span className="mffai-k">插件</span>
                  <span className="mffai-v"><span>{`${plugins} 个`}</span>{broken > 0 && <span className="mffai-bad">{`${broken} 有问题`}</span>}</span>
                </>
              )}
              {sv && <><span className="mffai-k">重启</span><span className="mffai-v">{sv.restarts}</span></>}
            </div>
          )}
          {chips.length > 0 && (
            <div className="mffai-pchips">
              {chips.map((c) => <Chip key={c.text} sq tone={c.tone} title={c.title}>{c.text}</Chip>)}
            </div>
          )}
          <label className="mffai-switch mffai-prow mffai-pauto">
            <span>开机自启</span>
            <input type="checkbox" role="switch" checked={state.autostart} onChange={(e) => onAutostart(e.target.checked)} />
          </label>
          {state.enabled && !busy && (
            <button
              type="button"
              className="set-btn mffai-prestart"
              onClick={() => { setOpen(false); if (tripped && state.compatible !== false) onResetTrip(); else onRestart() }}
            >
              <Icon name="refresh" size={13} />重启后台
            </button>
          )}
        </div>
      )}
    </div>
  )
}
