// ComputerUseService: the security core of computer use (spec §5, §6 T4/T5/T10, V3, V5, V6, V7g, V10, V12).
//
// - Modes live only in this module's Maps (R3). Nothing here reads or writes the persisted session store.
// - One session at a time holds ask/allow (R4).
// - Each enable mints a fresh token. off / stop / lock / forget revoke it, and a revoked token is never reissued.
// - A call needs a valid token, a mode that is on, and an open turn whose server-stamped origin is 'local' (R5, V12).
// - Gates are our own table. They know nothing of the session permission mode, so 完全访问 can't auto-allow them, and
//   nothing outside `resolve` with `by.local` can answer them (R12, V1).
// - Every call goes through one FIFO. The executor runs one call at a time, and the guarded driver it gets refuses to
//   post while any gate is pending or after its call was stopped (V6).
// - The only outlets are the injected `emit` (local sink), `note` (fixed sentences) and `stopTurn`.
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatSendPayload } from '@shared/types'
import { CU_ERR, type ComputerUseMode, type CuActionView, type CuErrCode, type Mod } from '@shared/computerUse'
import type { Settings } from '../config/schema'
import { forgeMcpConfigFile } from '../agents/mcpConfig'
import { CuDriverError, type ComputerDriver, type PostAction, type PostResult } from './driver'
import type { PermissionProbe } from './permissions'
import type {
  ActionLog, CallMeta, CuEvent, CuGate, CuOp, CuResult, CuSessionKey, Executor, GateDecision, ServiceInternals, StopWhy,
} from './types'
import { isCuOp } from './types'

export type { CuSessionKey, CuGate, CuEvent } from './types'

export const GATE_TIMEOUT_MS = 5 * 60_000
/** V5: a physical mouseDown / keyDown at most this long ago. */
export const PHYSICAL_WINDOW_S = 1.0
/** Outstanding calls (running + queued) across the service; one more is refused with rate_limited. Bounds the worst
 *  wait a caller can see, which the codex tool timeout is derived from (mcpConfig CU_TOOL_TIMEOUT_SEC). */
export const CU_QUEUE_MAX = 3

const NOTE: Partial<Record<StopWhy, string>> = {
  user: '电脑操作已停止',
  hotkey: '电脑操作已停止',
  lock: '屏幕已锁定 · 电脑操作已关闭',
  vision: '当前模型看不到截图 · 已关闭电脑操作',
  limit: '本次开启已执行 2000 步 · 已关闭电脑操作',
  // deleted: the session is gone, nowhere to write
}

type Origin = NonNullable<ChatSendPayload['origin']>
type SetModeResult =
  | { ok: true }
  | { ok: false; code: 'not_local' | 'busy' | 'unsupported' | 'restart_required' | 'no_physical' | 'stopped'; busy?: CuSessionKey & { title: string } }

export interface ComputerUseService {
  setMode(key: CuSessionKey, mode: ComputerUseMode, by: { local: boolean }): Promise<SetModeResult>
  modeOf(key: CuSessionKey): ComputerUseMode
  tokenFor(key: CuSessionKey): string | null
  /** origin undefined = an unstamped payload: non-local (V12) */
  beginTurn(key: CuSessionKey, origin: Origin | undefined): { tools: boolean }
  /** the sessions that are on, as in the `state` event */
  sessions(): { workspacePath: string; sessionId: string; mode: ComputerUseMode; title: string }[]
  endTurn(key: CuSessionKey): void
  handle(token: string, op: string, args: Record<string, unknown>, meta: CallMeta): Promise<CuResult>
  openGate(g: Omit<CuGate, 'id' | 'ts'>): Promise<GateDecision>
  resolve(id: string, decision: 'allow' | 'deny' | 'stop', by: { local: boolean }): Promise<boolean>
  pendingGates(): CuGate[]
  stop(key?: CuSessionKey, why?: StopWhy): void
  onLock(): void
  forget(key: CuSessionKey): void
}

export interface ComputerUseServiceDeps {
  driver: ComputerDriver
  probe: PermissionProbe
  now: () => number
  /** ≥16 chars of [A-Za-z0-9]; anything shorter or repeated falls back to crypto */
  random: () => string
  emit: (e: CuEvent) => void /* local sink only */
  note: (key: CuSessionKey, text: string) => void
  stopTurn: (key: CuSessionKey) => void
  titleOf: (key: CuSessionKey) => string
  settings: () => Settings['computerUse']
  ownPid: number
  ownAccelerators: () => string[]
  log: ActionLog
  executorFactory?: (svc: ServiceInternals) => Executor
  liveAgentChildren: () => { disclaimed: boolean }[]
  /** V5 / R18 switch: default false until 实测 20 shows our posts don't count as HID input */
  hidIsPhysical: () => boolean
  saveSettings: (patch: Partial<Settings['computerUse']>) => void
  /** the cu MCP config dir (Task 6); revoking a token deletes `mcp.<token>.json` there (V12) */
  configDir?: () => string | null
  setTimer?: (fn: () => void, ms: number) => () => void
}

/** The cu config dir holds `mcp.<token>.json` files: owner-only (V12). Tightens an existing dir too. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}

const err = (code: CuErrCode): CuResult => ({ ok: false, code, text: CU_ERR[code] })
const keyId = (k: CuSessionKey) => JSON.stringify([k.workspacePath, k.sessionId])
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const cryptoId = () => Array.from(randomBytes(16), (b) => B32[b & 31]).join('')

/** The mods / button an interrupted action may be holding down (V7g). */
function heldBy(a: PostAction): { mods: Mod[]; button?: 'left' | 'right' | 'middle' } {
  if (a.kind === 'click') return { mods: a.mods, button: a.button }
  if (a.kind === 'drag') return { mods: a.mods, button: a.button }
  if (a.kind === 'key') return { mods: a.mods }
  return { mods: [] }
}

const sameMods = (a: readonly Mod[] = [], b: readonly Mod[] = []) =>
  a.length === b.length && [...a].sort().join('+') === [...b].sort().join('+')

/**
 * M-1: does an approved CuActionView cover this post? Kind and payload must match (text, button, count, mods,
 * repeat, scroll amounts). Position is not compared: the view is in screenshot pixels for display, the post in
 * points, and where the event lands is pinned by the guard's expectPid / expectWindowId (R8, V7f).
 */
function viewCovers(v: CuActionView, a: PostAction): boolean {
  if (v.kind !== a.kind) return false
  switch (a.kind) {
    case 'click': return (v.button ?? 'left') === a.button && (v.count ?? 1) === a.count && sameMods(v.mods, a.mods)
    case 'drag': return (v.button ?? 'left') === a.button && sameMods(v.mods, a.mods)
    case 'scroll': return (v.dx ?? 0) === a.dx && (v.dy ?? 0) === a.dy
    case 'type': return v.text === a.text
    case 'key': return (v.repeat ?? 1) === a.repeat && (v.mods === undefined || sameMods(v.mods, a.mods))
    case 'move': return true
  }
}

/** What the executor gets: the driver minus `request` (a TCC prompt is the user's button, never the agent's, M-3). */
export type GuardedDriver = Omit<ComputerDriver, 'request'>

interface Sess { key: CuSessionKey; mode: Exclude<ComputerUseMode, 'off'>; token: string; enableSeq: number }
interface Turn { origin: Origin | undefined; seq: number }
interface Job {
  key: CuSessionKey; k: string; op: CuOp; args: unknown; meta: CallMeta
  enableSeq: number; turnSeq: number; settled: boolean; settle: (r: CuResult) => void
  /** the caller abandoned it (meta.signal) */
  abandoned: boolean
}
interface OpenGate { gate: CuGate; job: Job; done: (d: GateDecision) => void; cancel: () => void }
interface Ticket { job: Job; view: CuActionView }

export function createComputerUseService(d: ComputerUseServiceDeps): ComputerUseService {
  const sessions = new Map<string, Sess>()
  const tokens = new Map<string, CuSessionKey>()
  const issued = new Set<string>()
  const turns = new Map<string, Turn>()
  const gates = new Map<string, OpenGate>()
  const queue: Job[] = []
  let running: Job | null = null
  let inFlight: { action: PostAction; job: Job } | null = null
  let tickets: Ticket[] = []
  /** tokens whose first call already arrived: their mcp config file is gone (I-1) */
  const used = new Set<string>()
  let seq = 0
  /** I-2: bumped by every stop / lock / off / forget, so a setMode that awaited across one of them gives up */
  let epoch = 0
  const setTimer = d.setTimer ?? ((fn, ms) => {
    const h = setTimeout(fn, ms)
    h.unref?.()
    return () => clearTimeout(h)
  })

  const freshId = (prefix: string): string => {
    for (let i = 0; i < 4; i++) {
      let r = ''
      try { r = String(d.random()).replace(/[^A-Za-z0-9]/g, '').slice(0, 16) } catch { /* fall through */ }
      if (r.length === 16 && !issued.has(`${prefix}${r}`)) { issued.add(`${prefix}${r}`); return `${prefix}${r}` }
    }
    for (;;) {
      const id = `${prefix}${cryptoId()}`
      if (!issued.has(id)) { issued.add(id); return id }
    }
  }

  const modeOf = (key: CuSessionKey): ComputerUseMode => sessions.get(keyId(key))?.mode ?? 'off'
  const sessionList = () => [...sessions.values()].map((s) => ({ ...s.key, mode: s.mode as ComputerUseMode, title: d.titleOf(s.key) }))
  const emitState = () => d.emit({ type: 'state', sessions: sessionList() })

  // ── gates ──
  const finishGate = (id: string, decision: GateDecision): boolean => {
    const g = gates.get(id)
    if (!g) return false
    gates.delete(id)
    g.cancel()
    // M-1: an approved action gate leaves a one-shot ticket that only its own call can spend
    if (decision === 'allow' && g.gate.kind === 'action' && g.gate.action) tickets.push({ job: g.job, view: g.gate.action })
    d.emit({ type: 'gate-resolved', id, decision })
    g.done(decision)
    return true
  }
  const closeGatesOf = (k: string, decision: GateDecision) => {
    for (const [id, g] of [...gates]) if (keyId(g.gate.key) === k) finishGate(id, decision)
  }

  const physicalRecent = async (): Promise<boolean> => {
    try {
      const [m, kb] = await Promise.all([d.driver.idleSeconds('mouseDown'), d.driver.idleSeconds('keyDown')])
      const least = Math.min(m, kb)
      return Number.isFinite(least) && least >= 0 && least <= PHYSICAL_WINDOW_S
    } catch {
      return false
    }
  }

  // ── tokens ──
  const removeTokenFile = (token: string) => {
    const dir = d.configDir?.()
    if (!dir) return
    // the same name forgeMcpArgs wrote (hashed for cu tokens, I-1)
    try { rmSync(forgeMcpConfigFile(dir, token), { force: true }) } catch { /* best effort */ }
  }
  const revoke = (token: string) => {
    tokens.delete(token)
    used.delete(token)
    removeTokenFile(token)
  }

  // ── calls ──
  const cancelled = (job: Job): CuErrCode | null => {
    if (job.abandoned) return 'stopped'
    const s = sessions.get(job.k)
    if (!s || s.enableSeq !== job.enableSeq) return 'stopped'
    const t = turns.get(job.k)
    if (!t || t.seq !== job.turnSeq || t.origin !== 'local') return 'no_turn'
    return null
  }
  const settle = (job: Job, r: CuResult) => {
    if (job.settled) return
    job.settled = true
    job.settle(r)
  }

  /** V7g: SIGUSR1 first; the helper lifts what it holds. If it was killed, or the signal failed, release explicitly. */
  const abortInFlight = (k: string) => {
    if (!inFlight || inFlight.job.k !== k) return
    const held = heldBy(inFlight.action)
    const release = () => d.driver.release(held).catch(() => { /* the helper restarts on the next request */ })
    d.driver.abort().then((r) => (r === 'killed' ? release() : undefined), () => release())
  }

  /** Turn a session off: revoke, close its gates, drop its queued and running calls, abort its in-flight post. */
  const disable = (k: string, gateDecision: GateDecision): boolean => {
    const s = sessions.get(k)
    if (s) {
      sessions.delete(k)
      revoke(s.token)
    }
    closeGatesOf(k, gateDecision)
    for (const job of queue.filter((j) => j.k === k)) {
      queue.splice(queue.indexOf(job), 1)
      settle(job, err('stopped'))
    }
    if (running && running.k === k) settle(running, err('stopped'))
    abortInFlight(k)
    return !!s
  }

  /** The caller gave up on this one call: drop it if queued; if running, deny its gates and refuse its later posts.
   *  A post already in the helper finishes (no abort: that would hit the session, not the call); its result is dropped. */
  const abandon = (job: Job) => {
    if (job.settled) return
    job.abandoned = true
    const qi = queue.indexOf(job)
    if (qi >= 0) queue.splice(qi, 1)
    for (const [id, g] of [...gates]) if (g.job === job) finishGate(id, 'deny')
    settle(job, err('stopped'))
  }

  const refuseIfCancelled = () => {
    const job = running
    if (!job || job.settled || cancelled(job)) throw new CuDriverError('stopped')
  }
  const postRefusal = (job: Job | null): PostResult | null => {
    if (!job || job.settled || cancelled(job)) return { ok: false, code: 'stopped' }
    if (gates.size > 0) return { ok: false, code: 'target_changed' }
    return null
  }
  const ticketFor = (job: Job, a: PostAction) => tickets.findIndex((t) => t.job === job && viewCovers(t.view, a))

  const guarded: GuardedDriver = {
    status: () => d.driver.status(),
    capture: (o) => d.driver.capture(o),
    crop: (o) => d.driver.crop(o),
    hitTest: (p) => d.driver.hitTest(p),
    front: () => d.driver.front(),
    async post(a, g): Promise<PostResult> {
      const job = running
      const r0 = postRefusal(job)
      if (r0 || !job) return r0 ?? { ok: false, code: 'stopped' }
      // I-4: the screen is re-checked right before every post; any doubt refuses.
      let st
      try { st = await d.driver.status() } catch { st = null }
      const r1 = postRefusal(job)
      if (r1) return r1
      if (!st || st.locked || !st.onConsole || st.asleep) return { ok: false, code: 'locked' }
      // M-6 + M-1: re-read the mode now. In ask, anything but a move must spend a ticket from this call's approval.
      const mode = modeOf(job.key)
      const ti = ticketFor(job, a)
      if (mode === 'ask' && a.kind !== 'move' && ti < 0) return { ok: false, code: 'denied' }
      if (ti >= 0) tickets.splice(ti, 1)
      const mine = { action: a, job }
      inFlight = mine
      try {
        return await d.driver.post(a, g)
      } finally {
        if (inFlight === mine) inFlight = null
      }
    },
    async activate(pid) { refuseIfCancelled(); return d.driver.activate(pid) },
    async release(o) {
      // after a stop the service itself releases what the in-flight action held (abortInFlight)
      const job = running
      if (!job || job.settled || cancelled(job)) return
      return d.driver.release(o)
    },
    idleSeconds: (kind) => d.driver.idleSeconds(kind),
    runningApps: () => d.driver.runningApps(),
    abort: () => d.driver.abort(),
    kill: () => d.driver.kill(),
    dispose: () => { /* the service doesn't own the helper's lifetime */ },
  }

  const internals: ServiceInternals = {
    // typed as the full driver for Task 5's createExecutor; `request` is absent at runtime (M-3)
    driver: guarded as ComputerDriver,
    modeOf,
    turnSeq: (key) => {
      const t = turns.get(keyId(key))
      return t && t.origin === 'local' ? t.seq : 0
    },
    enableSeq: (key) => sessions.get(keyId(key))?.enableSeq ?? 0,
    openGate: (g) => svc.openGate(g),
    hasPendingGate: () => gates.size > 0,
    emitAction: (key, entry) => d.emit({ type: 'action', key: { ...key }, entry }),
    note: (key, text) => d.note(key, text),
    stop: (key, why) => svc.stop(key, why),
  }
  const executor: Executor = d.executorFactory
    ? d.executorFactory(internals)
    : { run: async () => err('unsupported') }

  const runJob = async (job: Job): Promise<CuResult> => {
    const c0 = cancelled(job)
    if (c0) return err(c0)
    // R16 / V10: a locked screen, another console user (fast user switching) or a sleeping display refuses outright.
    let st
    try { st = await d.driver.status() } catch { return err('helper_failed') }
    const c1 = cancelled(job)
    if (c1) return err(c1)
    if (st.locked || !st.onConsole || st.asleep) return err('locked')
    let r: CuResult
    try { r = await executor.run(job.key, job.op, job.args, job.meta) } catch { r = err('helper_failed') }
    const c2 = cancelled(job)
    return c2 ? err(c2) : r
  }

  const pump = async () => {
    if (running) return
    const job = queue.shift()
    if (!job) return
    running = job
    try {
      settle(job, await runJob(job))
    } finally {
      running = null
      tickets = tickets.filter((t) => t.job !== job)
      void pump()
    }
  }

  const svc: ComputerUseService = {
    async setMode(key, mode, by) {
      if (!by.local) return { ok: false, code: 'not_local' }
      const k = keyId(key)
      if (mode === 'off') {
        epoch++
        if (disable(k, 'deny')) emitState()
        return { ok: true }
      }
      // I-2: a stop / lock / off that lands during one of the awaits below wins over this call.
      const epoch0 = epoch
      const cur = modeOf(key)
      if (cur === mode) return { ok: true }
      const holder = () => [...sessions.values()].find((s) => keyId(s.key) !== k)
      if (cur === 'off') {
        let supported = false
        try { supported = (await d.probe.status()).supported } catch { supported = false }
        if (!supported) return { ok: false, code: 'unsupported' }
        const h = holder()
        if (h) return { ok: false, code: 'busy', busy: { ...h.key, title: d.titleOf(h.key) } }
        // V3: from now on agent CLIs spawn disclaimed. Persist first, so even a refused enable fixes the next start.
        if (!d.settings()?.provisioned) d.saveSettings({ provisioned: true })
        let undisclaimed = true
        try { undisclaimed = d.liveAgentChildren().some((c) => !c.disclaimed) } catch { undisclaimed = true }
        if (undisclaimed) return { ok: false, code: 'restart_required' }
      }
      // V5: off→on and ask→allow widen what the agent may do; both need a physical press when the switch is on.
      const widening = cur === 'off' || (cur === 'ask' && mode === 'allow')
      if (widening && d.hidIsPhysical() && !(await physicalRecent())) return { ok: false, code: 'no_physical' }
      if (epoch !== epoch0) return { ok: false, code: 'stopped' }
      // re-read after the awaits: another setMode may have run meanwhile
      const s = sessions.get(k)
      if (s) {
        s.mode = mode
      } else if (cur !== 'off') {
        return { ok: false, code: 'stopped' }   // never mint a session on the switch path
      } else {
        const h = holder()
        if (h) return { ok: false, code: 'busy', busy: { ...h.key, title: d.titleOf(h.key) } }
        const token = freshId('cu.')
        sessions.set(k, { key: { ...key }, mode, token, enableSeq: ++seq })
        tokens.set(token, { ...key })
      }
      emitState()
      return { ok: true }
    },

    modeOf,
    sessions: sessionList,
    tokenFor: (key) => sessions.get(keyId(key))?.token ?? null,

    beginTurn(key, origin) {
      turns.set(keyId(key), { origin, seq: ++seq })
      // the spawn path rewrites the token's config file every turn: the first call of each turn deletes it again
      const cur = sessions.get(keyId(key))
      if (cur) used.delete(cur.token)
      return { tools: origin === 'local' && modeOf(key) !== 'off' }
    },

    endTurn(key) {
      const k = keyId(key)
      turns.delete(k)
      // V16 ②: buildClaudeChatArgs rewrote mcp.cu-<hash>.json for this turn, and only a token's first call deletes it.
      // The CLI has long since read it, so it goes now; the next turn writes it again before spawning.
      const s = sessions.get(k)
      if (s) removeTokenFile(s.token)
      closeGatesOf(k, 'deny')
      abortInFlight(k)   // M-2: the turn is over, so is its action
    },

    async handle(token, op, args, meta) {
      const key = typeof token === 'string' ? tokens.get(token) : undefined
      if (!key) return err('not_enabled')
      const k = keyId(key)
      const s = sessions.get(k)
      if (!s || s.token !== token) return err('not_enabled')
      const t = turns.get(k)
      if (!t || t.origin !== 'local') return err('no_turn')
      if (!isCuOp(op)) return err('invalid_args')
      // I-1: the CLI has evidently loaded its MCP config, so the file holding the token goes now, not at revoke.
      if (!used.has(token)) { used.add(token); removeTokenFile(token) }
      const signal = meta?.signal
      if (signal?.aborted) return err('stopped')
      if (queue.length + (running ? 1 : 0) >= CU_QUEUE_MAX) return err('rate_limited')
      return new Promise<CuResult>((resolve) => {
        const job: Job = {
          key: { ...key }, k, op, args, meta: meta ?? {}, enableSeq: s.enableSeq, turnSeq: t.seq, settled: false, settle: resolve,
          abandoned: false,
        }
        signal?.addEventListener('abort', () => abandon(job), { once: true })
        queue.push(job)
        void pump()
      })
    },

    openGate(g) {
      const k = keyId(g.key)
      const t = turns.get(k)
      if (!sessions.has(k) || !t || t.origin !== 'local') return Promise.resolve('deny')
      // M-4: only the running call of this session, while it is still live, may ask
      const job = running
      if (!job || job.k !== k || job.settled || cancelled(job)) return Promise.resolve('deny')
      const gate: CuGate = { ...g, key: { ...g.key }, id: freshId('cug.'), ts: d.now() }
      return new Promise<GateDecision>((done) => {
        const cancel = setTimer(() => { finishGate(gate.id, 'timeout') }, GATE_TIMEOUT_MS)
        gates.set(gate.id, { gate, job, done, cancel })
        d.emit({ type: 'gate', gate })
      })
    },

    async resolve(id, decision, by) {
      if (!by.local) return false
      const g = gates.get(id)
      if (!g) return false
      const stale = () => d.now() - g.gate.ts >= GATE_TIMEOUT_MS
      if (stale()) { finishGate(id, 'timeout'); return false }
      if (decision === 'allow' && d.hidIsPhysical()) {
        if (!(await physicalRecent())) return false
        if (!gates.has(id)) return false
        if (stale()) { finishGate(id, 'timeout'); return false }
      }
      if (decision === 'stop') {
        finishGate(id, 'stop')
        svc.stop(g.gate.key, 'user')
        return true
      }
      return finishGate(id, decision)
    },

    pendingGates: () => [...gates.values()].map((g) => g.gate),

    stop(key, why = 'user') {
      epoch++
      const targets: CuSessionKey[] = key ? [key] : [...sessions.values()].map((s) => s.key)
      let changed = false
      for (const t of targets) {
        const wasOn = disable(keyId(t), 'stop')
        changed ||= wasOn
        d.stopTurn(t)
        if (wasOn) {
          d.emit({ type: 'stopped', key: { ...t }, why })
          const text = NOTE[why]
          if (text) d.note(t, text)
        }
      }
      if (changed) emitState()
    },

    onLock() { svc.stop(undefined, 'lock') },

    forget(key) {
      svc.stop(key, 'deleted')
      turns.delete(keyId(key))
    },
  }
  return svc
}
