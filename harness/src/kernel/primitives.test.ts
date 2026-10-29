import { describe, expect, it } from 'vitest'
import { EffectScope } from './effects'
import { EventBus } from './events'
import { ServiceRegistry } from './services'

describe('ServiceRegistry', () => {
  it('whenReady resolves only after all keys provided', async () => {
    const r = new ServiceRegistry()
    let done = false
    const p = r.whenReady(['a', 'b']).then(() => { done = true })
    r.provide('a', 1)
    await Promise.resolve()
    expect(done).toBe(false)
    r.provide('b', 2)
    await p
    expect(done).toBe(true)
  })
  it('whenReady with empty keys resolves immediately', async () => {
    await new ServiceRegistry().whenReady([])
  })
  it('duplicate provide throws', () => {
    const r = new ServiceRegistry()
    r.provide('a', 1)
    expect(() => r.provide('a', 2)).toThrow()
  })
  it('disposer removes the service and allows re-provide', () => {
    const r = new ServiceRegistry()
    const off = r.provide('a', 1)
    expect(r.get('a')).toBe(1)
    off()
    expect(r.get('a')).toBeUndefined()
    r.provide('a', 3)
    expect(r.get('a')).toBe(3)
  })
  it('stale disposer does not remove a newer provider', () => {
    const r = new ServiceRegistry()
    const off = r.provide('a', 1)
    off()
    r.provide('a', 2)
    off()
    expect(r.get('a')).toBe(2)
  })
})

describe('EventBus', () => {
  it('emit calls all handlers in order and ignores return', () => {
    const b = new EventBus()
    b.declare('e', 'emit')
    const seen: number[] = []
    b.on('e', () => { seen.push(1); return 'x' })
    b.on('e', (n: number) => { seen.push(n) })
    expect(b.emit('e', 2)).toBeUndefined()
    expect(seen).toEqual([1, 2])
  })
  it('prepend runs first; disposer unregisters', () => {
    const b = new EventBus()
    b.declare('e', 'emit')
    const seen: string[] = []
    b.on('e', () => seen.push('a'))
    const off = b.on('e', () => seen.push('p'), { prepend: true })
    b.emit('e')
    expect(seen).toEqual(['p', 'a'])
    off()
    b.emit('e')
    expect(seen).toEqual(['p', 'a', 'a'])
  })
  it('waterfall passes value through and passes extra args', async () => {
    const b = new EventBus()
    b.declare('w', 'waterfall')
    b.on('w', async (v: number, tag: string, next: (v: number) => Promise<number>) => next(v + 1))
    b.on('w', (v: number, tag: string, next: any) => next(v * 10))
    expect(await b.waterfall('w', 1, 't')).toBe(20)
  })
  it('waterfall handler can short-circuit', async () => {
    const b = new EventBus()
    b.declare('w', 'waterfall')
    let second = false
    b.on('w', (v: number) => v + 100)
    b.on('w', (v: number, next: any) => { second = true; return next(v) })
    expect(await b.waterfall('w', 1)).toBe(101)
    expect(second).toBe(false)
  })
  it('waterfall with no handlers returns the value', async () => {
    const b = new EventBus()
    b.declare('w', 'waterfall')
    expect(await b.waterfall('w', 5)).toBe(5)
  })
  it('serial awaits handlers in order', async () => {
    const b = new EventBus()
    b.declare('s', 'serial')
    const seen: number[] = []
    b.on('s', async () => { await new Promise(r => setTimeout(r, 10)); seen.push(1) })
    b.on('s', () => { seen.push(2) })
    await b.serial('s')
    expect(seen).toEqual([1, 2])
  })
  it('bail returns first non-undefined and stops', async () => {
    const b = new EventBus()
    b.declare('b', 'bail')
    let third = false
    b.on('b', () => undefined)
    b.on('b', async () => 'hit')
    b.on('b', () => { third = true; return 'late' })
    expect(await b.bail('b')).toBe('hit')
    expect(third).toBe(false)
  })
  it('bail returns undefined when nobody handles', async () => {
    const b = new EventBus()
    b.declare('b', 'bail')
    expect(await b.bail('b')).toBeUndefined()
  })
  it('mode mismatch and undeclared types throw', async () => {
    const b = new EventBus()
    b.declare('e', 'emit')
    expect(() => b.emit('nope')).toThrow()
    await expect(b.bail('e')).rejects.toThrow('event e is emit')
    await expect(b.waterfall('e', 1)).rejects.toThrow('event e is emit')
    await expect(b.serial('e')).rejects.toThrow('event e is emit')
    b.declare('b', 'bail')
    expect(() => b.emit('b')).toThrow('event b is bail')
  })
})

describe('EffectScope', () => {
  it('disposes in reverse order', async () => {
    const s = new EffectScope()
    const seen: number[] = []
    s.add(() => { seen.push(1) })
    s.add(async () => { seen.push(2) })
    await s.disposeAll()
    expect(seen).toEqual([2, 1])
  })
  it('throwing disposer does not stop the rest; AggregateError', async () => {
    const s = new EffectScope()
    const seen: number[] = []
    s.add(() => { seen.push(1) })
    s.add(() => { throw new Error('boom') })
    s.add(() => { seen.push(3) })
    const err = await s.disposeAll().catch(e => e)
    expect(err).toBeInstanceOf(AggregateError)
    expect(err.errors).toHaveLength(1)
    expect(seen).toEqual([3, 1])
  })
  it('disposeAll is idempotent', async () => {
    const s = new EffectScope()
    let n = 0
    s.add(() => { n++ })
    await s.disposeAll()
    await s.disposeAll()
    expect(n).toBe(1)
  })
})
