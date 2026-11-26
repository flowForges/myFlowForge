import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CuOverlayState } from '@shared/computerUse'
import { CH } from '../ipc/channels'
import { createCuOverlay, OVERLAY_ARG, type ScreenLike, type WinLike } from './cuOverlay'

const WORK = { x: 0, y: 25, width: 1792, height: 1070 }

function fakeWin() {
  const calls: unknown[][] = []
  const listeners: Record<string, (() => void)[]> = {}
  const wcListeners: Record<string, (() => void)[]> = {}
  let visible = false
  let destroyed = false
  let bounds = { x: 0, y: 0, width: 0, height: 0 }
  const w = {
    getBounds: () => ({ ...bounds }),
    _init: (b: typeof bounds) => { bounds = b },
    calls, sent: [] as { channel: string; payload: unknown }[],
    setAlwaysOnTop: (...a: unknown[]) => { calls.push(['setAlwaysOnTop', ...a]) },
    setVisibleOnAllWorkspaces: (...a: unknown[]) => { calls.push(['setVisibleOnAllWorkspaces', ...a]) },
    setBounds: (b: typeof bounds) => { calls.push(['setBounds', b]); bounds = { ...b } },
    showInactive: () => { calls.push(['showInactive']); visible = true },
    setContentProtection: (...a: unknown[]) => { calls.push(['setContentProtection', ...a]) },
    show: () => { calls.push(['show']); visible = true },
    focus: () => { calls.push(['focus']) },
    hide: () => { calls.push(['hide']); visible = false },
    isVisible: () => visible,
    isDestroyed: () => destroyed,
    destroy: () => { destroyed = true; for (const f of listeners.closed ?? []) f() },
    on: (ev: string, fn: () => void) => { (listeners[ev] ??= []).push(fn) },
    webContents: {
      id: 900 + Math.floor(Math.random() * 99),
      send: (channel: string, payload: unknown) => { w.sent.push({ channel, payload }) },
      on: (ev: string, fn: () => void) => { (wcListeners[ev] ??= []).push(fn) },
    },
    fire: (ev: string) => { for (const f of wcListeners[ev] ?? []) f() },
  }
  return w
}

function setup() {
  const wins: ReturnType<typeof fakeWin>[] = []
  const opts: unknown[] = []
  const loads: unknown[] = []
  let work = WORK
  let cursor = { x: 0, y: 0 }
  // a second display to the right of the primary one
  const RIGHT = { x: 1792, y: 0, width: 1440, height: 900 }
  const nearest: { p: { x: number; y: number } }[] = []
  const screen: ScreenLike = {
    getPrimaryDisplay: () => ({ workArea: work }),
    getCursorScreenPoint: () => ({ ...cursor }),
    getDisplayNearestPoint: (p) => { nearest.push({ p }); return { workArea: p.x >= RIGHT.x ? RIGHT : work } },
  }
  const ov = createCuOverlay({
    makeWindow: (o) => {
      opts.push(o); const w = fakeWin(); w._init({ x: o.x!, y: o.y!, width: o.width!, height: o.height! }); wins.push(w); return w as unknown as WinLike
    },
    screen,
    loadUrl: (w) => loads.push(w),
    preload: '/out/preload/index.js',
  })
  return { ov, wins, opts, loads, setWork: (w: typeof WORK) => { work = w }, cursorAt: (x: number, y: number) => { cursor = { x, y } } }
}

const ON: CuOverlayState = { session: { workspacePath: '/w', sessionId: 's', title: '会话一', mode: 'ask' }, gate: null, actionSeq: 0, hotkeyFailed: false }
const GATED: CuOverlayState = { ...ON, gate: { id: 'cug.1', kind: 'action', action: { kind: 'click', at: { x: 1, y: 2 } }, crop: 'Y3JvcA==' } }

describe('createCuOverlay', () => {
  it('nothing is created until the first show; hide before that creates nothing', () => {
    const t = setup()
    t.ov.hide()
    t.ov.dispose()
    expect(t.wins).toEqual([])
  })

  it('window options are exact: a non-activating, always-on-top, transparent panel centred on the primary work area', () => {
    const t = setup()
    t.ov.show(ON)
    expect(t.opts).toEqual([{
      type: 'panel', frame: false, transparent: true, resizable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true,
      hasShadow: false, width: 420, height: 36, x: 686, y: 31, show: false,
      minimizable: false, maximizable: false, fullscreenable: false, acceptFirstMouse: true, backgroundColor: '#00000000',
      webPreferences: { preload: '/out/preload/index.js', contextIsolation: true, sandbox: false, additionalArguments: [OVERLAY_ARG] },
    }])
    const w = t.wins[0]
    expect(w.calls).toContainEqual(['setAlwaysOnTop', true, 'screen-saver'])
    // rc3 issue 1: without skipTransformProcessType Electron turns the process into a UIElement and the Dock icon goes
    expect(w.calls).toContainEqual(['setVisibleOnAllWorkspaces', true, { visibleOnFullScreen: true, skipTransformProcessType: true }])
    expect(t.loads).toEqual([w])
  })

  it('show pushes the state and shows inactive (never show / focus); a gate expands it to 420×220', () => {
    const t = setup()
    t.ov.show(ON)
    const w = t.wins[0]
    expect(w.sent).toEqual([{ channel: CH.cuOverlayState, payload: ON }])
    expect(w.calls).toContainEqual(['showInactive'])
    expect(w.calls.find((c) => c[0] === 'show' || c[0] === 'focus')).toBeUndefined()
    t.ov.show(GATED)
    expect(w.calls.filter((c) => c[0] === 'setBounds').at(-1)).toEqual(['setBounds', { x: 686, y: 31, width: 420, height: 220 }])
    t.ov.show(ON)
    expect(w.calls.filter((c) => c[0] === 'setBounds').at(-1)).toEqual(['setBounds', { x: 686, y: 31, width: 420, height: 36 }])
    expect(t.wins).toHaveLength(1)
  })

  it('placed on the primary display each time it shows', () => {
    const t = setup()
    t.ov.show(ON)
    t.setWork({ x: -1440, y: 0, width: 1440, height: 900 })
    t.ov.show(ON)
    expect(t.wins[0].calls.filter((c) => c[0] === 'setBounds').at(-1)).toEqual(['setBounds', { x: -930, y: 6, width: 420, height: 36 }])
  })

  it('hides on off; the last state is re-sent when the page (re)loads', () => {
    const t = setup()
    t.ov.show(ON)
    t.ov.show(GATED)
    const w = t.wins[0]
    w.sent.length = 0
    w.fire('did-finish-load')
    expect(w.sent).toEqual([{ channel: CH.cuOverlayState, payload: GATED }])
    t.ov.hide()
    expect(w.calls.at(-1)).toEqual(['hide'])
  })

  it('a destroyed window is rebuilt on the next show; dispose destroys it', () => {
    const t = setup()
    t.ov.show(ON)
    t.wins[0].destroy()
    t.ov.show(ON)
    expect(t.wins).toHaveLength(2)
    t.ov.dispose()
    expect(t.wins[1].isDestroyed()).toBe(true)
  })

  it('webContentsId: null until built, the live window\'s id after, null once destroyed (I-1 sender check)', () => {
    const t = setup()
    expect(t.ov.webContentsId()).toBeNull()
    t.ov.show(ON)
    expect(t.ov.webContentsId()).toBe(t.wins[0].webContents.id)
    t.ov.dispose()
    expect(t.ov.webContentsId()).toBeNull()
  })

  it('the overlay window is excluded from screen captures (setContentProtection, spec §9.1)', () => {
    const t = setup()
    t.ov.show(ON)
    expect(t.wins[0].calls).toContainEqual(['setContentProtection', true])
    const i = t.wins[0].calls.findIndex((c) => c[0] === 'setContentProtection')
    const j = t.wins[0].calls.findIndex((c) => c[0] === 'showInactive')
    expect(i).toBeLessThan(j)
  })

  it('no collapseMain any more', () => {
    const t = setup()
    expect('collapseMain' in t.ov).toBe(false)
  })

  // rc3 issue 3: the pill can be dragged; main moves the window by the cursor's travel (the renderer sends phases only)
  describe('drag', () => {
    const lastBounds = (w: ReturnType<typeof fakeWin>) => w.calls.filter((c) => c[0] === 'setBounds').at(-1)?.[1]
    it('start → move follows the cursor\'s travel from where the window was', () => {
      const t = setup()
      t.ov.show(ON)
      t.cursorAt(800, 40)
      t.ov.drag('start')
      t.cursorAt(700, 300)
      t.ov.drag('move')
      expect(lastBounds(t.wins[0])).toEqual({ x: 586, y: 291, width: 420, height: 36 })
      t.ov.drag('end')
    })

    it('the dragged place is kept: a gate expanding, hide → show and a fresh show all reuse it', () => {
      const t = setup()
      t.ov.show(ON)
      t.cursorAt(800, 40); t.ov.drag('start'); t.cursorAt(700, 300); t.ov.drag('move'); t.ov.drag('end')
      t.ov.show(GATED)
      expect(lastBounds(t.wins[0])).toEqual({ x: 586, y: 291, width: 420, height: 220 })
      t.ov.hide()
      t.ov.show(ON)
      expect(lastBounds(t.wins[0])).toEqual({ x: 586, y: 291, width: 420, height: 36 })
      t.wins[0].destroy()
      t.ov.show(ON)
      expect(t.opts[1]).toMatchObject({ x: 586, y: 291 })
      expect(lastBounds(t.wins[1])).toEqual({ x: 586, y: 291, width: 420, height: 36 })
    })

    it('clamped to the work area of the display it is on, including when a gate makes it taller', () => {
      const t = setup()
      t.ov.show(ON)
      t.cursorAt(800, 40); t.ov.drag('start'); t.cursorAt(800, 5000); t.ov.drag('move'); t.ov.drag('end')
      // WORK: y 25..1095 → a 36-high pill tops out at 1059
      expect(lastBounds(t.wins[0])).toEqual({ x: 686, y: 1059, width: 420, height: 36 })
      t.ov.show(GATED)
      expect(lastBounds(t.wins[0])).toEqual({ x: 686, y: 875, width: 420, height: 220 })
      // dragged onto the right-hand display: clamped to that one
      t.cursorAt(800, 40); t.ov.drag('start'); t.cursorAt(800 + 3000, 40); t.ov.drag('move'); t.ov.drag('end')
      expect(lastBounds(t.wins[0])).toEqual({ x: 1792 + 1440 - 420, y: 900 - 220, width: 420, height: 220 })
    })

    it('move / end without a start, unknown phases and drags with no window do nothing', () => {
      const t = setup()
      t.ov.drag('move')
      t.ov.drag('start')
      expect(t.wins).toEqual([])
      t.ov.show(ON)
      const n = t.wins[0].calls.length
      t.ov.drag('move'); t.ov.drag('end'); t.ov.drag('bogus' as never)
      expect(t.wins[0].calls.length).toBe(n)
    })

    it('a crash rebuild comes back where it was dragged to (T10 recovery reuses the place)', () => {
      vi.useFakeTimers()
      try {
        const t = setup()
        t.ov.show(GATED)
        t.cursorAt(800, 40); t.ov.drag('start'); t.cursorAt(700, 300); t.ov.drag('move'); t.ov.drag('end')
        t.wins[0].fire('render-process-gone')
        vi.runAllTimers()
        expect(t.opts[1]).toMatchObject({ x: 586, y: 291, height: 220 })
      } finally { vi.useRealTimers() }
    })
  })

  // T10 carry-over, fix round 1 (reviewer findings 1-3): render-process-gone recovery is deferred (off the crash
  // event's own call stack) and the cap/backoff is time-based, so these all run under fake timers.
  describe('render-process-gone recovery', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })

    it('a crashed/killed overlay renderer is rebuilt and the last state — including a pending gate — reappears', () => {
      const t = setup()
      t.ov.show(GATED)
      const w = t.wins[0]
      w.sent.length = 0
      w.fire('render-process-gone')
      vi.runAllTimers()
      expect(w.isDestroyed()).toBe(true)
      expect(t.wins).toHaveLength(2)
      const w2 = t.wins[1]
      expect(w2.sent).toContainEqual({ channel: CH.cuOverlayState, payload: GATED })
      expect(w2.calls).toContainEqual(['showInactive'])
      expect(t.ov.webContentsId()).toBe(w2.webContents.id)
    })

    it('the rebuild is deferred off the render-process-gone call stack', () => {
      const t = setup()
      t.ov.show(GATED)
      const w = t.wins[0]
      w.fire('render-process-gone')
      // nothing has happened synchronously yet
      expect(w.isDestroyed()).toBe(false)
      expect(t.wins).toHaveLength(1)
      vi.runAllTimers()
      expect(w.isDestroyed()).toBe(true)
      expect(t.wins).toHaveLength(2)
    })

    it('finding 2: a crash after hide() does not resurrect the panel; the next explicit show() rebuilds normally', () => {
      const t = setup()
      t.ov.show(GATED)
      const w = t.wins[0]
      t.ov.hide()
      w.sent.length = 0
      w.fire('render-process-gone')
      vi.runAllTimers()
      // no auto-rebuild while hidden
      expect(t.wins).toHaveLength(1)
      expect(t.ov.webContentsId()).toBeNull()
      // an explicit show() still works
      t.ov.show(ON)
      expect(t.wins).toHaveLength(2)
      expect(t.wins[1].sent).toContainEqual({ channel: CH.cuOverlayState, payload: ON })
    })

    it('a stale render-process-gone from an already-replaced window does not touch the current one', () => {
      const t = setup()
      t.ov.show(ON)
      const w1 = t.wins[0]
      t.ov.show(GATED) // same window, new state
      w1.destroy()
      t.ov.show(ON) // rebuilds (w1 was destroyed)
      const w2 = t.wins[1]
      w2.sent.length = 0
      // a late event from the dead w1 must not rebuild again or touch w2
      w1.fire('render-process-gone')
      vi.runAllTimers()
      expect(t.wins).toHaveLength(2)
      expect(w2.sent).toEqual([])
    })

    it('finding 3: a crash loop is capped at 3 rebuilds per 10 s, then it gives up until the next explicit show()', () => {
      const t = setup()
      t.ov.show(GATED)
      for (let i = 0; i < 5; i++) {
        const w = t.wins[t.wins.length - 1]
        w.fire('render-process-gone')
        vi.runAllTimers()
      }
      // 1 initial window + 3 allowed auto-rebuilds; the 4th and 5th crash gave up
      expect(t.wins).toHaveLength(4)
      expect(t.ov.webContentsId()).toBeNull()
      // the cap only limits auto-recovery: an explicit show() right after still works
      t.ov.show(ON)
      expect(t.wins).toHaveLength(5)
    })
  })
})

// The preload isn't in any vitest project (it's bundled into the renderer), so its source is scanned, as
// terminalPreload.test.ts does.
describe('preload: the overlay gets only its five calls', () => {
  const SRC = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')
  it('with OVERLAY_ARG it exposes cuOverlay and not forge; otherwise forge and not cuOverlay', () => {
    expect(SRC).toMatch(/if \(process\.argv\.includes\(CU_OVERLAY_ARG\)\) contextBridge\.exposeInMainWorld\('cuOverlay', cuOverlayApi\)\nelse contextBridge\.exposeInMainWorld\('forge', api\)/)
    expect(SRC.match(/exposeInMainWorld\(/g)).toHaveLength(2)
  })
  it('the bridge is onState / resolve / stop / openMain / drag over the local-only channels', () => {
    const body = SRC.slice(SRC.indexOf('const cuOverlayApi = {'), SRC.indexOf('if (process.argv.includes(CU_OVERLAY_ARG))'))
    expect([...body.matchAll(/^  (\w+):/gm)].map((m) => m[1])).toEqual(['onState', 'resolve', 'stop', 'openMain', 'drag'])
    expect([...body.matchAll(/CH\.(\w+)/g)].map((m) => m[1]).sort()).toEqual(['cuOpenMain', 'cuOverlayDrag', 'cuOverlayState', 'cuOverlayState', 'cuResolve', 'cuStop'])
    expect(body).not.toMatch(/ipcRenderer\.send\(/)
  })
})
