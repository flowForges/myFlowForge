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
  const [failed, setFailed] = useState(false)
  const api = window.forge.mffai
  // 操作结果:成功更新状态并清失败标记,失败记日志并显示「失败」
  const run = (p: Promise<MffaiState>) => {
    setFailed(false)
    void p.then(setState).catch((e) => { console.error('mffai', e); setFailed(true) })
  }

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
          failed={failed}
          // 立刻落盘(enabled 未变,不加载 host),轮询读回的就是用户的选择
          onToggleAutostart={(on) => {
            setState({ ...state, autostart: on })
            void Promise.resolve(window.forge.setSettings({ mffai: { enabled: false, autostart: on } })).catch((e) => console.error('mffai', e))
          }}
          onEnable={() => run(Promise.resolve(window.forge.setSettings({ mffai: { enabled: false, autostart: state.autostart } })).then(() => api.enable()))}
        />
      </div>
    )
  }
  return (
    <div className="mffai-page">
      <StatusStrip
        state={state}
        failed={failed}
        onRestart={() => run(api.restart())}
        onResetTrip={() => run(api.resetTrip())}
      />
      {state.running && <DebugPanel />}
    </div>
  )
}
