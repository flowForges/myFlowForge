import { describe, it, expect, afterEach } from 'vitest'
import { startGateway } from './gateway'
import { connectRemote, type RemoteState } from './remoteClient'
import { connectHost, type HostState } from '../../../mobile/src/net/hostClient'
import { createBroadcastHub } from '../ipc/broadcastHub'
import { generateIdentity, toBase64 } from '@shared/remote/e2e'
import type { MethodTable } from '../ipc/invokeCtx'

/**
 * 真网关 + **两个真客户端**(桌面端 `remoteClient` / 手机端 `hostClient`)。
 *
 * ★★为什么要连手机端那一份也拉进来跑:「三档判据」在两个文件里各写了一遍
 *  (`remoteClient.ts` 和 `hostClient.ts`,注释里互相声明"逐字同一套")。
 *  而真正每天在走的那条路是**手机端**的那一份 —— 上面那句声明本身没有任何东西钉着它。
 *  这里两个客户端跑同一组断言:任何一边漂了,这个文件就红。
 *
 * ★手机端那份用的是平台自带的全局 `WebSocket`(node 22 自带),不是 `ws` 包 ——
 *  正好把「RN 那侧的 API 差异(addEventListener / 没有 terminate)」也一起过一遍。
 */

const closers: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const c of closers.splice(0)) await c() })

/**
 * ★`e2eGraceMs` 默认给**大**的。
 *
 * 嗅探窗口是「窗口内没等到 hs-init 就断定对面是明文客户端」。全量并行跑时 CPU 是饱和的,
 * 客户端的 hs-init 完全可能晚于一个 60ms 的窗口到达 —— 于是网关回明文 hello,
 * 而客户端报「对面这台电脑的版本太老」。**那是测试机器慢,不是代码错**,
 * 但它长得和真 bug 一模一样,查起来会先怀疑加密那条路。
 *
 * 所以:要验**加密**的用例把窗口调大(等多久都无所谓,hs-init 一到就立刻决定,零延迟);
 * 只有要验**明文**的那条才需要小窗口 —— 它是唯一真的要等窗口过完的。
 */
async function serve(
  table: MethodTable,
  identity?: Parameters<typeof startGateway>[0]['identity'],
  e2eGraceMs = 2000,
) {
  const hub = createBroadcastHub()
  const gw = await startGateway({
    table, addSink: hub.addSink, version: '1.2.0', port: 0, identity, e2eGraceMs,
  })
  closers.push(() => gw.close())
  return { gw, hub }
}

const until = <S extends { status: string }>(
  get: () => S,
  on: (cb: (s: S) => void) => () => void,
  want: S['status'],
) => new Promise<void>((res, rej) => {
  if (get().status === want) return res()
  const t = setTimeout(() => rej(new Error(`等 ${want} 超时,停在 ${JSON.stringify(get())}`)), 4000)
  const off = on((s) => {
    if (s.status === want) { clearTimeout(t); off(); res() }
    if (s.status === 'failed') { clearTimeout(t); off(); rej(new Error(JSON.stringify(s))) }
  })
})

/** 两个客户端各包一层,变成同一个形状 —— 下面的断言就能一字不差地跑两遍。 */
const DESKTOP = {
  name: '桌面端 remoteClient',
  connect(port: number, pubKey?: string, token?: string) {
    const c = connectRemote({
      url: `ws://127.0.0.1:${port}`, clientVersion: '1.2.0', pubKey, token,
      onEvent: () => {}, backoff: false, readyTimeoutMs: 4000,
    })
    closers.push(() => c.close())
    return {
      ready: () => until<RemoteState>(() => c.state(), (cb) => c.onState(cb), 'ready'),
      invoke: (ch: string, args: unknown[]) => c.invoke(ch, args),
      state: () => c.state(),
    }
  },
}

const MOBILE = {
  name: '手机端 hostClient',
  connect(port: number, pubKey?: string, token?: string) {
    const c = connectHost({
      url: `ws://127.0.0.1:${port}`, clientVersion: '1.2.0', pubKey, token,
      onEvent: () => {}, backoff: false, readyTimeoutMs: 4000,
    })
    closers.push(() => c.close())
    return {
      ready: () => until<HostState>(() => c.state(), (cb) => c.onState(cb), 'ready'),
      invoke: (ch: string, args: unknown[]) => c.invoke(ch, args),
      state: () => c.state(),
    }
  },
}

for (const CLIENT of [DESKTOP, MOBILE]) {
  describe(`${CLIENT.name} ↔ 局域网网关`, () => {
    it('★★带公钥、没有中转 = 直连 + 端到端加密 —— 能 ready、能 invoke', async () => {
      const identity = generateIdentity()
      const { gw } = await serve({ 'a:b': (_ctx, n) => `收到 ${n}` }, identity)
      const c = CLIENT.connect(gw.port, toBase64(identity.publicKey))
      await c.ready()
      expect(await c.invoke('a:b', [7])).toBe('收到 7')
    })

    it('★加密那条路上令牌照样校验', async () => {
      const identity = generateIdentity()
      const hub = createBroadcastHub()
      const gw = await startGateway({
        table: { 'a:b': () => 1 }, addSink: hub.addSink, version: '1.2.0', port: 0,
        identity, token: '口令', e2eGraceMs: 60,
      })
      closers.push(() => gw.close())
      const c = CLIENT.connect(gw.port, toBase64(identity.publicKey), '口令')
      await c.ready()
      expect(await c.invoke('a:b', [])).toBe(1)
    })

    it('★不带公钥 = 明文直连(老配对码),照旧能 ready、能 invoke', async () => {
      const identity = generateIdentity()
      // ★这条是唯一真的要等窗口过完的 —— 小窗口,别让它白等两秒
      const { gw } = await serve({ 'a:b': () => '明文' }, identity, 60)
      const c = CLIENT.connect(gw.port)
      await c.ready()
      expect(await c.invoke('a:b', [])).toBe('明文')
    })

    it('公钥不是对面那把 —— 连不上,而且**不降级成明文**', async () => {
      const identity = generateIdentity()
      const { gw } = await serve({ 'a:b': () => 1 }, identity)
      const c = CLIENT.connect(gw.port, toBase64(generateIdentity().publicKey))
      await expect(c.ready()).rejects.toThrow()
      expect(c.state().status).not.toBe('ready')
    })
  })
}
