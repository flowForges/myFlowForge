// What the desktop shell does with computer-use events (spec §5.7, §6 T4/T5/T10, §10.4, V2, V9, V10). No electron in
// here: index.ts hands in registry.broadcast, the overlay, the OS notifier and the tray / shortcut refresh.
//
// - Every event goes to `localBroadcast` (registry.broadcast: this machine's windows) and nowhere else. Never
//   hub.broadcast (remote sinks) and never router.localEvent (it drops events while the window views a remote host,
//   and then the overlay would be the only approval surface with nothing on it).
// - The OS notification for a new gate carries the kind label and nothing else: no typed text, no app name, no crop.
import { CU_KIND_LABEL, type CuOverlayGate, type CuOverlayState } from '@shared/computerUse'
import { CH } from '../ipc/channels'
import type { CuEvent, CuGate } from './types'

export const CU_POWER_EVENTS = ['lock-screen', 'suspend', 'user-did-resign-active', 'shutdown'] as const

/** V10: lock, sleep, fast user switching and shutdown all turn computer use off. */
export function attachPowerMonitor(pm: { on(event: string, fn: () => void): unknown }, onLock: () => void): void {
  for (const ev of CU_POWER_EVENTS) pm.on(ev, () => onLock())
}

export const cuTrayTitle = (active: boolean): string => (active ? '●' : '')
/** Prepended to the tray / Dock menu while any session is on. */
export function cuTrayMenuItems(active: boolean, stop: () => void): ({ label: string; click: () => void } | { type: 'separator' })[] {
  return active ? [{ label: '停止电脑操作', click: stop }, { type: 'separator' }] : []
}

export interface CuOverlayLike { show(s: CuOverlayState): void; hide(): void }

export interface CuShellDeps {
  localBroadcast: (channel: string, payload: unknown) => void
  overlay: CuOverlayLike
  notify: (n: { title: string; body: string }, onClick: () => void) => void
  /** main window unfocused and the user's notification switches allow it */
  shouldNotify: () => boolean
  /** any session went on / everything went off: tray title, menus, the stop hotkey */
  onActive: (active: boolean) => void
  /** the stop hotkey's target (runtime.stopAll) */
  stopAll: () => void
}

export interface CuShell {
  emit(e: CuEvent): void
  state(): CuOverlayState
  active(): boolean
  /** handlers for registerGlobalShortcuts: the stop hotkey exists only while a session is on */
  shortcutHandlers(): Record<string, () => void>
  /** the notification's click */
  reveal(): void
}

const gateView = (g: CuGate): CuOverlayGate => ({
  id: g.id, kind: g.kind,
  ...(g.action ? { action: g.action } : {}),
  ...(g.crop ? { crop: g.crop } : {}),
  ...(g.reason ? { reason: g.reason } : {}),
})

export function wireComputerUse(d: CuShellDeps): CuShell {
  let session: CuOverlayState['session'] = null
  let gates: CuGate[] = []
  let ownBlocked = false
  let actionSeq = 0
  let wasActive = false

  const state = (): CuOverlayState => ({
    session: session ? { ...session } : null,
    gate: gates.length ? gateView(gates[0]) : null,
    ownBlocked, actionSeq,
  })
  const render = () => {
    if (session) d.overlay.show(state())
    else d.overlay.hide()
  }
  const sameKey = (a: { workspacePath: string; sessionId: string }, b: { workspacePath: string; sessionId: string }) =>
    a.workspacePath === b.workspacePath && a.sessionId === b.sessionId

  const apply = (e: CuEvent) => {
    switch (e.type) {
      case 'state': {
        const s = e.sessions.find((x) => x.mode !== 'off')
        session = s ? { workspacePath: s.workspacePath, sessionId: s.sessionId, title: s.title, mode: s.mode as 'ask' | 'allow' } : null
        if (!session) { gates = []; ownBlocked = false }
        else gates = gates.filter((g) => sameKey(g.key, session!))
        break
      }
      case 'gate':
        gates.push(e.gate)
        if (d.shouldNotify()) {
          const kind = e.gate.kind === 'continue' ? 'continue' : e.gate.action?.kind
          d.notify({ title: '电脑操作待批准', body: kind ? CU_KIND_LABEL[kind] : CU_KIND_LABEL.continue }, () => render())
        }
        break
      case 'gate-resolved':
        gates = gates.filter((g) => g.id !== e.id)
        break
      case 'action':
        if (session && sameKey(e.key, session)) {
          ownBlocked = e.entry.code === 'own_window'
          actionSeq++
        }
        break
      case 'stopped':
        gates = e.key ? gates.filter((g) => !sameKey(g.key, e.key!)) : []
        break
    }
  }

  return {
    emit(e) {
      d.localBroadcast(CH.cuEvent, e)
      apply(e)
      const active = session !== null
      // render before onActive: the overlay is up by the time the hotkey / tray change
      if (e.type !== 'state' || active || wasActive) render()
      if (active !== wasActive) { wasActive = active; d.onActive(active) }
    },
    state,
    active: () => session !== null,
    shortcutHandlers: (): Record<string, () => void> => (session ? { 'computer-use-stop': () => d.stopAll() } : {}),
    reveal: render,
  }
}
