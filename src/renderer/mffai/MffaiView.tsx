import { useCallback, useEffect, useState } from 'react'
import type { MffaiState } from '@mffai/protocol'
import { EnableCard } from './EnableCard'
import { StatusStrip } from './StatusStrip'
import { DebugPanel } from './DebugPanel'
import './mffai.css'

/** 监督进程 50 + worker 51 MB(Task 10 实测),向上取整到 10 */
export const MFFAI_EXPECTED_RSS_MB = 110

export default function MffaiView() {
  const [state, setState] = useState<MffaiState | null>(null)
  const api = window.forge.mffai

  const refresh = useCallback(() => { void api.state().then(setState).catch(() => {}) }, [api])
  useEffect(() => {
    refresh()
    // 状态不推送:运行中周期轮询 + 事件到来时刷新
    const t = setInterval(refresh, 3000)
    const off = api.onAlert(refresh)
    return () => { clearInterval(t); off() }
  }, [api, refresh])

  if (!state) return <div className="mffai-page" />
  if (!state.enabled) {
    return (
      <div className="mffai-page">
        <EnableCard
          expectedRssMb={MFFAI_EXPECTED_RSS_MB}
          dataDir={state.dataDir ?? ''}
          autostart={state.autostart}
          onToggleAutostart={(on) => setState({ ...state, autostart: on })}
          onEnable={() => {
            // 先落盘开机自启选择(enabled 未变,不触发 host),再启用
            void Promise.resolve(window.forge.setSettings({ mffai: { enabled: false, autostart: state.autostart } }))
              .catch(() => {}).then(() => api.enable()).then(setState).catch(() => {})
          }}
        />
      </div>
    )
  }
  return (
    <div className="mffai-page">
      <StatusStrip
        state={state}
        onRestart={() => { void api.restart().then(setState).catch(() => {}) }}
        onResetTrip={() => { void api.resetTrip().then(setState).catch(() => {}) }}
      />
      {state.running && <DebugPanel />}
    </div>
  )
}
