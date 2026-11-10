import { lazy, Suspense, useCallback, useEffect, useState, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react'
import type { MffaiState } from '@mffai/protocol'
import { EnableCard } from './EnableCard'
import { StatusStrip } from './StatusStrip'
import { DEFAULT_PAGE, route, type MffaiPage } from './route'
import { useRoute } from './useRoute'
import { useShellInfo, type NavCounts } from './useShellInfo'
import { Rail } from './shell/Rail'
import { PageHeader, PAGE_TITLE } from './shell/PageHeader'
import { HeaderSlotCtx } from './shell/headerSlot'
import { Icon } from './shell/icons'
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
/** 左侧图标轨 + 主区(页头带状态胶囊,下面是当前页)。数字:对话 = 待批审批,记忆 = 待确认提议,插件 = 不在 active 的插件;没有就不显示 */
function Shell({ counts, strip, tripped }: { counts: NavCounts; strip: ReactNode; tripped: boolean }) {
  const { page } = useRoute()
  const Page = PAGES[page]
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  // 离开 mff-ai 再回来落在默认页;别处(铃铛)在挂载前 set 的路由照常生效
  useEffect(() => () => route.set({ page: DEFAULT_PAGE }), [])
  return (
    <>
      <Rail
        page={page}
        counts={counts}
        onSelect={(p) => route.set({ page: p })}
        // 电源键和弹层是下一步(Task 3);这里只是位置和状态色
        power={<span className={`mffai-power${tripped ? ' bad' : ''}`}><Icon name="power" size={18} /></span>}
      />
      <div className="mffai-main">
        <HeaderSlotCtx.Provider value={slot}>
          <PageHeader title={PAGE_TITLE[page]} pill={strip} slotRef={setSlot} />
          <Suspense fallback={null}>
            <div className="mffai-pagebox" data-testid={`mffai-page-${page}`}><Page /></div>
          </Suspense>
        </HeaderSlotCtx.Provider>
      </div>
    </>
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
  const strip = (
    <StatusStrip
      state={state}
      info={connected ? info : undefined}
      failed={failed}
      // 宿主的重启:proxyStale 时整个重拉后台,换上新代理(Task 4)
      onRestart={() => run(api.restart())}
      onResetTrip={() => run(api.resetTrip())}
    />
  )
  // 后台不在:只有状态条(和重新启动),没有导航
  if (!state.running) return <div className="mffai-page">{strip}</div>
  return (
    <div className="mffai-page mffai-running">
      <Shell counts={counts} strip={strip} tripped={state.supervisor?.state === 'tripped' || state.compatible === false} />
    </div>
  )
}
