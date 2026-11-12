import { describe, it, expect, vi, afterEach } from 'vitest'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import * as cp from 'node:child_process'
import { helperDriver, type ChildLike } from './helperDriver'
import { createDriver } from './driver'

// The real child_process.spawn must stay unreachable: every driver below gets an injected spawn.
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>()
  return { ...real, spawn: vi.fn(() => { throw new Error('real spawn called') }) }
})

type Fake = ChildLike & {
  stdin: PassThrough; stdout: PassThrough; stderr: PassThrough
  kill: ReturnType<typeof vi.fn>; emit: (ev: string, ...a: unknown[]) => boolean; written: () => any[]; reply: (o: unknown) => void; stdinEnded: () => boolean
}

function fakeChild(): Fake {
  const ee = new EventEmitter()
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
  let data = ''
  stdin.on('data', (b) => { data += b.toString() })
  const kill = vi.fn((sig?: string) => { if (sig !== 'SIGUSR1') queueMicrotask(() => ee.emit('exit', null, sig ?? 'SIGTERM')); return true })
  return Object.assign(ee, {
    stdin, stdout, stderr, kill, pid: 4242,
    written: () => data.split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    reply: (o: unknown) => { stdout.write(JSON.stringify(o) + '\n') },
    stdinEnded: () => stdin.writableEnded,
  }) as unknown as Fake
}

const flush = () => vi.advanceTimersByTimeAsync(0)
const guard = { denyPids: [1], denyBundlePrefixes: ['com.zghua.myflowforge'] }

function setup(o: { log?: (m: string) => void } = {}) {
  const children: Fake[] = []
  const spawn = vi.fn((_exe: string, _args: string[], _opts: Record<string, unknown>) => { const c = fakeChild(); children.push(c); return c })
  const d = helperDriver({ helperPath: () => '/x/forge-cu', ownerPid: 99, spawn, ...o })
  return { d, spawn, children }
}

afterEach(() => { vi.useRealTimers() })

describe('helperDriver', () => {
  it('is lazy and spawns [path, --owner-pid, pid] on first call', async () => {
    vi.useFakeTimers()
    const { d, spawn, children } = setup()
    expect(spawn).not.toHaveBeenCalled()
    const p = d.idleSeconds()
    await flush()
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0].slice(0, 2)).toEqual(['/x/forge-cu', ['--owner-pid', '99']])
    const [req] = children[0].written()
    expect(req).toMatchObject({ op: 'idle' })
    children[0].reply({ id: req.id, ok: true, seconds: 3 })
    expect(await p).toBe(3)
    expect(cp.spawn).not.toHaveBeenCalled()
  })

  it('correlates responses by id regardless of order of garbage and unknown ids', async () => {
    vi.useFakeTimers()
    const { d, children } = setup()
    const p = d.front()
    await flush()
    const c = children[0]
    c.stdout.write('not json at all\n')
    c.reply({ id: 'zzz', ok: true, front: { pid: 1, layer: 0 } })
    c.reply({ id: c.written()[0].id, ok: true, front: { pid: 7, layer: 0 } })
    expect(await p).toEqual({ pid: 7, layer: 0 })
  })

  it('serialises concurrent calls: second request is written only after the first answers', async () => {
    vi.useFakeTimers()
    const { d, children } = setup()
    const a = d.hitTest({ x: 1, y: 2 })
    const b = d.front()
    await flush()
    const c = children[0]
    expect(c.written()).toHaveLength(1)
    expect(c.written()[0]).toMatchObject({ op: 'hitTest', xPt: 1, yPt: 2 })
    c.reply({ id: c.written()[0].id, ok: true, hit: null })
    expect(await a).toBeNull()
    await flush()
    expect(c.written()).toHaveLength(2)
    c.reply({ id: c.written()[1].id, ok: true, front: null })
    expect(await b).toBeNull()
  })

  it('times out: kills the child, rejects helper_failed, respawns on the next call', async () => {
    vi.useFakeTimers()
    const { d, spawn, children } = setup()
    const p = d.status()
    const caught = p.catch((e) => e)
    await flush()
    await vi.advanceTimersByTimeAsync(2000)
    expect(await caught).toMatchObject({ code: 'helper_failed' })
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL')
    const q = d.idleSeconds()
    await flush()
    expect(spawn).toHaveBeenCalledTimes(2)
    children[1].reply({ id: children[1].written()[0].id, ok: true, seconds: 1 })
    expect(await q).toBe(1)
  })

  it('capture gets the longer timeout', async () => {
    vi.useFakeTimers()
    const { d, children } = setup()
    const caught = d.capture({ maxW: 1, maxH: 1, quality: 1, maskPids: [], maskBundlePrefixes: [] }).catch((e) => e)
    await flush()
    await vi.advanceTimersByTimeAsync(4999)
    expect(children[0].kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await caught).toMatchObject({ code: 'helper_failed' })
  })

  it('post: timeout and child exit give {ok:false, helper_failed} instead of throwing', async () => {
    vi.useFakeTimers()
    const { d, children } = setup()
    const p = d.post({ kind: 'move', x: 1, y: 1 }, guard)
    await flush()
    children[0].emit('exit', 1, null)
    expect(await p).toEqual({ ok: false, code: 'helper_failed' })
  })

  it('post passes the action and guard, and relays target_changed with typed', async () => {
    vi.useFakeTimers()
    const { d, children } = setup()
    const p = d.post({ kind: 'type', text: 'abc' }, { ...guard, expectPid: 5 })
    await flush()
    const req = children[0].written()[0]
    expect(req).toMatchObject({ op: 'post', action: { kind: 'type', text: 'abc' }, guard: { expectPid: 5, denyPids: [1] } })
    children[0].reply({ id: req.id, ok: false, code: 'target_changed', typed: 2 })
    expect(await p).toEqual({ ok: false, code: 'target_changed', typed: 2 })
  })

  it('maps helper errors to CuDriverError with the helper code', async () => {
    vi.useFakeTimers()
    const { d, children } = setup()
    const p = d.activate(5)
    const caught = p.catch((e) => e)
    await flush()
    children[0].reply({ id: children[0].written()[0].id, ok: false, code: 'no_permission', message: 'nope' })
    expect(await caught).toMatchObject({ code: 'no_permission' })
  })

  it('crop uses the rectPt wire field', async () => {
    vi.useFakeTimers()
    const { d, children } = setup()
    const p = d.crop({ rectPt: { x: 1, y: 2, w: 3, h: 4 }, marker: [{ x: 1, y: 1 }], maskPids: [], maskBundlePrefixes: [] })
    await flush()
    const req = children[0].written()[0]
    expect(req).toMatchObject({ op: 'crop', rectPt: { x: 1, y: 2, w: 3, h: 4 } })
    children[0].reply({ id: req.id, ok: true, jpegBase64: 'a', sig: 'b' })
    expect(await p).toEqual({ jpegBase64: 'a', sig: 'b' })
  })

  describe('abort', () => {
    it('sends SIGUSR1 and resolves stopped when the child answers', async () => {
      vi.useFakeTimers()
      const { d, children } = setup()
      const p = d.post({ kind: 'type', text: 'x' }, guard)
      await flush()
      const c = children[0]
      const ab = d.abort()
      expect(c.kill).toHaveBeenCalledWith('SIGUSR1')
      c.reply({ id: c.written()[0].id, ok: false, code: 'stopped' })
      expect(await ab).toBe('stopped')
      expect(await p).toEqual({ ok: false, code: 'stopped' })
      expect(c.kill).not.toHaveBeenCalledWith('SIGKILL')
    })

    it('resolves stopped on an unsolicited stopped event', async () => {
      vi.useFakeTimers()
      const { d, children } = setup()
      const p = d.idleSeconds().catch(() => 0)
      await flush()
      const ab = d.abort()
      children[0].reply({ event: 'stopped' })
      expect(await ab).toBe('stopped')
      children[0].reply({ id: children[0].written()[0].id, ok: true, seconds: 1 })
      await p
    })

    it('SIGKILLs after 300 ms of silence and resolves killed', async () => {
      vi.useFakeTimers()
      const { d, children } = setup()
      const p = d.post({ kind: 'move', x: 1, y: 1 }, guard)
      await flush()
      const ab = d.abort()
      await vi.advanceTimersByTimeAsync(299)
      expect(children[0].kill).not.toHaveBeenCalledWith('SIGKILL')
      await vi.advanceTimersByTimeAsync(1)
      expect(await ab).toBe('killed')
      expect(children[0].kill).toHaveBeenCalledWith('SIGKILL')
      expect(await p).toMatchObject({ ok: false })
    })

    it('with no running child resolves stopped without spawning', async () => {
      const { d, spawn } = setup()
      expect(await d.abort()).toBe('stopped')
      expect(spawn).not.toHaveBeenCalled()
    })
  })

  it('kill() SIGKILLs now and the next call respawns', async () => {
    vi.useFakeTimers()
    const { d, spawn, children } = setup()
    const p = d.idleSeconds().catch((e) => e)
    await flush()
    d.kill()
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL')
    expect(await p).toMatchObject({ code: 'helper_failed' })
    d.idleSeconds().catch(() => {})
    await flush()
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('dispose closes stdin and rejects later calls', async () => {
    vi.useFakeTimers()
    const { d, children } = setup()
    const p = d.idleSeconds()
    await flush()
    children[0].reply({ id: children[0].written()[0].id, ok: true, seconds: 1 })
    await p
    d.dispose()
    expect(children[0].stdinEnded()).toBe(true)
    await expect(d.idleSeconds()).rejects.toMatchObject({ code: 'helper_failed' })
  })

  it('helperPath() null rejects helper_failed without spawning', async () => {
    const spawn = vi.fn()
    const d = helperDriver({ helperPath: () => null, ownerPid: 1, spawn })
    await expect(d.status()).rejects.toMatchObject({ code: 'helper_failed' })
    expect(spawn).not.toHaveBeenCalled()
  })

  describe('logging', () => {
    it('typed text never reaches the log, stderr is truncated to 200 chars', async () => {
      vi.useFakeTimers()
      const log = vi.fn()
      const { d, children } = setup({ log })
      const p = d.post({ kind: 'type', text: 'hunter2-secret' }, guard)
      await flush()
      const c = children[0]
      c.stderr.write('E'.repeat(500) + '\n')
      c.reply({ id: c.written()[0].id, ok: false, code: 'target_changed', message: 'typed hunter2-secret', typed: 1 })
      await p
      await flush()
      const all = log.mock.calls.map((x) => String(x[0]))
      expect(all.join('\n')).not.toContain('hunter2')
      const err = all.find((m) => m.includes('EEEE'))!
      expect(err.replace(/^[^E]*/, '').length).toBeLessThanOrEqual(200)
    })

    it('typed text is not logged on timeout either', async () => {
      vi.useFakeTimers()
      const log = vi.fn()
      const { d } = setup({ log })
      const p = d.post({ kind: 'type', text: 'hunter2-secret' }, guard)
      await flush()
      await vi.advanceTimersByTimeAsync(10_000)
      await p
      expect(log.mock.calls.map((x) => String(x[0])).join('\n')).not.toContain('hunter2')
    })
  })
})

describe('createDriver', () => {
  it('darwin builds a helper driver (lazy, injected spawn); others are unsupported', async () => {
    const spawn = vi.fn()
    const d = createDriver('darwin', { helperPath: () => '/x', ownerPid: 1, spawn })
    expect(spawn).not.toHaveBeenCalled()
    d.dispose()
    for (const pl of ['win32', 'linux'] as const) {
      await expect(createDriver(pl, { helperPath: () => '/x', ownerPid: 1, spawn }).status()).rejects.toMatchObject({ code: 'unsupported' })
    }
    expect(spawn).not.toHaveBeenCalled()
  })
})
