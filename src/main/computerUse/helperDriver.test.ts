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
      // (8) the post that was in flight reports stopped, not helper_failed
      expect(await p).toEqual({ ok: false, code: 'stopped' })
    })

    it('(1) a stopped EVENT while a post is pending: SIGKILL the helper and resolve the post as stopped', async () => {
      // the race: SIGUSR1 landed after the post was written but before the helper began it
      vi.useFakeTimers()
      const { d, children } = setup()
      const p = d.post({ kind: 'click', x: 1, y: 1, button: 'left', count: 1, mods: [] }, guard)
      await flush()
      const ab = d.abort()
      children[0].reply({ event: 'stopped' })
      expect(await p).toEqual({ ok: false, code: 'stopped' })
      expect(children[0].kill).toHaveBeenCalledWith('SIGKILL')
      expect(await ab).toBe('killed')
      // a late reply from the dead child changes nothing; the next call runs on a fresh helper
      children[0].reply({ id: children[0].written()[0].id, ok: true })
      const n = d.idleSeconds()
      await flush()
      expect(children).toHaveLength(2)
      const w = children[1].written()
      expect(w.map((r: any) => r.op)).toEqual(['idle'])
      children[1].reply({ id: w[0].id, ok: true, seconds: 2 })
      expect(await n).toBe(2)
    })

    it('(1) after an idle abort the next request is preceded by clearAbort on the same helper', async () => {
      vi.useFakeTimers()
      const { d, children } = setup()
      const first = d.idleSeconds()
      await flush()
      children[0].reply({ id: children[0].written()[0].id, ok: true, seconds: 1 })
      await first
      const ab = d.abort()
      children[0].reply({ event: 'stopped' })
      expect(await ab).toBe('stopped')
      const p = d.post({ kind: 'move', x: 1, y: 1 }, guard)
      await flush()
      let w = children[0].written()
      expect(w.map((r: any) => r.op)).toEqual(['idle', 'clearAbort'])
      children[0].reply({ id: w[1].id, ok: true, wasAborted: true })
      await flush()
      w = children[0].written()
      expect(w.map((r: any) => r.op)).toEqual(['idle', 'clearAbort', 'post'])
      children[0].reply({ id: w[2].id, ok: true })
      expect(await p).toEqual({ ok: true })
      expect(children[0].kill).not.toHaveBeenCalledWith('SIGKILL')
    })

    it('with no running child resolves stopped without spawning', async () => {
      const { d, spawn } = setup()
      expect(await d.abort()).toBe('stopped')
      expect(spawn).not.toHaveBeenCalled()
    })
  })

  it('(7) a post that times out is followed by release{mods,button} on the respawned helper', async () => {
    vi.useFakeTimers()
    const { d, children } = setup()
    const p = d.post({ kind: 'click', x: 1, y: 1, button: 'right', count: 1, mods: ['cmd', 'shift'] }, guard)
    await flush()
    await vi.advanceTimersByTimeAsync(2000)
    expect(await p).toEqual({ ok: false, code: 'helper_failed' })
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL')
    await flush()
    expect(children).toHaveLength(2)
    expect(children[1].written()[0]).toMatchObject({ op: 'release', mods: ['cmd', 'shift'], button: 'right' })
  })

  it('(9) type text is made well-formed before it is sent (lone surrogates → U+FFFD)', async () => {
    vi.useFakeTimers()
    const { d, children } = setup()
    void d.post({ kind: 'type', text: 'a\uD800b\uDC00c😀' }, guard)
    await flush()
    expect(children[0].written()[0].action.text).toBe('a\uFFFDb\uFFFDc😀')
  })

  it('(9) an id-less error line fails the pending request', async () => {
    vi.useFakeTimers()
    const { d, children } = setup()
    const a = d.activate(5).catch((e) => e)
    await flush()
    children[0].reply({ ok: false, code: 'invalid_args', message: 'bad request' })
    expect(await a).toMatchObject({ code: 'invalid_args' })
    const p = d.post({ kind: 'move', x: 1, y: 1 }, guard)
    await flush()
    children[0].reply({ ok: false, code: 'invalid_args' })
    expect(await p).toEqual({ ok: false, code: 'helper_failed' })
  })

  it('(10) stdout is decoded as UTF-8 across chunk boundaries', async () => {
    vi.useFakeTimers()
    const { d, children } = setup()
    const p = d.front()
    await flush()
    const line = Buffer.from(JSON.stringify({ id: children[0].written()[0].id, ok: true, front: { pid: 3, layer: 0, name: '备忘录' } }) + '\n')
    const cut = line.indexOf(Buffer.from('忘')) + 1 // inside the multi-byte sequence
    children[0].stdout.write(line.subarray(0, cut))
    children[0].stdout.write(line.subarray(cut))
    expect(await p).toMatchObject({ name: '备忘录' })
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

    it('C: a refused caller logs its reason code, and a status call fails as helper_failed', async () => {
      vi.useFakeTimers()
      const log = vi.fn()
      const { d, children } = setup({ log })
      const p = d.status()
      await flush()
      const c = children[0]
      c.stderr.write('forge-cu: caller not allowed (self_responsible)\n')
      c.emit('exit', 2, null)
      await expect(p).rejects.toMatchObject({ code: 'helper_failed' })
      const all = log.mock.calls.map((x) => String(x[0]))
      expect(all).toContain('forge-cu refused: self_responsible')
      expect(all.some((m) => m.includes('caller not allowed (self_responsible)'))).toBe(false)
    })

    it('C: an unknown or path-carrying reason is logged as unknown, never echoed', async () => {
      vi.useFakeTimers()
      const log = vi.fn()
      const { d, children } = setup({ log })
      const p = d.status()
      await flush()
      const c = children[0]
      c.stderr.write('forge-cu: caller not allowed (/Users/x/y)\n')
      c.emit('exit', 2, null)
      await expect(p).rejects.toMatchObject({ code: 'helper_failed' })
      const all = log.mock.calls.map((x) => String(x[0]))
      expect(all).toContain('forge-cu refused: unknown')
      expect(all.join('\n')).not.toContain('/Users/x')
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

  describe('AX ref ops (T4)', () => {
    const instance = { pid: 7, start: '123.456' }
    const actGuard = { denyPids: [1], denyBundlePrefixes: ['com.zghua.myflowforge'], expectInstance: instance }

    it('snapshot sends the wire fields with the default deadlineMs and strips id/ok from the reply', async () => {
      vi.useFakeTimers()
      const { d, children } = setup()
      const p = d.snapshot({ app: { bundleId: 'com.a' }, mode: 'skeleton' })
      await flush()
      const req = children[0].written()[0]
      expect(req).toMatchObject({ op: 'snapshot', app: { bundleId: 'com.a' }, mode: 'skeleton', deadlineMs: 3000 })
      const result = { snapId: 's1', instance, app: { bundleId: 'com.a', name: 'A' }, window: {}, complete: true, nodes: [] }
      children[0].reply({ id: req.id, ok: true, ...result })
      expect(await p).toEqual(result)
    })

    it('snapshot passes an optional guard through untouched', async () => {
      vi.useFakeTimers()
      const { d, children } = setup()
      void d.snapshot({ app: { pid: 7 }, mode: 'full', guard: { denyPids: [1], denyBundlePrefixes: ['x'] } })
      await flush()
      expect(children[0].written()[0]).toMatchObject({ guard: { denyPids: [1], denyBundlePrefixes: ['x'] } })
    })

    it('resolve sends only {ref}', async () => {
      vi.useFakeTimers()
      const { d, children } = setup()
      const p = d.resolve('@s1:e2')
      await flush()
      expect(children[0].written()[0]).toMatchObject({ op: 'resolve', ref: '@s1:e2', deadlineMs: 3000 })
      children[0].reply({ id: children[0].written()[0].id, ok: true, instance, bundleId: 'com.a', appName: 'A', role: 'AXButton' })
      expect(await p).toEqual({ instance, bundleId: 'com.a', appName: 'A', role: 'AXButton' })
    })

    it('act sends the request with guard.expectInstance', async () => {
      vi.useFakeTimers()
      const { d, children } = setup()
      const p = d.act({ ref: '@s1:e2', action: 'click' }, actGuard)
      await flush()
      const req = children[0].written()[0]
      expect(req).toMatchObject({ op: 'act', ref: '@s1:e2', action: 'click', guard: { expectInstance: instance }, deadlineMs: 3000 })
      children[0].reply({ id: req.id, ok: true, delivery: 'delivered_verified', steps: [{ name: 'click', outcome: 'delivered_verified' }] })
      expect(await p).toEqual({ delivery: 'delivered_verified', steps: [{ name: 'click', outcome: 'delivered_verified' }] })
    })

    it('act error replies always carry delivery on the rejected CuDriverError', async () => {
      vi.useFakeTimers()
      const { d, children } = setup()
      const caught = d.act({ ref: '@s1:e2', action: 'click' }, actGuard).catch((e) => e)
      await flush()
      const req = children[0].written()[0]
      children[0].reply({ id: req.id, ok: false, code: 'target_changed', delivery: 'not_delivered' })
      const e = await caught
      expect(e).toMatchObject({ code: 'target_changed', delivery: 'not_delivered' })
    })

    it('an uncertain error reply rejects CuDriverError with delivery uncertain', async () => {
      vi.useFakeTimers()
      const { d, children } = setup()
      const caught = d.act({ ref: '@s1:e2', action: 'type', text: 'hi' }, actGuard).catch((e) => e)
      await flush()
      children[0].reply({ id: children[0].written()[0].id, ok: false, code: 'uncertain', delivery: 'uncertain' })
      const e = await caught
      expect(e).toMatchObject({ code: 'uncertain', delivery: 'uncertain' })
    })

    it('waitFor sends pid/match/gone/timeoutMs; deadlineMs defaults to timeoutMs', async () => {
      vi.useFakeTimers()
      const { d, children } = setup()
      const p = d.waitFor({ pid: 7, match: { role: 'AXButton' }, gone: false, timeoutMs: 8000 })
      await flush()
      expect(children[0].written()[0]).toMatchObject({ op: 'waitFor', pid: 7, match: { role: 'AXButton' }, gone: false, timeoutMs: 8000, deadlineMs: 8000 })
      children[0].reply({ id: children[0].written()[0].id, ok: true, found: true })
      expect(await p).toEqual({ found: true })
    })

    it('launch sends bundleId/activate with an optional guard', async () => {
      vi.useFakeTimers()
      const { d, children } = setup()
      const p = d.launch({ bundleId: 'com.a', activate: true })
      await flush()
      expect(children[0].written()[0]).toMatchObject({ op: 'launch', bundleId: 'com.a', activate: true, deadlineMs: 3000 })
      const result = { instance, bundleId: 'com.a', name: 'A', windows: [{ number: 1 }] }
      children[0].reply({ id: children[0].written()[0].id, ok: true, ...result })
      expect(await p).toEqual(result)
    })

    it('focusWindow sends pid/windowNumber', async () => {
      vi.useFakeTimers()
      const { d, children } = setup()
      const p = d.focusWindow({ pid: 7, windowNumber: 2 })
      await flush()
      expect(children[0].written()[0]).toMatchObject({ op: 'focusWindow', pid: 7, windowNumber: 2 })
      children[0].reply({ id: children[0].written()[0].id, ok: true })
      await expect(p).resolves.toBeUndefined()
    })

    it('windows sends an optional pid', async () => {
      vi.useFakeTimers()
      const { d, children } = setup()
      const p = d.windows({ pid: 7 })
      await flush()
      expect(children[0].written()[0]).toMatchObject({ op: 'windows', pid: 7 })
      children[0].reply({ id: children[0].written()[0].id, ok: true, windows: [{ pid: 7, number: 1 }] })
      expect(await p).toEqual({ windows: [{ pid: 7, number: 1 }] })
    })

    it('appKey sends pid/mods/key/repeat', async () => {
      vi.useFakeTimers()
      const { d, children } = setup()
      const p = d.appKey({ pid: 7, mods: ['cmd'], key: { char: 'w' }, repeat: 1 })
      await flush()
      expect(children[0].written()[0]).toMatchObject({ op: 'appKey', pid: 7, mods: ['cmd'], key: { char: 'w' }, repeat: 1 })
      children[0].reply({ id: children[0].written()[0].id, ok: true, via: 'pid', delivery: 'delivered_unverified' })
      expect(await p).toEqual({ via: 'pid', delivery: 'delivered_unverified' })
    })

    it('a11yRevert sends an empty body and returns reverted pids', async () => {
      vi.useFakeTimers()
      const { d, children } = setup()
      const p = d.a11yRevert()
      await flush()
      expect(children[0].written()[0]).toMatchObject({ op: 'a11yRevert' })
      children[0].reply({ id: children[0].written()[0].id, ok: true, reverted: [9] })
      expect(await p).toEqual({ reverted: [9] })
    })

    it('runningApps surfaces pid and active from the forge-cu appsReply', async () => {
      vi.useFakeTimers()
      const { d, children } = setup()
      const p = d.runningApps()
      await flush()
      children[0].reply({
        id: children[0].written()[0].id, ok: true,
        apps: [{ bundleId: 'com.a', name: 'A', pid: 7, active: true }],
      })
      expect(await p).toEqual([{ bundleId: 'com.a', name: 'A', pid: 7, active: true }])
    })

    describe('timeout aborts instead of kill', () => {
      it('a non-snapshot op TS-times out at deadlineMs + 1000: SIGUSR1, not SIGKILL', async () => {
        vi.useFakeTimers()
        const { d, children } = setup()
        void d.resolve('@s1:e2').catch(() => {})
        await flush()
        await vi.advanceTimersByTimeAsync(3999) // deadlineMs(3000, default) + 1000 - 1
        expect(children[0].kill).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(children[0].kill).toHaveBeenCalledWith('SIGUSR1')
        expect(children[0].kill).not.toHaveBeenCalledWith('SIGKILL')
      })

      it('snapshot TS-times out at deadlineMs + 4000 (not +1000)', async () => {
        vi.useFakeTimers()
        const { d, children } = setup()
        void d.snapshot({ app: { bundleId: 'com.a' }, mode: 'skeleton', deadlineMs: 3000 }).catch(() => {})
        await flush()
        await vi.advanceTimersByTimeAsync(6999) // 3000 + 4000 - 1: still nothing
        expect(children[0].kill).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1) // hits 7000: abort, not kill
        expect(children[0].kill).toHaveBeenCalledWith('SIGUSR1')
        expect(children[0].kill).not.toHaveBeenCalledWith('SIGKILL')
      })

      it('a stopped reply inside the 2000 ms grace resolves the op as stopped, never kills', async () => {
        vi.useFakeTimers()
        const { d, children } = setup()
        const caught = d.snapshot({ app: { bundleId: 'com.a' }, mode: 'skeleton' }).catch((e) => e)
        await flush()
        await vi.advanceTimersByTimeAsync(7000)
        expect(children[0].kill).toHaveBeenCalledWith('SIGUSR1')
        await vi.advanceTimersByTimeAsync(1999) // inside the 2000 ms grace
        children[0].reply({ id: children[0].written()[0].id, ok: false, code: 'stopped' })
        expect(await caught).toMatchObject({ code: 'stopped' })
        expect(children[0].kill).not.toHaveBeenCalledWith('SIGKILL')
      })

      it('no reply for 2000 ms more after the abort: kill and reject helper_failed; refs survive the next call', async () => {
        vi.useFakeTimers()
        const { d, spawn, children } = setup()
        const caught = d.snapshot({ app: { bundleId: 'com.a' }, mode: 'skeleton' }).catch((e) => e)
        await flush()
        await vi.advanceTimersByTimeAsync(7000)
        expect(children[0].kill).toHaveBeenCalledWith('SIGUSR1')
        await vi.advanceTimersByTimeAsync(1999)
        expect(children[0].kill).not.toHaveBeenCalledWith('SIGKILL')
        await vi.advanceTimersByTimeAsync(1)
        expect(children[0].kill).toHaveBeenCalledWith('SIGKILL')
        expect(await caught).toMatchObject({ code: 'helper_failed' })
        const q = d.idleSeconds()
        await flush()
        expect(spawn).toHaveBeenCalledTimes(2)
        children[1].reply({ id: children[1].written()[0].id, ok: true, seconds: 1 })
        expect(await q).toBe(1)
      })

      it('a normal reply that lands after the soft timeout but inside the grace resolves normally (no kill)', async () => {
        vi.useFakeTimers()
        const { d, children } = setup()
        const p = d.resolve('@s1:e2')
        await flush()
        const req = children[0].written()[0]
        await vi.advanceTimersByTimeAsync(4000) // soft timeout: SIGUSR1 sent
        expect(children[0].kill).toHaveBeenCalledWith('SIGUSR1')
        await vi.advanceTimersByTimeAsync(1500) // still inside the 2000 ms grace
        children[0].reply({ id: req.id, ok: true, instance, bundleId: 'com.a', appName: 'A', role: 'AXButton' })
        expect(await p).toEqual({ instance, bundleId: 'com.a', appName: 'A', role: 'AXButton' })
        expect(children[0].kill).not.toHaveBeenCalledWith('SIGKILL')
      })
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
