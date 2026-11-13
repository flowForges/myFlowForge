import { describe, it, expect, vi } from 'vitest'
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
  const w = {
    calls, sent: [] as { channel: string; payload: unknown }[],
    setAlwaysOnTop: (...a: unknown[]) => { calls.push(['setAlwaysOnTop', ...a]) },
    setVisibleOnAllWorkspaces: (...a: unknown[]) => { calls.push(['setVisibleOnAllWorkspaces', ...a]) },
    setBounds: (b: unknown) => { calls.push(['setBounds', b]) },
    showInactive: () => { calls.push(['showInactive']); visible = true },
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
  const collapse = vi.fn()
  let work = WORK
  const screen: ScreenLike = { getPrimaryDisplay: () => ({ workArea: work }) }
  const ov = createCuOverlay({
    makeWindow: (o) => { opts.push(o); const w = fakeWin(); wins.push(w); return w as unknown as WinLike },
    screen,
    loadUrl: (w) => loads.push(w),
    preload: '/out/preload/index.js',
    collapseMain: collapse,
  })
  return { ov, wins, opts, loads, collapse, setWork: (w: typeof WORK) => { work = w } }
}

const ON: CuOverlayState = { session: { workspacePath: '/w', sessionId: 's', title: '会话一', mode: 'ask' }, gate: null, ownBlocked: false, actionSeq: 0, hotkeyFailed: false }
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
    expect(w.calls).toContainEqual(['setVisibleOnAllWorkspaces', true, { visibleOnFullScreen: true }])
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

  it('collapseMain forwards to the shell', () => {
    const t = setup()
    t.ov.collapseMain()
    expect(t.collapse).toHaveBeenCalledTimes(1)
  })
})

// The preload isn't in any vitest project (it's bundled into the renderer), so its source is scanned, as
// terminalPreload.test.ts does.
describe('preload: the overlay gets only its four calls', () => {
  const SRC = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')
  it('with OVERLAY_ARG it exposes cuOverlay and not forge; otherwise forge and not cuOverlay', () => {
    expect(SRC).toMatch(/if \(process\.argv\.includes\(CU_OVERLAY_ARG\)\) contextBridge\.exposeInMainWorld\('cuOverlay', cuOverlayApi\)\nelse contextBridge\.exposeInMainWorld\('forge', api\)/)
    expect(SRC.match(/exposeInMainWorld\(/g)).toHaveLength(2)
  })
  it('the bridge is onState / resolve / stop / collapseMain over the local-only channels', () => {
    const body = SRC.slice(SRC.indexOf('const cuOverlayApi = {'), SRC.indexOf('if (process.argv.includes(CU_OVERLAY_ARG))'))
    expect([...body.matchAll(/^  (\w+):/gm)].map((m) => m[1])).toEqual(['onState', 'resolve', 'stop', 'collapseMain'])
    expect([...body.matchAll(/CH\.(\w+)/g)].map((m) => m[1]).sort()).toEqual(['cuCollapseMain', 'cuOverlayState', 'cuOverlayState', 'cuResolve', 'cuStop'])
    expect(body).not.toMatch(/ipcRenderer\.send\(/)
  })
})
