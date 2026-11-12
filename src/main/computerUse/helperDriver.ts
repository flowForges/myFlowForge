import type { Readable, Writable } from 'node:stream'
import type { Mod } from '@shared/computerUse'
import {
  CuDriverError, type Button, type CaptureOpts, type CaptureResult, type ComputerDriver, type CropOpts,
  type DriverStatus, type PostAction, type PostGuard, type PostResult, type Pt, type WinHit,
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
}

const ABORT_GRACE_MS = 300
const POST_CODES = new Set(['target_changed', 'helper_failed', 'stopped'])

/** Lone surrogates → U+FFFD (String.prototype.toWellFormed, without needing the ES2024 lib). */
export function wellFormed(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
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
    if (m.code === 'stopped') settleAbort('stopped')
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
        if (line) log(`forge-cu: ${line.slice(0, 200)}`)
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
      const timer = setTimeout(() => {
        log(`forge-cu timeout (${op})`)
        killChild()
      }, timeoutMs)
      pending = { id, op, timer, resolve, reject }
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
    if (r.ok === false) throw new CuDriverError(String(r.code ?? 'helper_failed'), typeof r.message === 'string' ? r.message : undefined)
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
    async runningApps() { return (await strict('apps')).apps as { bundleId: string; name: string }[] },
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
