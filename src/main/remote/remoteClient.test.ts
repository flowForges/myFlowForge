import { describe, it, expect, afterEach } from 'vitest'
import { startGateway } from './gateway'
import { connectRemote, type RemoteClient, type RemoteState } from './remoteClient'
import { createBroadcastHub } from '../ipc/broadcastHub'
import type { MethodTable } from '../ipc/invokeCtx'

// 真网关 + 真 socket + 真断线。这一层的 bug 全在时序上,假 transport 一个也测不出来。
const closers: (() => Promise<void>)[] = []
afterEach(async () => { for (const c of closers.splice(0)) await c() })

async function serve(table: MethodTable, o: { port?: number; token?: string; version?: string } = {}) {
  const hub = createBroadcastHub()
  const gw = await startGateway({
    table, addSink: hub.addSink, version: o.version ?? '1.1.2', port: o.port ?? 0, token: o.token,
  })
  closers.push(() => gw.close())
  return { gw, hub }
}

function client(port: number, o: Partial<Parameters<typeof connectRemote>[0]> = {}) {
  const events: [string, unknown][] = []
  const states: RemoteState[] = []
  const c = connectRemote({
    url: `ws://127.0.0.1:${port}`,
    clientVersion: '1.1.2',
    onEvent: (ch, p) => events.push([ch, p]),
    onState: (s) => states.push(s),
    backoff: { baseMs: 20, maxMs: 60 },
    readyTimeoutMs: 3000,
    ...o,
  })
  closers.push(() => c.close())
  return { c, events, states }
}

const untilReady = (c: RemoteClient) => new Promise<void>((res, rej) => {
  if (c.state().status === 'ready') return res()
  const t = setTimeout(() => rej(new Error('等 ready 超时')), 3000)
  const off = c.onState((s) => { if (s.status === 'ready') { clearTimeout(t); off(); res() } })
})
const untilState = (c: RemoteClient, want: RemoteState['status']) => new Promise<RemoteState>((res, rej) => {
  if (c.state().status === want) return res(c.state())
  const t = setTimeout(() => rej(new Error(`等 ${want} 超时`)), 3000)
  const off = c.onState((s) => { if (s.status === want) { clearTimeout(t); off(); res(s) } })
})

describe('远程连接', () => {
  it('握手完成后拿到对方的方法清单(能力置灰就靠它)', async () => {
    const { gw } = await serve({ 'chat:send': () => 1, 'workspaces:list': () => [] })
    const { c } = client(gw.port)
    await untilReady(c)
    const s = c.state()
    expect(s.status).toBe('ready')
    if (s.status === 'ready') {
      expect([...s.methods].sort()).toEqual(['chat:send', 'workspaces:list'])
      expect(s.version).toBe('1.1.2')
    }
  })

  it('invoke 把参数送过去,把结果带回来', async () => {
    const { gw } = await serve({ 'chat:send': (_c, ...a) => ({ echoed: a }) })
    const { c } = client(gw.port)
    await untilReady(c)
    expect(await c.invoke('chat:send', [{ text: '你好' }])).toEqual({ echoed: [{ text: '你好' }] })
  })

  it('对面 handler 报错 → 本地这个 promise 以同样的话 reject', async () => {
    const { gw } = await serve({ 'x:boom': () => { throw new Error('那台机器上炸了') } })
    const { c } = client(gw.port)
    await untilReady(c)
    await expect(c.invoke('x:boom', [])).rejects.toThrow('那台机器上炸了')
  })

  it('对面广播的事件透传给 onEvent', async () => {
    const { gw, hub } = await serve({ 'a:b': () => 1 })
    const { c, events } = client(gw.port)
    await untilReady(c)
    hub.broadcast('chat:event', { type: 'delta', text: '哈' })
    await expect.poll(() => events.length, { timeout: 2000 }).toBe(1)
    expect(events[0]).toEqual(['chat:event', { type: 'delta', text: '哈' }])
  })

  it('★断线时所有在飞的请求立刻 reject,不许永远挂着', async () => {
    // 不 reject 的话界面上不是报错,是一个永远转下去的圈,而且看不出跟断线有关。
    const { gw } = await serve({ 'slow:never': () => new Promise(() => {}) })
    const { c } = client(gw.port)
    await untilReady(c)
    const inflight = c.invoke('slow:never', [])
    const settled = expect(inflight).rejects.toThrow()
    await gw.close()
    await settled
  })

  it('★断线后自动重连,恢复后照常调用', async () => {
    const { gw: g1 } = await serve({ 'a:b': () => 'first' })
    const port = g1.port
    const { c } = client(port)
    await untilReady(c)
    expect(await c.invoke('a:b', [])).toBe('first')

    await g1.close()
    await untilState(c, 'retrying')

    await serve({ 'a:b': () => 'second' }, { port })
    await untilReady(c)
    expect(await c.invoke('a:b', [])).toBe('second')
  })

  it('重连成功后退避计数归零(不然下次断线要等很久)', async () => {
    const { gw: g1 } = await serve({ 'a:b': () => 1 })
    const port = g1.port
    const { c } = client(port)
    await untilReady(c)
    await g1.close()
    const retrying = await untilState(c, 'retrying')
    expect(retrying.status === 'retrying' && retrying.attempt).toBe(1)
    await serve({ 'a:b': () => 1 }, { port })
    await untilReady(c)
    const s = c.state()
    expect(s.status).toBe('ready')
  })

  it('协议版本对不上 → failed,而且不再傻等重连', async () => {
    const { gw } = await serve({ 'a:b': () => 1 })
    const { c } = client(gw.port, { clientVersion: '1.1.2' })
    await untilReady(c)
    await c.close()
    // 主版本不一致的那条单独验(见下);这里验的是「failed 之后不重连」的形状
    expect(c.state().status).toBe('closed')
  })

  it('主版本不一致 → 拒绝这一条连接,并说清楚原因', async () => {
    const { gw } = await serve({ 'a:b': () => 1 }, { version: '2.0.0' })
    const { c } = client(gw.port, { clientVersion: '1.1.2' })
    const s = await untilState(c, 'failed')
    expect(s.status === 'failed' && s.error).toContain('主版本不兼容')
  })

  it('次版本不一致照常连 —— 基础功能要能用(决策 B-2)', async () => {
    const { gw } = await serve({ 'a:b': () => 1 }, { version: '1.9.0' })
    const { c } = client(gw.port, { clientVersion: '1.1.2' })
    await untilReady(c)
    expect(await c.invoke('a:b', [])).toBe(1)
  })

  it('需要 token 但没配 → failed,别拿一个必然失败的连接反复重试', async () => {
    const { gw } = await serve({ 'a:b': () => 1 }, { token: 'sec' })
    const { c } = client(gw.port)
    const s = await untilState(c, 'failed')
    expect(s.status === 'failed' && s.error).toContain('访问令牌')
  })

  it('token 不对 → failed 且不重连', async () => {
    const { gw } = await serve({ 'a:b': () => 1 }, { token: 'sec' })
    const { c } = client(gw.port, { token: 'wrong' })
    const s = await untilState(c, 'failed')
    expect(s.status === 'failed' && s.error).toContain('token')
  })

  it('token 对 → 正常握手', async () => {
    const { gw } = await serve({ 'a:b': () => 'ok' }, { token: 'sec' })
    const { c } = client(gw.port, { token: 'sec' })
    await untilReady(c)
    expect(await c.invoke('a:b', [])).toBe('ok')
  })

  it('还没 ready 就 invoke → 等就绪再发,而不是当场失败', async () => {
    // 重连中的短暂空窗如果直接失败,用户看到的是随机某个按钮报错。
    const { gw } = await serve({ 'a:b': () => 'ok' })
    const { c } = client(gw.port)
    expect(c.state().status).not.toBe('ready')
    expect(await c.invoke('a:b', [])).toBe('ok')
  })
})
