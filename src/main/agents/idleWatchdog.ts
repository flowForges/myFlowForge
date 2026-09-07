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
  /**
   * Suspend the countdown while the turn is legitimately blocked on a HUMAN (a confirm/input gate).
   * Waiting for the user is not a wedge — in a real terminal claude/codex wait indefinitely — so the
   * inactivity timer must not fire and kill the turn (which wasted the run or applied a default). No-op
   * once fired/cleared. Pair every pause() with a resume() (use try/finally so an error still resumes).
   */
  pause(): void
  /** Re-arm the countdown after a pause (the user answered). No-op if already fired/cleared/not paused. */
  resume(): void
  /** Stop the watchdog (call on process exit). Idempotent. */
  clear(): void
  /** True once the watchdog has fired (the turn was killed for inactivity). */
  get firedFlag(): boolean
}

/**
 * 静默之后怎么收场。
 *
 * ★★不传 `stall` = 老行为:`onIdle` 就是终局(通常是杀进程)。留给**无人值守**的场景 ——
 *  daemon、手机端没人盯着,那里自动回收是对的。
 * ★★传了 `stall` = 静默先**报告**(`onIdle`),过了 `hardMs` 还是没动静才 `onDeadline`。
 *  这是给有人看着的会话用的:静默是有歧义的(可能在算,也可能在等一个我们看不见的人 ——
 *  外部钩子、浏览器 OAuth、sudo 密码、git 凭据、MCP elicitation),而我们原来对每一种歧义
 *  都选了最不可逆的解释:无声 SIGTERM。2026-09-07 用户就是这么撞上的 ——
 *  他装的 PermissionRequest 钩子超时是 24 小时,我们 4 分钟就杀,两个数字差 360 倍。
 *  报告之后只要**来了任何一个字节**,硬上限就撤掉,这一轮当没事发生。
 */
export interface StallPolicy {
  hardMs: number
  onDeadline: () => void
}

export function makeIdleWatchdog(
  idleMs: number,
  onIdle: () => void,
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
  stall?: StallPolicy,
): IdleWatchdog {
  let handle: unknown = null
  let hardHandle: unknown = null
  let fired = false
  let done = false
  let paused = false
  const disarmHard = () => { if (hardHandle !== null) { timers.clear(hardHandle); hardHandle = null } }
  const arm = () => {
    handle = timers.set(() => {
      if (done) return
      fired = true
      handle = null
      // 老契约:没有 stall 策略时,onIdle 就是终局,不再武装任何东西。
      if (!stall) { done = true; onIdle(); return }
      // 有 stall 策略:报告,并开始数硬上限。**不置 done** —— 之后来了字节要能撤销、要能再报一次。
      disarmHard()
      hardHandle = timers.set(() => { if (done) return; done = true; hardHandle = null; stall.onDeadline() }, stall.hardMs)
      onIdle()
    }, idleMs)
  }
  const disarm = () => { if (handle != null) { timers.clear(handle); handle = null } }
  arm()
  return {
    // While paused (awaiting a human), swallow beats so a stray late chunk doesn't secretly re-arm the
    // countdown mid-gate; resume() is the only thing that re-arms.
    // ★来了字节 → 连**硬上限**一起撤掉:报告之后又活过来了,这一轮就当没事发生过。
    beat() { if (done || paused) return; disarmHard(); disarm(); arm() },
    pause() { if (done) return; paused = true; disarmHard(); disarm() },
    resume() { if (done || !paused) return; paused = false; arm() },
    clear() { done = true; disarmHard(); disarm() },
    get firedFlag() { return fired },
  }
}

// 4 minutes of TOTAL silence. Generous enough that a long input's read/reason phase (or a slow
// first token) never trips it, while a truly hung turn is still reclaimed.
/**
 * 静默多久之后**动手**(不是报告)。★和 CHAT_IDLE_MS 的分工:4 分钟没动静先说一声,
 * 半小时还是没动静才回收。用户装的钩子超时可以长到 24 小时,所以「4 分钟就杀」必然撞车;
 * 但真卡死的进程也不能永远挂着,所以留这条硬上限。
 */
export const CHAT_STALL_KILL_MS = 30 * 60_000
export const CHAT_IDLE_MS = 240_000
