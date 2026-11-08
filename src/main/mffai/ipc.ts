import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { connect as netConnect } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { connectControlClient, dataDir, runtimePaths, type MffaiState } from '@mffai/protocol'
import { CH } from '../ipc/channels'
import type { Settings } from '../config/schema'
import type { CallEnvelope } from './callEnvelope'
import { CONTROL_TIMEOUT_MS, controlCall, readSupervisorJson } from './client'
import { isCallable, takesCommandId } from './methods'
import { anyRootExists, probeControl, rootsOf, wipeData, type WipeDeps } from './wipe'
import { wipeLock, type WipeLock } from './wipeLock'

type HostModule = typeof import('./host')
type AddAccountInput = import('./host').AddAccountInput
type PromptOpts = import('./host').PromptOpts
type ApprovalDecision = import('./host').ApprovalDecision

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
  /**
   * 08 §5.1(评审修订 R1):带发送方判断的注册。index.ts 传入 `e.sender === 主窗口.webContents`;
   * mffai:call、mffai:wipe 只经它注册。没给 → 这两条经 handle 注册,一律当别的窗口
   */
  handleFrom?: (ch: string, fn: (fromMain: boolean, ...a: unknown[]) => unknown) => void
  /** 路径在不在(按 lstat,悬空链接也算);默认 lstatSync。停用状态的 dataExists 和删除全部数据用 */
  exists?: (p: string) => boolean
  /** 删除全部数据的副作用,测试注入;默认真的控制口 / fs.rm / execFile */
  wipe?: Partial<Pick<WipeDeps, 'controlAlive' | 'rm' | 'exists' | 'run' | 'platform' | 'home' | 'tmpDir'>>
  /** 和启用互斥的锁;默认模块级单例(host、设置同步用同一把) */
  lock?: WipeLock
  /** 只记方法名、错误码和路径 */
  log?: (msg: string) => void
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})

/** 页面传来的 { accountId, modelId };不像就当没选 */
function modelRef(v: unknown): { accountId: string; modelId: string } | undefined {
  const o = obj(v)
  return typeof o.accountId === 'string' && typeof o.modelId === 'string' ? { accountId: o.accountId, modelId: o.modelId } : undefined
}

/** 调试会话选项:cwd 去空白后非空才带,approvalMode 只认 ask / auto;都没有 → undefined */
function promptOpts(v: unknown): PromptOpts | undefined {
  const o = obj(v)
  const sessionId = str(o.sessionId)
  if (sessionId) return { sessionId }
  const out: PromptOpts = {}
  const cwd = str(o.cwd).trim()
  if (cwd) out.cwd = cwd
  if (o.approvalMode === 'ask' || o.approvalMode === 'auto') out.approvalMode = o.approvalMode
  return Object.keys(out).length ? out : undefined
}

const lexists = (p: string): boolean => {
  try { lstatSync(p); return true } catch { return false }
}

/** 默认的命令执行:不经 shell,10 s 上限,回退出码;起不来(ENOENT)→ reject */
const runCmd = (cmd: string, args: string[]): Promise<number> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10_000, windowsHide: true }, (err) => {
      if (!err) return resolve(0)
      const code = (err as NodeJS.ErrnoException & { code?: unknown }).code
      if (typeof code === 'number') resolve(code)
      else reject(err)
    })
  })

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v))

/** app 只建 app 会话、只发用户本人的话(08 §5.1);其余原样转,校验交给后台的 zod */
const SCRUB: Partial<Record<string, readonly string[]>> = {
  'session.create': ['origin', 'audience', 'projectTop'],
  'session.prompt': ['external'],
}

const fail = (code: number, message: string): CallEnvelope => ({ ok: false, error: { code, message } })

/** 参数 JSON 的上限,低于后台的帧上限(08 评审 M2) */
const MAX_PARAMS_BYTES = 8 * 1024 * 1024
const paramsTooBig = (p: unknown): boolean => {
  try { return Buffer.byteLength(JSON.stringify(p) ?? '') > MAX_PARAMS_BYTES } catch { return true }
}

/** 进程在不在(EPERM:在,但不是我们的) */
const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' }
}

/** 只连一下地址、不认证;超时 reject Error('timeout') */
const rawConnect = (addr: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const sock = netConnect(addr)
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('timeout')) }, CONTROL_TIMEOUT_MS)
    sock.once('connect', () => { clearTimeout(timer); sock.destroy(); resolve() })
    sock.once('error', (e) => { clearTimeout(timer); sock.destroy(); reject(e) })
  })

const DECISIONS: readonly unknown[] = ['allow', 'allow_session', 'deny'] satisfies ApprovalDecision[]

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

  const log = deps.log ?? (() => {})
  const exists = deps.exists ?? lexists
  const lock = deps.lock ?? wipeLock
  const mffaiDir = () => process.env.MFFAI_DATA_DIR || dataDir()

  // 未启用:只读设置,host 永远不加载
  const enabled = () => deps.readSettings().mffai.enabled
  const disabledState = (): MffaiState => {
    const { enabled, autostart } = deps.readSettings().mffai
    const dir = mffaiDir()
    return { enabled, autostart, running: false, dataDir: dir, dataExists: anyRootExists(dir, exists), roots: rootsOf(dir) }
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
    if (lock.active()) throw new Error('wiping') // 删除全部数据进行中(评审修订 R7)
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

  deps.handle(CH.mffaiPrompt, requireEnabled((h, text, model, opts) => {
    const t = String(text ?? '')
    const ref = modelRef(model)
    const o = promptOpts(opts)
    return o ? h.prompt(t, ref, o) : ref ? h.prompt(t, ref) : h.prompt(t)
  }))
  deps.handle(CH.mffaiApprovalRespond, requireEnabled((h, id, decision) => {
    if (!DECISIONS.includes(decision)) throw new Error('invalid decision')
    return h.approvalRespond(str(id), decision as ApprovalDecision)
  }))
  deps.handle(CH.mffaiRollback, requireEnabled((h, sessionId, turnId) => h.rollback(str(sessionId), str(turnId))))
  deps.handle(CH.mffaiCancel, requireEnabled((h, sessionId) => h.cancel(str(sessionId))))
  deps.handle(CH.mffaiPermissionsGet, requireEnabled((h, sessionId) => {
    const sid = str(sessionId)
    return sid ? h.permissionsGet(sid) : h.permissionsGet()
  }))
  // 只收普通对象;规则本身由内核严格校验
  deps.handle(CH.mffaiPermissionsSet, requireEnabled((h, config) => {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('invalid config')
    return h.permissionsSet(config)
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

  // —— 08:只收主窗口的两条 ——
  const handleFrom = deps.handleFrom ?? ((ch, fn) => deps.handle(ch, (...a) => fn(false, ...a)))

  handleFrom(CH.mffaiCall, async (fromMain, method, params): Promise<CallEnvelope> => {
    if (!fromMain) return fail(-32601, 'method not found')
    if (!enabled()) return fail(-32000, 'disabled') // 和 requireEnabled 同一条:不加载 host
    if (!isCallable(method)) return fail(-32601, 'method not found')
    if (params !== undefined && !isPlainObject(params)) return fail(-32602, 'invalid params')
    if (paramsTooBig(params)) return fail(-32602, 'params too large')
    const p: Record<string, unknown> = { ...(params ?? {}) }
    for (const k of SCRUB[method] ?? []) delete p[k]
    if (takesCommandId(method) && typeof p.commandId !== 'string') p.commandId = randomUUID()
    try {
      return await (await loadHost()).call(method, p)
    } catch {
      log(`mffai call ${method} failed: -32603`)
      return fail(-32603, 'internal error')
    }
  })

  handleFrom(CH.mffaiWipe, async (fromMain): Promise<{ ok: boolean; removed?: string[]; reason?: string }> => {
    if (!fromMain) return { ok: false, reason: 'sender' }
    if (!lock.begin()) return { ok: false, reason: 'wiping' }
    try {
      // 已加载的 host 有串行操作在跑(停用时为撤销自启临时拉起后台等):不删
      if (lock.hostOp() !== undefined) return { ok: false, reason: 'busy' }
      const dir = mffaiDir()
      const paths = runtimePaths(dir)
      const w = deps.wipe ?? {}
      const r = await wipeData({
        dataDir: dir,
        enabled: enabled(), // 标记置上之后再读:之后的启用都会被挡住
        platform: w.platform ?? process.platform,
        home: w.home ?? homedir(),
        tmpDir: w.tmpDir ?? tmpdir(),
        envDataDir: process.env.MFFAI_DATA_DIR || undefined,
        // 往"在"那边错:只有没人在听而且监管 pid 不在才算不在。★绝不为此拉起后台
        controlAlive: w.controlAlive ?? (() => probeControl({
          call: () => controlCall(connectControlClient, paths, 'status'),
          connect: () => rawConnect(paths.controlAddr),
          supervisorPid: () => readSupervisorJson(paths.supervisorJson)?.pid,
          isAlive: pidAlive,
        })),
        rm: w.rm ?? ((p) => rm(p, { recursive: true, force: true })),
        exists: w.exists ?? exists,
        run: w.run ?? runCmd,
      })
      if (r.ok) log(`mffai wipe removed: ${r.removed.join(', ')}`)
      return r
    } catch (err) {
      const path = (err as NodeJS.ErrnoException)?.path
      log(`mffai wipe failed${typeof path === 'string' ? `: ${path}` : ''}`)
      return { ok: false, reason: 'failed' }
    } finally {
      lock.end()
    }
  })
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
  /** 删除全部数据进行中就等它删完再加载 host(设置开关那条路也挡住,评审修订 R7) */
  lock?: WipeLock
}): (s: Pick<Settings, 'mffai'>) => void {
  const lock = deps.lock ?? wipeLock
  let prev = deps.initial
  return (s) => {
    const next = s.mffai ?? prev
    const t = mffaiTransition(prev, next)
    prev = next
    if (!t) return
    void lock.idle()
      .then(() => deps.loadHost())
      .then((h) => (t === 'enable' ? h.enable() : t === 'disable' ? h.disable() : h.setAutostart(next.autostart)))
      .catch(deps.onError)
  }
}
