import type { Readable, Writable } from 'node:stream'
import type { Mod } from '@shared/computerUse'
import {
  CuDriverError, type ActGuard, type ActRequest, type ActResult, type AppKeyOpts, type AppKeyResult,
  type Button, type CaptureOpts, type CaptureResult, type ComputerDriver, type CropOpts, type Delivery,
  type DriverStatus, type FocusWindowOpts, type LaunchOpts, type LaunchResult, type PostAction, type PostGuard,
  type PostResult, type Pt, type ResolveResult, type SnapshotOpts, type SnapshotResult, type WaitForOpts,
  type WaitForResult, type WinHit, type WindowsOpts, type WindowsResult,
} from './driver'

/** The slice of a ChildProcess the driver uses. Injected so tests never start a real helper. */
export interface ChildLike {
  stdin: Pick<Writable, 'write' | 'end' | 'on'>
  stdout: Pick<Readable, 'on'> & { setEncoding?: (e: BufferEncoding) => unknown }
  stderr: (Pick<Readable, 'on'> & { setEncoding?: (e: BufferEncoding) => unknown }) | null
  kill(signal?: NodeJS.Signals | number): boolean
  on(ev: 'exit' | 'error', cb: (...a: any[]) => void): unknown
}
export type SpawnLike = (exe: string, args: string[], opts: Record<string, unknown>) => ChildLike

interface Pending {
  id: string
  op: string
  timer: ReturnType<typeof setTimeout>
  resolve: (r: Record<string, any>) => void
  reject: (e: CuDriverError) => void
  /** this request's own TS timeout sent the SIGUSR1 that produced a `stopped` reply — rename it to `timeout`
   *  before resolving so the caller can't mistake our own watchdog abort for a user emergency stop. */
  softAborted?: boolean
}

/** Wire fields `strict()` would otherwise drop on an error reply; carried on `CuDriverError.extra` for Task 6. */
const ERROR_EXTRA_KEYS = ['steps', 'physical_delivery_started', 'candidates', 'via', 'typed'] as const

const ABORT_GRACE_MS = 300
const POST_CODES = new Set(['target_changed', 'helper_failed', 'stopped'])

// ───────────────────────── AX ref ops (T4): TS-side timeout / abort-before-kill ─────────────────────────
// Ruling R6: default deadlineMs 3000; TS per-op timeout = deadlineMs + 1000, except snapshot = deadlineMs + 4000
// (Electron activation may extend the helper's own deadline by ≤3 s). On a TS timeout the driver sends SIGUSR1
// (abort) instead of killing — it waits for the helper's `stopped` reply; only after SOFT_KILL_GRACE_MS more with
// no reply does it kill + let the next call respawn, exactly like a v1 (hard) timeout.
export const DEFAULT_DEADLINE_MS = 3000
const SOFT_KILL_GRACE_MS = 2000
/** ops that go through the soft (abort-first) timeout path instead of the v1 immediate-kill path. */
const SOFT_OPS = new Set(['snapshot', 'resolve', 'act', 'waitFor', 'launch', 'focusWindow', 'windows', 'appKey', 'a11yRevert'])
function tsTimeoutFor(op: string, deadlineMs: number): number {
  return deadlineMs + (op === 'snapshot' ? 4000 : 1000)
}

/** Lone surrogates → U+FFFD (String.prototype.toWellFormed, without needing the ES2024 lib). */
export function wellFormed(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
}

/** The caller-check codes forge-cu prints (Core.swift callerRefusal). Anything else is `unknown`: never echoed. */
const REFUSAL_CODES = new Set(['owner_mismatch', 'parent_not_app', 'no_spi', 'self_responsible', 'responsible_mismatch'])
export function refusalCode(line: string): string {
  const m = /\(([a-z_]+)\)\s*$/.exec(line)
  return m && REFUSAL_CODES.has(m[1]) ? m[1] : 'unknown'
}

/** What a post may leave pressed if the helper died mid-way. */
function heldBy(a: PostAction): { mods: Mod[]; button?: Button } | null {
  if (a.kind === 'click') return { mods: a.mods, button: a.button }
  if (a.kind === 'drag') return { mods: a.mods, button: a.button }
  if (a.kind === 'key') return a.mods.length ? { mods: a.mods } : null
  return null
}

export function helperDriver(o: {
  helperPath: () => string | null
  ownerPid: number
  spawn: SpawnLike
  timeouts?: { capture: number; other: number }
  log?: (m: string) => void
}): ComputerDriver {
  const timeouts = o.timeouts ?? { capture: 5000, other: 2000 }
  const log = o.log ?? (() => {})
  let child: ChildLike | null = null
  let pending: Pending | null = null
  let chain: Promise<unknown> = Promise.resolve()
  let seq = 0
  let disposed = false
  let aborting = false
  let abortWaiters: ((r: 'stopped' | 'killed') => void)[] = []
  let abortTimer: ReturnType<typeof setTimeout> | null = null
  /** The helper latches an abort until told otherwise; the next request must clear it first. */
  let needClear = false

  const settleAbort = (r: 'stopped' | 'killed') => {
    if (abortTimer) { clearTimeout(abortTimer); abortTimer = null }
    if (r === 'stopped' && child) needClear = true
    const ws = abortWaiters; abortWaiters = []
    aborting = false
    for (const w of ws) w(r)
  }

  const failPending = (e: CuDriverError) => {
    const p = pending
    if (!p) return
    pending = null
    clearTimeout(p.timer)
    p.reject(e)
  }

  const onLine = (line: string) => {
    let m: any
    try { m = JSON.parse(line) } catch { return }
    if (!m || typeof m !== 'object') return
    if (m.event === 'stopped') {
      const p = pending
      if (p && p.op === 'post') {
        // The helper was idle when SIGUSR1 landed, yet a post is in flight: the signal raced the post's
        // write. Never let that post run — kill the helper and report the post as stopped.
        pending = null
        clearTimeout(p.timer)
        p.resolve({ ok: false, code: 'stopped' })
        killChild('stopped')
        settleAbort('killed')
        return
      }
      settleAbort('stopped')
      return
    }
    const p = pending
    if (!p) return
    // an id-less error answers whatever is in flight (a line the helper couldn't parse or that was too long)
    if (m.id === undefined && m.ok === false) {
      pending = null
      clearTimeout(p.timer)
      p.resolve(m)
      return
    }
    if (m.id !== p.id) return
    pending = null
    clearTimeout(p.timer)
    if (m.code === 'stopped') {
      settleAbort('stopped')
      // the helper is answering a SIGUSR1 *we* sent for a TS timeout, not a user's emergency stop — rename it
      // so callers (the service's stop handling in particular) don't treat a slow op as a session stop.
      if (p.softAborted) m.code = 'timeout'
    }
    p.resolve(m)
  }

  const ensureChild = (): ChildLike => {
    if (disposed) throw new CuDriverError('helper_failed', 'disposed')
    if (child) return child
    const path = o.helperPath()
    if (!path) throw new CuDriverError('helper_failed', 'helper missing')
    const c = o.spawn(path, ['--owner-pid', String(o.ownerPid)], { stdio: ['pipe', 'pipe', 'pipe'] })
    child = c
    needClear = false // a fresh helper has nothing latched
    c.stdout.setEncoding?.('utf8')
    c.stderr?.setEncoding?.('utf8')
    let buf = ''
    c.stdout.on('data', (b: Buffer | string) => {
      buf += b.toString()
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line) onLine(line)
      }
    })
    let ebuf = ''
    c.stderr?.on('data', (b: Buffer | string) => {
      ebuf += b.toString()
      let i: number
      while ((i = ebuf.indexOf('\n')) >= 0) {
        const line = ebuf.slice(0, i).trim()
        ebuf = ebuf.slice(i + 1)
        if (!line) continue
        const refused = /^forge-cu: caller not allowed\b/.test(line) ? refusalCode(line) : null
        log(refused ? `forge-cu refused: ${refused}` : `forge-cu: ${line.slice(0, 200)}`)
      }
    })
    c.stdin.on('error', () => {})
    c.on('error', () => { if (child === c) drop(c, 'error') })
    c.on('exit', () => { if (child === c) drop(c, 'exit') })
    return c
  }

  /** The child is gone (or declared dead): reject what is in flight; the next call respawns. */
  const drop = (c: ChildLike, why: string) => {
    if (child === c) child = null
    log(`forge-cu ${why}`)
    failPending(new CuDriverError('helper_failed', why))
    if (aborting) settleAbort('killed')
  }

  const killChild = (code: 'helper_failed' | 'stopped' = 'helper_failed') => {
    const c = child
    if (!c) return
    child = null
    try { c.kill('SIGKILL') } catch { /* already gone */ }
    failPending(new CuDriverError(code, 'killed'))
    if (aborting) settleAbort('killed')
  }

  const run = (op: string, body: Record<string, unknown>, timeoutMs: number): Promise<Record<string, any>> =>
    new Promise((resolve, reject) => {
      let c: ChildLike
      try { c = ensureChild() } catch (e) { reject(e); return }
      const id = `r${++seq}`
      const soft = SOFT_OPS.has(op)
      const p: Pending = { id, op, timer: undefined as unknown as ReturnType<typeof setTimeout>, resolve, reject }
      const onTimeout = () => {
        if (pending !== p) return // already answered / failed
        if (!soft) {
          log(`forge-cu timeout (${op})`)
          killChild()
          return
        }
        // R6: a timed-out AX op aborts the helper (refs survive) instead of killing it outright.
        log(`forge-cu soft timeout (${op}): aborting instead of killing`)
        try { c.kill('SIGUSR1') } catch { /* already gone */ }
        p.softAborted = true
        // The helper latches the abort flag whether or not it got to emit anything (e.g. mid-`beginPost`
        // when the signal landed) — the next request must clear it first, or it wrongly answers `stopped`.
        needClear = true
        p.timer = setTimeout(() => {
          if (pending !== p) return
          log(`forge-cu timeout (${op}): no reply after the abort, killing`)
          killChild()
        }, SOFT_KILL_GRACE_MS)
      }
      p.timer = setTimeout(onTimeout, timeoutMs)
      pending = p
      try {
        c.stdin.write(JSON.stringify({ id, op, ...body }) + '\n')
      } catch {
        killChild()
      }
    })

  /** One request in flight at a time. */
  const call = (op: string, body: Record<string, unknown> = {}, timeoutMs = timeouts.other): Promise<Record<string, any>> => {
    const next = chain.then(async () => {
      if (needClear && child) {
        needClear = false
        await run('clearAbort', {}, timeouts.other).catch(() => {})
      }
      return run(op, body, timeoutMs)
    })
    chain = next.catch(() => {})
    return next
  }

  const strict = async (op: string, body?: Record<string, unknown>, t?: number) => {
    const r = await call(op, body, t)
    if (r.ok === false) {
      // wire extras: act errors always carry `delivery` (uncertain / not_delivered / …); surfaced on the error.
      const delivery = typeof r.delivery === 'string' ? (r.delivery as Delivery) : undefined
      const extra: Record<string, unknown> = {}
      for (const k of ERROR_EXTRA_KEYS) if (r[k] !== undefined) extra[k] = r[k]
      throw new CuDriverError(
        String(r.code ?? 'helper_failed'), typeof r.message === 'string' ? r.message : undefined, delivery,
        Object.keys(extra).length ? extra : undefined,
      )
    }
    return r
  }

  return {
    async status() { const { id: _i, ok: _o, ...s } = await strict('status'); return s as unknown as DriverStatus },
    async request(kind) { await strict('request', { kind }) },
    async capture(c: CaptureOpts) {
      const { id: _i, ok: _o, ...r } = await strict('capture', { ...c }, timeouts.capture)
      return r as unknown as CaptureResult
    },
    async crop(c: CropOpts) {
      const r = await strict('crop', { ...c }, timeouts.capture)
      return { jpegBase64: r.jpegBase64 as string, sig: r.sig as string }
    },
    async hitTest(p: Pt): Promise<WinHit | null> { return (await strict('hitTest', { xPt: p.x, yPt: p.y })).hit ?? null },
    async front(): Promise<WinHit | null> { return (await strict('front')).front ?? null },
    async post(action: PostAction, guard: PostGuard): Promise<PostResult> {
      // long text takes longer to type: 20 units per ~8 ms chunk, with slack
      const extra = action.kind === 'type' ? action.text.length * 2 : 0
      const wire = action.kind === 'type' ? { ...action, text: wellFormed(action.text) } : action
      try {
        const r = await call('post', { action: wire, guard }, timeouts.other + extra)
        if (r.ok === false) {
          const code = POST_CODES.has(r.code) ? r.code : 'helper_failed'
          return { ok: false, code, ...(typeof r.typed === 'number' ? { typed: r.typed } : {}) } as PostResult
        }
        return { ok: true }
      } catch (e) {
        if ((e instanceof CuDriverError && e.code === 'stopped') || aborting) return { ok: false, code: 'stopped' }
        // timed out or died mid-post: whatever it pressed may still be down — lift it on the next helper
        const held = heldBy(action)
        if (held && !disposed) void call('release', { ...held }).catch(() => {})
        return { ok: false, code: 'helper_failed' }
      }
    },
    async activate(pid: number) { await strict('activate', { pid }) },
    async release(r: { mods: Mod[]; button?: Button }) { await strict('release', { ...r }) },
    async idleSeconds(kind = 'any') { return (await strict('idle', { kind })).seconds as number },
    async runningApps() {
      return (await strict('apps')).apps as { bundleId: string; name: string; pid: number; active: boolean }[]
    },
    async snapshot(o: SnapshotOpts): Promise<SnapshotResult> {
      const { deadlineMs = DEFAULT_DEADLINE_MS, ...rest } = o
      const { id: _i, ok: _o, ...r } = await strict('snapshot', { ...rest, deadlineMs }, tsTimeoutFor('snapshot', deadlineMs))
      return r as unknown as SnapshotResult
    },
    async resolve(ref: string): Promise<ResolveResult> {
      const deadlineMs = DEFAULT_DEADLINE_MS
      const { id: _i, ok: _o, ...r } = await strict('resolve', { ref, deadlineMs }, tsTimeoutFor('resolve', deadlineMs))
      return r as unknown as ResolveResult
    },
    async act(req: ActRequest, guard: ActGuard): Promise<ActResult> {
      const deadlineMs = DEFAULT_DEADLINE_MS
      try {
        const { id: _i, ok: _o, code: _c, ...r } = await strict('act', { ...req, guard, deadlineMs }, tsTimeoutFor('act', deadlineMs))
        return r as unknown as ActResult
      } catch (e) {
        // the helper never got to answer at all (killed after the abort grace, exited, disposed): no wire
        // reply means no delivery, but act's contract is that every error carries one — nothing was confirmed
        // delivered, so the safe default is `uncertain`, never left undefined.
        if (e instanceof CuDriverError && e.delivery === undefined) throw new CuDriverError(e.code, e.message, 'uncertain', e.extra)
        throw e
      }
    },
    async waitFor(o: WaitForOpts): Promise<WaitForResult> {
      const timeoutMs = o.timeoutMs ?? 5000
      const deadlineMs = Math.max(o.deadlineMs ?? DEFAULT_DEADLINE_MS, timeoutMs)
      const { deadlineMs: _d, timeoutMs: _t, ...rest } = o
      const { id: _i, ok: _o, ...r } =
        await strict('waitFor', { ...rest, timeoutMs, deadlineMs }, tsTimeoutFor('waitFor', deadlineMs))
      return r as unknown as WaitForResult
    },
    async launch(o: LaunchOpts): Promise<LaunchResult> {
      const { deadlineMs = DEFAULT_DEADLINE_MS, ...rest } = o
      const { id: _i, ok: _o, ...r } = await strict('launch', { ...rest, deadlineMs }, tsTimeoutFor('launch', deadlineMs))
      return r as unknown as LaunchResult
    },
    async focusWindow(o: FocusWindowOpts): Promise<void> {
      const { deadlineMs = DEFAULT_DEADLINE_MS, ...rest } = o
      await strict('focusWindow', { ...rest, deadlineMs }, tsTimeoutFor('focusWindow', deadlineMs))
    },
    async windows(o: WindowsOpts = {}): Promise<WindowsResult> {
      const { deadlineMs = DEFAULT_DEADLINE_MS, ...rest } = o
      const { id: _i, ok: _o, ...r } = await strict('windows', { ...rest, deadlineMs }, tsTimeoutFor('windows', deadlineMs))
      return r as unknown as WindowsResult
    },
    async appKey(o: AppKeyOpts): Promise<AppKeyResult> {
      const { deadlineMs = DEFAULT_DEADLINE_MS, ...rest } = o
      const { id: _i, ok: _o, ...r } = await strict('appKey', { ...rest, deadlineMs }, tsTimeoutFor('appKey', deadlineMs))
      return r as unknown as AppKeyResult
    },
    async a11yRevert(): Promise<{ reverted: number[] }> {
      const deadlineMs = DEFAULT_DEADLINE_MS
      const r = await strict('a11yRevert', {}, tsTimeoutFor('a11yRevert', deadlineMs))
      return { reverted: r.reverted as number[] }
    },
    abort() {
      const c = child
      if (!c) return Promise.resolve('stopped' as const)
      return new Promise<'stopped' | 'killed'>((resolve) => {
        abortWaiters.push(resolve)
        if (aborting) return
        aborting = true
        try { c.kill('SIGUSR1') } catch { /* gone */ }
        abortTimer = setTimeout(() => { abortTimer = null; killChild('stopped'); settleAbort('killed') }, ABORT_GRACE_MS)
      })
    },
    kill() { killChild() },
    dispose() {
      disposed = true
      const c = child
      child = null
      failPending(new CuDriverError('helper_failed', 'disposed'))
      if (c) { try { c.stdin.end() } catch { /* ignore */ } }
    },
  }
}
