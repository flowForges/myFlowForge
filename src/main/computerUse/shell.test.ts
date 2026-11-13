import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CuOverlayState } from '@shared/computerUse'
import { defaultSettings, type Settings } from '../config/schema'
import { createBroadcastHub } from '../ipc/broadcastHub'
import { CH } from '../ipc/channels'
import { registerGlobalShortcuts, type GlobalShortcutApi } from '../shortcuts/globalShortcuts'
import { fakeDriver } from './fakeDriver'
import type { WinHit } from './driver'
import { createCuRuntime } from './runtime'
import { attachPowerMonitor, CU_POWER_EVENTS, cuSystemNote, cuTrayMenuItems, cuTrayTitle, wireComputerUse } from './shell'
import type { CuEvent, CuGate, CuSessionKey } from './types'

const A: CuSessionKey = { workspacePath: '/w/a', sessionId: 's-a' }
const LOCAL = { local: true }
const APP: WinHit = { pid: 500, bundleId: 'com.example.app', name: 'Example', layer: 0, windowId: 77 }
const MARKER = 'SECRET-MARKER-7f3a'
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await Promise.resolve() }

const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })

function shell(o: { focused?: boolean; notifyOn?: boolean } = {}) {
  const local: { channel: string; payload: unknown }[] = []
  const shown: CuOverlayState[] = []
  let hides = 0
  const notes: { title: string; body: string; onClick: () => void }[] = []
  const active: boolean[] = []
  const stopAll = vi.fn()
  const sh = wireComputerUse({
    localBroadcast: (channel, payload) => local.push({ channel, payload }),
    overlay: { show: (s) => shown.push(s), hide: () => { hides++ } },
    notify: (n, onClick) => notes.push({ ...n, onClick }),
    shouldNotify: () => (o.notifyOn ?? true) && !(o.focused ?? false),
    onActive: (a) => active.push(a),
    stopAll,
  })
  return { sh, local, shown, notes, active, stopAll, get hides() { return hides } }
}

const stateOn: CuEvent = { type: 'state', sessions: [{ ...A, mode: 'ask', title: '会话一' }] }
const stateOff: CuEvent = { type: 'state', sessions: [] }
const gate = (over: Partial<CuGate> = {}): CuGate => ({
  id: 'cug.1', key: A, kind: 'action', ts: 1, crop: 'Y3JvcA==',
  action: { kind: 'click', app: 'Example', bundleId: 'com.example.app', at: { x: 10, y: 20 } }, ...over,
})

describe('events go to the local sink only (Review Focus 15, V2)', () => {
  it('state, gate, action and stop reach registry.broadcast and never the hub — also while viewing a remote host', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cu-shell-'))
    roots.push(root)
    const hub = createBroadcastHub()
    const remote = vi.fn()
    hub.addSink(remote)
    // the router's local sink drops non-client events while it views a remote host
    const routerLocal = vi.fn()
    hub.addSink(routerLocal)
    const registry = vi.fn()
    const sh = wireComputerUse({
      localBroadcast: registry, overlay: { show: () => {}, hide: () => {} }, notify: () => {}, shouldNotify: () => true,
      onActive: () => {}, stopAll: () => {},
    })
    const driver = fakeDriver({ front: APP, hits: APP, capture: { width: 1280, height: 800 } })
    let settings: Settings = defaultSettings()
    const rt = createCuRuntime({
      platform: 'darwin', dir: join(root, 'computer-use'), ownPid: 4242, helperPath: () => '/fake/forge-cu',
      makeDriver: () => driver,
      startBridge: async (d) => ({ socketPath: join(d, 'cu.sock'), configDir: d, close: async () => {} }),
      openExternal: () => {}, emit: sh.emit, note: () => {}, stopTurn: () => {}, titleOf: () => 't',
      readSettings: () => settings, writeSettings: (s) => { settings = s }, ownAccelerators: () => [],
      liveAgentChildren: () => [], now: () => 0, sleep: async () => {},
    })
    const svc = rt.host()!.service
    await svc.setMode(A, 'ask', LOCAL)
    svc.beginTurn(A, 'local')
    const tok = svc.tokenFor(A)!
    await svc.handle(tok, 'screenshot', {}, {})
    const code = driver.captures[0].code!
    const call = svc.handle(tok, 'type', { text: MARKER, visionCode: code }, {})
    await flush()
    const g = registry.mock.calls.map((c) => c[1] as CuEvent).find((e) => e.type === 'gate') as { gate: CuGate }
    await svc.resolve(g.gate.id, 'allow', LOCAL)
    await call
    rt.stopAll()
    const types = registry.mock.calls.filter((c) => c[0] === CH.cuEvent).map((c) => (c[1] as CuEvent).type)
    for (const t of ['state', 'gate', 'gate-resolved', 'action', 'stopped']) expect(types).toContain(t)
    expect(remote).not.toHaveBeenCalled()
    expect(routerLocal).not.toHaveBeenCalled()
    expect(registry.mock.calls.every((c) => c[0] === CH.cuEvent)).toBe(true)
  })
})

describe('overlay state', () => {
  it('shows on state on with the title and mode, hides on off; never creates it to hide', () => {
    const t = shell()
    t.sh.emit(stateOff)
    expect(t.shown).toEqual([])
    t.sh.emit(stateOn)
    expect(t.shown.at(-1)).toEqual({ session: { ...A, title: '会话一', mode: 'ask' }, gate: null, ownBlocked: false, actionSeq: 0 })
    t.sh.emit(stateOff)
    expect(t.hides).toBe(1)
    expect(t.sh.state().session).toBeNull()
  })

  it('a pending gate expands it; resolving it collapses again', () => {
    const t = shell()
    t.sh.emit(stateOn)
    t.sh.emit({ type: 'gate', gate: gate() })
    expect(t.shown.at(-1)!.gate).toEqual({ id: 'cug.1', kind: 'action', action: gate().action, crop: 'Y3JvcA==' })
    t.sh.emit({ type: 'gate-resolved', id: 'cug.1', decision: 'allow' })
    expect(t.shown.at(-1)!.gate).toBeNull()
  })

  it('the last action blocked by our own window offers 收起主窗口; the next one clears it; each action bumps the flash', () => {
    const t = shell()
    t.sh.emit(stateOn)
    t.sh.emit({ type: 'action', key: A, entry: { ts: 1, turn: 1, op: 'click', result: 'failed', code: 'own_window' } })
    expect(t.shown.at(-1)).toMatchObject({ ownBlocked: true, actionSeq: 1 })
    t.sh.emit({ type: 'action', key: A, entry: { ts: 2, turn: 1, op: 'click', result: 'auto' } })
    expect(t.shown.at(-1)).toMatchObject({ ownBlocked: false, actionSeq: 2 })
  })

  it('the overlay state never carries the action log text preview', () => {
    const t = shell()
    t.sh.emit(stateOn)
    t.sh.emit({ type: 'action', key: A, entry: { ts: 1, turn: 1, op: 'type', result: 'auto', textLen: 18, textPreview: MARKER } })
    expect(JSON.stringify(t.shown)).not.toContain(MARKER)
  })
})

describe('OS notification (Review Focus 10)', () => {
  it('a new gate while the main window is not focused: title 电脑操作待批准, body only the kind label; click shows the overlay', () => {
    const t = shell()
    t.sh.emit(stateOn)
    t.sh.emit({ type: 'gate', gate: gate({ action: { kind: 'type', text: MARKER, app: MARKER } }) })
    expect(t.notes).toHaveLength(1)
    expect(t.notes[0].title).toBe('电脑操作待批准')
    expect(t.notes[0].body).toBe('输入')
    expect(JSON.stringify(t.notes)).not.toContain(MARKER)
    const before = t.shown.length
    t.notes[0].onClick()
    expect(t.shown.length).toBe(before + 1)
    t.sh.emit({ type: 'gate', gate: gate({ id: 'cug.2', kind: 'continue', action: undefined, reason: '已执行 100 步 · 继续 100 步' }) })
    expect(t.notes[1].body).toBe('继续')
  })

  it('no notification while the main window is focused or notifications are off', () => {
    for (const o of [{ focused: true }, { notifyOn: false }]) {
      const t = shell(o)
      t.sh.emit(stateOn)
      t.sh.emit({ type: 'gate', gate: gate() })
      expect(t.notes).toEqual([])
    }
  })
})

describe('tray, hotkey and lock (Review Focus 12)', () => {
  it('onActive fires on the transitions only', () => {
    const t = shell()
    t.sh.emit(stateOn)
    t.sh.emit({ type: 'state', sessions: [{ ...A, mode: 'allow', title: '会话一' }] })
    t.sh.emit(stateOff)
    t.sh.emit(stateOff)
    expect(t.active).toEqual([true, false])
  })

  it('tray title ● and the 停止电脑操作 item only while on', () => {
    const stop = vi.fn()
    expect(cuTrayTitle(false)).toBe('')
    expect(cuTrayTitle(true)).toBe('●')
    expect(cuTrayMenuItems(false, stop)).toEqual([])
    const items = cuTrayMenuItems(true, stop)
    expect(items[0]).toMatchObject({ label: '停止电脑操作' })
    ;(items[0] as { click: () => void }).click()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('the stop hotkey is registered while a session is on and calls stopAll; unregistered when everything is off', () => {
    const t = shell()
    const registered = new Map<string, () => void>()
    const gs: GlobalShortcutApi = { register: (a, cb) => { registered.set(a, cb); return true }, unregisterAll: () => registered.clear() }
    const apply = () => registerGlobalShortcuts({}, { 'toggle-pet': () => {}, ...t.sh.shortcutHandlers() }, gs)
    apply()
    expect(registered.has('Control+Alt+Command+Escape')).toBe(false)
    t.sh.emit(stateOn)
    apply()
    registered.get('Control+Alt+Command+Escape')!()
    expect(t.stopAll).toHaveBeenCalledTimes(1)
    t.sh.emit(stateOff)
    apply()
    expect(registered.has('Control+Alt+Command+Escape')).toBe(false)
    expect(registered.has('CommandOrControl+Shift+P')).toBe(true)
  })

  it('powerMonitor lock-screen, suspend, user-did-resign-active and shutdown each call onLock', () => {
    expect([...CU_POWER_EVENTS]).toEqual(['lock-screen', 'suspend', 'user-did-resign-active', 'shutdown'])
    const pm = new EventEmitter()
    const onLock = vi.fn()
    attachPowerMonitor(pm, onLock)
    for (const ev of CU_POWER_EVENTS) pm.emit(ev)
    expect(onLock).toHaveBeenCalledTimes(4)
    pm.emit('resume')
    expect(onLock).toHaveBeenCalledTimes(4)
  })

  it('a fake powerMonitor lock turns a live session off through the runtime, with the lock note', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cu-lock-'))
    roots.push(root)
    const notes: string[] = []
    let settings: Settings = defaultSettings()
    const rt = createCuRuntime({
      platform: 'darwin', dir: join(root, 'computer-use'), ownPid: 4242, helperPath: () => '/fake/forge-cu',
      makeDriver: () => fakeDriver(),
      startBridge: async (d) => ({ socketPath: join(d, 'cu.sock'), configDir: d, close: async () => {} }),
      openExternal: () => {}, emit: () => {}, note: (_k, text) => notes.push(text), stopTurn: () => {}, titleOf: () => 't',
      readSettings: () => settings, writeSettings: (s) => { settings = s }, ownAccelerators: () => [],
      liveAgentChildren: () => [],
    })
    const pm = new EventEmitter()
    attachPowerMonitor(pm, rt.onLock)
    await rt.host()!.service.setMode(A, 'allow', LOCAL)
    const tok = rt.host()!.service.tokenFor(A)!
    pm.emit('lock-screen')
    expect(rt.host()!.service.modeOf(A)).toBe('off')
    expect(notes).toEqual(['屏幕已锁定 · 电脑操作已关闭'])
    rt.host()!.service.beginTurn(A, 'local')
    expect(await rt.host()!.service.handle(tok, 'screenshot', {}, {})).toMatchObject({ ok: false, code: 'not_enabled' })
  })
})

describe('cuSystemNote', () => {
  it('appends a 系统 message to the session and announces it like the chat path does (start, then done)', () => {
    const sent: { channel: string; payload: any }[] = []
    const appended: any[] = []
    const note = cuSystemNote({
      broadcast: (channel, payload) => sent.push({ channel, payload: payload as any }),
      appendMessage: (ws, sid, m) => appended.push({ ws, sid, m }),
      now: () => new Date('2026-11-13T08:09:10.000Z'),
    })
    note(A, '屏幕已锁定 · 电脑操作已关闭')
    expect(appended).toEqual([{ ws: '/w/a', sid: 's-a', m: { id: 'sys-1794557350000', who: 'ai', text: '屏幕已锁定 · 电脑操作已关闭', model: '系统', ts: '08:09:10' } }])
    expect(sent.map((s) => [s.channel, s.payload.type])).toEqual([[CH.chatEvent, 'assistant-start'], [CH.chatEvent, 'done']])
    expect(sent[1].payload).toMatchObject({ workspacePath: '/w/a', sessionId: 's-a', message: appended[0].m })
  })
})
