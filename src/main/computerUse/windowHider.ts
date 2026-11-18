// myFlowForge steps aside during computer use (spec §9.1, §9.3). No electron in here: index.ts hands in the windows
// (every app window except the cu-overlay), runtime.ts the front check and the activation.
//
// - Before the first mutating action of a turn (semantic act or physical post): hide() every visible window except the
//   pet, remember which, and if we are still the front app ask forge-cu to focus the target, so the front leaves us.
// - restore(): showInactive() only the windows we hid (never activates), then forget them.
// - The user reopening a window we hid (Dock click, the overlay's 打开主窗口) ends auto-hide until the next turn, and
//   that window is no longer ours to restore. Show events caused by restore() itself are not a reopen.
import type { Instance } from '@shared/computerUse'

export interface HideableWin { id: number; isVisible(): boolean; hide(): void; showInactive(): void; isPet: boolean }

export interface WindowHider {
  beforeMutation(target?: Instance): Promise<void>
  restore(): void
  onUserShow(winId: number): void
  turnStarted(): void
}

export function createWindowHider(o: {
  windows: () => HideableWin[]
  isOwnAppFront: () => Promise<boolean>
  /** focus the target instance (no target → no-op) */
  activateAway: (target?: Instance) => Promise<void>
}): WindowHider {
  /** the windows we hid and have not restored */
  const hidden = new Set<number>()
  /** we stepped aside since the last turn start / restore */
  let aside = false
  /** the user reopened a window this turn: no more auto-hide */
  let userShown = false
  let restoring = false

  const list = (): HideableWin[] => { try { return o.windows() } catch { return [] } }

  return {
    async beforeMutation(target) {
      if (aside || userShown) return
      aside = true
      for (const w of list()) {
        if (w.isPet) continue
        try {
          if (!w.isVisible()) continue
          w.hide()
          hidden.add(w.id)
        } catch { /* destroyed meanwhile */ }
      }
      let front = false
      try { front = await o.isOwnAppFront() } catch { front = false }
      if (front) { try { await o.activateAway(target) } catch { /* semantic actions don't need the front */ } }
    },

    restore() {
      aside = false
      if (!hidden.size) return
      const ids = new Set(hidden)
      hidden.clear()
      restoring = true
      try {
        for (const w of list()) {
          if (!ids.has(w.id)) continue
          try { w.showInactive() } catch { /* destroyed meanwhile */ }
        }
      } finally {
        restoring = false
      }
    },

    onUserShow(winId) {
      if (restoring || !aside) return
      userShown = true
      hidden.delete(winId)
    },

    turnStarted() {
      userShown = false
      aside = false
    },
  }
}
