import { globalShortcut as electronGlobalShortcut } from 'electron'
import { GLOBAL_ACTIONS, effectiveBindings } from '../../shared/keybindings'

// Minimal slice of Electron's globalShortcut we depend on — lets tests inject a fake.
export interface GlobalShortcutApi {
  register(accelerator: string, callback: () => void): boolean
  unregisterAll(): void
}

export type GlobalHandlers = Record<string, () => void>

// Register the OS-level (scope==='global') shortcuts for the current effective bindings. Always clears
// prior registrations first (idempotent — safe to call again whenever settings change). Any accelerator
// the OS refuses (already owned by another app / the system) is collected into `failed` so the settings
// pane can flag it. Actions without a binding or without a handler are skipped.
export function registerGlobalShortcuts(
  overrides: Record<string, string>,
  handlers: GlobalHandlers,
  gs: GlobalShortcutApi = electronGlobalShortcut,
): { failed: string[] } {
  gs.unregisterAll()
  const eff = effectiveBindings(overrides)
  const failed: string[] = []
  for (const a of GLOBAL_ACTIONS) {
    const accel = eff[a.id]
    const handler = handlers[a.id]
    if (!accel || !handler) continue
    let ok = false
    try { ok = gs.register(accel, handler) } catch { ok = false }
    if (!ok) failed.push(a.id)
  }
  return { failed }
}

export function unregisterGlobalShortcuts(gs: GlobalShortcutApi = electronGlobalShortcut): void {
  gs.unregisterAll()
}
