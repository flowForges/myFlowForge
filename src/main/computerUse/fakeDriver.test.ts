import { describe, it, expect } from 'vitest'
import { fakeDriver } from './fakeDriver'
import { unsupportedDriver, CuDriverError, type PostGuard } from './driver'

const guard: PostGuard = { denyPids: [1], denyBundlePrefixes: ['x'] }

describe('unsupportedDriver', () => {
  it('rejects every op with unsupported', async () => {
    const d = unsupportedDriver('platform')
    for (const p of [d.status(), d.capture({} as never), d.post({ kind: 'move', x: 1, y: 1 }, guard), d.abort(), d.runningApps()]) {
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
})
