import { describe, it, expect, afterEach, vi } from 'vitest'
import { startGateway } from './gateway'
import { createHostRouter } from './router'
import { createBroadcastHub } from '../ipc/broadcastHub'
import { NOOP_CTX, type MethodTable } from '../ipc/invokeCtx'
import type { RemoteHost } from './hostStore'

const closers: (() => Promise<void>)[] = []
afterEach(async () => { for (const c of closers.splice(0)) await c() })

const host = (address: string): RemoteHost => ({
  id: 'h1', label: '云服务器', kind: 'direct', address, sshTarget: '', icon: '', display: 'both', token: '', lastConnectedAt: 0,
})

async function setup(localTable: MethodTable, remoteTable: MethodTable) {
  const remoteHub = createBroadcastHub()
  const gw = await startGateway({ table: remoteTable, addSink: remoteHub.addSink, version: '1.1.2', port: 0 })
  closers.push(() => gw.close())

  const toWindows = vi.fn()
  const localHub = createBroadcastHub()
  const router = createHostRouter({
    localTable, toWindows, clientVersion: '1.1.2',
    onStatus: () => {},
    resolveUrl: async (h) => ({ url: h.address }),
  })
  localHub.addSink(router.localEvent)
  closers.push(() => router.disconnect())
  return { gw, router, toWindows, localHub, remoteHub, url: `ws://127.0.0.1:${gw.port}` }
}

const untilReady = async (router: ReturnType<typeof createHostRouter>) => {
  await expect.poll(() => router.status().state.status, { timeout: 3000 }).toBe('ready')
}

describe('host 路由', () => {
  it('没连远程时全部走本机', async () => {
    const { router } = await setup({ 'chat:send': () => '本机' }, { 'chat:send': () => '远程' })
    expect(await router.invoke('chat:send', NOOP_CTX, [])).toBe('本机')
    expect(router.status().hostId).toBeNull()
  })

  it('连上之后,跟机器走的方法转到远程', async () => {
    const s = await setup({ 'chat:send': () => '本机' }, { 'chat:send': () => '远程' })
    await s.router.connect(host(s.url))
    await untilReady(s.router)
    expect(await s.router.invoke('chat:send', NOOP_CTX, [])).toBe('远程')
  })

  it('★跟设备走的方法即使连着远程也留在本机 —— 连过去不该换掉你的壁纸', async () => {
    const s = await setup(
      { 'wallpaper:catalog': () => '本机壁纸', 'update:check': () => '本机更新' },
      { 'wallpaper:catalog': () => '远程壁纸', 'update:check': () => '远程更新' },
    )
    await s.router.connect(host(s.url))
    await untilReady(s.router)
    expect(await s.router.invoke('wallpaper:catalog', NOOP_CTX, [])).toBe('本机壁纸')
    expect(await s.router.invoke('update:check', NOOP_CTX, [])).toBe('本机更新')
  })

  describe('设置是组合出来的(第二期 C)', () => {
    const halves = (who: string) => ({
      'config:get-client-settings': () => ({ appearance: `${who}的主题`, appProxy: `${who}的app代理` }),
      'config:get-host-settings': () => ({ disabledProviders: [`${who}禁用的`], agentProxy: `${who}的agent代理` }),
      'config:set-client-settings': (_c: unknown, p: any) => ({ saved: 'client', got: p }),
      'config:set-host-settings': (_c: unknown, p: any) => ({ saved: 'host', got: p }),
    })

    it('★跟设备的那半边来自本机,跟机器的那半边来自远程', async () => {
      // 不这么做的话:连着云服务器时你看到并编辑的 disabledProviders / pluginCreds 其实是本机的,
      // 你以为在配那台机器,配的是自己 —— 而且界面上没有任何迹象。
      const s = await setup(halves('本机'), halves('远程'))
      await s.router.connect(host(s.url))
      await untilReady(s.router)
      expect(await s.router.invoke('config:get-settings', NOOP_CTX, [])).toEqual({
        appearance: '本机的主题', appProxy: '本机的app代理',
        disabledProviders: ['远程禁用的'], agentProxy: '远程的agent代理',
      })
    })

    it('没连远程时组合出来的就是纯本机那份(行为与拆分前一致)', async () => {
      const s = await setup(halves('本机'), halves('远程'))
      expect(await s.router.invoke('config:get-settings', NOOP_CTX, [])).toEqual({
        appearance: '本机的主题', appProxy: '本机的app代理',
        disabledProviders: ['本机禁用的'], agentProxy: '本机的agent代理',
      })
    })

    it('写设置时两半分别落到各自那一端', async () => {
      const seen: string[] = []
      const local = { ...halves('本机'), 'config:set-client-settings': (_c: unknown, p: any) => { seen.push('client'); return p } }
      const s = await setup(local, { ...halves('远程'), 'config:set-host-settings': (_c: unknown, p: any) => ({ ...p, wroteOn: '远程' }) })
      await s.router.connect(host(s.url))
      await untilReady(s.router)
      const r = await s.router.invoke('config:set-settings', NOOP_CTX, [{ appearance: 'x' }]) as any
      expect(seen).toEqual(['client'])          // 客户端那半边写在本机
      expect(r.wroteOn).toBe('远程')             // 机器那半边写去了远程
    })
  })

  it('★对方没有这个方法时报错,绝不悄悄回落到本机', async () => {
    // 回落的话「工作区列表」会在你以为在看服务器时显示本机的工作区,界面上零迹象。
    const s = await setup({ 'workspaces:list': () => ['本机工作区'] }, { 'chat:send': () => 1 })
    await s.router.connect(host(s.url))
    await untilReady(s.router)
    await expect(s.router.invoke('workspaces:list', NOOP_CTX, [])).rejects.toThrow(/不提供这个功能/)
  })

  it('★连着远程时,本机 agent 的事件不许漏进界面', async () => {
    // 决策 2:切到哪台就只看到哪台。漏进来的话你会看到一条不属于当前 host 的回复凭空冒出来。
    const s = await setup({ 'a:b': () => 1 }, { 'a:b': () => 1 })
    await s.router.connect(host(s.url))
    await untilReady(s.router)
    s.toWindows.mockClear()
    s.localHub.broadcast('chat:event', { from: '本机' })
    s.localHub.broadcast('run2:event', { from: '本机' })
    expect(s.toWindows).not.toHaveBeenCalled()
  })

  it('但「描述这台设备本身」的事件照常放行(设置/日志/快捷键/更新)', async () => {
    const s = await setup({ 'a:b': () => 1 }, { 'a:b': () => 1 })
    await s.router.connect(host(s.url))
    await untilReady(s.router)
    s.toWindows.mockClear()
    s.localHub.broadcast('settings:changed', { theme: 'dark' })
    s.localHub.broadcast('update:progress', { pct: 10 })
    expect(s.toWindows.mock.calls.map((c) => c[0])).toEqual(['settings:changed', 'update:progress'])
  })

  it('远程广播的事件送到界面', async () => {
    const s = await setup({ 'a:b': () => 1 }, { 'a:b': () => 1 })
    await s.router.connect(host(s.url))
    await untilReady(s.router)
    s.toWindows.mockClear()
    s.remoteHub.broadcast('chat:event', { from: '远程' })
    await expect.poll(() => s.toWindows.mock.calls.length, { timeout: 2000 }).toBe(1)
    expect(s.toWindows).toHaveBeenCalledWith('chat:event', { from: '远程' })
  })

  it('断开之后回到本机,本机事件也重新放行', async () => {
    const s = await setup({ 'chat:send': () => '本机' }, { 'chat:send': () => '远程' })
    await s.router.connect(host(s.url))
    await untilReady(s.router)
    await s.router.disconnect()
    expect(s.router.status().hostId).toBeNull()
    expect(await s.router.invoke('chat:send', NOOP_CTX, [])).toBe('本机')
    s.toWindows.mockClear()
    s.localHub.broadcast('chat:event', { from: '本机' })
    expect(s.toWindows).toHaveBeenCalledWith('chat:event', { from: '本机' })
  })

  it('连第二台时先把第一台断干净(不能两条连接同时往界面上推)', async () => {
    const s = await setup({ 'a:b': () => 1 }, { 'a:b': () => '第一台' })
    await s.router.connect(host(s.url))
    await untilReady(s.router)

    const hub2 = createBroadcastHub()
    const gw2 = await startGateway({ table: { 'a:b': () => '第二台' }, addSink: hub2.addSink, version: '1.1.2', port: 0 })
    closers.push(() => gw2.close())
    await s.router.connect({ ...host(`ws://127.0.0.1:${gw2.port}`), id: 'h2', label: '第二台' })
    await untilReady(s.router)

    expect(await s.router.invoke('a:b', NOOP_CTX, [])).toBe('第二台')
    s.toWindows.mockClear()
    s.remoteHub.broadcast('chat:event', { from: '第一台' })
    await new Promise((r) => setTimeout(r, 80))
    expect(s.toWindows).not.toHaveBeenCalled()
  })

  it('隧道拉不起来时不留下半连状态', async () => {
    const toWindows = vi.fn()
    const router = createHostRouter({
      localTable: { 'a:b': () => '本机' }, toWindows, clientVersion: '1.1.2',
      onStatus: () => {}, resolveUrl: async () => { throw new Error('ssh 起不来') },
    })
    await expect(router.connect(host('ws://x'))).rejects.toThrow('ssh 起不来')
    expect(router.status().hostId).toBeNull()
    expect(await router.invoke('a:b', NOOP_CTX, [])).toBe('本机')
  })

  it('★导出:内容来自那台机器,文件落在你面前这台(第二期 D)', async () => {
    // 无头机器上没有「保存到哪儿」这回事 —— 直接路由过去只会得到「这台主机没有桌面环境」。
    const saved: unknown[] = []
    const s = await setup(
      { 'client:save-file': (_c: unknown, a: any) => { saved.push(a); return { ok: true, path: '/本机/下载/x.json' } } },
      { 'config:export-projects-data': () => ({ name: 'x.json', content: '{"远程":"内容"}', title: '导出' }) },
    )
    await s.router.connect(host(s.url))
    await untilReady(s.router)
    const r = await s.router.invoke('config:export-projects', NOOP_CTX, [])
    expect(saved).toEqual([{ name: 'x.json', content: '{"远程":"内容"}', title: '导出' }])
    expect(r).toEqual({ ok: true, path: '/本机/下载/x.json' })
  })

  it('没连远程时导出照旧走本机那一条(行为与以前一致)', async () => {
    const s = await setup(
      { 'config:export-projects': () => ({ ok: true, path: '/本机/x.json' }), 'client:save-file': () => { throw new Error('不该走到这儿') } },
      { 'config:export-projects-data': () => ({ name: 'x.json', content: '', title: '' }) },
    )
    expect(await s.router.invoke('config:export-projects', NOOP_CTX, [])).toEqual({ ok: true, path: '/本机/x.json' })
  })

  it('★远程事件走单独的出口 —— 本机事件不能从两条路各触发一次(否则每条回复弹两个通知)', async () => {
    const remoteSeen: string[] = []
    const hub = createBroadcastHub()
    const gw = await startGateway({ table: { 'a:b': () => 1 }, addSink: hub.addSink, version: '1.1.2', port: 0 })
    closers.push(() => gw.close())
    const toWindows = vi.fn()
    const localHub = createBroadcastHub()
    const router = createHostRouter({
      localTable: { 'a:b': () => 1 }, toWindows, clientVersion: '1.1.2', onStatus: () => {},
      onRemoteEvent: (ch, p) => { remoteSeen.push(ch); toWindows(ch, p) },
      resolveUrl: async (h) => ({ url: h.address }),
    })
    localHub.addSink(router.localEvent)
    closers.push(() => router.disconnect())
    await router.connect(host(`ws://127.0.0.1:${gw.port}`))
    await expect.poll(() => router.status().state.status, { timeout: 3000 }).toBe('ready')

    // 本机事件:只走 toWindows,不许经过远程那条出口
    toWindows.mockClear()
    localHub.broadcast('settings:changed', {})
    expect(remoteSeen).toEqual([])

    // 远程事件:走远程出口(通知就是在那儿补的)
    hub.broadcast('chat:event', { type: 'done' })
    await expect.poll(() => remoteSeen.length, { timeout: 2000 }).toBe(1)
  })

  it('★改了当前这台主机的配置(改名/换标识/换显示方式)要当场生效,不用重连', async () => {
    // router.current 是 connect 那一刻的快照。不同步的话,你在设置里把「只显示标识」存下去,
    // 标题栏那枚芯片纹丝不动 —— 看起来就是「保存了但没生效」。真机验收就卡在这儿。
    const seen: string[] = []
    const hub2 = createBroadcastHub()
    const gw = await startGateway({ table: { 'a:b': () => 1 }, addSink: hub2.addSink, version: '1.1.2', port: 0 })
    closers.push(() => gw.close())
    const router = createHostRouter({
      localTable: { 'a:b': () => 1 }, toWindows: vi.fn(), clientVersion: '1.1.2',
      onStatus: (s) => seen.push(`${s.label}/${s.display ?? ''}/${s.icon ?? ''}`),
      resolveUrl: async (h) => ({ url: h.address }),
    })
    closers.push(() => router.disconnect())
    const h = { ...host(`ws://127.0.0.1:${gw.port}`), icon: '🌩', display: 'both' as const }
    await router.connect(h)
    await expect.poll(() => router.status().state.status, { timeout: 3000 }).toBe('ready')
    expect(router.status().display).toBe('both')

    router.hostUpdated({ ...h, label: '改了名', icon: '🏠', display: 'icon' })
    expect(router.status().display).toBe('icon')
    expect(router.status().icon).toBe('🏠')
    expect(router.status().label).toBe('改了名')
    expect(seen[seen.length - 1]).toBe('改了名/icon/🏠')      // 而且要广播出去,界面才会跟着变
  })

  it('改的是别的主机时不动当前这台', async () => {
    const s = await setup({ 'a:b': () => 1 }, { 'a:b': () => 1 })
    await s.router.connect(host(s.url))
    await untilReady(s.router)
    s.router.hostUpdated({ ...host('ws://x'), id: '别的', label: '别的主机' })
    expect(s.router.status().label).toBe('云服务器')
  })
})
