import { dataDir, type MffaiState } from '@mffai/protocol'
import { CH } from '../ipc/channels'
import type { Settings } from '../config/schema'

type HostModule = typeof import('./host')

export interface MffaiIpcDeps {
  handle: (ch: string, fn: (...a: unknown[]) => unknown) => void
  readSettings: () => Settings
  /**
   * 写设置补丁。★必须是设置 IPC 用的同一个写入口(落盘 + 广播 settingsChanged + onSettings),
   * onSettings 再去调 host.enable / disable / setAutostart —— 设置只有一条写入路径。
   */
  saveSettings: (patch: Pick<Settings, 'mffai'>) => unknown
  /**
   * 第一次被调用时才加载 host 及其依赖。index.ts 传入的版本顺带 `init`(注入 send / 版本号 / 入口路径),
   * 所以事件推送不经这里。默认 `() => import('./host')`。
   */
  loadHost?: () => Promise<HostModule>
}

/** mff-ai 的本机 IPC。用 ipcMain.handle 直接注册,不进方法表(不跟随远程主机路由) */
export function registerMffaiIpc(deps: MffaiIpcDeps): void {
  const loadHost = deps.loadHost ?? (() => import('./host'))
  const save = (patch: Partial<Settings['mffai']>) =>
    deps.saveSettings({ mffai: { ...deps.readSettings().mffai, ...patch } })

  deps.handle(CH.mffaiState, async (): Promise<MffaiState> => {
    const { enabled, autostart } = deps.readSettings().mffai
    // 未启用:只读设置,host 永远不加载
    if (!enabled) return { enabled, autostart, running: false, dataDir: process.env.MFFAI_DATA_DIR ?? dataDir() }
    return (await loadHost()).getState()
  })
  deps.handle(CH.mffaiEnable, async () => {
    save({ enabled: true })
    const h = await loadHost()
    await h.enable() // 与 onSettings 触发的那次共用同一个进行中的 promise
    return h.getState()
  })
  deps.handle(CH.mffaiDisable, async () => {
    save({ enabled: false })
    const h = await loadHost()
    await h.disable()
    return h.getState()
  })
  deps.handle(CH.mffaiSetAutostart, async (on) => {
    save({ autostart: !!on })
    const h = await loadHost()
    await h.setAutostart(!!on)
    return h.getState()
  })
  deps.handle(CH.mffaiRestart, async () => {
    const h = await loadHost()
    await h.restart()
    return h.getState()
  })
  deps.handle(CH.mffaiResetTrip, async () => {
    const h = await loadHost()
    await h.resetTrip()
    return h.getState()
  })
  deps.handle(CH.mffaiTail, async (limit) => (await loadHost()).tail(Number(limit) || 50))
  deps.handle(CH.mffaiPrompt, async (text) => (await loadHost()).prompt(String(text ?? '')))
}

type MffaiSetting = Settings['mffai']
export type MffaiTransition = 'enable' | 'disable' | 'setAutostart' | null

/** 设置前后两份 mffai → 该对 host 做什么(纯函数) */
export function mffaiTransition(prev: MffaiSetting, next: MffaiSetting): MffaiTransition {
  if (prev.enabled !== next.enabled) return next.enabled ? 'enable' : 'disable'
  if (next.enabled && prev.autostart !== next.autostart) return 'setAutostart'
  return null
}

/**
 * onSettings 用:记住上一份 mffai,只在它真的变了时才加载 host。
 * 其它设置项的写入、mffai 原样不变的写入,一律不碰 host。
 */
export function createMffaiSettingsSync(deps: {
  initial: MffaiSetting
  loadHost: () => Promise<HostModule>
  onError: (err: unknown) => void
}): (s: Pick<Settings, 'mffai'>) => void {
  let prev = deps.initial
  return (s) => {
    const next = s.mffai ?? prev
    const t = mffaiTransition(prev, next)
    prev = next
    if (!t) return
    void deps.loadHost()
      .then((h) => (t === 'enable' ? h.enable() : t === 'disable' ? h.disable() : h.setAutostart(next.autostart)))
      .catch(deps.onError)
  }
}
