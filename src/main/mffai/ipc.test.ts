import { describe, it, expect, vi } from 'vitest'
import { dataDir } from '@mffai/protocol'
import { afterEach as afterEach4, beforeEach as beforeEach4 } from 'vitest'
import { dataRoots, secretsAccountOf, SECRETS_SERVICE, WorkerMethods, type WorkerMethodName } from '@mffai/protocol'
import { CH } from '../ipc/channels'
import { CLIENT_SETTING_KEYS, MffaiSchema, SettingsSchema, defaultSettings, type Settings } from '../config/schema'
import { createMffaiSettingsSync, mffaiTransition, registerMffaiIpc } from './ipc'
import { createWipeLock } from './wipeLock'

type Fn = (...a: unknown[]) => unknown
// 08 §5.3:停用状态多了 dataExists(setup 注入 exists → false)和 roots
const OFF_EXTRA = { dataExists: false, roots: { ...dataRoots(dataDir()), keychain: `${SECRETS_SERVICE}/${secretsAccountOf(dataDir())}` } }

const MODEL_CHANNELS = [
  CH.mffaiModelsCatalog, CH.mffaiModelsAccounts, CH.mffaiModelsAddAccount, CH.mffaiModelsRemoveAccount,
  CH.mffaiModelsTestAccount, CH.mffaiModelsSetDefault, CH.mffaiModelsQuota,
  CH.mffaiChatgptBegin, CH.mffaiChatgptCancel, CH.mffaiOpenExternal,
]
const CODING_CHANNELS = [CH.mffaiApprovalRespond, CH.mffaiRollback]
const PERMISSION_CHANNELS = [CH.mffaiPermissionsGet, CH.mffaiPermissionsSet]

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
    cancel: vi.fn(async () => ({ ok: true })),
    permissionsGet: vi.fn(async () => ({ config: {}, defaults: [], errors: [], sandbox: { level: 'full', missing: [], autoDegraded: false } })),
    permissionsSet: vi.fn(async () => ({ ok: true })),
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
    exists: () => false,
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
      CH.mffaiResetTrip, CH.mffaiSetAutostart, CH.mffaiTail, CH.mffaiPrompt, CH.mffaiCancel,
      ...MODEL_CHANNELS, ...CODING_CHANNELS, ...PERMISSION_CHANNELS,
      CH.mffaiCall, CH.mffaiWipe, // 08:没注入 handleFrom 时经 handle 注册,一律当别的窗口
    ].sort())
  })

  it('未启用:mffai:state 只读设置,不加载 host', async () => {
    const { invoke, loadHost } = setup({ enabled: false, autostart: false })
    expect(await invoke(CH.mffaiState)).toEqual({ enabled: false, autostart: false, running: false, dataDir: dataDir(), ...OFF_EXTRA })
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
    const off = { enabled: false, autostart: true, running: false, dataDir: dataDir(), ...OFF_EXTRA }
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

  // 08 §4.7、§10.1:自定义预设的手填模型清单和自标限制经这条通道转发;非字符串数组项、非法 restriction 值都丢掉
  it('已启用:addAccount 转发 modelIds 和 restriction,过滤掉不是字符串/不合法的项', async () => {
    const { invoke, host } = setup({ enabled: true, autostart: true })
    await invoke(CH.mffaiModelsAddAccount, { presetId: 'custom-x', apiKey: 'sk-1', modelIds: ['m-a', 'm-b', 1, null], restriction: 'coding-tools-only' })
    expect(host.addAccount).toHaveBeenCalledWith({ presetId: 'custom-x', apiKey: 'sk-1', modelIds: ['m-a', 'm-b'], restriction: 'coding-tools-only' })
    await invoke(CH.mffaiModelsAddAccount, { presetId: 'p', apiKey: 'sk-2', restriction: 'bogus' })
    expect(host.addAccount).toHaveBeenLastCalledWith({ presetId: 'p', apiKey: 'sk-2' })
  })
})

describe('mffai 权限通道', () => {
  it('通道名', () => {
    expect(PERMISSION_CHANNELS).toEqual(['mffai:permissions:get', 'mffai:permissions:set'])
  })

  it('未启用:两个通道都报未启用,不加载 host', async () => {
    const { invoke, loadHost, host } = setup({ enabled: false, autostart: true })
    await expect(invoke(CH.mffaiPermissionsGet, 's1')).rejects.toThrow('mff-ai 未启用')
    await expect(invoke(CH.mffaiPermissionsSet, { rules: [] })).rejects.toThrow('mff-ai 未启用')
    expect(loadHost).not.toHaveBeenCalled()
    expect(host.permissionsGet).not.toHaveBeenCalled()
    expect(host.permissionsSet).not.toHaveBeenCalled()
  })

  it('get:sessionId 只认非空字符串,其余当没给', async () => {
    const { invoke, host } = setup({ enabled: true, autostart: true })
    await invoke(CH.mffaiPermissionsGet, 's1')
    expect(host.permissionsGet).toHaveBeenLastCalledWith('s1')
    for (const v of [undefined, '', 3, { sessionId: 's1' }]) {
      await invoke(CH.mffaiPermissionsGet, v)
      expect(host.permissionsGet).toHaveBeenLastCalledWith()
    }
  })

  it('set:只收对象,原样转给 host;其它一律拒绝', async () => {
    const { invoke, host } = setup({ enabled: true, autostart: true })
    const config = { rules: [{ effect: 'deny', rule: 'shell(rm *)' }], network: { allow: ['x.test'] } }
    expect(await invoke(CH.mffaiPermissionsSet, config)).toEqual({ ok: true })
    expect(host.permissionsSet).toHaveBeenCalledWith(config)
    for (const bad of [undefined, null, 'x', 3, true, [], [{ rules: [] }]]) {
      await expect(invoke(CH.mffaiPermissionsSet, bad)).rejects.toThrow('invalid config')
    }
    expect(host.permissionsSet).toHaveBeenCalledTimes(1)
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

  it('停止:未启用报未启用且不加载 host;已启用转给 host', async () => {
    expect(CH.mffaiCancel).toBe('mffai:session:cancel')
    const off = setup({ enabled: false, autostart: true })
    await expect(off.invoke(CH.mffaiCancel, 's1')).rejects.toThrow('mff-ai 未启用')
    expect(off.loadHost).not.toHaveBeenCalled()
    const on = setup({ enabled: true, autostart: true })
    expect(await on.invoke(CH.mffaiCancel, 's1')).toEqual({ ok: true })
    expect(on.host.cancel).toHaveBeenCalledWith('s1')
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
    await invoke(CH.mffaiPrompt, 'hi', undefined, { sessionId: 's9', cwd: '/repo', approvalMode: 'auto' })
    expect(host.prompt).toHaveBeenLastCalledWith('hi', undefined, { sessionId: 's9' })
    await invoke(CH.mffaiPrompt, 'hi', undefined, { sessionId: 7, cwd: '/repo' })
    expect(host.prompt).toHaveBeenLastCalledWith('hi', undefined, { cwd: '/repo' })
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

// —— 08 Task 4:mffai:call / mffai:wipe ——

const SIDE = '/tmp/mffai-ipc-never-created/mff-ai'

function setupCall(mffai: Settings['mffai'], o: { handleFrom?: boolean; fromMain?: boolean } = {}) {
  let settings: Settings = { ...defaultSettings(), mffai }
  const handlers = new Map<string, Fn>()
  const fromHandlers = new Map<string, (fromMain: boolean, ...a: unknown[]) => unknown>()
  const host = {
    getState: vi.fn(async () => ({ enabled: settings.mffai.enabled, autostart: settings.mffai.autostart, running: true })),
    enable: vi.fn(async () => {}),
    call: vi.fn(async (_m: string, _p: Record<string, unknown>) => ({ ok: true, result: { fine: 1 } }) as unknown),
  }
  const loadHost = vi.fn(async () => host as never)
  const saveSettings = vi.fn((patch: Partial<Settings>) => { settings = { ...settings, ...patch } })
  const lock = createWipeLock()
  const logs: string[] = []
  const removed: string[] = []
  const runs: Array<[string, string[]]> = []
  const wipe = {
    controlAlive: vi.fn(async () => false),
    rm: vi.fn(async (p: string) => { removed.push(p) }),
    exists: vi.fn((_p: string) => true),
    run: vi.fn(async (c: string, a: string[]) => { runs.push([c, a]); return 0 }),
    platform: 'darwin' as NodeJS.Platform,
    home: '/tmp/mffai-ipc-home',
  }
  registerMffaiIpc({
    handle: (ch, fn) => { handlers.set(ch, fn) },
    ...(o.handleFrom !== false && { handleFrom: (ch: string, fn: (fromMain: boolean, ...a: unknown[]) => unknown) => { fromHandlers.set(ch, fn) } }),
    readSettings: () => settings,
    saveSettings,
    loadHost,
    openExternal: vi.fn(),
    exists: wipe.exists,
    wipe,
    lock,
    log: (m) => { logs.push(m) },
  })
  const fromMain = o.fromMain ?? true
  const invoke = (ch: string, ...a: unknown[]) => (fromHandlers.get(ch) ? fromHandlers.get(ch)!(fromMain, ...a) : handlers.get(ch)!(...a))
  return { handlers, fromHandlers, host, loadHost, saveSettings, invoke, logs, removed, runs, wipe, lock, settings: () => settings }
}

describe('mffai:call / mffai:wipe registration', () => {
  beforeEach4(() => { vi.stubEnv('MFFAI_DATA_DIR', SIDE) })
  afterEach4(() => { vi.unstubAllEnvs() })

  it('channel names', () => {
    expect(CH.mffaiCall).toBe('mffai:call')
    expect(CH.mffaiWipe).toBe('mffai:wipe')
  })

  it('register through handleFrom when given; otherwise through handle', () => {
    const a = setupCall({ enabled: true, autostart: true })
    expect([...a.fromHandlers.keys()].sort()).toEqual([CH.mffaiCall, CH.mffaiWipe])
    expect(a.handlers.has(CH.mffaiCall)).toBe(false)
    const b = setupCall({ enabled: true, autostart: true }, { handleFrom: false })
    expect(b.handlers.has(CH.mffaiCall) && b.handlers.has(CH.mffaiWipe)).toBe(true)
  })

  it('a sender that is not the main window: -32601 / sender, no host load, no fs', async () => {
    for (const enabled of [true, false]) {
      const t = setupCall({ enabled, autostart: true }, { fromMain: false })
      expect(await t.invoke(CH.mffaiCall, 'status', {})).toMatchObject({ ok: false, error: { code: -32601 } })
      expect(await t.invoke(CH.mffaiWipe)).toEqual({ ok: false, reason: 'sender' })
      expect(t.loadHost).not.toHaveBeenCalled()
      expect(t.wipe.controlAlive).not.toHaveBeenCalled()
      expect(t.removed).toEqual([])
    }
  })

  it('without handleFrom both channels treat every sender as not the main window', async () => {
    const t = setupCall({ enabled: true, autostart: true }, { handleFrom: false })
    expect(await t.invoke(CH.mffaiCall, 'status', {})).toMatchObject({ ok: false, error: { code: -32601 } })
    expect(await t.invoke(CH.mffaiWipe)).toEqual({ ok: false, reason: 'sender' })
    expect(t.loadHost).not.toHaveBeenCalled()
    expect(t.removed).toEqual([])
  })
})

describe('mffai:call', () => {
  beforeEach4(() => { vi.stubEnv('MFFAI_DATA_DIR', SIDE) })
  afterEach4(() => { vi.unstubAllEnvs() })

  it('disabled: -32000 and the host is never loaded', async () => {
    const t = setupCall({ enabled: false, autostart: true })
    expect(await t.invoke(CH.mffaiCall, 'session.list', {})).toEqual({ ok: false, error: { code: -32000, message: 'disabled' } })
    expect(t.loadHost).not.toHaveBeenCalled()
  })

  it('every WorkerMethods key but the five excluded reaches host.call; the five and unknown names answer -32601 without the host', async () => {
    const t = setupCall({ enabled: true, autostart: true })
    const excluded = ['auth.challenge', 'auth.verify', 'hello', 'events.subscribe', 'auth.chatgpt.begin']
    for (const m of [...excluded, 'nope', '__proto__', 'constructor', 'toString', 42, undefined]) {
      expect(await t.invoke(CH.mffaiCall, m, {}), String(m)).toMatchObject({ ok: false, error: { code: -32601 } })
    }
    expect(t.loadHost).not.toHaveBeenCalled()
    const allowed = Object.keys(WorkerMethods).filter((m) => !excluded.includes(m))
    for (const m of allowed) expect(await t.invoke(CH.mffaiCall, m, {}), m).toEqual({ ok: true, result: { fine: 1 } })
    expect(t.host.call.mock.calls.map((c) => c[0])).toEqual(allowed)
  })

  it('params must be a plain object (or absent); anything else is -32602 without the host', async () => {
    const t = setupCall({ enabled: true, autostart: true })
    for (const bad of [null, 'x', 3, [], [{ a: 1 }], true]) {
      expect(await t.invoke(CH.mffaiCall, 'session.list', bad), JSON.stringify(bad)).toMatchObject({ ok: false, error: { code: -32602 } })
    }
    expect(t.loadHost).not.toHaveBeenCalled()
    await t.invoke(CH.mffaiCall, 'session.list')
    expect(t.host.call).toHaveBeenLastCalledWith('session.list', {})
  })

  it('session.create drops origin / audience / projectTop; session.prompt drops external', async () => {
    const t = setupCall({ enabled: true, autostart: true })
    await t.invoke(CH.mffaiCall, 'session.create', { commandId: 'c1', title: 't', cwd: '/r', origin: 'im', audience: 'group', projectTop: '/top' })
    expect(t.host.call).toHaveBeenLastCalledWith('session.create', { commandId: 'c1', title: 't', cwd: '/r' })
    await t.invoke(CH.mffaiCall, 'session.prompt', { commandId: 'c2', sessionId: 's', text: 'hi', external: true })
    expect(t.host.call).toHaveBeenLastCalledWith('session.prompt', { commandId: 'c2', sessionId: 's', text: 'hi' })
  })

  it('adds a commandId only when the method has one and the page left it out', async () => {
    const t = setupCall({ enabled: true, autostart: true })
    const last = () => t.host.call.mock.calls.at(-1)![1]
    await t.invoke(CH.mffaiCall, 'session.rename', { sessionId: 's', title: 'x' })
    expect(last().commandId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/))
    await t.invoke(CH.mffaiCall, 'session.rename', { commandId: 'mine', sessionId: 's', title: 'x' })
    expect(last().commandId).toBe('mine')
    await t.invoke(CH.mffaiCall, 'executor.refresh', {}) // optional commandId: still added
    expect(typeof last().commandId).toBe('string')
    for (const m of ['channel.telegram.setToken', 'plugins.settings.set', 'channel.telegram.pairing.begin', 'plugins.dev.trust', 'status', 'session.list'] as WorkerMethodName[]) {
      await t.invoke(CH.mffaiCall, m, {})
      expect('commandId' in last(), m).toBe(false)
    }
  })

  it('the host envelope comes back as is (error code and data intact)', async () => {
    const t = setupCall({ enabled: true, autostart: true })
    const env = { ok: false, error: { code: -32003, message: 'busy', data: [{ index: 0, id: 'n_x' }] } }
    t.host.call.mockResolvedValueOnce(env)
    expect(await t.invoke(CH.mffaiCall, 'memory.deleteMany', { commandId: 'c', ids: ['n_x'] })).toEqual(env)
  })

  it('a host that throws becomes a -32603 envelope', async () => {
    const t = setupCall({ enabled: true, autostart: true })
    t.host.call.mockRejectedValueOnce(new Error('boom'))
    expect(await t.invoke(CH.mffaiCall, 'session.list', {})).toMatchObject({ ok: false, error: { code: -32603 } })
  })
})

describe('mffai:wipe', () => {
  beforeEach4(() => { vi.stubEnv('MFFAI_DATA_DIR', SIDE) })
  afterEach4(() => { vi.unstubAllEnvs() })

  it('disabled: removes the four roots and the keychain entry with the injected fs and control client; never loads host', async () => {
    const t = setupCall({ enabled: false, autostart: true })
    const r = await t.invoke(CH.mffaiWipe)
    const r0 = dataRoots(SIDE)
    const roots = [r0.worktrees, r0.imWorktrees, r0.plugins, r0.data] // 数据根最后删
    expect(t.removed).toEqual(roots)
    expect(t.runs).toEqual([['/usr/bin/security', ['delete-generic-password', '-a', secretsAccountOf(SIDE), '-s', SECRETS_SERVICE]]])
    expect(r).toEqual({ ok: true, removed: [...roots, `${SECRETS_SERVICE}/${secretsAccountOf(SIDE)}`] })
    expect(t.wipe.controlAlive).toHaveBeenCalledTimes(1)
    expect(t.loadHost).not.toHaveBeenCalled()
    // logged as paths only
    expect(t.logs).toEqual([`mffai wipe removed: ${[...roots, `${SECRETS_SERVICE}/${secretsAccountOf(SIDE)}`].join(', ')}`])
  })

  it('enabled → refused, nothing removed', async () => {
    const t = setupCall({ enabled: true, autostart: true })
    expect(await t.invoke(CH.mffaiWipe)).toEqual({ ok: false, reason: 'enabled' })
    expect(t.removed).toEqual([])
    expect(t.loadHost).not.toHaveBeenCalled()
  })

  it('control port answers → running', async () => {
    const t = setupCall({ enabled: false, autostart: true })
    t.wipe.controlAlive.mockResolvedValueOnce(true)
    expect(await t.invoke(CH.mffaiWipe)).toEqual({ ok: false, reason: 'running' })
    expect(t.removed).toEqual([])
  })

  it('an rm failure answers failed and logs the path only', async () => {
    const t = setupCall({ enabled: false, autostart: true })
    t.wipe.rm.mockRejectedValueOnce(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
    expect(await t.invoke(CH.mffaiWipe)).toEqual({ ok: false, reason: 'failed' })
    expect(t.logs.join('\n')).toContain('mffai wipe failed')
  })

  it('mffai:enable while a wipe is in flight answers wiping and leaves settings untouched; a second wipe is refused', async () => {
    const t = setupCall({ enabled: false, autostart: true })
    let release!: () => void
    t.wipe.controlAlive.mockImplementationOnce(() => new Promise<boolean>((r) => { release = () => r(false) }))
    const w = t.invoke(CH.mffaiWipe) as Promise<unknown>
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await expect(t.invoke(CH.mffaiEnable)).rejects.toThrow('wiping')
    expect(await t.invoke(CH.mffaiWipe)).toEqual({ ok: false, reason: 'wiping' })
    expect(t.saveSettings).not.toHaveBeenCalled()
    expect(t.loadHost).not.toHaveBeenCalled()
    release()
    expect(await w).toMatchObject({ ok: true })
    // the flag clears in finally
    await t.invoke(CH.mffaiEnable)
    expect(t.saveSettings).toHaveBeenCalledWith({ mffai: { enabled: true, autostart: true } })
  })

  it('the flag clears even when the wipe throws', async () => {
    const t = setupCall({ enabled: false, autostart: true })
    t.wipe.controlAlive.mockRejectedValueOnce(new Error('weird'))
    expect(await t.invoke(CH.mffaiWipe)).toEqual({ ok: false, reason: 'failed' })
    await t.invoke(CH.mffaiEnable)
    expect(t.saveSettings).toHaveBeenCalledTimes(1)
  })
})

describe('mffai:state while disabled (08 §5.3)', () => {
  beforeEach4(() => { vi.stubEnv('MFFAI_DATA_DIR', SIDE) })
  afterEach4(() => { vi.unstubAllEnvs() })

  it('adds dataExists and roots without loading host', async () => {
    const t = setupCall({ enabled: false, autostart: true })
    t.wipe.exists.mockReturnValue(false)
    expect(await t.invoke(CH.mffaiState)).toEqual({
      enabled: false, autostart: true, running: false, dataDir: SIDE, dataExists: false,
      roots: { ...dataRoots(SIDE), keychain: `${SECRETS_SERVICE}/${secretsAccountOf(SIDE)}` },
    })
    t.wipe.exists.mockReturnValue(true)
    expect((await t.invoke(CH.mffaiState) as { dataExists: boolean }).dataExists).toBe(true)
    expect(t.wipe.exists).toHaveBeenCalledWith(SIDE)
    expect(t.loadHost).not.toHaveBeenCalled()
  })
})

describe('08 Task 4 review fixes (ipc)', () => {
  beforeEach4(() => { vi.stubEnv('MFFAI_DATA_DIR', SIDE) })
  afterEach4(() => { vi.unstubAllEnvs() })

  it('I1: the wipe is refused while a loaded host reports an op (e.g. disable temp-spawning to unregister autostart)', async () => {
    const t = setupCall({ enabled: false, autostart: true })
    t.lock.setOpProbe(() => 'disable')
    expect(await t.invoke(CH.mffaiWipe)).toEqual({ ok: false, reason: 'busy' })
    expect(t.wipe.controlAlive).not.toHaveBeenCalled()
    expect(t.removed).toEqual([])
    expect(t.lock.active()).toBe(false)
    t.lock.setOpProbe(() => undefined)
    expect(await t.invoke(CH.mffaiWipe)).toMatchObject({ ok: true })
  })

  it('I1: the settings toggle path does not load or enable the host while a wipe runs; it does once the wipe ends', async () => {
    const lock = createWipeLock()
    const host = { enable: vi.fn(async () => {}), disable: vi.fn(async () => {}), setAutostart: vi.fn(async () => {}) }
    const loadHost = vi.fn(async () => host as never)
    const fn = createMffaiSettingsSync({ initial: { enabled: false, autostart: true }, loadHost, onError: vi.fn(), lock })
    expect(lock.begin()).toBe(true)
    fn({ mffai: { enabled: true, autostart: true } })
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(loadHost).not.toHaveBeenCalled()
    lock.end()
    await vi.waitFor(() => expect(host.enable).toHaveBeenCalledTimes(1))
  })

  it('I3: disabled dataExists stays true while any root is left (a partial wipe keeps the button)', async () => {
    const t = setupCall({ enabled: false, autostart: true })
    t.wipe.exists.mockImplementation((p: string) => p === `${SIDE}-plugins`)
    expect((await t.invoke(CH.mffaiState) as { dataExists: boolean }).dataExists).toBe(true)
    t.wipe.exists.mockImplementation(() => false)
    expect((await t.invoke(CH.mffaiState) as { dataExists: boolean }).dataExists).toBe(false)
  })

  it('M2: params over 8 MB of JSON answer -32602 without loading the host', async () => {
    const t = setupCall({ enabled: true, autostart: true })
    const big = { commandId: 'c', sessionId: 's', text: 'x'.repeat(8 * 1024 * 1024) }
    expect(await t.invoke(CH.mffaiCall, 'session.prompt', big)).toMatchObject({ ok: false, error: { code: -32602 } })
    expect(t.loadHost).not.toHaveBeenCalled()
    await t.invoke(CH.mffaiCall, 'session.prompt', { ...big, text: 'x'.repeat(1024) })
    expect(t.host.call).toHaveBeenCalledTimes(1)
  })
})

describe('dataDir dep (Task 15)', () => {
  afterEach4(() => { vi.unstubAllEnvs() })
  const OTHER = '/tmp/mffai-ipc-never-created-t15/mff-ai'
  const reg = (dataDirDep: string | undefined) => {
    const handlers = new Map<string, Fn>()
    const fromHandlers = new Map<string, (fromMain: boolean, ...a: unknown[]) => unknown>()
    const removed: string[] = []
    const runs: Array<[string, string[]]> = []
    const loadHost = vi.fn(async () => ({}) as never)
    registerMffaiIpc({
      handle: (ch, fn) => { handlers.set(ch, fn) },
      handleFrom: (ch, fn) => { fromHandlers.set(ch, fn) },
      readSettings: () => ({ ...defaultSettings(), mffai: { enabled: false, autostart: true } }),
      saveSettings: vi.fn(),
      loadHost,
      openExternal: vi.fn(),
      exists: () => false,
      ...(dataDirDep !== undefined && { dataDir: dataDirDep }),
      wipe: {
        controlAlive: async () => false,
        rm: async (p) => { removed.push(p) },
        exists: (p) => p.startsWith(OTHER),
        run: async (c, a) => { runs.push([c, a]); return 0 },
        readFile: () => undefined,
        platform: 'darwin',
        home: '/tmp/mffai-ipc-home-t15',
      },
      lock: createWipeLock(),
    })
    return { handlers, fromHandlers, removed, runs, loadHost }
  }

  it('disabledState and wipe use the given dataDir', async () => {
    vi.stubEnv('MFFAI_DATA_DIR', '')
    const t = reg(OTHER)
    expect(await t.handlers.get(CH.mffaiState)!()).toEqual({
      enabled: false, autostart: true, running: false, dataDir: OTHER, dataExists: false,
      roots: { ...dataRoots(OTHER), keychain: `${SECRETS_SERVICE}/${secretsAccountOf(OTHER)}` },
    })
    expect(await t.fromHandlers.get(CH.mffaiWipe)!(true)).toMatchObject({ ok: true })
    const r0 = dataRoots(OTHER)
    expect(t.removed).toEqual([r0.worktrees, r0.imWorktrees, r0.plugins, r0.data])
    expect(t.runs).toEqual([['/usr/bin/security', ['delete-generic-password', '-a', secretsAccountOf(OTHER), '-s', SECRETS_SERVICE]]])
    expect(t.loadHost).not.toHaveBeenCalled()
  })

  it('without the dep: MFFAI_DATA_DIR, else dataDir() as before', async () => {
    vi.stubEnv('MFFAI_DATA_DIR', '')
    expect((await reg(undefined).handlers.get(CH.mffaiState)!() as { dataDir: string }).dataDir).toBe(dataDir())
    vi.stubEnv('MFFAI_DATA_DIR', OTHER)
    expect((await reg(undefined).handlers.get(CH.mffaiState)!() as { dataDir: string }).dataDir).toBe(OTHER)
  })
})
