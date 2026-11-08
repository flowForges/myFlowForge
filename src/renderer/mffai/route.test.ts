import { describe, it, expect, vi, beforeEach } from 'vitest'
import { route, MFFAI_PAGES } from './route'

beforeEach(() => route.set({ page: 'chat' }))

describe('route', () => {
  it('lists the seven pages in nav order', () => {
    expect(MFFAI_PAGES).toEqual(['chat', 'tasks', 'memory', 'plugins', 'conn', 'perm', 'debug'])
  })

  it('get/set/subscribe', () => {
    const cb = vi.fn()
    const off = route.subscribe(cb)
    route.set({ page: 'chat', sessionId: 's1' })
    expect(route.get()).toEqual({ page: 'chat', sessionId: 's1' })
    expect(cb).toHaveBeenCalledWith({ page: 'chat', sessionId: 's1' })
    off()
    route.set({ page: 'debug' })
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('set copies its input; mutating it later does not move the route', () => {
    const r = { page: 'chat' as const, newSession: { cwd: '/a' } }
    route.set(r)
    r.newSession.cwd = '/b'
    expect(route.get().newSession).toEqual({ cwd: '/a' })
  })
})
