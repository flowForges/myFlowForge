import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PluginScheduler, type PluginSnapshot } from './pluginScheduler'
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
})
