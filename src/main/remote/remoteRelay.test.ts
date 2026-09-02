import { describe, it, expect, afterEach } from 'vitest'
import { startRelay, type RelayHandle } from '../../../relay/src/node'
import { startRelayHost } from './relayHost'
import { connectRemote, type RemoteClient, type RemoteState } from './remoteClient'
import { createBroadcastHub } from '../ipc/broadcastHub'
import { toBase64, generateIdentity } from '@shared/remote/e2e'
import type { MethodTable } from '../ipc/invokeCtx'

/**
 * **一台电脑经中转连另一台电脑。**
 *
 * ★★2026-09-02 之前这条路只有手机端能走:`hostStore` 没有 pubKey/relay 字段,
 *  `remoteClient` 里 `relay|pubKey|sealed|e2e` 一个都搜不到,连接就一句 `new WebSocket(opts.url)`。
 *  桌面端只能直连或走 SSH 隧道,而且**直连是明文的** —— 同一个 daemon,两个客户端,
 *  一个加密一个不加密。
 *
 * ★这一组用**真中转 + 真 daemon 侧 relayHost + 真客户端**,不是假 transport:
 *  这一层的 bug 全在时序和握手顺序上(先 join 还是先握手、房间里没人时发 hs-init 谁来接、
 *  peer-offline 时在飞的请求谁来 reject),假 transport 一个也测不出来。
 *  同一条规矩已经写在 `remoteClient.test.ts` 顶上。
 */
const closers: (() => Promise<void> | void)[] = []
let relay: RelayHandle | null = null
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c()
  await relay?.close()
  relay = null
})

const untilState = (c: RemoteClient, want: RemoteState['status'], ms = 5000) =>
  new Promise<RemoteState>((res, rej) => {
    if (c.state().status === want) return res(c.state())
    const t = setTimeout(() => rej(new Error(`等 ${want} 超时,现在是 ${c.state().status}`)), ms)
    const off = c.onState((s) => { if (s.status === want) { clearTimeout(t); off(); res(s) } })
  })

/** 起一台「被连的电脑」:它把自己挂到中转的房间里。 */
async function hostSide(table: MethodTable, o: { token?: string } = {}) {
  const identity = generateIdentity()
  const hub = createBroadcastHub()
  const h = startRelayHost({
    relayUrl: `ws://127.0.0.1:${relay!.port}`,
    identity,
    table,
    addSink: hub.addSink,
    version: '1.1.2',
    token: o.token,
    backoff: { baseMs: 20, maxMs: 60 },
  })
  closers.push(() => h.close())
  return { identity, pubKey: toBase64(identity.publicKey), hub }
}

/** 起一台「去连的电脑」。★`url` 是那台机器的局域网地址 —— 走中转时它只是个记录,连不到。 */
function clientSide(o: { pubKey?: string; relayUrl?: string; token?: string }) {
  const events: [string, unknown][] = []
  const c = connectRemote({
    url: 'ws://127.0.0.1:1',            // 故意是个连不上的地址:证明真的走了中转
    clientVersion: '1.1.2',
    clientLabel: '另一台笔记本',
    onEvent: (ch, p) => events.push([ch, p]),
    backoff: { baseMs: 20, maxMs: 60 },
    readyTimeoutMs: 4000,
    ...o,
  })
  closers.push(() => c.close())
  return { c, events }
}

describe('电脑经中转连电脑', () => {
  it('★★整条链路真的通:握手、拿到方法表、调一个方法拿到返回值', async () => {
    relay = await startRelay({ port: 0, host: '127.0.0.1' })
    const host = await hostSide({ 'workspaces:list': () => [{ name: 'alpha' }], 'chat:send': () => 'ok' })

    const { c } = clientSide({ pubKey: host.pubKey, relayUrl: `ws://127.0.0.1:${relay.port}` })
    const st = await untilState(c, 'ready')
    expect(st.status === 'ready' && [...st.methods]).toContain('workspaces:list')

    // ★真调一次:握手过了不等于**协议帧**过得去(加密层拆包、cid 多路复用都在这一跳上)。
    await expect(c.invoke('workspaces:list', [])).resolves.toEqual([{ name: 'alpha' }])
  })

  it('★令牌走的是同一条加密信道,对面认得出来', async () => {
    relay = await startRelay({ port: 0, host: '127.0.0.1' })
    const host = await hostSide({ 'a:b': () => 1 }, { token: 'sekret' })
    const { c } = clientSide({ pubKey: host.pubKey, relayUrl: `ws://127.0.0.1:${relay.port}`, token: 'sekret' })
    await untilState(c, 'ready')
    await expect(c.invoke('a:b', [])).resolves.toBe(1)
  })

  it('★令牌不对时**不重试** —— 用退避刷一个不会变的错,只会刷一整晚日志', async () => {
    relay = await startRelay({ port: 0, host: '127.0.0.1' })
    const host = await hostSide({ 'a:b': () => 1 }, { token: 'right' })
    const { c } = clientSide({ pubKey: host.pubKey, relayUrl: `ws://127.0.0.1:${relay.port}`, token: 'wrong' })
    const st = await untilState(c, 'failed')
    expect(st.status === 'failed' && st.error).toBeTruthy()
  })

  /**
   * ★★这一条是**安全边界**,不是易用性:有中转地址却没有公钥时,绝不许悄悄降级成明文中转 ——
   *  那等于把令牌和全部内容交给一台第三方服务器。当配置错误直接失败,让人看得见。
   */
  it('★★配了中转但没有公钥 = 直接失败,不许降级成明文中转', async () => {
    relay = await startRelay({ port: 0, host: '127.0.0.1' })
    const { c } = clientSide({ relayUrl: `ws://127.0.0.1:${relay.port}` })   // 故意不给 pubKey
    const st = await untilState(c, 'failed')
    expect(st.status === 'failed' && st.error).toContain('公钥')
  })

  it('★对面还没上线时保持等待,不退避重连 —— 那台电脑可能只是还没开机', async () => {
    relay = await startRelay({ port: 0, host: '127.0.0.1' })
    const identity = generateIdentity()
    const { c } = clientSide({ pubKey: toBase64(identity.publicKey), relayUrl: `ws://127.0.0.1:${relay.port}` })
    // 房间里没有 host。★状态应该停在 connecting(等着),而不是 retrying/failed。
    await new Promise((r) => setTimeout(r, 400))
    expect(c.state().status).toBe('connecting')
  })
})
