import { describe, it, expect, vi } from 'vitest'
import { CH } from '../ipc/channels'
import { CLIENT_SETTING_KEYS, MffaiSchema, SettingsSchema, defaultSettings, type Settings } from '../config/schema'
import { registerMffaiIpc } from './ipc'

type Fn = (...a: unknown[]) => unknown

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
  }
  const loadHost = vi.fn(async () => host as never)
  const saveSettings = vi.fn((patch: Partial<Settings>) => { settings = { ...settings, ...patch } })
  registerMffaiIpc({
    handle: (ch, fn) => { handlers.set(ch, fn) },
    readSettings: () => settings,
    saveSettings,
    loadHost,
  })
  const invoke = (ch: string, ...a: unknown[]) => handlers.get(ch)!(...a)
  return { handlers, host, loadHost, saveSettings, invoke, settings: () => settings }
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
    ].sort())
  })

  it('未启用:mffai:state 只读设置,不加载 host', async () => {
    const { invoke, loadHost } = setup({ enabled: false, autostart: false })
    expect(await invoke(CH.mffaiState)).toEqual({ enabled: false, autostart: false, running: false })
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
