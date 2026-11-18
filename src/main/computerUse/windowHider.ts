// myFlowForge steps aside during computer use (spec §9.1, §9.3). No electron in here: index.ts hands in the windows
// (every app window except the cu-overlay), runtime.ts the front check and the activation.
//
// - Before the first mutating action of a turn (semantic act or physical post): hide() every visible window except the
//   pet, remember which, and if we are still the front app ask forge-cu to focus the target, so the front leaves us.
//   Hidden and front-moved are separate latches: a first call without a target (computer_launch) hides but can't move
//   the front, so a later call in the same turn that carries a target, while we are still front, activates it (once).
// - restore(): showInactive() only the windows we hid (never activates), then forget them.
// - The user reopening a window we hid (Dock click, the overlay's 打开主窗口) ends auto-hide until the next turn, and
//   that window is no longer ours to restore. Show events caused by restore() itself are not a reopen.
// - `live()` (the computer-use turn is still on): checked before hiding and again before activating, so a call that
//   resumes after the turn ended / was stopped (and its restore ran) can neither hide again nor move the front.
//   A restore while the front check is pending also cancels the activation.
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
  /** the turn that may step aside is still live; absent → always */
  live?: () => boolean
}): WindowHider {
  /** the windows we hid and have not restored */
  const hidden = new Set<number>()
  /** we stepped aside since the last turn start / restore */
  let aside = false
  /** the front left us (or we asked the target to take it) since the last turn start / restore */
  let frontMoved = false
  /** the user reopened a window this turn: no more auto-hide */
  let userShown = false
  let restoring = false
  /** bumped by every restore: a beforeMutation that awaited across one gives up */
  let gen = 0
  const isLive = () => { try { return o.live ? o.live() : true } catch { return false } }

  const list = (): HideableWin[] => { try { return o.windows() } catch { return [] } }

  return {
    async beforeMutation(target) {
      if (userShown || !isLive()) return
      const g = gen
      if (!aside) {
        aside = true
        for (const w of list()) {
          if (w.isPet) continue
          try {
            if (!w.isVisible()) continue
            w.hide()
            hidden.add(w.id)
          } catch { /* destroyed meanwhile */ }
        }
      } else if (frontMoved || !target) {
        return
      }
      let front: boolean | null = null
      try { front = await o.isOwnAppFront() } catch { front = null }
      if (g !== gen || !isLive() || front === null) return
      if (!front) { frontMoved = true; return }
      // no target (launch, a coordinate tool): nothing to activate yet; the next call with a target tries again
      if (target) frontMoved = true
      try { await o.activateAway(target) } catch { /* semantic actions don't need the front */ }
    },

    restore() {
      gen++
      aside = false
      frontMoved = false
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
      frontMoved = false
    },
  }
}
