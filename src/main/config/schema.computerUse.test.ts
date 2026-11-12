import { describe, it, expect } from 'vitest'
import { SettingsSchema, ClientSettingsSchema, defaultSettings, CLIENT_SETTING_KEYS, HOST_SETTING_KEYS, pickHostPatch, pickClientPatch } from './schema'

// spec V3: `computerUse.provisioned` flips agent spawns to disclaimed. Task 4 extends `computerUse`.
describe('settings.computerUse.provisioned', () => {
  it('defaults to false', () => {
    expect(defaultSettings().computerUse.provisioned).toBe(false)
  })

  it('an old config without computerUse parses to provisioned:false', () => {
    const { computerUse: _drop, ...old } = defaultSettings()
    expect(SettingsSchema.parse(old).computerUse).toEqual({ provisioned: false })
  })

  it('a dirty value falls back to false without losing the rest', () => {
    const s = SettingsSchema.parse({ ...defaultSettings(), computerUse: { provisioned: 'yes' }, agentProxy: 'http://p' })
    expect(s.computerUse.provisioned).toBe(false)
    expect(s.agentProxy).toBe('http://p')
    expect(SettingsSchema.parse({ ...defaultSettings(), computerUse: 7 }).computerUse.provisioned).toBe(false)
  })

  it('true survives a round trip', () => {
    expect(SettingsSchema.parse({ ...defaultSettings(), computerUse: { provisioned: true } }).computerUse.provisioned).toBe(true)
    expect(ClientSettingsSchema.shape.computerUse).toBeDefined()
  })

  it('follows the device, so a remote client\'s host-settings patch can never flip it', () => {
    expect(CLIENT_SETTING_KEYS).toContain('computerUse')
    expect(HOST_SETTING_KEYS).not.toContain('computerUse')
    expect(pickHostPatch({ computerUse: { provisioned: false } })).toEqual({})
    expect(pickClientPatch({ computerUse: { provisioned: true } })).toEqual({ computerUse: { provisioned: true } })
  })
})
