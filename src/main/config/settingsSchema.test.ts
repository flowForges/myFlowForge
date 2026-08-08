import { describe, it, expect } from 'vitest'
import { SettingsSchema, defaultSettings } from './schema'


describe('SettingsSchema botBridge', () => {
  it('defaults to per-platform disabled config', () => {
    const s = defaultSettings()
    expect(s.botBridge.dingtalk).toEqual({ enabled: false, clientId: '', clientSecret: '' })
    expect(s.botBridge.telegram).toEqual({ enabled: false, botToken: '' })
    expect(s.botBridge.feishu).toEqual({ enabled: false, appId: '', appSecret: '' })
  })

  it('migrates the legacy { enabled, dingtalk } shape into dingtalk.enabled', () => {
    const parsed = SettingsSchema.parse({
      ...defaultSettings(),
      botBridge: { enabled: true, dingtalk: { clientId: 'ding123', clientSecret: 'sec' }, pairingCode: '654321' },
    })
    expect(parsed.botBridge.dingtalk).toEqual({ enabled: true, clientId: 'ding123', clientSecret: 'sec' })
    expect(parsed.botBridge.pairingCode).toBe('654321')
    expect(parsed.botBridge.telegram.enabled).toBe(false)
    expect('enabled' in parsed.botBridge).toBe(false)   // legacy top-level flag dropped after migration
  })
})

describe('SettingsSchema skills + pet', () => {
  it('defaultSettings includes skills + pet defaults', () => {
    const s = defaultSettings()
    expect(s.skills['code-review']).toBe(true)
    expect(s.skills['deep-research']).toBe(false)
    expect(s.pet).toMatchObject({
      enabled: true,
      skin: 'ghost',
      corner: 'right',
      pos: { bottom: 24 },
      followCursor: true,
      scale: 1,
      notify: { confirm: true, input: true, done: false },
      states: { idle: { anim: 'float', accent: 'none' }, working: { anim: 'spin-halo', accent: 'none' }, confirm: { anim: 'alert', accent: 'warn' }, input: { anim: 'tilt', accent: 'accent' }, done: { anim: 'pulse-ok', accent: 'ok' } },
    })
    expect(s.pet.customPets).toEqual([])          // 不再有随包内置宠物
    expect(s.pet.skin).toBe('ghost')             // 默认形象 = 内置 SVG 幽灵
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
    expect(parsed.pet.skin).toBe('ghost')
    expect(parsed.pet.activeCustomPetId).toBeUndefined()
  })
  it('textWeight: 旧枚举迁移为数值,数值吸附步进,越界/垃圾回落 450', () => {
    const base = defaultSettings()
    expect(base.appearance.textWeight).toBe(450)                                            // 新默认
    const parse = (v: unknown) => SettingsSchema.parse({ ...base, appearance: { ...base.appearance, textWeight: v } }).appearance.textWeight
    expect(parse('medium')).toBe(450)                                                       // 旧「适中」
    expect(parse('normal')).toBe(400)                                                       // 旧「标准」
    expect(parse(500)).toBe(500)                                                            // 数值透传
    expect(parse(437)).toBe(425)                                                            // 吸附到步进 25 网格
    expect(parse(900)).toBe(600)                                                            // 越上界夹到 600
    expect(parse(100)).toBe(300)                                                            // 越下界夹到 300
    expect(parse('banana')).toBe(450)                                                       // 垃圾回落
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
  it('memory defaults to DISABLED (opt-in; distillation costs tokens); respects explicit on; old files without memory default off', () => {
    const base = defaultSettings()
    expect(base.memory).toEqual({ enabled: false })
    expect(SettingsSchema.parse({ ...base }).memory.enabled).toBe(false)
    expect(SettingsSchema.parse({ ...base, memory: { enabled: true } }).memory.enabled).toBe(true)
    const old = SettingsSchema.parse({ appearance: { theme: 'dark', vibrancy: true, density: 'comfortable', fontSize: 'medium' }, termProxy: '' })
    expect(old.memory.enabled).toBe(false)
  })
  // ★ 终审实测出来的爆炸半径:customPets[].growth 上没有 .catch 时,一个坏成长包会让整份
  // SettingsSchema.parse 抛出;store.readJson 的 `catch { return fallback() }` 接住之后,用户的
  // 全部设置一次性回到出厂,下次写盘就固化。所以坏 growth 只准丢它自己。
  it('坏掉的 growth 块只丢自己,不让整份设置解析失败(store 会把 throw 变成出厂重置)', () => {
    const base = defaultSettings()
    const bad = {
      ...base,
      // 三处都不合法:cols 必须 positive、actions 缺 cellW/cellH 的兄弟字段、stages 至少 1 项。
      pet: { ...base.pet, customPets: [{ id: 'growth-x', name: '成长树', growth: { atlas: { cols: 0 }, actions: {}, stages: [] } }] },
      // 下面这些是「其余设置」的取样,必须原封不动地活下来 —— 它们才是「没被重置」的证据。
      appearance: { ...base.appearance, theme: 'dark' as const, fontSize: 17 },
      termProxy: 'http://127.0.0.1:7890',
      pinnedWorkspaces: ['/a/b'],
      lastActiveWorkspace: '/a/b',
      keybindings: { overrides: { 'new-workspace': 'Cmd+Shift+N' } },
      closeAction: 'quit' as const,
    }
    let parsed!: ReturnType<typeof SettingsSchema.parse>
    expect(() => { parsed = SettingsSchema.parse(bad) }).not.toThrow()
    // 坏字段退成 undefined,宠物本身还在(只是不再按成长包渲染)
    expect(parsed.pet.customPets).toHaveLength(1)
    expect(parsed.pet.customPets[0].id).toBe('growth-x')
    expect(parsed.pet.customPets[0].growth).toBeUndefined()
    // ★ 其余设置逐条完好 —— 这条才是「用户没被重置」的证据
    expect(parsed.appearance.theme).toBe('dark')
    expect(parsed.appearance.fontSize).toBe(17)
    expect(parsed.termProxy).toBe('http://127.0.0.1:7890')
    expect(parsed.pinnedWorkspaces).toEqual(['/a/b'])
    expect(parsed.lastActiveWorkspace).toBe('/a/b')
    expect(parsed.keybindings.overrides).toEqual({ 'new-workspace': 'Cmd+Shift+N' })
    expect(parsed.closeAction).toBe('quit')
  })
  it('合法的 growth 块照常透传(.catch 不能把好包也吃掉)', () => {
    const base = defaultSettings()
    const growth = {
      atlas: { cols: 4, cellW: 100, cellH: 100 },
      actions: { idle: { row: 0, durations: [200, 200] } },
      stages: [{ at: 0, sheet: 'growth-x/0.png' }],
    }
    const parsed = SettingsSchema.parse({ ...base, pet: { ...base.pet, customPets: [{ id: 'growth-x', name: '成长树', growth }] } })
    expect(parsed.pet.customPets[0].growth).toEqual(growth)
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
