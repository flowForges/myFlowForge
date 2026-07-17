import { describe, it, expect } from 'vitest'
import { deferred, ResolverRegistry } from './resolver'

describe('deferred', () => {
  it('resolves externally', async () => {
    const d = deferred<number>()
    setTimeout(() => d.resolve(42), 0)
    expect(await d.promise).toBe(42)
  })
})

describe('ResolverRegistry', () => {
  it('create + settle unblocks the awaiter and reports pending ids', async () => {
    const r = new ResolverRegistry<string>()
    const p = r.create('e1')
    expect(r.has('e1')).toBe(true)
    expect(r.pendingIds()).toEqual(['e1'])
    expect(r.settle('e1', 'allow')).toBe(true)
    expect(await p).toBe('allow')
    expect(r.has('e1')).toBe(false)
  })
  it('settle unknown/already-settled id returns false', () => {
    const r = new ResolverRegistry<string>()
    expect(r.settle('nope', 'x')).toBe(false)
    r.create('e2'); r.settle('e2', 'a')
    expect(r.settle('e2', 'b')).toBe(false)
  })
  it('settleAll resolves every pending promise', async () => {
    const r = new ResolverRegistry<string>()
    const a = r.create('a'); const b = r.create('b')
    r.settleAll('abort')
    expect(await a).toBe('abort'); expect(await b).toBe('abort')
    expect(r.pendingIds()).toEqual([])
  })
})
