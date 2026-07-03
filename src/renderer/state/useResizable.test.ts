import { describe, it, expect, beforeEach, vi } from 'vitest'
import { clampWidth, loadWidth } from './useResizable'

describe('clampWidth', () => {
  it('returns min when value is below min', () => {
    expect(clampWidth(100, 180, 440)).toBe(180)
  })

  it('returns max when value is above max', () => {
    expect(clampWidth(500, 180, 440)).toBe(440)
  })

  it('returns value unchanged when in range', () => {
    expect(clampWidth(300, 180, 440)).toBe(300)
  })

  it('returns min when value equals min', () => {
    expect(clampWidth(180, 180, 440)).toBe(180)
  })

  it('returns max when value equals max', () => {
    expect(clampWidth(440, 180, 440)).toBe(440)
  })
})

describe('loadWidth', () => {
  // localStorage may not exist in this jsdom environment; stub it so tests are self-contained.
  const store: Record<string, string> = {}
  const mockStorage: Storage = {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => { store[k] = v },
    removeItem: (k) => { delete store[k] },
    clear: () => { Object.keys(store).forEach(k => delete store[k]) },
    get length() { return Object.keys(store).length },
    key: (i) => Object.keys(store)[i] ?? null,
  }

  beforeEach(() => {
    mockStorage.clear()
    vi.stubGlobal('localStorage', mockStorage)
  })

  it('returns default when key is missing', () => {
    expect(loadWidth('sidebarW', 248, 180, 440)).toBe(248)
  })

  it('returns clamped value when stored value is within range', () => {
    localStorage.setItem('forge.sidebarW', '300')
    expect(loadWidth('sidebarW', 248, 180, 440)).toBe(300)
  })

  it('clamps stored value below min to min', () => {
    localStorage.setItem('forge.sidebarW', '50')
    expect(loadWidth('sidebarW', 248, 180, 440)).toBe(180)
  })

  it('clamps stored value above max to max', () => {
    localStorage.setItem('forge.sidebarW', '999')
    expect(loadWidth('sidebarW', 248, 180, 440)).toBe(440)
  })

  it('returns default when stored value is non-numeric', () => {
    localStorage.setItem('forge.sidebarW', 'abc')
    expect(loadWidth('sidebarW', 248, 180, 440)).toBe(248)
  })

  it('returns default when stored value is empty string', () => {
    localStorage.setItem('forge.sidebarW', '')
    expect(loadWidth('sidebarW', 248, 180, 440)).toBe(248)
  })

  it('uses correct key (forge. prefix)', () => {
    localStorage.setItem('forge.inspectorW', '400')
    expect(loadWidth('inspectorW', 380, 280, 720)).toBe(400)
    // different key should still return default
    expect(loadWidth('sidebarW', 248, 180, 440)).toBe(248)
  })
})
