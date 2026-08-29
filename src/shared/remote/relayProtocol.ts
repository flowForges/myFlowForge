import { z } from 'zod'

/**
 * 中转的线协议(设计文档第八节)。
 *
 * ## 中转是什么
 *
 * 一个**哑管道**。它做的全部事情是:把 A 说的话原样念给 B 听。它不解析 `d` 里的一个字节,
 * 不知道谁在跟谁说什么,也没有任何办法知道 —— 那一层是 `e2e.ts` 的事(设计文档决策 5)。
 * 它能做的坏事只有一件:**丢包**。那是拒绝服务,不是泄密。
 *
 * ## 房间怎么对上
 *
 * 房间号 = `base64url(sha256(daemon 的长期公钥))`。
 *
 * ★为什么是**公钥的哈希**而不是公钥本身:公钥是身份,没必要交给中转。哈希让中转能撮合,
 *  又不让它拿到一个可以拿去别处冒充/关联的东西。两端各自算得出同一个房间号,
 *  **不需要任何注册流程** —— 这正是"自建中转、部署完就能用"成立的前提。
 *
 * ★为什么不怕别人占房间:占了也没用。E2E 握手要 daemon 用**长期私钥**签
 *  (见 `e2e.ts` 的 `hostHandshakeReply`),占房间的人签不出来,客户端第一步就把他甩了。
 *  他能做的还是只有"让真 daemon 连不上" = 丢包 = 上面那条。
 *
 * ## 多路复用
 *
 * daemon 跟中转只有**一条** socket,但可能同时有手机 + 笔记本两个客户端。所以 host 那一侧
 * 的帧都带一个 `cid`(这条逻辑连接的编号,中转分配)。客户端那一侧**不套信封** ——
 * 它跟中转是一对一的,`client-ok` 之后就是原样的既有协议,所以客户端的改动只有一句开场白。
 *
 * ★`cid` 由**中转**分配而不是 host:host 收到 `open` 才知道有新客户端,它没有先手。
 *
 * ## 为什么这份文件在 src/shared
 *
 * daemon 和手机端都要 import。★但**中转服务器自己不 import 它** —— 中转是不可信组件,
 * 设计文档要求它最终独立成仓(决策 10),独立仓不该依赖主仓的类型。那边有一份等价的、
 * 手写的校验(`relay/src/rooms.ts`),两份靠 `relayProtocol.test.ts` 里的形状断言对齐。
 */

export const RELAY_PROTOCOL_VERSION = 1

/** cid 的形状:中转分配的短字符串。限长是为了不让一个恶意中转拿超长 key 撑爆 host 的表。 */
const Cid = z.string().min(1).max(64)
/** 房间号:base64url(sha256(pub)) = 43 个字符。收紧到这个长度,畸形的一律不进状态机。 */
const Room = z.string().min(8).max(128)

// ── host ⇄ relay ────────────────────────────────────────────────────────────

/** host → relay,连上即发。 */
export const HostHelloFrame = z.object({
  t: z.literal('host-hello'),
  v: z.number().int(),
  room: Room,
})

/** relay → host,房间认领成功。 */
export const HostOkFrame = z.object({ t: z.literal('host-ok') })

/** relay → host,来了一个新客户端。 */
export const OpenFrame = z.object({ t: z.literal('open'), cid: Cid })

/** 两个方向都有:某条逻辑连接断了。 */
export const CloseFrame = z.object({ t: z.literal('close'), cid: Cid })

/**
 * 两个方向都有:某条逻辑连接上的一帧数据。
 *
 * ★`d` 是**不透明字符串**。中转不许看,这边也不该在这一层解析它 —— 它可能是明文的既有协议
 *  (局域网直连不套中转时用不到这层),也可能是 `e2e.ts` 封好的密文帧。这一层不关心。
 */
export const DataFrame = z.object({ t: z.literal('data'), cid: Cid, d: z.string() })

// ── client ⇄ relay ──────────────────────────────────────────────────────────

/** client → relay,连上即发。 */
export const ClientHelloFrame = z.object({
  t: z.literal('client-hello'),
  v: z.number().int(),
  room: Room,
})

/** relay → client,接上了。**这之后不再有中转的帧**,双向都是原样的既有协议。 */
export const ClientOkFrame = z.object({ t: z.literal('client-ok') })

/**
 * relay → 任一端,出错了。
 *
 * ★中转吐的错必须是**人话**,而且必须区分"房间没人"和"你说的话我听不懂" ——
 *  前者是"电脑没开机",后者是"版本对不上",给用户的下一步动作完全不同。
 */
export const RelayErrorFrame = z.object({ t: z.literal('error'), error: z.string() })

export const HostInbound = z.discriminatedUnion('t', [HostOkFrame, OpenFrame, CloseFrame, DataFrame, RelayErrorFrame])
export const HostOutbound = z.discriminatedUnion('t', [HostHelloFrame, CloseFrame, DataFrame])
export const ClientInbound = z.discriminatedUnion('t', [ClientOkFrame, RelayErrorFrame])
export const ClientOutbound = z.discriminatedUnion('t', [ClientHelloFrame])

export type HostInboundFrame = z.infer<typeof HostInbound>
export type HostOutboundFrame = z.infer<typeof HostOutbound>
export type ClientInboundFrame = z.infer<typeof ClientInbound>

export type RelayDecode<T> = { ok: true; frame: T } | { ok: false; error: string }

function decodeWith<T>(schema: z.ZodType<T>, raw: string): RelayDecode<T> {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, error: '不是合法 JSON' }
  }
  const p = schema.safeParse(json)
  // ★`z.treeifyError` 那种完整报告不往外抛:这是不可信输入的入口,
  //  详细的解析失败原因回给对面等于告诉他"再改哪里就能过"。日志里留一句就够了。
  return p.success ? { ok: true, frame: p.data } : { ok: false, error: '帧的形状不对' }
}

export const decodeHostInbound = (raw: string) => decodeWith(HostInbound, raw)
export const decodeClientInbound = (raw: string) => decodeWith(ClientInbound, raw)

export const encodeRelayFrame = (f: unknown): string => JSON.stringify(f)

/**
 * 房间号 = base64url(sha256(公钥))。
 *
 * ★`sha256` 由调用方传进来:这份文件在 `src/shared`,同时被 node(有 `node:crypto`)和
 *  RN(没有)import。写死任何一边的实现都会让另一边的 bundle 炸掉 —— `wsUrl.ts` 和
 *  `base64.ts` 都为同一类事栽过。
 */
export function roomIdFrom(sha256: (b: Uint8Array) => Uint8Array, publicKey: Uint8Array): string {
  const h = sha256(publicKey)
  let s = ''
  for (const b of h) s += String.fromCharCode(b)
  // base64url:去掉 `+/=`,因为房间号会出现在 URL 路径里(Cloudflare 那个适配器就是这么路由的)。
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
