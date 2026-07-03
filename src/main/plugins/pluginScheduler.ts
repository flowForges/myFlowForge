import type { InstalledPlugin } from './pluginSchema'
import type { PluginRunResult } from './pluginHost'

export interface PluginResult {
  ok: boolean
  type?: string
  data?: unknown
  error?: string
  at: number
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
      if (!p.enabled) continue
      // Register in timers with a placeholder so runOne() knows to re-arm after completing
      this.timers.set(p.id, undefined as unknown)
      this.armed.set(p.id, p)
      void this.runOne(p)
    }
  }

  private arm(p: InstalledPlugin): void {
    // Clear any previous handle (may be undefined placeholder on the first arm)
    const existing = this.timers.get(p.id)
    if (existing !== undefined) this.deps.clearTimer(existing)
    const handle = this.deps.setTimer(() => void this.runOne(p), p.refreshSec * 1000)
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
    const entry: PluginResult = r.ok
      ? { ok: true, type: r.type, data: r.data, at: this.deps.nowMs() }
      : { ok: false, error: r.error, at: this.deps.nowMs() }
    this.results.set(p.id, entry)
    this.deps.broadcast(this.snapshot())
    // Re-arm with setTimeout only if this plugin is still in the scheduled set.
    // refresh() does not add to timers, so on-demand runs never trigger re-arming.
    if (this.timers.has(p.id)) {
      this.arm(p)
    }
  }

  reconcile(): void {
    const plugins = this.deps.readPlugins()
    const enabledMap = new Map(plugins.filter(p => p.enabled).map(p => [p.id, p]))

    // Clear timers for plugins no longer enabled/existing
    for (const [id, handle] of this.timers) {
      if (!enabledMap.has(id)) {
        this.deps.clearTimer(handle)
        this.timers.delete(id)
        this.results.delete(id)
        this.armed.delete(id)
      }
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

  async refresh(id?: string): Promise<void> {
    const plugins = this.deps.readPlugins()
    if (id !== undefined) {
      const p = plugins.find(pl => pl.id === id)
      if (p) await this.runOne(p)
    } else {
      const enabled = plugins.filter(p => p.enabled)
      await Promise.all(enabled.map(p => this.runOne(p)))
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
