import { useCallback, useEffect, useState } from 'react'
import type { Keybindings, Settings } from '@shared/types'

type ComputerUseSettings = Settings['computerUse']
import { ASK_ALWAYS_BUNDLES, BLOCKED_BUNDLES, SYSTEM_UI_OWNERS, type CuStatus } from '@shared/computerUse'
import { effectiveBindings, formatAccelerator } from '@shared/keybindings'

type Kind = 'screen' | 'ax'
interface RunningApp { bundleId: string; name: string }
interface CuBridge {
  status: () => Promise<CuStatus>
  requestPermission: (a: { kind: Kind }) => Promise<unknown>
  openSettings: (a: { kind: Kind }) => Promise<unknown>
  runningApps: () => Promise<RunningApp[]>
}
const bridge = (): CuBridge | undefined => (window as unknown as { forge?: { computerUse?: CuBridge } }).forge?.computerUse
const relaunch = (): void => { void (window as unknown as { forge?: { appRelaunch?: () => unknown } }).forge?.appRelaunch?.() }

interface Props {
  computerUse: ComputerUseSettings
  keybindings: Keybindings
  onChange: (patch: Partial<ComputerUseSettings>) => void
}

const KIND_LABEL: Record<Kind, string> = { screen: '屏幕录制', ax: '辅助功能' }

function PermRow({ kind, granted, requested, onRequest, onOpen }: {
  kind: Kind; granted: boolean | null; requested: boolean; onRequest: () => void; onOpen: () => void
}) {
  const needsRestart = granted === false && requested
  return (
    <div className="set-row" data-testid={`cu-row-${kind}`}>
      <div className="info"><div className="t">{KIND_LABEL[kind]}</div></div>
      {granted === null && <span className="cu-chip">检测中</span>}
      {granted === true && <span className="cu-chip ok">已授权</span>}
      {granted === false && !needsRestart && (
        <>
          <span className="cu-chip bad">未授权</span>
          <button className="btn-ghost" onClick={onRequest}>授权</button>
        </>
      )}
      {needsRestart && (
        <>
          <span className="cu-chip warn">授权后需重启</span>
          <button className="btn-ghost" onClick={onOpen}>打开系统设置</button>
          <button className="btn-ghost" onClick={relaunch}>重新启动</button>
        </>
      )}
    </div>
  )
}

function AppList({ id, title, builtin, extra, onChange }: {
  id: string; title: string; builtin: readonly string[]; extra: string[]; onChange: (next: string[]) => void
}) {
  const [picking, setPicking] = useState(false)
  const [apps, setApps] = useState<RunningApp[]>([])
  const open = async (): Promise<void> => {
    if (picking) { setPicking(false); return }
    setPicking(true)
    try { setApps((await bridge()?.runningApps()) ?? []) } catch { setApps([]) }
  }
  const have = new Set([...builtin, ...extra])
  const choices = apps.filter(a => !have.has(a.bundleId))
  return (
    <div className="set-group" data-testid={`cu-group-${id}`}>
      <div className="set-group-h">
        <h4>{title}</h4>
        <button className="btn-ghost" data-add onClick={() => void open()}>添加</button>
      </div>
      {picking && (
        <div className="cu-pick">
          {choices.map(a => (
            <button key={a.bundleId} className="cu-app" onClick={() => { onChange([...extra, a.bundleId]); setPicking(false) }}>{a.name}</button>
          ))}
        </div>
      )}
      <div className="cu-apps" data-testid={`cu-list-${id}`}>
        {extra.map(b => (
          <span className="cu-app" key={b} data-bundle={b}>
            {b}
            <button className="kb-mini" aria-label={`移除 ${b}`} onClick={() => onChange(extra.filter(x => x !== b))}>×</button>
          </span>
        ))}
        {builtin.map(b => <span className="cu-app builtin" key={b} data-bundle={b} data-builtin="true">{b}</span>)}
      </div>
    </div>
  )
}

export function ComputerUsePane({ computerUse, keybindings, onChange }: Props) {
  const darwin = (window as unknown as { forge?: { platform?: string } }).forge?.platform
  const supported = (darwin ?? 'darwin') === 'darwin'
  const [status, setStatus] = useState<CuStatus | null>(null)
  const [asked, setAsked] = useState<{ screen: boolean; ax: boolean }>({ screen: false, ax: false })

  const refresh = useCallback(() => {
    const b = bridge()
    if (!b) return
    b.status().then(setStatus, () => {})
  }, [])

  // Probes run only while this pane is mounted (= open). Nothing here starts at app start.
  useEffect(() => {
    if (!supported) return
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [supported, refresh])

  if (!supported || (status && !status.supported)) {
    return <div><div className="set-row"><div className="info"><div className="t">系统 · 暂不支持</div></div></div></div>
  }

  const request = async (kind: Kind): Promise<void> => {
    await bridge()?.requestPermission({ kind })
    setAsked(a => ({ ...a, [kind]: true }))
    onChange({ requested: { ...computerUse.requested, [kind]: true } })
    refresh()
  }
  const openPane = (kind: Kind): void => { void bridge()?.openSettings({ kind }) }
  const requested = (k: Kind): boolean => computerUse.requested[k] || asked[k]
  const accel = effectiveBindings(keybindings.overrides ?? {})['computer-use-stop']
  const helperLabel = status?.helper === 'ok' ? '正常' : status?.helper === 'missing' ? '组件缺失' : status?.helper === 'failed' ? '无法启动' : '检测中'
  const helperCls = status?.helper === 'ok' ? 'ok' : status ? 'bad' : ''

  return (
    <div className="cu-pane">
      <div className="set-group">
        <h4>权限</h4>
        {status && !status.osOK && (
          <div className="set-row" data-testid="cu-row-os">
            <div className="info"><div className="t">系统版本</div></div>
            <span className="cu-chip bad">需要 macOS 14 或更新</span>
          </div>
        )}
        <PermRow kind="screen" granted={status ? status.screen : null} requested={requested('screen')} onRequest={() => void request('screen')} onOpen={() => openPane('screen')} />
        <PermRow kind="ax" granted={status ? status.ax : null} requested={requested('ax')} onRequest={() => void request('ax')} onOpen={() => openPane('ax')} />
        <div className="set-row" data-testid="cu-row-helper">
          <div className="info"><div className="t">操作组件</div></div>
          <span className={`cu-chip ${helperCls}`}>{helperLabel}</span>
        </div>
        <div className="set-row" data-testid="cu-row-stop">
          <div className="info"><div className="t">停止快捷键</div></div>
          <span className="cu-chip">{accel ? formatAccelerator(accel, 'darwin') : '未绑定'}</span>
        </div>
      </div>
      <AppList id="blocked" title="始终拒绝的应用" builtin={BLOCKED_BUNDLES} extra={computerUse.extraBlocked} onChange={(v) => onChange({ extraBlocked: v })} />
      <AppList id="askAlways" title="始终询问的应用" builtin={[...ASK_ALWAYS_BUNDLES, ...SYSTEM_UI_OWNERS]} extra={computerUse.extraAskAlways} onChange={(v) => onChange({ extraAskAlways: v })} />
    </div>
  )
}
