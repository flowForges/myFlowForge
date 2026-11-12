import { describe, it, expect } from 'vitest'
import { defaultComputerUse, SettingsSchema, ClientSettingsSchema, defaultSettings, CLIENT_SETTING_KEYS, HOST_SETTING_KEYS, pickHostPatch, pickClientPatch } from './schema'

// spec V3: `computerUse.provisioned` flips agent spawns to disclaimed. Task 4 extends `computerUse`.
describe('settings.computerUse.provisioned', () => {
  it('defaults to false', () => {
    expect(defaultSettings().computerUse.provisioned).toBe(false)
  })

  it('an old config without computerUse parses to provisioned:false', () => {
    const { computerUse: _drop, ...old } = defaultSettings()
    expect(SettingsSchema.parse(old).computerUse).toEqual(defaultComputerUse())
    expect(SettingsSchema.parse(old).computerUse.provisioned).toBe(false)
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
    const off = { ...defaultComputerUse(), provisioned: false }
    const on = { ...defaultComputerUse(), provisioned: true }
    expect(pickHostPatch({ computerUse: off })).toEqual({})
    expect(pickClientPatch({ computerUse: on })).toEqual({ computerUse: on })
  })
})

// Task 4: the rest of computerUse — which TCC kinds were requested (§8.3), and the user's extra app lists (T2/T3).
describe('settings.computerUse (Task 4 fields)', () => {
  it('defaults: nothing requested, no extra apps', () => {
    expect(defaultSettings().computerUse).toEqual({
      provisioned: false, requested: { screen: false, ax: false }, extraBlocked: [], extraAskAlways: [],
    })
  })

  it('a Task 3A config ({provisioned:true} only) keeps provisioned and fills the rest', () => {
    const s = SettingsSchema.parse({ ...defaultSettings(), computerUse: { provisioned: true } })
    expect(s.computerUse).toEqual({
      provisioned: true, requested: { screen: false, ax: false }, extraBlocked: [], extraAskAlways: [],
    })
  })

  it('dirty fields fall back one by one without losing the others', () => {
    const s = SettingsSchema.parse({
      ...defaultSettings(),
      computerUse: { provisioned: true, requested: { screen: 'x', ax: true }, extraBlocked: 'com.a', extraAskAlways: ['com.b', 3] },
    })
    expect(s.computerUse.provisioned).toBe(true)
    expect(s.computerUse.requested).toEqual({ screen: false, ax: true })
    expect(s.computerUse.extraBlocked).toEqual([])
    expect(s.computerUse.extraAskAlways).toEqual(['com.b'])
  })

  it('extra lists are trimmed, de-duplicated and drop empty entries', () => {
    const s = SettingsSchema.parse({
      ...defaultSettings(),
      computerUse: { extraBlocked: [' com.a ', 'com.a', '', 'com.c'], extraAskAlways: [] },
    })
    expect(s.computerUse.extraBlocked).toEqual(['com.a', 'com.c'])
  })

  it('defaultComputerUse returns fresh arrays each call', () => {
    const a = defaultComputerUse(); a.extraBlocked.push('x')
    expect(defaultComputerUse().extraBlocked).toEqual([])
  })
})
