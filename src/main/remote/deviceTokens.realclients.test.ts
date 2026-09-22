import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'

/**
 * 按设备发令牌 —— 真网关 + 真客户端(桌面端 remoteClient / 手机端 hostClient)。
 *
 * ★★钉的是用户 2026-09-22 的两句话:
 *  「点击中断,然后发现又会自动连上,我怎么永久剔除呢?」—— 移除之后必须当场断开、而且**不会自动重连**;
 *  「如果我连接秘钥泄露了,如何重置呢?」—— 撤销必须**立刻**生效,不能像原来那样要重启 app。
 * 落盘换成内存(不碰真的 ~/.myFlowForge)。
 */
const disk = new Map<string, unknown>()
vi.mock('../config/paths', () => ({ sysFile: (n: string) => `/fake/${n}` }))
vi.mock('../config/store', () => ({
  readJson: (f: string, schema: { parse: (v: unknown) => unknown }, fallback: () => unknown) =>
    disk.has(f) ? schema.parse(disk.get(f)) : fallback(),
  writeJson: (f: string, v: unknown) => { disk.set(f, v) },
}))

import { startGateway } from './gateway'
import { connectRemote, type RemoteState } from './remoteClient'
import { connectHost, type HostState } from '../../../mobile/src/net/hostClient'
import { createBroadcastHub } from '../ipc/broadcastHub'
import { generateIdentity, toBase64 } from '@shared/remote/e2e'
import { deviceAuth, pairingToken, revokeDevice, revokeAll, listDevices, checkToken, LEGACY_ID } from './deviceTokens'
import { ensureToken } from '../daemon/config'
import { startRelay } from '../../../relay/src/node'
import { startRelayHost } from './relayHost'

const closers: (() => Promise<void> | void)[] = []
beforeEach(() => disk.clear())
afterEach(async () => { for (const c of closers.splice(0)) await c() })

async function serve() {
  const identity = generateIdentity()
  const hub = createBroadcastHub()
  const gw = await startGateway({
    table: { 'a:b': () => 'ok' }, addSink: hub.addSink, version: '1.2.0', port: 0,
    identity, token: deviceAuth(), e2eGraceMs: 2000,
  })
  closers.push(() => gw.close())
  return { gw, pubKey: toBase64(identity.publicKey) }
}

type S = { status: string; error?: string }
const until = (get: () => S, on: (cb: (s: S) => void) => () => void, want: (s: S) => boolean, what: string) =>
  new Promise<S>((res, rej) => {
    if (want(get())) return res(get())
    const t = setTimeout(() => rej(new Error(`等「${what}」超时,停在 ${JSON.stringify(get())}`)), 5000)
    const off = on((s) => { if (want(s)) { clearTimeout(t); off(); res(s) } })
  })

const CLIENTS = {
  desktop(port: number, pubKey: string, token: string, label?: string) {
    // ★backoff 开着 —— 就是要验证「被移除之后不会自己重连回来」
    const c = connectRemote({ url: `ws://127.0.0.1:${port}`, clientVersion: '1.2.0', pubKey, token, clientLabel: label, onEvent: () => {}, backoff: { baseMs: 100, maxMs: 300 }, readyTimeoutMs: 4000 })
    closers.push(() => c.close())
    return { state: () => c.state() as S, on: (cb: (s: S) => void) => c.onState(cb as (s: RemoteState) => void), invoke: (ch: string) => c.invoke(ch, []) }
  },
  mobile(port: number, pubKey: string, token: string) {
    const c = connectHost({ url: `ws://127.0.0.1:${port}`, clientVersion: '1.2.0', pubKey, token, onEvent: () => {}, backoff: { baseMs: 100, maxMs: 300 }, readyTimeoutMs: 4000 })
    closers.push(() => c.close())
    return { state: () => c.state() as S, on: (cb: (s: S) => void) => c.onState(cb as (s: HostState) => void), invoke: (ch: string) => c.invoke(ch, []) }
  },
}
const ready = (c: { state: () => S; on: (cb: (s: S) => void) => () => void }) => until(c.state, c.on, (s) => s.status === 'ready', 'ready')

describe('按设备发令牌', () => {
  it('★★移除一台:它当场断开、不会自己重连;另一台照常能用', async () => {
    const { gw, pubKey } = await serve()
    const a = pairingToken()
    // 第一枚码还没被用过 —— 再要一次是同一枚(展开 / 收起二维码不该凭空多一条)
    expect(pairingToken().id).toBe(a.id)
    const phone = CLIENTS.mobile(gw.port, pubKey, a.token)
    await ready(phone)
    const b = pairingToken()
    expect(b.id, '第一枚被用过之后,再要就是新的一枚').not.toBe(a.id)
    const laptop = CLIENTS.desktop(gw.port, pubKey, b.token, '同事的 MacBook')
    await ready(laptop)

    revokeDevice(a.id)
    const s = await until(phone.state, phone.on, (x) => x.status === 'failed', 'failed')
    expect(s.error).toMatch(/token|令牌/)
    // 等过一个退避周期,确认它没有自己连回来
    await new Promise((r) => setTimeout(r, 1200))
    expect(phone.state().status).toBe('failed')
    expect(laptop.state().status).toBe('ready')
    expect(await laptop.invoke('a:b')).toBe('ok')
    // 拿着被移除的令牌重新连:进不来
    const again = CLIENTS.desktop(gw.port, pubKey, a.token)
    await until(again.state, again.on, (x) => x.status === 'failed', 'failed')
  })

  it('连上之后用对方自报的名字给这一条起名,并记下在线', async () => {
    const { gw, pubKey } = await serve()
    const p = pairingToken()
    const c = CLIENTS.desktop(gw.port, pubKey, p.token, '同事的 MacBook')
    await ready(c)
    await new Promise((r) => setTimeout(r, 200))
    const row = listDevices().find((d) => d.id === p.id)!
    expect(row.label).toBe('同事的 MacBook')
    expect(row.pending).toBe(false)
    expect(row.online).toBe(true)
  })

  it('★升级前配对的设备(共用旧令牌)照常能连;撤销旧码后它断开,新配对的不受影响', async () => {
    const legacy = ensureToken()   // 升级前就存在的那把共用令牌
    const { gw, pubKey } = await serve()
    const old = CLIENTS.mobile(gw.port, pubKey, legacy)
    await ready(old)
    expect(listDevices()[0]).toMatchObject({ id: LEGACY_ID, legacy: true, online: true })
    const fresh = CLIENTS.desktop(gw.port, pubKey, pairingToken().token)
    await ready(fresh)

    revokeDevice(LEGACY_ID)
    await until(old.state, old.on, (x) => x.status === 'failed', 'failed')
    expect(fresh.state().status).toBe('ready')
    expect(checkToken(legacy)).toBeNull()
    expect(listDevices().some((d) => d.legacy)).toBe(false)
  })

  it('★全部撤销:所有连接立刻断开,所有令牌作废(令牌泄露又不知道是哪台时)', async () => {
    const legacy = ensureToken()
    const { gw, pubKey } = await serve()
    const t1 = pairingToken().token
    const c1 = CLIENTS.desktop(gw.port, pubKey, t1)
    await ready(c1)
    const c2 = CLIENTS.mobile(gw.port, pubKey, legacy)
    await ready(c2)
    revokeAll()
    await until(c1.state, c1.on, (x) => x.status === 'failed', 'c1 failed')
    await until(c2.state, c2.on, (x) => x.status === 'failed', 'c2 failed')
    expect(checkToken(t1)).toBeNull()
    expect(checkToken(legacy)).toBeNull()
    expect(listDevices()).toEqual([])
  })

  /**
   * ★中转那一跳会丢关闭码:移除时 host 用 4403 关逻辑连接,中转一律用 4410 关客户端。
   *  客户端已经 ready 时 4410 看着像普通断线 ⇒ 它会**重连一次**,重新鉴权时令牌被拒 ⇒ 停在 failed。
   *  结论一样:连不回来,也不会一直刷重连。
   */
  it('★走中转时移除一台:同样连不回来,另一台不受影响', async () => {
    const relay = await startRelay({ port: 0, host: '127.0.0.1' })
    closers.push(() => relay.close())
    const identity = generateIdentity()
    const hub = createBroadcastHub()
    const h = startRelayHost({
      relayUrl: `ws://127.0.0.1:${relay.port}`, identity, table: { 'a:b': () => 'ok' },
      addSink: hub.addSink, version: '1.2.0', token: deviceAuth(), backoff: { baseMs: 20, maxMs: 60 },
    })
    closers.unshift(() => h.close())
    const pubKey = toBase64(identity.publicKey)
    const viaRelay = (token: string) => {
      const c = connectRemote({
        url: 'ws://127.0.0.1:1', relayUrl: `ws://127.0.0.1:${relay.port}`, clientVersion: '1.2.0', pubKey, token,
        onEvent: () => {}, backoff: { baseMs: 20, maxMs: 60 }, readyTimeoutMs: 4000,
      })
      closers.unshift(() => c.close())
      return { state: () => c.state() as S, on: (cb: (s: S) => void) => c.onState(cb as (s: RemoteState) => void), invoke: (ch: string) => c.invoke(ch, []) }
    }
    const a = pairingToken()
    const ca = viaRelay(a.token)
    await ready(ca)
    const cb = viaRelay(pairingToken().token)
    await ready(cb)

    revokeDevice(a.id)
    await until(ca.state, ca.on, (x) => x.status === 'failed', 'failed')
    await new Promise((r) => setTimeout(r, 400))   // 好几个退避周期(20–60ms)过去,仍然没连回来
    expect(ca.state().status).toBe('failed')
    expect(cb.state().status).toBe('ready')
    expect(await cb.invoke('a:b')).toBe('ok')
  })

  it('全新安装没有旧令牌时,不凭空多出一条「旧配对码」', () => {
    expect(listDevices()).toEqual([])
    expect(checkToken('')).toBeNull()
    expect(checkToken('随便写的')).toBeNull()
  })
})
