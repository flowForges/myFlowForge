import { describe, it, expect } from 'vitest'
import type { Settings, Appearance } from './types'
import { defaultSettings } from '../main/config/schema'

describe('shared settings types', () => {
  it('defaultSettings satisfies the Settings/Appearance shape', () => {
    const s: Settings = defaultSettings()
    const a: Appearance = s.appearance
    expect(a.theme).toBe('light')
    expect(a.vibrancy).toBe(false)
    expect(a.windowOpacity).toBe(1)
    expect(a.density).toBe('comfortable')
    expect(a.fontSize).toBe('medium')
  })
})
