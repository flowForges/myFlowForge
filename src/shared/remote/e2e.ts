import nacl from 'tweetnacl'

/**
 * 端到端加密层(设计文档决策 5)。
 *
 * ★**中转是不可信的哑管道**。这一层的全部意义是:即使中转服务器完全被控制,它也
 *  ① 读不到任何内容 ② 改不了任何一个字节而不被发现 ③ 冒充不了任何一端。
 *  它能做的只有丢包 —— 那是拒绝服务,不是泄密。
 *
 * ★**加密层与传输无关**。走中转和走直连是同一套代码,两条路**都不需要 TLS 证书**。
 *  所以「直连」不是降级方案,安全性等同(决策 6)。
 *
 * ## 信任锚点
 *
 * daemon 有一对**长期 Ed25519 身份密钥**。公钥印在配对链接 / 二维码里,由人从
 * 电脑屏幕搬到手机上 —— **这是整条链路里唯一不经过网络的一步**,也因此是唯一的信任锚点。
 * 客户端认的是这个公钥,不是地址:换了中转、换了 IP、换了端口,认的还是同一台 daemon。
 *
 * ## 握手(三步,前向保密)
 *
 * ```
 * client → daemon   hs-init   { epk: 客户端一次性公钥 }
 * daemon → client   hs-reply  { epk: daemon 一次性公钥, sig: 长期私钥签(daemon_epk ‖ client_epk) }
 * 双方各自 ECDH(自己的一次性私钥, 对方的一次性公钥) → 会话密钥
 * ```
 *
 * ★**签名必须覆盖两个一次性公钥**,不能只签自己那个。只签自己的话,一个中间人可以把
 *  daemon 在别的会话里发过的 reply 原样搬过来 —— 签名照样验得过,而他手里有那个会话的
 *  一次性私钥,于是完全接管。把对方的公钥也签进去,签名就和这一次握手绑死了。
 *
 * ★**两端都用一次性密钥**,所以长期私钥即使日后泄露,也解不开录下来的历史流量。
 *  如果 daemon 图省事直接拿长期密钥做 ECDH,这条性质就没了。
 *
 * ## 防重放
 *
 * nonce 不是随机的,是 `方向 ‖ 单调计数器`。接收方要求计数器**严格递增** ——
 * 录下一条密文重发,计数器不前进,直接丢。方向占一个字节,避免两端各自从 0 开始时撞 nonce
 * (同一把会话密钥下 nonce 重用 = XSalsa20 的密钥流重用 = 明文可恢复)。
 */

/** 一次握手协商出来的会话状态。**不要序列化它** —— 它一次性,断线就重新握手。 */
export type Session = {
  /** ECDH 之后预计算的对称密钥(nacl.box.before 的产物)。 */
  key: Uint8Array
  /** 我发出去的帧用哪个方向字节。 */
  sendDir: number
  /** 我收到的帧应该是哪个方向字节。 */
  recvDir: number
  /** 我已经发了多少条。 */
  sendCounter: number
  /** 对方最后一条的计数器。收到的必须严格大于它。 */
  lastRecvCounter: number
}

/** daemon 的长期身份。私钥只落在 daemon 那台机器上,公钥进配对链接。 */
export type Identity = { publicKey: Uint8Array; secretKey: Uint8Array }

/** 握手中途的客户端状态:一次性密钥对,等对面回复。 */
export type PendingHandshake = { ephemeral: nacl.BoxKeyPair }

export const DIR_CLIENT_TO_HOST = 0
export const DIR_HOST_TO_CLIENT = 1

// ── base64:自己实现,不用 Buffer / btoa ─────────────────────────────────────
// ★这一层要在 **Electron 主进程 / React Native(Hermes)/ Cloudflare Worker** 三种运行时里跑。
//  `Buffer` 只有 Node 有,`btoa` Hermes 上不保证有,`TextEncoder` 也不保证。
//  纯算术实现没有任何平台依赖 —— 这一层是安全边界,不值得为了省 20 行去赌某个全局对象存在。
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += B64[b0 >> 2]
    out += B64[((b0 & 3) << 4) | (b1 >> 4)]
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '='
    out += i + 2 < bytes.length ? B64[b2 & 63] : '='
  }
  return out
}

export function fromBase64(s: string): Uint8Array | null {
  const clean = s.replace(/=+$/, '')
  // ★非法字符必须让整个解码失败,不能悄悄跳过。对面发来的任何垃圾都该在这里被挡住,
  //  而不是解出一段「差不多」的字节再拿去当密文。
  if (!/^[A-Za-z0-9+/]*$/.test(clean)) return null
  if (clean.length % 4 === 1) return null
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let p = 0
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64.indexOf(clean[i])
    const c1 = B64.indexOf(clean[i + 1] ?? 'A')
    const c2 = B64.indexOf(clean[i + 2] ?? 'A')
    const c3 = B64.indexOf(clean[i + 3] ?? 'A')
    out[p++] = (c0 << 2) | (c1 >> 4)
    if (i + 2 < clean.length) out[p++] = ((c1 & 15) << 4) | (c2 >> 2)
    if (i + 3 < clean.length) out[p++] = ((c2 & 3) << 6) | c3
  }
  return out.subarray(0, p)
}

/** UTF-8 编解码,同样不依赖 TextEncoder/TextDecoder(Hermes 上不保证有)。 */
export function utf8ToBytes(s: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i)
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1)
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00)
        i++
        out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
        continue
      }
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return new Uint8Array(out)
}

export function bytesToUtf8(b: Uint8Array): string {
  let out = ''
  for (let i = 0; i < b.length; ) {
    const c = b[i]
    if (c < 0x80) {
      out += String.fromCharCode(c)
      i += 1
    } else if (c < 0xe0) {
      out += String.fromCharCode(((c & 31) << 6) | (b[i + 1] & 63))
      i += 2
    } else if (c < 0xf0) {
      out += String.fromCharCode(((c & 15) << 12) | ((b[i + 1] & 63) << 6) | (b[i + 2] & 63))
      i += 3
    } else {
      const cp = ((c & 7) << 18) | ((b[i + 1] & 63) << 12) | ((b[i + 2] & 63) << 6) | (b[i + 3] & 63)
      const v = cp - 0x10000
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 1023))
      i += 4
    }
  }
  return out
}

// ── 身份与配对 ───────────────────────────────────────────────────────────────

/** 生成 daemon 的长期身份。**一台机器一次**,私钥落盘,公钥进配对链接。 */
export function generateIdentity(): Identity {
  const kp = nacl.sign.keyPair()
  return { publicKey: kp.publicKey, secretKey: kp.secretKey }
}

/**
 * 配对链接。**它只承载「这台 daemon 是谁」,不承载「怎么连上它」**——
 * 地址可以变(换中转、换 IP),身份不变。
 *
 * 形如 `myflowforge://pair?k=<base64 公钥>&a=<地址>&n=<显示名>`。
 */
export function pairingLink(pub: Uint8Array, addr: string, name?: string): string {
  const q = [`k=${encodeURIComponent(toBase64(pub))}`, `a=${encodeURIComponent(addr)}`]
  if (name) q.push(`n=${encodeURIComponent(name)}`)
  return `myflowforge://pair?${q.join('&')}`
}

export type Pairing = { publicKey: Uint8Array; addr: string; name?: string }

/**
 * 解配对链接。**任何一处不对就整条拒绝** —— 这是信任锚点,
 * 「大概能解出来」在这里等于「接受了一个来路不明的公钥」。
 */
export function parsePairingLink(link: string): Pairing | null {
  const m = /^myflowforge:\/\/pair\?(.+)$/.exec(link.trim())
  if (!m) return null
  const params = new Map<string, string>()
  for (const kv of m[1].split('&')) {
    const i = kv.indexOf('=')
    if (i < 0) continue
    try {
      params.set(kv.slice(0, i), decodeURIComponent(kv.slice(i + 1)))
    } catch {
      return null // 坏的百分号转义
    }
  }
  const k = params.get('k')
  const a = params.get('a')
  if (!k || !a) return null
  const pub = fromBase64(k)
  // Ed25519 公钥就是 32 字节。长度不对说明这根本不是一把公钥,别往下走。
  if (!pub || pub.length !== nacl.sign.publicKeyLength) return null
  const name = params.get('n')
  return { publicKey: pub, addr: a, name: name || undefined }
}

// ── 握手 ─────────────────────────────────────────────────────────────────────

export type HandshakeInit = { t: 'hs-init'; epk: string }
export type HandshakeReply = { t: 'hs-reply'; epk: string; sig: string }

/** 客户端第一步:掏出一次性密钥对,把公钥发过去。 */
export function clientHandshakeInit(): { pending: PendingHandshake; frame: HandshakeInit } {
  const ephemeral = nacl.box.keyPair()
  return { pending: { ephemeral }, frame: { t: 'hs-init', epk: toBase64(ephemeral.publicKey) } }
}

/** 签名覆盖的字节:daemon 的一次性公钥 ‖ 客户端的一次性公钥。顺序固定,两端必须一致。 */
function signedBytes(hostEpk: Uint8Array, clientEpk: Uint8Array): Uint8Array {
  const out = new Uint8Array(hostEpk.length + clientEpk.length)
  out.set(hostEpk, 0)
  out.set(clientEpk, hostEpk.length)
  return out
}

/**
 * daemon 第二步:自己也掏一次性密钥对,用**长期私钥**签「两个一次性公钥」,回过去。
 * 同时它这一侧的会话密钥就已经能算出来了。
 */
export function hostHandshakeReply(
  identity: Identity,
  init: HandshakeInit,
): { session: Session; frame: HandshakeReply } | null {
  const clientEpk = fromBase64(init.epk)
  if (!clientEpk || clientEpk.length !== nacl.box.publicKeyLength) return null
  const ephemeral = nacl.box.keyPair()
  const sig = nacl.sign.detached(signedBytes(ephemeral.publicKey, clientEpk), identity.secretKey)
  return {
    session: {
      key: nacl.box.before(clientEpk, ephemeral.secretKey),
      sendDir: DIR_HOST_TO_CLIENT,
      recvDir: DIR_CLIENT_TO_HOST,
      sendCounter: 0,
      lastRecvCounter: -1,
    },
    frame: { t: 'hs-reply', epk: toBase64(ephemeral.publicKey), sig: toBase64(sig) },
  }
}

/**
 * 客户端第三步:**先验签,再算密钥**。
 *
 * ★`trustedPub` 必须来自配对链接(人从屏幕上搬过来的那把),**绝不能**用对面这一帧里带的任何东西。
 *  拿对面自报的公钥去验对面的签名,等于没验 —— 任何人都能自签一对。
 */
export function clientHandshakeFinish(
  pending: PendingHandshake,
  reply: HandshakeReply,
  trustedPub: Uint8Array,
): Session | null {
  const hostEpk = fromBase64(reply.epk)
  const sig = fromBase64(reply.sig)
  if (!hostEpk || hostEpk.length !== nacl.box.publicKeyLength) return null
  if (!sig || sig.length !== nacl.sign.signatureLength) return null
  if (trustedPub.length !== nacl.sign.publicKeyLength) return null
  const ok = nacl.sign.detached.verify(signedBytes(hostEpk, pending.ephemeral.publicKey), sig, trustedPub)
  if (!ok) return null
  return {
    key: nacl.box.before(hostEpk, pending.ephemeral.secretKey),
    sendDir: DIR_CLIENT_TO_HOST,
    recvDir: DIR_HOST_TO_CLIENT,
    sendCounter: 0,
    lastRecvCounter: -1,
  }
}

// ── 收发 ─────────────────────────────────────────────────────────────────────

export type EncFrame = { t: 'enc'; c: string }

/** nonce = 方向(1 字节) ‖ 计数器(大端 8 字节) ‖ 零填充。同一把会话密钥下必须唯一。 */
function makeNonce(dir: number, counter: number): Uint8Array {
  const n = new Uint8Array(nacl.box.nonceLength)
  n[0] = dir
  // JS 的安全整数是 53 位,写满低 6 字节足够 —— 会话是一次性的,不可能发到 2^48 条。
  let c = counter
  for (let i = 8; i >= 3; i--) {
    n[i] = c & 0xff
    c = Math.floor(c / 256)
  }
  return n
}

/** 计数器上限。到顶必须重新握手,**绝不允许回绕** —— 回绕就是 nonce 重用。 */
export const MAX_COUNTER = 2 ** 48 - 1

/**
 * 把一个明文帧封成密文帧。会**就地推进** session 的发送计数器。
 * 计数器到顶返回 null(调用方应当重新握手,而不是继续发)。
 */
export function seal(session: Session, plaintext: string): EncFrame | null {
  if (session.sendCounter > MAX_COUNTER) return null
  const nonce = makeNonce(session.sendDir, session.sendCounter)
  const box = nacl.box.after(utf8ToBytes(plaintext), nonce, session.key)
  // 计数器随密文一起走(它在 nonce 里,而 nonce 不保密 —— 保密的是内容,不是顺序)。
  const packed = new Uint8Array(6 + box.length)
  packed.set(nonce.subarray(3, 9), 0)
  packed.set(box, 6)
  session.sendCounter += 1
  return { t: 'enc', c: toBase64(packed) }
}

/**
 * 解一个密文帧。**永远不抛**,坏帧一律返回 null。
 *
 * 挡三样东西:① 解不开(被改过 / 不是这把密钥)② 计数器没前进(重放)③ 方向不对(自己发的被弹回来)。
 */
export function open(session: Session, frame: EncFrame): string | null {
  const packed = fromBase64(frame.c)
  if (!packed || packed.length <= 6) return null
  let counter = 0
  for (let i = 0; i < 6; i++) counter = counter * 256 + packed[i]
  // ★严格递增。相等也要拒 —— 相等就是原样重放。
  if (counter <= session.lastRecvCounter) return null
  const nonce = makeNonce(session.recvDir, counter)
  const opened = nacl.box.open.after(packed.subarray(6), nonce, session.key)
  if (!opened) return null
  // ★只有真的解开了才推进计数器。解不开就推进的话,对面发个垃圾就能把我们的窗口顶上去,
  //  之后合法的帧全被当成重放丢掉 —— 一个谁都能触发的拒绝服务。
  session.lastRecvCounter = counter
  return bytesToUtf8(opened)
}
