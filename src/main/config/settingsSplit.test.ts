import { describe, it, expect } from 'vitest'
import {
  SettingsSchema, CLIENT_SETTING_KEYS, HOST_SETTING_KEYS,
  migrateLegacySettings, pickClient, pickHost, defaultSettings,
  ClientSettingsSchema, HostSettingsSchema,
} from './schema'
import { overlayForTest as overlay } from './store'

describe('归属划分', () => {
  it('两张表加起来正好覆盖全部设置项,且没有重叠', () => {
    // ★这条是刹车:新加一个设置项会让它挂,逼你当场决定归谁。
    // 漏掉的字段既不会被写进 client.json 也不会写进 settings.json —— **一存就丢**,
    // 而且不会有任何报错。
    const all = Object.keys(SettingsSchema.shape).sort()
    const split = [...CLIENT_SETTING_KEYS, ...HOST_SETTING_KEYS].sort()
    expect(split).toEqual(all)
    expect(new Set(split).size).toBe(split.length)
  })

  it('几条一眼就该对的归属', () => {
    expect(CLIENT_SETTING_KEYS).toContain('appearance')   // 连去哪台机器都不该变
    expect(CLIENT_SETTING_KEYS).toContain('pet')
    expect(CLIENT_SETTING_KEYS).toContain('appProxy')
    expect(HOST_SETTING_KEYS).toContain('disabledProviders')  // CLI 装在那台机器上
    expect(HOST_SETTING_KEYS).toContain('pluginCreds')
    expect(HOST_SETTING_KEYS).toContain('agentProxy')
    expect(HOST_SETTING_KEYS).toContain('notifyEvents')
  })

  it('pickClient / pickHost 拆完能原样拼回去', () => {
    const d = defaultSettings()
    expect({ ...pickHost(d), ...pickClient(d) }).toEqual(d)
  })
})

describe('老 settings.json 的迁移', () => {
  const legacy = {
    appearance: { theme: 'midnight', accent: 'violet', bgWallpaperId: 'w-42' },
    pet: { enabled: false },
    termProxy: 'http://127.0.0.1:7897',
    notifications: { enabled: true, confirm: true, input: false, done: true },
    lastActiveWorkspace: '/Users/me/ws/alpha',
    disabledProviders: ['gemini'],
    pluginCreds: { qoder: 'tok' },
    nsfwCodes: ['abc'],
    pinnedWorkspaces: ['/a', '/b'],
  }

  it('★客户端那半边一样不能少 —— 丢了就是用户的主题壁纸在升级里凭空消失', () => {
    const { client } = migrateLegacySettings(legacy)
    const c = client as Record<string, unknown>
    expect(c.appearance).toEqual(legacy.appearance)
    expect(c.pet).toEqual(legacy.pet)
    expect(c.nsfwCodes).toEqual(['abc'])
  })

  it('★机器那半边也一样不能少', () => {
    const { host } = migrateLegacySettings(legacy) as { host: Record<string, unknown> }
    expect(host.disabledProviders).toEqual(['gemini'])
    expect(host.pluginCreds).toEqual({ qoder: 'tok' })
    expect(host.pinnedWorkspaces).toEqual(['/a', '/b'])
  })

  it('★termProxy 同时抄进两边 —— 升级后行为必须和升级前一模一样', () => {
    // 只抄一边的话:要么 agent 突然直连(被墙的用户以为 app 坏了),
    // 要么检查更新突然直连。升级前这俩本来就是同一个值,升级当天不该有任何变化。
    const { client, host } = migrateLegacySettings(legacy) as { client: any; host: any }
    expect(host.agentProxy).toBe('http://127.0.0.1:7897')
    expect(client.appProxy).toBe('http://127.0.0.1:7897')
  })

  it('★老的通知开关同时抄进 notifyEvents —— 升级前「产生」和「接收」本来是一件事', () => {
    const { client, host } = migrateLegacySettings(legacy) as { client: any; host: any }
    expect(client.notifications).toEqual(legacy.notifications)
    expect(host.notifyEvents).toEqual({ confirm: true, input: false, done: true })
  })

  it('★lastActiveWorkspace 从字符串变成按 host 分键,本机的键是 local', () => {
    const { client } = migrateLegacySettings(legacy) as { client: any }
    expect(client.lastActiveWorkspace).toEqual({ local: '/Users/me/ws/alpha' })
  })

  it('空的 lastActiveWorkspace 不该造出一个指向空路径的「上次」', () => {
    const { client } = migrateLegacySettings({ lastActiveWorkspace: '' }) as { client: any }
    expect(client.lastActiveWorkspace).toEqual({})
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['空对象', {}],
    ['字符串', 'not an object'],
    ['数组', [1, 2, 3]],
    ['数字', 42],
  ])('垃圾输入「%s」不抛,只是拆出两个空壳', (_l, raw) => {
    // 迁移抛异常 = 启动时 readSettings 整个失败 = 用户全部设置回落默认值。
    expect(() => migrateLegacySettings(raw)).not.toThrow()
    const { client, host } = migrateLegacySettings(raw)
    expect(typeof client).toBe('object')
    expect(typeof host).toBe('object')
  })

  it('迁移结果必须能通过各自的 schema(以 defaults 打底)', () => {
    const d = defaultSettings()
    const { client, host } = migrateLegacySettings(legacy)
    expect(() => ClientSettingsSchema.parse(overlay(pickClient(d) as never, client))).not.toThrow()
    expect(() => HostSettingsSchema.parse(overlay(pickHost(d) as never, host))).not.toThrow()
  })

  it('★单个字段是脏值时只丢那一个字段,不能连累整份设置', () => {
    // 这是 schema 里那 42 处 .catch() 存在的理由。一次全量回落 = 用户所有设置被静默重置。
    const d = defaultSettings()
    const dirty = { ...legacy, disabledProviders: 'not-an-array', nsfwCodes: 12345 }
    const { client, host } = migrateLegacySettings(dirty)
    const c = ClientSettingsSchema.parse(overlay(pickClient(d) as never, client))
    const h = HostSettingsSchema.parse(overlay(pickHost(d) as never, host))
    expect(h.disabledProviders).toEqual([])              // 坏字段回落
    expect(c.nsfwCodes).toEqual([])                       // 坏字段回落
    expect(h.pluginCreds).toEqual({ qoder: 'tok' })       // 旁边的好字段还在
    expect(c.appearance.theme).toBe('midnight')           // 旁边的好字段还在
  })
})
