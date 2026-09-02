import {
  clientHandshakeFinish,
  clientHandshakeInit,
  hostHandshakeReply,
  open,
  seal,
  type Identity,
  type Session,
} from './e2e'
import type { Channel } from './channel'

/**
 * 把一条**明文的**双工信道,变成一条端到端加密的双工信道。
 *
 * ★★放在 `src/shared` 而不是 `src/main`:**手机端也要用客户端那一半**。
 *  原来它在 `src/main/remote/` 下,而那儿的 `serveConnection.ts` import 了 `node:crypto` ——
 *  手机 import 过来会把整条链拖进 RN 的 bundle。现在这个文件只依赖 `./e2e`(纯 tweetnacl)
 *  和 `./channel`(零 import 的类型)。
 *
 * ## 为什么要单独一层
 *
 * `serveConnection` 只认「发一行文本、收一行文本」(见 `channel.ts` 的 `Channel`)。加密不该渗进它 ——
 * 局域网直连那条路根本不套加密(那条链路上没有第三方),而中转那条路每一个字节都必须封起来。
 * 两条路要跑**同一套** hello/auth/ready/req/res,所以差异必须收在一层里,就是这一层。
 *
 * ## 顺序:握手必须在 `serveConnection` **之前**
 *
 * ★★`serveConnection` 一被调用就会立刻 `send({t:'hello'})`。如果这时候会话密钥还没协商出来,
 *  那一帧要么明文漏出去,要么得在这一层攒着 —— 攒着意味着一个"有时候发得出、有时候攒着"的
 *  send,而它出错时的表现是「连上了但永远不 ready」,最难查的那一类。
 *  所以这里的做法是:**握完手才把 `Channel` 交出去**(`onReady`),在那之前 `serveConnection`
 *  根本还没被创建。代价是每条逻辑连接多一个 RTT,换来的是 send 只有一种行为。
 *
 * ## 解不开的帧一律**丢掉,不断线**
 *
 * 解不开只有三种可能:被改过、重放、或者不是这把密钥。前两种是攻击,第三种是中转把别人的
 * 帧串过来了。★都不该断连接:断连接把「往这条链路上灌垃圾」变成了一个**谁都能按的**
 * 拒绝服务开关 —— 而丢帧的代价只是那一帧没到,上层本来就要处理丢包。
 */

export type E2ELink = {
  /** 对面来了一行原始文本(握手帧或密文帧)。 */
  receive(raw: string): void
  /** 这条逻辑连接没了。**必须调**,否则上层的 sink 不会被摘掉。 */
  closed(): void
}

type Wire = {
  /** 把一行原始文本发给对面(中转那一侧负责套信封)。 */
  sendRaw: (text: string) => void
  /** 关掉这条逻辑连接。 */
  closeRaw: (code: number, reason: string) => void
  onLog?: (msg: string) => void
}

/** 用一把已经协商好的会话密钥,造出交给 `serveConnection` 的那个 `Channel`。 */
function sealedChannel(session: Session, wire: Wire, hooks: { msg?: (t: string) => void; close?: () => void }): Channel {
  return {
    send: (text) => {
      const enc = seal(session, text)
      if (!enc) {
        // 计数器到顶。★绝不允许回绕 —— 回绕就是 nonce 重用,等于把密钥流重复用一遍。
        // 只能重新握手,而这一层没有那个权力,所以断掉让上层重连。
        wire.onLog?.('会话计数器到顶,断开重连')
        wire.closeRaw(4499, 'counter exhausted')
        return
      }
      wire.sendRaw(JSON.stringify(enc))
    },
    onMessage: (cb) => { hooks.msg = cb },
    close: (code, reason) => wire.closeRaw(code, reason),
    onClose: (cb) => { hooks.close = cb },
  }
}

/**
 * daemon 那一侧。等客户端的 `hs-init`,用**长期私钥**签名回复,握完手把 `Channel` 交出去。
 *
 * ★签名覆盖两个一次性公钥(实现在 `e2e.ts`),所以这次回复搬不到别的会话里去用。
 */
export function hostE2ELink(identity: Identity, wire: Wire, onReady: (ch: Channel) => void): E2ELink {
  let session: Session | null = null
  // ★★握手失败是**终态**。不置这个旗子的话,失败之后紧跟着到达的在途帧会再走一遍
  //  握手分支,把失败原因覆盖成一句无关的「形状不对」—— 排查时看到的是最后那一条,
  //  而真正的原因(签名验不过)已经没了。`closeRaw` 只是发出关闭意图,在途的帧照样会来。
  let dead = false
  const hooks: { msg?: (t: string) => void; close?: () => void } = {}

  return {
    receive(raw) {
      if (dead) return
      if (!session) {
        let init: unknown
        try { init = JSON.parse(raw) } catch { return die(4400, 'bad handshake') }
        const f = init as { t?: unknown; epk?: unknown }
        // ★第一帧必须是 hs-init,别的一律断。这是这条连接上唯一一次"我们知道该收到什么"的时刻,
        //  放宽等于给了对面一个在加密之前跟我们说话的机会。
        if (f?.t !== 'hs-init' || typeof f.epk !== 'string') return die(4400, 'expected hs-init')
        const r = hostHandshakeReply(identity, { t: 'hs-init', epk: f.epk })
        if (!r) return die(4400, 'bad ephemeral key')
        session = r.session
        // ★先把回复发出去,再交出 Channel。反过来的话 `serveConnection` 的 hello 会排在
        //  hs-reply 前面 —— 对面还没有会话密钥,那一帧它解不开,直接丢,然后永远等 hello。
        wire.sendRaw(JSON.stringify(r.frame))
        onReady(sealedChannel(session, wire, hooks))
        return
      }
      let frame: unknown
      try { frame = JSON.parse(raw) } catch { return wire.onLog?.('丢弃一条不是 JSON 的密文帧') }
      const f = frame as { t?: unknown; c?: unknown }
      if (f?.t !== 'enc' || typeof f.c !== 'string') return wire.onLog?.('丢弃一条形状不对的帧')
      const plain = open(session, { t: 'enc', c: f.c })
      // ★解不开就丢,不断线。理由见文件顶部那段。
      if (plain === null) return wire.onLog?.('丢弃一条解不开的帧(被改过 / 重放 / 不是这把密钥)')
      hooks.msg?.(plain)
    },
    closed() {
      hooks.close?.()
    },
  }

  function die(code: number, reason: string) {
    dead = true
    wire.closeRaw(code, reason)
  }
}

/**
 * 客户端那一侧。掏一次性密钥、发 `hs-init`、**拿配对时那把公钥验签**,握完手交出 `Channel`。
 *
 * ★`trustedPub` 必须来自配对链接(人从电脑屏幕搬到手机上的那一把)。
 *  拿对面这一帧里带的东西去验对面的签名,等于没验 —— 任何人都能自签一对。
 */
export function clientE2ELink(
  trustedPub: Uint8Array,
  wire: Wire,
  onReady: (ch: Channel) => void,
  onFail?: (why: string) => void,
): E2ELink {
  const { pending, frame } = clientHandshakeInit()
  let session: Session | null = null
  // ★★同 host 那一侧:握手失败是终态。见那边的注释 —— 这条不加的话,验签失败之后
  //  紧跟着到达的第一帧业务数据(对面已经在发 hello 了)会把 `onFail` 的原因覆盖成
  //  「形状不对」,而那是**症状**不是**原因**。
  let dead = false
  const hooks: { msg?: (t: string) => void; close?: () => void } = {}
  // ★造出来就把 hs-init 放到线上。客户端是发起方,没有"等对面先说"这一档 ——
  //  多一个"要不要现在发"的开关,只会多一条"忘了发,于是永远连不上"的路径。
  wire.sendRaw(JSON.stringify(frame))

  return {
    receive(raw) {
      if (dead) return
      if (!session) {
        let reply: unknown
        try { reply = JSON.parse(raw) } catch { return fail('对面的握手回复不是 JSON') }
        const f = reply as { t?: unknown; epk?: unknown; sig?: unknown }
        if (f?.t !== 'hs-reply' || typeof f.epk !== 'string' || typeof f.sig !== 'string') {
          // ★这句话要**指着最可能的那个原因**说。走到这儿最常见的一种是:对面版本太老,
          //  它的局域网网关根本不会握手(2026-09-02 之前 E2E 只在中转那条路上有),
          //  于是回过来的是一帧明文 `hello`。「形状不对」是症状,升级才是解法。
          return fail(
            (f as { t?: unknown })?.t === 'hello'
              ? '对面这台电脑的版本太老,还不支持直连加密 —— 把它升到同一版本,或者在它那边打开中转'
              : '对面的握手回复形状不对',
          )
        }
        const s = clientHandshakeFinish(pending, { t: 'hs-reply', epk: f.epk, sig: f.sig }, trustedPub)
        // ★★验不过就是**验不过**,不重试、不降级。这一步是整条链路的信任锚点:
        //  它没过,意味着对面不是你配对的那台机器(或者中间有人),继续下去毫无意义。
        if (!s) return fail('对面证明不了自己是你配对的那台电脑 —— 中转可能被人换掉了')
        session = s
        onReady(sealedChannel(session, wire, hooks))
        return
      }
      let msg: unknown
      try { msg = JSON.parse(raw) } catch { return wire.onLog?.('丢弃一条不是 JSON 的密文帧') }
      const f = msg as { t?: unknown; c?: unknown }
      if (f?.t !== 'enc' || typeof f.c !== 'string') return wire.onLog?.('丢弃一条形状不对的帧')
      const plain = open(session, { t: 'enc', c: f.c })
      if (plain === null) return wire.onLog?.('丢弃一条解不开的帧(被改过 / 重放 / 不是这把密钥)')
      hooks.msg?.(plain)
    },
    closed() {
      hooks.close?.()
    },
  }

  function fail(why: string) {
    dead = true
    wire.onLog?.(why)
    onFail?.(why)
    wire.closeRaw(4401, 'handshake failed')
  }
}
