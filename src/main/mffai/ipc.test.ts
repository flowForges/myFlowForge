import { describe, it, expect, vi } from 'vitest'
import { dataDir } from '@mffai/protocol'
import { CH } from '../ipc/channels'
import { CLIENT_SETTING_KEYS, MffaiSchema, SettingsSchema, defaultSettings, type Settings } from '../config/schema'
import { createMffaiSettingsSync, mffaiTransition, registerMffaiIpc } from './ipc'

type Fn = (...a: unknown[]) => unknown

const MODEL_CHANNELS = [
  CH.mffaiModelsCatalog, CH.mffaiModelsAccounts, CH.mffaiModelsAddAccount, CH.mffaiModelsRemoveAccount,
  CH.mffaiModelsTestAccount, CH.mffaiModelsSetDefault, CH.mffaiModelsQuota,
  CH.mffaiChatgptBegin, CH.mffaiChatgptCancel, CH.mffaiOpenExternal,
]
const CODING_CHANNELS = [CH.mffaiApprovalRespond, CH.mffaiRollback]

function setup(mffai: Settings['mffai']) {
  let settings: Settings = { ...defaultSettings(), mffai }
  const handlers = new Map<string, Fn>()
  const host = {
    getState: vi.fn(async () => ({ enabled: settings.mffai.enabled, autostart: settings.mffai.autostart, running: true })),
    enable: vi.fn(async () => {}),
    disable: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    resetTrip: vi.fn(async () => {}),
    setAutostart: vi.fn(async () => {}),
    tail: vi.fn(async () => ({ events: [] })),
    prompt: vi.fn(async () => ({ accepted: true, turnId: 't1' })),
    modelsCatalog: vi.fn(async () => ({ presets: [], models: {} })),
    modelsAccounts: vi.fn(async () => ({ accounts: [], secretsBackend: 'keychain' })),
    addAccount: vi.fn(async () => ({ id: 'acc1' })),
    removeAccount: vi.fn(async () => ({ ok: true })),
    testAccount: vi.fn(async () => ({ ok: true })),
    setDefault: vi.fn(async () => ({ ok: true })),
    quota: vi.fn(async () => null),
    chatgptBegin: vi.fn(async () => ({ flowId: 'f1' })),
    chatgptCancel: vi.fn(async () => ({ ok: true })),
    openExternal: vi.fn(async () => {}),
    approvalRespond: vi.fn(async () => ({ ok: true })),
    rollback: vi.fn(async () => ({ ok: true, files: 2 })),
  }
  const openExternal = vi.fn()
  const loadHost = vi.fn(async () => host as never)
  const saveSettings = vi.fn((patch: Partial<Settings>) => { settings = { ...settings, ...patch } })
  registerMffaiIpc({
    handle: (ch, fn) => { handlers.set(ch, fn) },
    readSettings: () => settings,
    saveSettings,
    loadHost,
    openExternal,
  })
  const invoke = (ch: string, ...a: unknown[]) => handlers.get(ch)!(...a)
  return { handlers, host, loadHost, saveSettings, openExternal, invoke, settings: () => settings }
}

describe('mffai 设置项', () => {
  it('默认关闭、默认开机自启;垃圾值回落', () => {
    expect(defaultSettings().mffai).toEqual({ enabled: false, autostart: true })
    expect(MffaiSchema.parse({ enabled: 'x', autostart: 3 })).toEqual({ enabled: false, autostart: true })
    expect(SettingsSchema.shape.mffai).toBeDefined()
    expect(CLIENT_SETTING_KEYS).toContain('mffai')
  })
})

describe('registerMffaiIpc', () => {
  it('注册全部 invoke 通道', () => {
    const { handlers } = setup({ enabled: false, autostart: true })
    expect([...handlers.keys()].sort()).toEqual([
      CH.mffaiState, CH.mffaiEnable, CH.mffaiDisable, CH.mffaiRestart,
      CH.mffaiResetTrip, CH.mffaiSetAutostart, CH.mffaiTail, CH.mffaiPrompt,
      ...MODEL_CHANNELS, ...CODING_CHANNELS,
    ].sort())
  })

  it('未启用:mffai:state 只读设置,不加载 host', async () => {
    const { invoke, loadHost } = setup({ enabled: false, autostart: false })
    expect(await invoke(CH.mffaiState)).toEqual({ enabled: false, autostart: false, running: false, dataDir: dataDir() })
    expect(loadHost).not.toHaveBeenCalled()
  })

  it('已启用:mffai:state 交给 host', async () => {
    const { invoke, loadHost, host } = setup({ enabled: true, autostart: true })
    expect(await invoke(CH.mffaiState)).toEqual({ enabled: true, autostart: true, running: true })
    expect(loadHost).toHaveBeenCalledTimes(1)
    expect(host.getState).toHaveBeenCalledTimes(1)
  })

  it('mffai:enable 经设置写入口落盘,加载 host 一次并等它启用', async () => {
    const { invoke, loadHost, host, saveSettings } = setup({ enabled: false, autostart: true })
    await invoke(CH.mffaiEnable)
    expect(saveSettings).toHaveBeenCalledWith({ mffai: { enabled: true, autostart: true } })
    expect(loadHost).toHaveBeenCalledTimes(1)
    expect(host.enable).toHaveBeenCalledTimes(1)
  })

  it('mffai:disable / setAutostart 同样只改 mffai 这一项', async () => {
    const { invoke, host, saveSettings } = setup({ enabled: true, autostart: true })
    await invoke(CH.mffaiSetAutostart, false)
    expect(saveSettings).toHaveBeenLastCalledWith({ mffai: { enabled: true, autostart: false } })
    expect(host.setAutostart).toHaveBeenCalledWith(false)
    await invoke(CH.mffaiDisable)
    expect(saveSettings).toHaveBeenLastCalledWith({ mffai: { enabled: false, autostart: false } })
    expect(host.disable).toHaveBeenCalledTimes(1)
  })

  it('未启用:restart / resetTrip / setAutostart / tail / prompt 都不加载 host', async () => {
    const { invoke, loadHost, saveSettings } = setup({ enabled: false, autostart: true })
    const off = { enabled: false, autostart: true, running: false, dataDir: dataDir() }
    expect(await invoke(CH.mffaiRestart)).toEqual(off)
    expect(await invoke(CH.mffaiResetTrip)).toEqual(off)
    expect(await invoke(CH.mffaiTail, 20)).toEqual({ events: [] })
    await expect(invoke(CH.mffaiPrompt, 'hi')).rejects.toThrow('mff-ai 未启用')
    expect(await invoke(CH.mffaiSetAutostart, false)).toEqual({ ...off, autostart: false })
    expect(saveSettings).toHaveBeenLastCalledWith({ mffai: { enabled: false, autostart: false } })
    expect(loadHost).not.toHaveBeenCalled()
  })

  it('tail 的 limit 夹到 1..1000 的整数', async () => {
    const { invoke, host } = setup({ enabled: true, autostart: true })
    await invoke(CH.mffaiTail, 5000)
    await invoke(CH.mffaiTail, 2.7)
    await invoke(CH.mffaiTail, 'x')
    expect(host.tail.mock.calls).toEqual([[1000], [2], [50]])
  })

  it('其余通道透传参数给 host', async () => {
    const { invoke, host } = setup({ enabled: true, autostart: true })
    await invoke(CH.mffaiRestart)
    await invoke(CH.mffaiResetTrip)
    expect(await invoke(CH.mffaiTail, 20)).toEqual({ events: [] })
    expect(await invoke(CH.mffaiPrompt, 'hi')).toEqual({ accepted: true, turnId: 't1' })
    expect(host.restart).toHaveBeenCalledTimes(1)
    expect(host.resetTrip).toHaveBeenCalledTimes(1)
    expect(host.tail).toHaveBeenCalledWith(20)
    expect(host.prompt).toHaveBeenCalledWith('hi')
  })
})

describe('mffai 模型 / ChatGPT 登录通道', () => {
  it('通道名', () => {
    expect(MODEL_CHANNELS).toEqual([
      'mffai:models:catalog', 'mffai:models:accounts', 'mffai:models:addAccount', 'mffai:models:removeAccount',
      'mffai:models:testAccount', 'mffai:models:setDefault', 'mffai:models:quota',
      'mffai:auth:chatgpt:begin', 'mffai:auth:chatgpt:cancel', 'mffai:openExternal',
    ])
  })

  it('未启用:每个新通道都报未启用,不加载 host、不打开链接', async () => {
    const { invoke, loadHost, openExternal } = setup({ enabled: false, autostart: true })
    for (const ch of MODEL_CHANNELS) {
      await expect(invoke(ch, 'x', 'y')).rejects.toThrow('mff-ai 未启用')
    }
    await expect(invoke(CH.mffaiPrompt, 'hi', { accountId: 'a', modelId: 'm' })).rejects.toThrow('mff-ai 未启用')
    expect(loadHost).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('已启用:转发给 host', async () => {
    const { invoke, host, openExternal } = setup({ enabled: true, autostart: true })
    expect(await invoke(CH.mffaiModelsCatalog)).toEqual({ presets: [], models: {} })
    expect(await invoke(CH.mffaiModelsAccounts)).toEqual({ accounts: [], secretsBackend: 'keychain' })
    const input = { presetId: 'p', label: 'l', apiKey: 'sk-1', baseUrl: 'https://b', protocol: 'anthropic', restrictionAck: true }
    expect(await invoke(CH.mffaiModelsAddAccount, { ...input, commandId: 'from-page', junk: 1 })).toEqual({ id: 'acc1' })
    expect(host.addAccount).toHaveBeenCalledWith(input)
    await invoke(CH.mffaiModelsRemoveAccount, 'acc1')
    expect(host.removeAccount).toHaveBeenCalledWith('acc1')
    await invoke(CH.mffaiModelsTestAccount, 'acc1')
    expect(host.testAccount).toHaveBeenCalledWith('acc1')
    await invoke(CH.mffaiModelsSetDefault, 'acc1', 'm1')
    expect(host.setDefault).toHaveBeenCalledWith({ accountId: 'acc1', modelId: 'm1' })
    expect(await invoke(CH.mffaiModelsQuota, 'acc1')).toBeNull()
    expect(host.quota).toHaveBeenCalledWith('acc1')
    expect(await invoke(CH.mffaiChatgptBegin)).toEqual({ flowId: 'f1' })
    expect(host.chatgptBegin).toHaveBeenCalledWith(openExternal)
    await invoke(CH.mffaiChatgptCancel, 'f1')
    expect(host.chatgptCancel).toHaveBeenCalledWith('f1')
    await invoke(CH.mffaiOpenExternal, 'https://chatgpt.com/x')
    expect(host.openExternal).toHaveBeenCalledWith('https://chatgpt.com/x', openExternal)
    await invoke(CH.mffaiPrompt, 'hi', { accountId: 'a', modelId: 'm', extra: 1 })
    expect(host.prompt).toHaveBeenLastCalledWith('hi', { accountId: 'a', modelId: 'm' })
  })
})

describe('mffai 审批 / 回滚通道', () => {
  it('通道名', () => {
    expect(CODING_CHANNELS).toEqual(['mffai:approval:respond', 'mffai:turn:rollback'])
  })

  it('未启用:两个通道都报未启用,不加载 host', async () => {
    const { invoke, loadHost } = setup({ enabled: false, autostart: true })
    await expect(invoke(CH.mffaiApprovalRespond, 'ap1', 'allow')).rejects.toThrow('mff-ai 未启用')
    await expect(invoke(CH.mffaiRollback, 's1', 't1')).rejects.toThrow('mff-ai 未启用')
    expect(loadHost).not.toHaveBeenCalled()
  })

  it('已启用:转发;decision 只认三个值', async () => {
    const { invoke, host } = setup({ enabled: true, autostart: true })
    for (const d of ['allow', 'allow_session', 'deny']) {
      expect(await invoke(CH.mffaiApprovalRespond, 'ap1', d)).toEqual({ ok: true })
      expect(host.approvalRespond).toHaveBeenLastCalledWith('ap1', d)
    }
    for (const bad of ['always', '', undefined, { decision: 'allow' }]) {
      await expect(invoke(CH.mffaiApprovalRespond, 'ap1', bad)).rejects.toThrow()
    }
    expect(host.approvalRespond).toHaveBeenCalledTimes(3)
    expect(await invoke(CH.mffaiRollback, 's1', 't1')).toEqual({ ok: true, files: 2 })
    expect(host.rollback).toHaveBeenCalledWith('s1', 't1')
  })

  it('prompt 的 opts 只放行 cwd(去空白)与 approvalMode(ask / auto)', async () => {
    const { invoke, host } = setup({ enabled: true, autostart: true })
    const m = { accountId: 'a', modelId: 'm' }
    await invoke(CH.mffaiPrompt, 'hi', m, { cwd: '  /repo ', approvalMode: 'auto', toolset: 'edit', junk: 1 })
    expect(host.prompt).toHaveBeenLastCalledWith('hi', m, { cwd: '/repo', approvalMode: 'auto' })
    await invoke(CH.mffaiPrompt, 'hi', undefined, { cwd: '/repo', approvalMode: 'yolo' })
    expect(host.prompt).toHaveBeenLastCalledWith('hi', undefined, { cwd: '/repo' })
    await invoke(CH.mffaiPrompt, 'hi', m, { cwd: 3, approvalMode: 'ask' })
    expect(host.prompt).toHaveBeenLastCalledWith('hi', m, { approvalMode: 'ask' })
    await invoke(CH.mffaiPrompt, 'hi', m, { cwd: '   ' })
    expect(host.prompt).toHaveBeenLastCalledWith('hi', m)
    await invoke(CH.mffaiPrompt, 'hi', undefined, 'x')
    expect(host.prompt).toHaveBeenLastCalledWith('hi')
  })
})

describe('mffai 设置变化 → host', () => {
  const on = { enabled: true, autostart: true }
  const off = { enabled: false, autostart: true }

  it('mffaiTransition', () => {
    expect(mffaiTransition(off, on)).toBe('enable')
    expect(mffaiTransition(on, off)).toBe('disable')
    expect(mffaiTransition(on, { enabled: true, autostart: false })).toBe('setAutostart')
    expect(mffaiTransition(off, { enabled: false, autostart: false })).toBeNull() // 未启用时改自启不碰 host
    expect(mffaiTransition(on, { ...on })).toBeNull()
  })

  function sync(initial: Settings['mffai']) {
    const host = { enable: vi.fn(async () => {}), disable: vi.fn(async () => {}), setAutostart: vi.fn(async () => {}) }
    const loadHost = vi.fn(async () => host as never)
    const onError = vi.fn()
    return { host, loadHost, onError, fn: createMffaiSettingsSync({ initial, loadHost, onError }) }
  }

  it('mffai 不变 / 只改了别的设置 → 不加载 host', async () => {
    const t = sync(off)
    const fontChanged: Settings = { ...defaultSettings(), appearance: { ...defaultSettings().appearance, fontSize: 16 }, mffai: { ...off } }
    t.fn(fontChanged)
    t.fn({ ...defaultSettings(), mffai: { ...off } })
    await Promise.resolve()
    expect(t.loadHost).not.toHaveBeenCalled()
  })

  it('开 → enable;再写同样的值不重复;关 → disable;启用时改自启 → setAutostart', async () => {
    const t = sync(off)
    t.fn({ mffai: on })
    t.fn({ mffai: { ...on } })
    await vi.waitFor(() => expect(t.host.enable).toHaveBeenCalledTimes(1))
    t.fn({ mffai: { enabled: true, autostart: false } })
    await vi.waitFor(() => expect(t.host.setAutostart).toHaveBeenCalledWith(false))
    t.fn({ mffai: { enabled: false, autostart: false } })
    await vi.waitFor(() => expect(t.host.disable).toHaveBeenCalledTimes(1))
    expect(t.loadHost).toHaveBeenCalledTimes(3)
    expect(t.onError).not.toHaveBeenCalled()
  })

  it('host 报错交给 onError', async () => {
    const t = sync(off)
    t.host.enable.mockRejectedValueOnce(new Error('boom'))
    t.fn({ mffai: on })
    await vi.waitFor(() => expect(t.onError).toHaveBeenCalledTimes(1))
  })
})
