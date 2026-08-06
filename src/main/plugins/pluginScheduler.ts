import type { InstalledPlugin } from './pluginSchema'
import type { PluginRunResult } from './pluginHost'
import { isFeaturePlugin } from '@shared/plugins'

export interface PluginResult {
  ok: boolean
  type?: string
  data?: unknown
  error?: string
  at: number
  /** When the next automatic attempt is due. Absent for on-demand runs (they don't schedule one). */
  nextAt?: number
}

// 失败退避的天花板。撞上 429 后按 refreshSec×2^n 往后退,但封顶 1 小时 —— 再久就等于插件永久失联了。
export const MAX_BACKOFF_MS = 60 * 60 * 1000
// 手动「刷新」的最小间隔。防连点,也防 UI 里任何触发全量刷新的路径把额度 API 打出 429。
export const MANUAL_REFRESH_MIN_MS = 30_000

/**
 * 下一次自动运行的间隔。
 *  - 成功(failStreak=0)→ 就是插件自己的 refreshSec。
 *  - 服务器给了 Retry-After → 听服务器的(但不短于常规间隔)。它比我们的猜测准,且不封顶:
 *    服务器说等两小时就等两小时,硬压到 1 小时只会再撞一次 429。
 *  - 否则 → refreshSec × 2^失败次数,封顶 MAX_BACKOFF_MS。
 */
export function nextDelayMs(refreshSec: number, failStreak: number, retryAfterSec?: number): number {
  const base = Math.max(1, refreshSec) * 1000
  if (failStreak <= 0) return base
  if (retryAfterSec !== undefined && retryAfterSec > 0) return Math.max(retryAfterSec * 1000, base)
  const grown = base * 2 ** Math.min(failStreak, 20)   // 20 次以内就已远超上限,夹一下防溢出
  return Math.min(grown, MAX_BACKOFF_MS)
}

export interface PluginSnapshot {
  plugins: InstalledPlugin[]
  results: Record<string, PluginResult>
}

export interface SchedulerDeps {
  run: (p: InstalledPlugin) => Promise<PluginRunResult>
  readPlugins: () => InstalledPlugin[]
  broadcast: (snap: PluginSnapshot) => void
  nowMs?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
}

// 只有「会产出数据」的插件才进调度:功能插件(宠物市场之类)没有可执行入口也没有扩展点,跑它必然失败。
// 见 isFeaturePlugin。禁用的同样不跑。
function schedulable(p: InstalledPlugin): boolean {
  return p.enabled && !isFeaturePlugin(p)
}

function sameDef(a: InstalledPlugin, b: InstalledPlugin): boolean {
  return (
    a.dir === b.dir &&
    a.entry === b.entry &&
    a.refreshSec === b.refreshSec &&
    a.type === b.type &&
    a.provider === b.provider &&
    a.enabled === b.enabled
  )
}

export class PluginScheduler {
  private results: Map<string, PluginResult> = new Map()
  private timers: Map<string, unknown> = new Map()
  private armed: Map<string, InstalledPlugin> = new Map()
  // 连续失败次数,驱动指数退避。成功即清零。见 nextDelayMs。
  private failStreak: Map<string, number> = new Map()
  private deps: Required<SchedulerDeps>

  constructor(deps: SchedulerDeps) {
    this.deps = {
      ...deps,
      nowMs: deps.nowMs ?? (() => Date.now()),
      setTimer: deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
    }
  }

  start(): void {
    const plugins = this.deps.readPlugins()
    for (const p of plugins) {
      if (!schedulable(p)) continue
      // Register in timers with a placeholder so runOne() knows to re-arm after completing
      this.timers.set(p.id, undefined as unknown)
      this.armed.set(p.id, p)
      void this.runOne(p)
    }
  }

  private arm(p: InstalledPlugin, delayMs: number): void {
    // Clear any previous handle (may be undefined placeholder on the first arm)
    const existing = this.timers.get(p.id)
    if (existing !== undefined) this.deps.clearTimer(existing)
    const handle = this.deps.setTimer(() => void this.runOne(p), delayMs)
    this.timers.set(p.id, handle)
    this.armed.set(p.id, p)
  }

  private async runOne(p: InstalledPlugin): Promise<void> {
    let r: PluginRunResult
    try {
      r = await this.deps.run(p)
    } catch (e) {
      r = { ok: false, error: String(e) }
    }
    // 退避记账:成功清零,失败累加。这一步必须在算 delay 之前。
    const streak = r.ok ? 0 : (this.failStreak.get(p.id) ?? 0) + 1
    if (r.ok) this.failStreak.delete(p.id)
    else this.failStreak.set(p.id, streak)
    const willRearm = this.timers.has(p.id)
    const delay = nextDelayMs(p.refreshSec, streak, r.ok ? undefined : r.retryAfterSec)
    const now = this.deps.nowMs()
    const entry: PluginResult = r.ok
      ? { ok: true, type: r.type, data: r.data, at: now, ...(willRearm ? { nextAt: now + delay } : {}) }
      : { ok: false, error: r.error, at: now, ...(willRearm ? { nextAt: now + delay } : {}) }
    this.results.set(p.id, entry)
    this.deps.broadcast(this.snapshot())
    // Re-arm with setTimeout only if this plugin is still in the scheduled set.
    // refresh() does not add to timers, so on-demand runs never trigger re-arming.
    if (willRearm) {
      this.arm(p, delay)
    }
  }

  reconcile(): void {
    const plugins = this.deps.readPlugins()
    // 不可调度的(禁用 / 功能插件)一律不进 map —— 下面的清理循环会顺带把它们遗留的 timer 和
    // 旧结果清掉,所以从老版本升上来、已经存了一条「不支持的类型」错误的宠物市场插件会自愈。
    const enabledMap = new Map(plugins.filter(schedulable).map(p => [p.id, p]))

    // Clear timers for plugins no longer enabled/existing
    for (const [id, handle] of this.timers) {
      if (!enabledMap.has(id)) {
        this.deps.clearTimer(handle)
        this.timers.delete(id)
        this.results.delete(id)
        this.armed.delete(id)
      }
    }

    // …and drop stale results for anything no longer schedulable even if it never had a timer.
    // refresh(id) stores a result WITHOUT registering a timer (by design — on-demand runs must not
    // start re-arming), so the loop above alone would strand that result forever. Concretely: a
    // pet-market plugin that got run once and errored keeps showing 「不支持的类型」 until restart.
    for (const id of [...this.results.keys()]) {
      if (!enabledMap.has(id)) this.results.delete(id)
    }
    // 退避记账同样要跟着走,否则重新启用一个插件会继承它上一轮的失败次数、一上来就被推到长间隔。
    for (const id of [...this.failStreak.keys()]) {
      if (!enabledMap.has(id)) this.failStreak.delete(id)
    }

    // Register and run newly-enabled plugins; timers placeholder ensures runOne re-arms.
    // Also detect changed definitions (same id, different dir/entry/refreshSec/…) and re-arm.
    for (const [id, p] of enabledMap) {
      if (!this.timers.has(id)) {
        // New plugin: set placeholder, track armed def, run immediately
        this.timers.set(id, undefined as unknown)
        this.armed.set(id, p)
        void this.runOne(p)
      } else if (!sameDef(this.armed.get(id)!, p)) {
        // Changed definition: clear old timer, re-arm with new def, re-run immediately
        const oldHandle = this.timers.get(id)
        if (oldHandle !== undefined) this.deps.clearTimer(oldHandle)
        this.timers.set(id, undefined as unknown)
        this.armed.set(id, p)
        void this.runOne(p)
      }
      // Unchanged: leave as-is, the existing timer continues uninterrupted
    }

    // Broadcast current snapshot so the renderer immediately reflects
    // uninstalled / disabled plugins (runOne only broadcasts after async run).
    this.deps.broadcast(this.snapshot())
  }

  /**
   * On-demand run. `force` skips the min-interval guard — reserved for the user explicitly clicking
   * 刷新 on ONE plugin. Everything else (settings toggles, credential saves) goes through the guard,
   * because those paths used to fan out into a burst of额度 API calls and earn a 429.
   */
  async refresh(id?: string, force = false): Promise<void> {
    const plugins = this.deps.readPlugins()
    const tooSoon = (p: InstalledPlugin): boolean => {
      const last = this.results.get(p.id)
      return !!last && this.deps.nowMs() - last.at < MANUAL_REFRESH_MIN_MS
    }
    if (id !== undefined) {
      const p = plugins.find(pl => pl.id === id)
      // 手点「刷新」也不该跑功能插件(它没有可跑的东西)。
      if (!p || !schedulable(p)) return
      if (!force && tooSoon(p)) { this.deps.broadcast(this.snapshot()); return }
      await this.runOne(p)
    } else {
      const due = plugins.filter(p => schedulable(p) && (force || !tooSoon(p)))
      if (!due.length) { this.deps.broadcast(this.snapshot()); return }
      await Promise.all(due.map(p => this.runOne(p)))
    }
  }

  snapshot(): PluginSnapshot {
    return {
      plugins: this.deps.readPlugins(),
      results: Object.fromEntries(this.results),
    }
  }

  stop(): void {
    for (const [, handle] of this.timers) {
      this.deps.clearTimer(handle)
    }
    this.timers.clear()
  }
}
