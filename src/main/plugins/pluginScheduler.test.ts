import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PluginScheduler, nextDelayMs, MAX_BACKOFF_MS, MANUAL_REFRESH_MIN_MS, type PluginSnapshot } from './pluginScheduler'
import type { InstalledPlugin } from './pluginSchema'
import type { PluginRunResult } from './pluginHost'

const makePlugin = (id: string, enabled = true, refreshSec = 60): InstalledPlugin => ({
  id,
  dir: '/plugins/' + id,
  type: 'widget',
  name: id,
  entry: 'index.sh',
  refreshSec,
  enabled,
})

const okResult = (type = 'widget', data: unknown = { v: 1 }): PluginRunResult => ({ ok: true, type, data })
const errResult = (error = 'oops'): PluginRunResult => ({ ok: false, error })

function makeDeps(plugins: InstalledPlugin[]) {
  const runSpy = vi.fn((_p: InstalledPlugin): Promise<PluginRunResult> => Promise.resolve(okResult()))
  const broadcastSpy = vi.fn((_snap: PluginSnapshot): void => {})
  const setTimerSpy = vi.fn((_fn: () => void, _ms: number): unknown => Math.random())
  const clearTimerSpy = vi.fn((_h: unknown): void => {})
  const nowMs = vi.fn(() => 1000)

  return {
    runSpy,
    broadcastSpy,
    setTimerSpy,
    clearTimerSpy,
    nowMs,
    deps: {
      run: (p: InstalledPlugin) => runSpy(p),
      readPlugins: () => plugins,
      broadcast: (snap: PluginSnapshot) => broadcastSpy(snap),
      nowMs: () => nowMs(),
      setTimer: (fn: () => void, ms: number) => setTimerSpy(fn, ms),
      clearTimer: (h: unknown) => clearTimerSpy(h),
    },
  }
}

describe('PluginScheduler', () => {
  describe('start()', () => {
    it('runs only enabled plugins and arms timers for them', async () => {
      const plugins: InstalledPlugin[] = []
      const pa = makePlugin('a', true, 30)
      const pb = makePlugin('b', false, 60)
      plugins.push(pa, pb)
      const { deps, runSpy, setTimerSpy } = makeDeps(plugins)
      runSpy.mockResolvedValue(okResult())

      const sched = new PluginScheduler(deps)
      sched.start()
      // Timer is set after runOne completes, wait for it
      await vi.waitFor(() => expect(setTimerSpy).toHaveBeenCalledTimes(1))

      expect(runSpy).toHaveBeenCalledWith(pa)
      expect(runSpy).not.toHaveBeenCalledWith(pb)
      expect(setTimerSpy.mock.calls[0][1]).toBe(30 * 1000)
    })

    it('does not arm disabled plugins', async () => {
      const plugins = [makePlugin('x', false, 10)]
      const { deps, setTimerSpy } = makeDeps(plugins)
      const sched = new PluginScheduler(deps)
      sched.start()
      // Give a microtask tick to ensure any async work settles
      await Promise.resolve()
      expect(setTimerSpy).not.toHaveBeenCalled()
    })
  })

  describe('runOne success/failure', () => {
    it('success: updates results with ok+type+data and broadcasts', async () => {
      const plugins = [makePlugin('a', true, 60)]
      const { deps, runSpy, broadcastSpy } = makeDeps(plugins)
      runSpy.mockResolvedValue(okResult('widget', { score: 42 }))

      const sched = new PluginScheduler(deps)
      sched.start()
      await vi.waitFor(() => expect(broadcastSpy).toHaveBeenCalledTimes(1))

      const snap = broadcastSpy.mock.calls[0][0] as PluginSnapshot
      expect(snap.results['a']).toMatchObject({ ok: true, type: 'widget', data: { score: 42 }, at: 1000 })
    })

    it('failure: updates results with ok=false and error', async () => {
      const plugins = [makePlugin('a', true, 60)]
      const { deps, runSpy, broadcastSpy } = makeDeps(plugins)
      runSpy.mockResolvedValue(errResult('exec failed'))

      const sched = new PluginScheduler(deps)
      sched.start()
      await vi.waitFor(() => expect(broadcastSpy).toHaveBeenCalledTimes(1))

      const snap = broadcastSpy.mock.calls[0][0] as PluginSnapshot
      expect(snap.results['a']).toMatchObject({ ok: false, error: 'exec failed', at: 1000 })
      expect(snap.results['a'].type).toBeUndefined()
    })
  })

  describe('failure isolation', () => {
    it('a throwing run records error and does not affect other plugins', async () => {
      const plugins = [makePlugin('a', true, 60), makePlugin('b', true, 60)]
      const { deps, runSpy, broadcastSpy } = makeDeps(plugins)

      runSpy.mockImplementation(async (p: InstalledPlugin) => {
        if (p.id === 'a') throw new Error('boom')
        return okResult('widget', { v: 2 })
      })

      const sched = new PluginScheduler(deps)
      sched.start()
      await vi.waitFor(() => expect(broadcastSpy).toHaveBeenCalledTimes(2))

      const finalSnap = broadcastSpy.mock.calls[broadcastSpy.mock.calls.length - 1][0] as PluginSnapshot
      expect(finalSnap.results['a']).toBeDefined()
      expect(finalSnap.results['a'].ok).toBe(false)
      expect(finalSnap.results['a'].error).toContain('boom')
      expect(finalSnap.results['b']).toBeDefined()
      expect(finalSnap.results['b'].ok).toBe(true)
    })
  })

  describe('reconcile()', () => {
    it('disables a plugin: clears timer and removes result', async () => {
      const plugins: InstalledPlugin[] = [makePlugin('a', true, 60)]
      const { deps, runSpy, broadcastSpy, setTimerSpy, clearTimerSpy } = makeDeps(plugins)
      runSpy.mockResolvedValue(okResult())

      const sched = new PluginScheduler(deps)
      sched.start()
      await vi.waitFor(() => expect(broadcastSpy).toHaveBeenCalledTimes(1))

      const handle = setTimerSpy.mock.results[0].value
      plugins[0] = { ...plugins[0], enabled: false }

      sched.reconcile()

      expect(clearTimerSpy).toHaveBeenCalledWith(handle)
      const snap = sched.snapshot()
      expect(snap.results['a']).toBeUndefined()
    })

    it('enables a new plugin: arms timer and runs it', async () => {
      const plugins: InstalledPlugin[] = [makePlugin('a', false, 30)]
      const { deps, runSpy, setTimerSpy } = makeDeps(plugins)
      runSpy.mockResolvedValue(okResult())

      const sched = new PluginScheduler(deps)
      sched.start()
      expect(runSpy).not.toHaveBeenCalled()

      plugins[0] = { ...plugins[0], enabled: true }
      sched.reconcile()

      await vi.waitFor(() => expect(runSpy).toHaveBeenCalledTimes(1))
      expect(setTimerSpy).toHaveBeenCalledWith(expect.any(Function), 30 * 1000)
    })

    it('re-installs plugin (same id, changed dir/refreshSec): clears old timer, re-arms with new refreshSec, re-runs', async () => {
      const plugins: InstalledPlugin[] = [{ ...makePlugin('a', true, 30), dir: '/plugins/a' }]
      const { deps, runSpy, setTimerSpy, clearTimerSpy, broadcastSpy } = makeDeps(plugins)
      runSpy.mockResolvedValue(okResult())

      const sched = new PluginScheduler(deps)
      sched.start()
      await vi.waitFor(() => expect(broadcastSpy).toHaveBeenCalledTimes(1))

      // Capture the timer handle set after first run
      const oldHandle = setTimerSpy.mock.results[0].value

      // Re-install: same id, new dir + new refreshSec
      plugins[0] = { ...plugins[0], dir: '/plugins/a-v2', refreshSec: 90 }

      sched.reconcile()
      // reconcile re-runs the changed plugin
      await vi.waitFor(() => expect(runSpy).toHaveBeenCalledTimes(2))

      // Old timer handle must have been cleared
      expect(clearTimerSpy).toHaveBeenCalledWith(oldHandle)
      // New timer set with new refreshSec
      const newTimerCall = setTimerSpy.mock.calls.find(c => c[1] === 90 * 1000)
      expect(newTimerCall).toBeDefined()
    })

    it('reconcile with unchanged already-armed plugin: does NOT re-run or re-arm', async () => {
      const plugins: InstalledPlugin[] = [makePlugin('a', true, 60)]
      const { deps, runSpy, setTimerSpy, broadcastSpy } = makeDeps(plugins)
      runSpy.mockResolvedValue(okResult())

      const sched = new PluginScheduler(deps)
      sched.start()
      await vi.waitFor(() => expect(broadcastSpy).toHaveBeenCalledTimes(1))
      const runCountBefore = runSpy.mock.calls.length
      const timerCountBefore = setTimerSpy.mock.calls.length

      // Plugin definition unchanged
      sched.reconcile()
      // Give a tick to ensure any async re-run would show up
      await Promise.resolve()

      expect(runSpy.mock.calls.length).toBe(runCountBefore)       // no extra run
      expect(setTimerSpy.mock.calls.length).toBe(timerCountBefore) // no extra timer
    })
  })

  describe('refresh()', () => {
    it('refresh(id) runs only that plugin', async () => {
      const plugins = [makePlugin('a', true, 60), makePlugin('b', true, 60)]
      const { deps, runSpy } = makeDeps(plugins)
      runSpy.mockResolvedValue(okResult())

      const sched = new PluginScheduler(deps)
      await sched.refresh('a')

      expect(runSpy).toHaveBeenCalledTimes(1)
      expect(runSpy).toHaveBeenCalledWith(plugins[0])
    })

    it('refresh() with no id runs all enabled plugins', async () => {
      const plugins = [makePlugin('a', true, 60), makePlugin('b', false, 60), makePlugin('c', true, 60)]
      const { deps, runSpy } = makeDeps(plugins)
      runSpy.mockResolvedValue(okResult())

      const sched = new PluginScheduler(deps)
      await sched.refresh()

      expect(runSpy).toHaveBeenCalledTimes(2)
      expect(runSpy).toHaveBeenCalledWith(plugins[0])
      expect(runSpy).toHaveBeenCalledWith(plugins[2])
      expect(runSpy).not.toHaveBeenCalledWith(plugins[1])
    })

    it('refresh broadcasts after each run', async () => {
      const plugins = [makePlugin('a', true, 60)]
      const { deps, runSpy, broadcastSpy } = makeDeps(plugins)
      runSpy.mockResolvedValue(okResult())

      const sched = new PluginScheduler(deps)
      await sched.refresh()
      expect(broadcastSpy).toHaveBeenCalledTimes(1)
    })
  })

  describe('stop()', () => {
    it('clears all timers', async () => {
      const plugins = [makePlugin('a', true, 60), makePlugin('b', true, 120)]
      const { deps, runSpy, broadcastSpy, setTimerSpy, clearTimerSpy } = makeDeps(plugins)
      runSpy.mockResolvedValue(okResult())

      const sched = new PluginScheduler(deps)
      sched.start()
      // Timers are set after runOne() completes; wait for both broadcasts
      await vi.waitFor(() => expect(broadcastSpy).toHaveBeenCalledTimes(2))

      expect(setTimerSpy).toHaveBeenCalledTimes(2)
      const handles = setTimerSpy.mock.results.map((r) => r.value)

      sched.stop()

      expect(clearTimerSpy).toHaveBeenCalledTimes(2)
      for (const h of handles) {
        expect(clearTimerSpy).toHaveBeenCalledWith(h)
      }
    })
  })

  describe('snapshot()', () => {
    it('returns current plugins list and results map', async () => {
      const pa = makePlugin('a', true, 60)
      const plugins = [pa]
      const { deps, runSpy } = makeDeps(plugins)
      runSpy.mockResolvedValue(okResult('widget', 99))

      const sched = new PluginScheduler(deps)
      await sched.refresh('a')

      const snap = sched.snapshot()
      expect(snap.plugins).toEqual([pa])
      expect(snap.results['a']).toMatchObject({ ok: true, data: 99 })
    })
  })

  // 回归:宠物市场这类「功能插件」(native 且非 statusbar-usage)没有可执行入口也没有 pluginHost 扩展点。
  // 以前调度器照跑不误 → 每 refreshSec 在插件卡上刷一条「不支持的类型: pet-market」。它必须完全不进调度。
  describe('功能插件(native 非额度类)不进调度', () => {
    const petMarket = (enabled = true): InstalledPlugin => ({
      id: 'forge-official-pet-market', dir: '', type: 'pet-market', name: 'codex 宠物市场',
      entry: 'native', refreshSec: 300, enabled, native: true,
    })

    it('start() 不跑它、不给它排定时器', async () => {
      const { deps, runSpy, setTimerSpy } = makeDeps([petMarket()])
      new PluginScheduler(deps).start()
      await Promise.resolve()
      expect(runSpy).not.toHaveBeenCalled()
      expect(setTimerSpy).not.toHaveBeenCalled()
    })

    it('手点刷新也不跑它', async () => {
      const { deps, runSpy } = makeDeps([petMarket()])
      await new PluginScheduler(deps).refresh('forge-official-pet-market')
      expect(runSpy).not.toHaveBeenCalled()
    })

    it('全量 refresh() 跳过它但照常跑额度插件', async () => {
      const usage: InstalledPlugin = {
        id: 'forge-official-claude-usage', dir: '', type: 'statusbar-usage', provider: 'claude',
        name: 'Claude 额度', entry: 'native', refreshSec: 300, enabled: true, native: true,
      }
      const { deps, runSpy } = makeDeps([petMarket(), usage])
      await new PluginScheduler(deps).refresh()
      expect(runSpy).toHaveBeenCalledTimes(1)
      expect(runSpy.mock.calls[0][0].id).toBe('forge-official-claude-usage')
    })

    it('reconcile() 清掉老版本遗留的错误结果(自愈)', async () => {
      // 先让它以「可调度」的身份留下一条错误结果,模拟从老版本升级上来的用户。
      const legacy: InstalledPlugin = { ...petMarket(), native: false }
      const plugins: InstalledPlugin[] = [legacy]
      const { deps, runSpy } = makeDeps(plugins)
      runSpy.mockResolvedValue(errResult('不支持的类型: pet-market'))
      const sched = new PluginScheduler(deps)
      await sched.refresh(legacy.id)
      expect(sched.snapshot().results[legacy.id]).toMatchObject({ ok: false })

      // 升级后它被正确标为 native 功能插件 → reconcile 应把它移出调度并丢掉那条错误结果。
      plugins[0] = petMarket()
      sched.reconcile()
      expect(sched.snapshot().results[legacy.id]).toBeUndefined()
    })
  })

  // ── 429 防线 ──────────────────────────────────────────────────────────────
  // 以前无论成败都按固定 refreshSec 重排 → 撞上 429 就以同一频率一直撞,直到用户自己关掉插件。
  describe('nextDelayMs (失败退避曲线)', () => {
    it('成功就是常规间隔', () => {
      expect(nextDelayMs(300, 0)).toBe(300_000)
    })

    it('连续失败按 2 的幂次往后退', () => {
      expect(nextDelayMs(300, 1)).toBe(600_000)
      expect(nextDelayMs(300, 2)).toBe(1_200_000)
      expect(nextDelayMs(300, 3)).toBe(2_400_000)
    })

    it('封顶 1 小时,且大指数不溢出', () => {
      expect(nextDelayMs(300, 10)).toBe(MAX_BACKOFF_MS)
      expect(nextDelayMs(300, 999)).toBe(MAX_BACKOFF_MS)
    })

    it('服务器给了 Retry-After 就听它的,且不受 1 小时上限压制', () => {
      // 服务器说等两小时。硬压到 1 小时只会再撞一次 429 —— 所以这里必须超过 MAX_BACKOFF_MS。
      expect(nextDelayMs(300, 1, 7200)).toBe(7_200_000)
      expect(nextDelayMs(300, 1, 7200)).toBeGreaterThan(MAX_BACKOFF_MS)
    })

    it('Retry-After 比常规间隔还短时,不早于常规间隔', () => {
      expect(nextDelayMs(300, 1, 5)).toBe(300_000)
    })
  })

  describe('调度器的退避与节流', () => {
    it('失败后按退避重排,成功后回到常规间隔', async () => {
      const p = makePlugin('a', true, 60)
      const { deps, runSpy, setTimerSpy } = makeDeps([p])
      const sched = new PluginScheduler(deps)

      runSpy.mockResolvedValue(errResult('HTTP 429'))
      sched.start()
      await Promise.resolve(); await Promise.resolve()
      expect(setTimerSpy.mock.calls.at(-1)?.[1]).toBe(120_000)   // 60s × 2^1

      // 第二次失败继续退
      await sched.refresh('a', true)
      expect(setTimerSpy.mock.calls.at(-1)?.[1]).toBe(240_000)   // 60s × 2^2

      // 一次成功就复位
      runSpy.mockResolvedValue(okResult())
      await sched.refresh('a', true)
      expect(setTimerSpy.mock.calls.at(-1)?.[1]).toBe(60_000)
    })

    it('把服务器的 Retry-After 作为下次间隔', async () => {
      const p = makePlugin('a', true, 60)
      const { deps, runSpy, setTimerSpy } = makeDeps([p])
      runSpy.mockResolvedValue({ ok: false, error: '请求过于频繁（429），稍后再试', retryAfterSec: 900 })
      const sched = new PluginScheduler(deps)
      sched.start()
      await Promise.resolve(); await Promise.resolve()
      expect(setTimerSpy.mock.calls.at(-1)?.[1]).toBe(900_000)
    })

    it('结果里带上 nextAt,供 UI 显示还要等多久', async () => {
      const p = makePlugin('a', true, 60)
      const { deps, runSpy, nowMs } = makeDeps([p])
      nowMs.mockReturnValue(1000)
      runSpy.mockResolvedValue(errResult('HTTP 429'))
      const sched = new PluginScheduler(deps)
      sched.start()
      await Promise.resolve(); await Promise.resolve()
      expect(sched.snapshot().results['a']).toMatchObject({ ok: false, at: 1000, nextAt: 1000 + 120_000 })
    })

    it('非 force 的刷新在最小间隔内被吞掉(但仍广播,UI 不至于卡住)', async () => {
      const p = makePlugin('a', true, 60)
      const { deps, runSpy, broadcastSpy, nowMs } = makeDeps([p])
      nowMs.mockReturnValue(1000)
      const sched = new PluginScheduler(deps)

      await sched.refresh('a', true)
      expect(runSpy).toHaveBeenCalledTimes(1)

      broadcastSpy.mockClear()
      nowMs.mockReturnValue(1000 + MANUAL_REFRESH_MIN_MS - 1)
      await sched.refresh('a')                       // 未到最小间隔 → 不跑
      expect(runSpy).toHaveBeenCalledTimes(1)
      expect(broadcastSpy).toHaveBeenCalledTimes(1)

      nowMs.mockReturnValue(1000 + MANUAL_REFRESH_MIN_MS)
      await sched.refresh('a')                       // 到点 → 跑
      expect(runSpy).toHaveBeenCalledTimes(2)
    })

    it('force 无视最小间隔(用户点「刷新」就该真刷)', async () => {
      const p = makePlugin('a', true, 60)
      const { deps, runSpy, nowMs } = makeDeps([p])
      nowMs.mockReturnValue(1000)
      const sched = new PluginScheduler(deps)
      await sched.refresh('a', true)
      await sched.refresh('a', true)
      expect(runSpy).toHaveBeenCalledTimes(2)
    })
  })
})
