import { dataDir, type MffaiState } from '@mffai/protocol'
import { CH } from '../ipc/channels'
import type { Settings } from '../config/schema'

type HostModule = typeof import('./host')
type AddAccountInput = import('./host').AddAccountInput

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
  /** 用系统浏览器打开链接(index.ts 注入 shell.openExternal;mffai 目录不 import electron) */
  openExternal: (url: string) => void
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})

/** 页面传来的 { accountId, modelId };不像就当没选 */
function modelRef(v: unknown): { accountId: string; modelId: string } | undefined {
  const o = obj(v)
  return typeof o.accountId === 'string' && typeof o.modelId === 'string' ? { accountId: o.accountId, modelId: o.modelId } : undefined
}

/** 只挑添加账号认得的字段(commandId 由宿主生成);其余校验交给工作进程 */
function addAccountInput(v: unknown): AddAccountInput {
  const o = obj(v)
  const out: AddAccountInput = { presetId: str(o.presetId) }
  for (const k of ['label', 'apiKey', 'baseUrl'] as const) if (typeof o[k] === 'string') out[k] = o[k]
  if (typeof o.protocol === 'string') out.protocol = o.protocol as AddAccountInput['protocol']
  if (typeof o.restrictionAck === 'boolean') out.restrictionAck = o.restrictionAck
  return out
}

/** mff-ai 的本机 IPC。用 ipcMain.handle 直接注册,不进方法表(不跟随远程主机路由) */
export function registerMffaiIpc(deps: MffaiIpcDeps): void {
  const loadHost = deps.loadHost ?? (() => import('./host'))
  const save = (patch: Partial<Settings['mffai']>) =>
    deps.saveSettings({ mffai: { ...deps.readSettings().mffai, ...patch } })

  // 未启用:只读设置,host 永远不加载
  const enabled = () => deps.readSettings().mffai.enabled
  const disabledState = (): MffaiState => {
    const { enabled, autostart } = deps.readSettings().mffai
    return { enabled, autostart, running: false, dataDir: process.env.MFFAI_DATA_DIR || dataDir() }
  }
  /** 启用时才加载 host 做 fn,否则直接回未启用状态 */
  const whenEnabled = (fn: (h: HostModule) => Promise<unknown>) => async (): Promise<MffaiState> => {
    if (!enabled()) return disabledState()
    const h = await loadHost()
    await fn(h)
    return h.getState()
  }

  deps.handle(CH.mffaiState, async (): Promise<MffaiState> => {
    if (!enabled()) return disabledState()
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
    return whenEnabled((h) => h.setAutostart(!!on))()
  })
  deps.handle(CH.mffaiRestart, whenEnabled((h) => h.restart()))
  deps.handle(CH.mffaiResetTrip, whenEnabled((h) => h.resetTrip()))
  deps.handle(CH.mffaiTail, async (limit) => {
    if (!enabled()) return { events: [] }
    // 协议要求 1..1000 的整数
    const n = Math.min(1000, Math.max(1, Math.trunc(Number(limit)) || 50))
    return (await loadHost()).tail(n)
  })
  /** 未启用直接拒绝(不加载 host),启用才转给 host */
  const requireEnabled = <A extends unknown[]>(fn: (h: HostModule, ...a: A) => unknown) => async (...a: A) => {
    if (!enabled()) throw new Error('mff-ai 未启用')
    return fn(await loadHost(), ...a)
  }

  deps.handle(CH.mffaiPrompt, requireEnabled((h, text, model) => {
    const ref = modelRef(model)
    return ref ? h.prompt(String(text ?? ''), ref) : h.prompt(String(text ?? ''))
  }))
  deps.handle(CH.mffaiModelsCatalog, requireEnabled((h) => h.modelsCatalog()))
  deps.handle(CH.mffaiModelsAccounts, requireEnabled((h) => h.modelsAccounts()))
  deps.handle(CH.mffaiModelsAddAccount, requireEnabled((h, input) => h.addAccount(addAccountInput(input))))
  deps.handle(CH.mffaiModelsRemoveAccount, requireEnabled((h, id) => h.removeAccount(str(id))))
  deps.handle(CH.mffaiModelsTestAccount, requireEnabled((h, id) => h.testAccount(str(id))))
  deps.handle(CH.mffaiModelsSetDefault, requireEnabled((h, accountId, modelId) =>
    h.setDefault({ accountId: str(accountId), modelId: str(modelId) })))
  deps.handle(CH.mffaiModelsQuota, requireEnabled((h, id) => h.quota(str(id))))
  deps.handle(CH.mffaiChatgptBegin, requireEnabled((h) => h.chatgptBegin(deps.openExternal)))
  deps.handle(CH.mffaiChatgptCancel, requireEnabled((h, flowId) => h.chatgptCancel(str(flowId))))
  deps.handle(CH.mffaiOpenExternal, requireEnabled((h, url) => h.openExternal(str(url), deps.openExternal)))
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
