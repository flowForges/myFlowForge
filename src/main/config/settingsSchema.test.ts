import { describe, it, expect } from 'vitest'
import { SettingsSchema, defaultSettings } from './schema'
import { BUILTIN_PET_IDS, DEFAULT_BUILTIN_PET_ID } from '@shared/builtinPets'

describe('SettingsSchema skills + pet', () => {
  it('defaultSettings includes skills + pet defaults', () => {
    const s = defaultSettings()
    expect(s.skills['code-review']).toBe(true)
    expect(s.skills['deep-research']).toBe(false)
    expect(s.pet).toMatchObject({
      enabled: true,
      skin: 'custom',
      activeCustomPetId: `builtin-${DEFAULT_BUILTIN_PET_ID}`,
      corner: 'right',
      pos: { bottom: 24 },
      followCursor: false,
      scale: 1,
      notify: { confirm: true, input: true, done: false },
      states: { idle: { anim: 'float', accent: 'none' }, working: { anim: 'spin-halo', accent: 'none' }, confirm: { anim: 'alert', accent: 'warn' }, input: { anim: 'tilt', accent: 'accent' }, done: { anim: 'pulse-ok', accent: 'ok' } },
    })
    expect(s.pet.customPets.map(p => p.id)).toEqual(BUILTIN_PET_IDS.map(id => `builtin-${id}`))
  })
  it('pet.scale: 旧配置缺省补 1,合法值透传,越界/非法回落 1', () => {
    const base = defaultSettings()
    // 旧 on-disk 配置没有 scale → 默认 1
    const old = SettingsSchema.parse({ ...base, pet: { enabled: true, skin: 'sprite', corner: 'right', notify: { confirm: true, input: true, done: false } } })
    expect(old.pet.scale).toBe(1)
    // 合法范围 [0.6, 1.8] 内透传
    expect(SettingsSchema.parse({ ...base, pet: { ...base.pet, scale: 1.4 } }).pet.scale).toBe(1.4)
    // 越界/非法不让整份 settings 解析失败,回落 1
    expect(SettingsSchema.parse({ ...base, pet: { ...base.pet, scale: 99 } }).pet.scale).toBe(1)
    expect(SettingsSchema.parse({ ...base, pet: { ...base.pet, scale: 'huge' } }).pet.scale).toBe(1)
  })
  it('parses an old settings file (no skills/pet) by filling defaults', () => {
    const parsed = SettingsSchema.parse({ appearance: { theme: 'dark', vibrancy: true, density: 'comfortable', fontSize: 'medium' }, termProxy: '' })
    expect(parsed.skills['test-driven']).toBe(true)
    expect(parsed.pet.skin).toBe('custom')
    expect(parsed.pet.activeCustomPetId).toBe(`builtin-${DEFAULT_BUILTIN_PET_ID}`)
  })
  it('closeAction: 默认 ask,合法值透传,垃圾值回落 ask,旧配置缺省补 ask', () => {
    expect(defaultSettings().closeAction).toBe('ask')
    const base = defaultSettings()
    expect(SettingsSchema.parse({ ...base, closeAction: 'hide' }).closeAction).toBe('hide')
    expect(SettingsSchema.parse({ ...base, closeAction: 'quit' }).closeAction).toBe('quit')
    // 垃圾值不让整份 settings 解析失败,回落 ask
    expect(SettingsSchema.parse({ ...base, closeAction: 'banana' }).closeAction).toBe('ask')
    // 旧 on-disk 配置没有 closeAction → 默认 ask
    const old = SettingsSchema.parse({ appearance: { theme: 'dark', vibrancy: true, density: 'comfortable', fontSize: 'medium' }, termProxy: '' })
    expect(old.closeAction).toBe('ask')
  })
  it('defaults include terminal font + parses old settings without terminal', () => {
    const s = defaultSettings()
    expect(s.terminal).toEqual({ fontFamily: "'MesloLGS NF', 'JetBrainsMono Nerd Font', Menlo, ui-monospace, monospace", fontSize: 12.5 })
    const parsed = SettingsSchema.parse({ appearance: { theme:'dark', accent:'blue', vibrancy:true, glass:false, density:'comfortable', fontSize:'medium' }, termProxy:'' })
    expect(parsed.terminal.fontSize).toBe(12.5)
  })
  it('memory defaults to enabled; parses off; old files without memory default on', () => {
    const base = defaultSettings()
    expect(base.memory).toEqual({ enabled: true })
    expect(SettingsSchema.parse({ ...base }).memory.enabled).toBe(true)
    expect(SettingsSchema.parse({ ...base, memory: { enabled: false } }).memory.enabled).toBe(false)
    const old = SettingsSchema.parse({ appearance: { theme: 'dark', vibrancy: true, density: 'comfortable', fontSize: 'medium' }, termProxy: '' })
    expect(old.memory.enabled).toBe(true)
  })
  it('defaults app icon to the fourth colorway and menu bar off', () => {
    const s = defaultSettings()
    expect(s.appIcon.dockIcon).toBe('ember-violet')
    expect(s.appIcon.showMenuBar).toBe(false)
    const parsed = SettingsSchema.parse({ appearance: { theme:'dark', accent:'blue', vibrancy:true, glass:false, density:'comfortable', fontSize:'medium' }, termProxy:'' })
    expect(parsed.appIcon.dockIcon).toBe('ember-violet')
    expect(parsed.appIcon.showMenuBar).toBe(false)
  })
})
