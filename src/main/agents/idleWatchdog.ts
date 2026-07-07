// A per-turn INACTIVITY watchdog for headless chat subprocesses.
//
// Why: codex/opencode chat used a hard `timeout: 180_000` (total wall-clock). A long user input makes
// the model read + reason longer, so a perfectly healthy turn crosses 180s and gets killed with zero
// output → "chat 无回复". That's wrong: a turn that is actively streaming (or thinking) should never be
// killed just for taking a while. This watchdog instead fires only after `idleMs` of NO output at all —
// so a progressing turn lives indefinitely, while a genuinely wedged one is still cleaned up.
//
// Pure/injectable timers so it's unit-testable without real time.
export interface IdleWatchdog {
  /** Call on every stdout/stderr chunk (any byte = alive) to reset the countdown. */
  beat(): void
  /** Stop the watchdog (call on process exit). Idempotent. */
  clear(): void
  /** True once the watchdog has fired (the turn was killed for inactivity). */
  get firedFlag(): boolean
}

export function makeIdleWatchdog(
  idleMs: number,
  onIdle: () => void,
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
): IdleWatchdog {
  let handle: unknown = null
  let fired = false
  let done = false
  const arm = () => { handle = timers.set(() => { if (done) return; fired = true; done = true; onIdle() }, idleMs) }
  const disarm = () => { if (handle != null) { timers.clear(handle); handle = null } }
  arm()
  return {
    beat() { if (done) return; disarm(); arm() },
    clear() { done = true; disarm() },
    get firedFlag() { return fired },
  }
}

// 4 minutes of TOTAL silence. Generous enough that a long input's read/reason phase (or a slow
// first token) never trips it, while a truly hung turn is still reclaimed.
export const CHAT_IDLE_MS = 240_000
