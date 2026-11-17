import { describe, it, expect } from 'vitest'
import { fakeDriver, type AxApp } from './fakeDriver'
import { unsupportedDriver, CuDriverError, type ActGuard, type Instance, type PostGuard } from './driver'

const guard: PostGuard = { denyPids: [1], denyBundlePrefixes: ['x'] }
const instance: Instance = { pid: 11, start: '1.0' }
const actGuard: ActGuard = { denyPids: [1], denyBundlePrefixes: ['x'], expectInstance: instance }

describe('unsupportedDriver', () => {
  it('rejects every op with unsupported', async () => {
    const d = unsupportedDriver('platform')
    for (const p of [
      d.status(), d.capture({} as never), d.post({ kind: 'move', x: 1, y: 1 }, guard), d.abort(), d.runningApps(),
      d.snapshot({ app: { bundleId: 'com.a' }, mode: 'skeleton' }), d.resolve('@s1:e1'),
      d.act({ ref: '@s1:e1', action: 'click' }, actGuard), d.waitFor({ pid: 1, match: { role: 'x' } }),
      d.launch({ activate: true }), d.focusWindow({ pid: 1 }), d.windows({}), d.appKey({ pid: 1, mods: [], key: { char: 'a' }, repeat: 1 }),
      d.a11yRevert(),
    ]) {
      await expect(p).rejects.toMatchObject({ code: 'unsupported' })
      await expect(p).rejects.toBeInstanceOf(CuDriverError)
    }
    expect(() => { d.kill(); d.dispose() }).not.toThrow()
  })
})

describe('fakeDriver', () => {
  it('records posts, captures, activations, released and kill', async () => {
    const d = fakeDriver()
    expect(await d.post({ kind: 'type', text: 'hi' }, guard)).toEqual({ ok: true })
    await d.capture({ maxW: 1, maxH: 1, quality: 1, maskPids: [], maskBundlePrefixes: [] })
    await d.activate(7)
    await d.release({ mods: ['cmd'] })
    d.kill()
    expect(d.posts).toEqual([{ action: { kind: 'type', text: 'hi' }, guard }])
    expect(d.captures).toHaveLength(1)
    expect(d.activations).toEqual([7])
    expect(d.released).toEqual([{ mods: ['cmd'] }])
    expect(d.killed).toBe(1)
  })

  it('setters drive status, front, hit map, idle and post result', async () => {
    const d = fakeDriver()
    d.setStatus({ locked: true })
    expect((await d.status()).locked).toBe(true)
    d.setFront({ pid: 5, layer: 0 })
    expect((await d.front())?.pid).toBe(5)
    d.setHitMap([{ rect: { x: 0, y: 0, w: 10, h: 10 }, hit: { pid: 9, layer: 0 } }])
    expect((await d.hitTest({ x: 5, y: 5 }))?.pid).toBe(9)
    expect(await d.hitTest({ x: 50, y: 5 })).toBeNull()
    d.setIdle(12)
    expect(await d.idleSeconds()).toBe(12)
    d.setPostResult({ ok: false, code: 'target_changed' })
    expect(await d.post({ kind: 'move', x: 1, y: 1 }, guard)).toEqual({ ok: false, code: 'target_changed' })
  })

  describe('AX world (T4)', () => {
    const app: AxApp = {
      instance, bundleId: 'com.a', name: 'A', windows: [{ number: 1, title: 'Main' }],
      tree: [{ ref: 'e1', depth: 0, role: 'AXButton', name: 'OK', states: [], actions: ['AXPress'] }],
    }

    it('snapshot qualifies local refs with the snapId and records the call', async () => {
      const d = fakeDriver({ ax: { apps: [app] } })
      const s = await d.snapshot({ app: { bundleId: 'com.a' }, mode: 'skeleton' })
      expect(s.instance).toEqual(instance)
      expect(s.nodes).toEqual([{ ref: `@${s.snapId}:e1`, depth: 0, role: 'AXButton', name: 'OK', states: [], actions: ['AXPress'] }])
      expect(d.snapshots).toEqual([{ app: { bundleId: 'com.a' }, mode: 'skeleton' }])
    })

    it('snapshot of an unknown app rejects not_found', async () => {
      const d = fakeDriver()
      await expect(d.snapshot({ app: { bundleId: 'com.x' }, mode: 'skeleton' })).rejects.toMatchObject({ code: 'not_found' })
    })

    it('resolve looks the node back up by its qualified ref', async () => {
      const d = fakeDriver({ ax: { apps: [app] } })
      const s = await d.snapshot({ app: { pid: 11 }, mode: 'skeleton' })
      const ref = s.nodes[0].ref!
      expect(await d.resolve(ref)).toEqual({ instance, bundleId: 'com.a', appName: 'A', role: 'AXButton', name: 'OK', bounds: undefined })
      expect(d.resolves).toEqual([ref])
    })

    it('resolve of a ref from a different fake driver (or a made-up one) rejects stale_ref', async () => {
      const d = fakeDriver({ ax: { apps: [app] } })
      await expect(d.resolve('@s999:e1')).rejects.toMatchObject({ code: 'stale_ref' })
    })

    it('act returns the scripted ActResult and records ref/action/guard', async () => {
      const d = fakeDriver({ ax: { apps: [app] }, actResult: { delivery: 'delivered_without_effect', steps: [] } })
      const s = await d.snapshot({ app: { bundleId: 'com.a' }, mode: 'skeleton' })
      const ref = s.nodes[0].ref!
      const r = await d.act({ ref, action: 'click' }, actGuard)
      expect(r).toEqual({ delivery: 'delivered_without_effect', steps: [] })
      expect(d.acts).toEqual([{ req: { ref, action: 'click' }, guard: actGuard }])
    })

    it('act on an unknown/made-up ref rejects stale_ref with delivery not_delivered', async () => {
      const d = fakeDriver({ ax: { apps: [app] } })
      await expect(d.act({ ref: '@s999:e1', action: 'click' }, actGuard)).rejects.toMatchObject({ code: 'stale_ref', delivery: 'not_delivered' })
    })

    it('act rejects target_changed when guard.expectInstance no longer matches the world', async () => {
      const d = fakeDriver({ ax: { apps: [app] } })
      const s = await d.snapshot({ app: { bundleId: 'com.a' }, mode: 'skeleton' })
      const ref = s.nodes[0].ref!
      const staleGuard: ActGuard = { ...actGuard, expectInstance: { pid: 11, start: '2.0' } } // app relaunched since
      await expect(d.act({ ref, action: 'click' }, staleGuard)).rejects.toMatchObject({ code: 'target_changed', delivery: 'not_delivered' })
    })

    it('act can be scripted to reject with a code/delivery via setActError', async () => {
      const d = fakeDriver({ ax: { apps: [app] } })
      const s = await d.snapshot({ app: { bundleId: 'com.a' }, mode: 'skeleton' })
      const ref = s.nodes[0].ref!
      d.setActError({ code: 'secure_input', delivery: 'not_delivered' })
      await expect(d.act({ ref, action: 'type', text: 'x' }, actGuard)).rejects.toMatchObject({ code: 'secure_input', delivery: 'not_delivered' })
      d.setActError(null)
      await expect(d.act({ ref, action: 'click' }, actGuard)).resolves.toMatchObject({ delivery: 'delivered_verified' })
    })

    it('waitFor returns the scripted result and records the call', async () => {
      const d = fakeDriver({ waitForResult: { found: false } })
      const r = await d.waitFor({ pid: 11, match: { role: 'AXButton' } })
      expect(r).toEqual({ found: false })
      expect(d.waitFors).toEqual([{ pid: 11, match: { role: 'AXButton' } }])
    })

    it('launch resolves an app in the AX world by bundleId', async () => {
      const d = fakeDriver({ ax: { apps: [app] } })
      const r = await d.launch({ bundleId: 'com.a', activate: true })
      expect(r).toEqual({ instance, bundleId: 'com.a', name: 'A', windows: [{ number: 1, title: 'Main' }] })
      expect(d.launches).toEqual([{ bundleId: 'com.a', activate: true }])
    })

    it('launch of an unknown bundle rejects not_found', async () => {
      const d = fakeDriver()
      await expect(d.launch({ bundleId: 'com.x', activate: true })).rejects.toMatchObject({ code: 'not_found' })
    })

    it('focusWindow records the call and rejects not_found for an unknown pid', async () => {
      const d = fakeDriver({ ax: { apps: [app] } })
      await expect(d.focusWindow({ pid: 11 })).resolves.toBeUndefined()
      await expect(d.focusWindow({ pid: 999 })).rejects.toMatchObject({ code: 'not_found' })
      expect(d.focusWindows).toEqual([{ pid: 11 }, { pid: 999 }])
    })

    it('windows lists the AX world, filterable by pid', async () => {
      const d = fakeDriver({ ax: { apps: [app] } })
      expect(await d.windows({})).toEqual({ windows: [{ number: 1, title: 'Main', pid: 11, bundleId: 'com.a', name: 'A' }] })
      expect(await d.windows({ pid: 999 })).toEqual({ windows: [] })
      expect(d.windowsCalls).toEqual([{}, { pid: 999 }])
    })

    it('appKey returns the scripted result and records the call', async () => {
      const d = fakeDriver({ appKeyResult: { via: 'menu', delivery: 'delivered_verified' } })
      const r = await d.appKey({ pid: 11, mods: ['cmd'], key: { char: 'w' }, repeat: 1 })
      expect(r).toEqual({ via: 'menu', delivery: 'delivered_verified' })
      expect(d.appKeys).toEqual([{ pid: 11, mods: ['cmd'], key: { char: 'w' }, repeat: 1 }])
    })

    it('a11yRevert reverts every AX-world pid and counts calls', async () => {
      const d = fakeDriver({ ax: { apps: [app] } })
      expect(await d.a11yRevert()).toEqual({ reverted: [11] })
      expect(d.a11yReverts).toBe(1)
    })

    it('setAxApps swaps the world for later calls', async () => {
      const d = fakeDriver()
      await expect(d.snapshot({ app: { bundleId: 'com.a' }, mode: 'skeleton' })).rejects.toMatchObject({ code: 'not_found' })
      d.setAxApps([app])
      await expect(d.snapshot({ app: { bundleId: 'com.a' }, mode: 'skeleton' })).resolves.toMatchObject({ app: { bundleId: 'com.a' } })
    })
  })
})
