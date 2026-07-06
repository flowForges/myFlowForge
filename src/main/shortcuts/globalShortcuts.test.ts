import { describe, it, expect, vi } from 'vitest'
import { registerGlobalShortcuts, type GlobalShortcutApi } from './globalShortcuts'

function fakeGs(failAccels: string[] = []): GlobalShortcutApi & { registered: Map<string, () => void>; unregisterCalls: number } {
  const registered = new Map<string, () => void>()
  return {
    registered,
    unregisterCalls: 0,
    register(accel, cb) { if (failAccels.includes(accel)) return false; registered.set(accel, cb); return true },
    unregisterAll() { this.unregisterCalls++; registered.clear() },
  }
}

const handlers = { 'toggle-main-window': vi.fn(), 'toggle-pet': vi.fn() }

describe('registerGlobalShortcuts', () => {
  it('clears prior registrations then registers global-scope defaults', () => {
    const gs = fakeGs()
    const { failed } = registerGlobalShortcuts({}, handlers, gs)
    expect(gs.unregisterCalls).toBe(1)
    expect(failed).toEqual([])
    expect(gs.registered.has('CommandOrControl+Shift+F')).toBe(true)
    expect(gs.registered.has('CommandOrControl+Shift+P')).toBe(true)
  })

  it('collects accelerators the OS refuses', () => {
    const gs = fakeGs(['CommandOrControl+Shift+P'])
    const { failed } = registerGlobalShortcuts({}, handlers, gs)
    expect(failed).toEqual(['toggle-pet'])
  })

  it('respects overrides, skipping explicitly-unbound actions', () => {
    const gs = fakeGs()
    registerGlobalShortcuts({ 'toggle-pet': '' }, handlers, gs)
    expect(gs.registered.has('CommandOrControl+Shift+P')).toBe(false)
    expect(gs.registered.size).toBe(1)
  })

  it('skips actions with no handler and does not register app-scope actions', () => {
    const gs = fakeGs()
    registerGlobalShortcuts({}, { 'toggle-main-window': vi.fn() }, gs)
    expect(gs.registered.size).toBe(1) // toggle-pet has no handler; app actions never considered
  })

  it('treats a thrown register() as a failure, not a crash', () => {
    const gs = fakeGs()
    gs.register = () => { throw new Error('boom') }
    const { failed } = registerGlobalShortcuts({}, handlers, gs)
    expect(failed.sort()).toEqual(['toggle-main-window', 'toggle-pet'])
  })
})
