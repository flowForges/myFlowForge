/**
 * claude 的钩子生命周期事件 —— 解析 + 「谁把这一轮拖住了」的追踪。
 *
 * ★★背景:claude 在 stream-json 上**主动**发 `hook_started` / `hook_response`,Forge 一直全丢了。
 *  代价是用户装的 `PermissionRequest` 钩子把 claude 拦住时,界面上和「模型在思考」完全一样 ——
 *  2026-09-07 用户是靠**另一个软件**才发现 agent 在等他授权的。
 *  (那台机器上 PermissionRequest 挂着 3 个钩子,超时都是 86400 秒 = 24 小时。)
 * ★同样被丢掉的还有钩子**报错**:treland-bridge 连不上自己的 socket、ping-island-bridge 直接抛错,
 *  用户至今不知道 —— 接上之后 Forge 自己就会说。
 *
 * 这里只做纯逻辑(解析 + 计时),不碰 UI、不碰进程。
 */

/**
 * 挂多久才播报。★2 秒是刻意选的:钩子正常是毫秒级返回(写个日志、发个通知),超过 2 秒基本只有
 * 一种可能 —— 它在等人。低于这个值会把一轮里几十个正常钩子全播报出来,那就成噪音了。
 */
export const HOOK_SLOW_MS = 2_000

export interface HookEvent {
  phase: 'start' | 'end'
  /** 同一个钩子的开始/结束靠它配对。CLI 给的是 hook_id,兜底用名字。 */
  id: string
  /** 形如 `PermissionRequest:Bash`。 */
  name: string
  /** 形如 `PermissionRequest`。播报时用它 —— 带工具名的那一份对用户没有增量信息。 */
  event: string
  outcome?: string
  output?: string
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** 从一条 stream-json 事件里认出钩子事件;不是的返回 null(防御性读:这是 CLI 内部结构)。 */
export function parseHookEvent(obj: unknown): HookEvent | null {
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  if (o.type !== 'system') return null
  const phase = o.subtype === 'hook_started' ? 'start' : o.subtype === 'hook_response' ? 'end' : null
  if (!phase) return null
  const name = str(o.hook_name)
  const id = str(o.hook_id) || name
  if (!id) return null
  return {
    phase, id, name,
    event: str(o.hook_event) || name.split(':')[0],
    ...(phase === 'end' ? { outcome: str(o.outcome), output: str(o.output) } : {}),
  }
}

export interface HookWatchTimers {
  set(fn: () => void, ms: number): unknown
  clear(h: unknown): void
}

export interface HookWatchOpts {
  /** 挂了这么久还没回来才播报。秒回的钩子一声不吭 —— 一轮里几十个,每个都说就是噪音。 */
  slowMs: number
  onSlow(names: string[], seconds: number): void
  onError(name: string, message: string): void
  timers?: HookWatchTimers
}

const defaultTimers: HookWatchTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

/**
 * 追踪这一轮里还挂着的钩子。
 * - 有钩子挂过 `slowMs` 还没回来 → `onSlow`,把还挂着的全列出来
 * - 钩子以 error 收场 → `onError`
 * - `pending()` 给看门狗用:静默的时候要能说出「还有谁没回来」
 */
export function makeHookWatch(opts: HookWatchOpts) {
  const timers = opts.timers ?? defaultTimers
  const live = new Map<string, string>()   // id → event
  let handle: unknown = null
  let done = false

  const disarm = () => { if (handle !== null) { timers.clear(handle); handle = null } }
  // ★只在「从没有到有」时起表:每来一个钩子就重置的话,一串连着来的钩子会把播报无限推后。
  const arm = () => {
    if (done || handle !== null || live.size === 0) return
    handle = timers.set(() => {
      handle = null
      if (done || live.size === 0) return
      opts.onSlow([...live.values()], Math.round(opts.slowMs / 1000))
    }, opts.slowMs)
  }

  return {
    feed(obj: unknown): HookEvent | null {
      const ev = parseHookEvent(obj)
      if (!ev || done) return ev
      if (ev.phase === 'start') { live.set(ev.id, ev.event); arm(); return ev }
      live.delete(ev.id)
      if (live.size === 0) disarm()
      // 钩子报错:只取第一行 —— 报错常常带一整段堆栈,正文里摆不下也没人看。
      if (ev.outcome && ev.outcome !== 'success') {
        const first = (ev.output ?? '').split('\n').map(s => s.trim()).find(Boolean)
        if (first) opts.onError(ev.event, first)
      }
      return ev
    },
    /** 此刻还没回来的钩子(按事件名)。 */
    pending(): string[] { return [...live.values()] },
    clear() { done = true; live.clear(); disarm() },
  }
}
