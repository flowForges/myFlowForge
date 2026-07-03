import { describe, it, expect } from 'vitest'
import { SettingsSchema, defaultSettings } from './schema'

describe('settings.heartbeat', () => {
  it('defaults are present and sane', () => {
    const s = defaultSettings()
    expect(s.heartbeat).toEqual({ stallMs: 90_000, killGraceMs: 60_000, pingMs: 15_000 })
  })
  it('schema fills heartbeat when an older settings file omits it', () => {
    const parsed = SettingsSchema.parse({
      appearance: { theme: 'dark', accent: 'blue', vibrancy: true, glass: false, density: 'comfortable', fontSize: 'medium' },
      termProxy: '',
    })
    expect(parsed.heartbeat.stallMs).toBe(90_000)
    expect(parsed.heartbeat.killGraceMs).toBe(60_000)
    expect(parsed.heartbeat.pingMs).toBe(15_000)
  })
})
