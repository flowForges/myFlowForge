import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { ACTIVITY_KEY, LIST_NARROW_BELOW, PANEL_MIN_MAIN, activityPref } from './layout'

// 这个测试环境的 localStorage 不可用(Connections.test 同样处理):装一份内存实现
const memStorage = (): Storage => {
  const d: Record<string, string> = {}
  return {
    getItem: (k) => d[k] ?? null, setItem: (k, v) => { d[k] = String(v) }, removeItem: (k) => { delete d[k] },
    clear: () => { for (const k of Object.keys(d)) delete d[k] }, key: (i) => Object.keys(d)[i] ?? null,
    get length() { return Object.keys(d).length },
  }
}
beforeEach(() => { vi.stubGlobal('localStorage', memStorage()) })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('layout', () => {
  it('the key and the two thresholds', () => {
    expect(ACTIVITY_KEY).toBe('mffai.activityPanel')
    expect(PANEL_MIN_MAIN).toBe(1280)
    expect(LIST_NARROW_BELOW).toBe(1200)
  })

  it('no stored value → open, and reading writes nothing', () => {
    expect(activityPref.get()).toBe('open')
    expect(localStorage.getItem(ACTIVITY_KEY)).toBeNull()
  })

  it('a stored open / closed is read back; a junk value → open', () => {
    localStorage.setItem(ACTIVITY_KEY, 'closed')
    expect(activityPref.get()).toBe('closed')
    localStorage.setItem(ACTIVITY_KEY, 'open')
    expect(activityPref.get()).toBe('open')
    for (const junk of ['', 'CLOSED', 'true', '{"v":"closed"}']) {
      localStorage.setItem(ACTIVITY_KEY, junk)
      expect(activityPref.get()).toBe('open')
    }
  })

  it('no localStorage at all → open; set does not throw', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(activityPref.get()).toBe('open')
    expect(() => activityPref.set('closed')).not.toThrow()
  })

  it('storage that throws on read → open', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('denied') })
    expect(activityPref.get()).toBe('open')
  })

  it('set writes and notifies each subscriber once; unsubscribe stops it', () => {
    const a = vi.fn(), b = vi.fn()
    const offA = activityPref.subscribe(a)
    const offB = activityPref.subscribe(b)
    activityPref.set('closed')
    expect(localStorage.getItem(ACTIVITY_KEY)).toBe('closed')
    expect(activityPref.get()).toBe('closed')
    expect(a).toHaveBeenCalledTimes(1)
    expect(a).toHaveBeenCalledWith('closed')
    expect(b).toHaveBeenCalledTimes(1)
    offA()
    activityPref.set('open')
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenLastCalledWith('open')
    offB()
  })

  it('storage that throws on write: the choice is kept in memory for that storage and read back (a new pane reads it)', () => {
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('full') })
    activityPref.set('closed')
    expect(activityPref.get()).toBe('closed')
    activityPref.set('open')
    expect(activityPref.get()).toBe('open')
    activityPref.set('closed')
    // 另一个存储(另一个测试、另一个窗口)不受影响
    vi.stubGlobal('localStorage', memStorage())
    expect(activityPref.get()).toBe('open')
  })

  it('a later successful write wins over the in-memory fallback', () => {
    const real = localStorage.setItem.bind(localStorage)
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('full') })
    activityPref.set('closed')
    spy.mockImplementation(real)
    activityPref.set('open')
    expect(localStorage.getItem(ACTIVITY_KEY)).toBe('open')
    expect(activityPref.get()).toBe('open')
  })

  it('storage that throws on write still notifies (the choice holds for this run)', () => {
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('full') })
    const cb = vi.fn()
    const off = activityPref.subscribe(cb)
    expect(() => activityPref.set('closed')).not.toThrow()
    expect(cb).toHaveBeenCalledWith('closed')
    off()
  })
})
