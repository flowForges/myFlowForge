import { lazy, Suspense, useCallback, useEffect, useState, type ComponentType, type LazyExoticComponent } from 'react'
import type { MffaiState } from '@mffai/protocol'
import { EnableCard } from './EnableCard'
import { StatusStrip } from './StatusStrip'
import { DEFAULT_PAGE, MFFAI_PAGES, route, type MffaiPage } from './route'
import { useRoute } from './useRoute'
import { useShellInfo, type NavCounts } from './useShellInfo'
import './mffai.css'

/** 监督进程 50 + worker 51 MB(Task 10 实测),向上取整到 10 */
export const MFFAI_EXPECTED_RSS_MB = 110

// 每页一个懒加载块(08 §6.1)
const PAGES: Record<MffaiPage, LazyExoticComponent<ComponentType>> = {
  chat: lazy(() => import('./chat/ChatPage')),
  tasks: lazy(() => import('./tasks/TasksPage')),
  memory: lazy(() => import('./memory/MemoryPage')),
  plugins: lazy(() => import('./plugins/PluginsPage')),
  conn: lazy(() => import('./conn/ConnectionsPage')),
  perm: lazy(() => import('./perm/PermissionsPage')),
  debug: lazy(() => import('./debug/DebugPage')),
}
const PAGE_LABEL: Record<MffaiPage, string> = { chat: '对话', tasks: '任务', memory: '记忆', plugins: '插件', conn: '连接', perm: '权限', debug: '调试' }

/** 左侧导航 7 项 + 当前页。数字:对话 = 待批审批,记忆 = 待确认提议,插件 = 不在 active 的插件;没有就不显示 */
function Shell({ counts }: { counts: NavCounts }) {
  const { page } = useRoute()
  const Page = PAGES[page]
  // 离开 mff-ai 再回来落在默认页;别处(铃铛)在挂载前 set 的路由照常生效
  useEffect(() => () => route.set({ page: DEFAULT_PAGE }), [])
  return (
    <div className="mffai-shell">
      <nav className="set-nav mffai-nav">
        {MFFAI_PAGES.map((p) => (
          <button key={p} className={p === page ? 'on' : undefined} onClick={() => route.set({ page: p })}>
            <span className="mffai-navlabel">{PAGE_LABEL[p]}</span>
            {!!counts[p] && <span className="mffai-navnum">{counts[p]}</span>}
          </button>
        ))}
      </nav>
      <div className="mffai-main">
        <Suspense fallback={null}>
          <div className="mffai-pagebox" data-testid={`mffai-page-${page}`}><Page /></div>
        </Suspense>
      </div>
    </div>
  )
}

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

  const connected = !!state?.enabled && !!state.running
  const { info, counts } = useShellInfo(connected)

  if (!state) return <div className="mffai-page" />
  if (!state.enabled) {
    return (
      <div className="mffai-page">
        <EnableCard
          expectedRssMb={MFFAI_EXPECTED_RSS_MB}
          dataDir={state.dataDir ?? ''}
          autostart={state.autostart}
          failed={failed}
          dataExists={state.dataExists}
          roots={state.roots}
          // 删除全部数据不经后台:主进程直接删,删完重读状态(dataExists 变假,按钮就没了)
          onWipe={() => api.wipe().finally(refresh)}
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
        info={connected ? info : undefined}
        failed={failed}
        // 宿主的重启:proxyStale 时整个重拉后台,换上新代理(Task 4)
        onRestart={() => run(api.restart())}
        onResetTrip={() => run(api.resetTrip())}
      />
      {state.running && <Shell counts={counts} />}
    </div>
  )
}
