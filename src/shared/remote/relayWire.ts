/**
 * app 这一侧怎么跟中转说话。
 *
 * ## ★★为什么这份和 `relay/src/core.ts` 是**两份**
 *
 * 中转是不可信组件,设计文档要求它最终独立成仓(决策 10):自建的人只想 clone 两三百行,
 * 而且"独立仓库本身就是信任声明"。独立仓不该 import 主仓的类型 —— 那等于把它绑回来。
 *
 * 所以这是一份**契约的两半**,故意不共享代码。代价是漂移风险,对策是:
 *  ① 两边的帧一共只有四种,而且都极小(join / open / close / data);
 *  ② `relayWire.test.ts` 里钉死了每一种的字面形状,改一边不改另一边会红;
 *  ③ `relay/src/e2e.integration.test.ts` 拿**真的**中转跑一遍真链路。
 *
 * ## 房间号
 *
 * 房间号 = `base64(daemon 的长期公钥)`。配对链接里已经有这把公钥,所以客户端天然知道
 * 该进哪个房间 —— **不需要在中转上注册任何东西**,这是"部署完就能用"成立的前提。
 * ★别人知道公钥也没用:他进得了房间,但握手要用**私钥**签名(见 `e2e.ts`),
 *  他一条命令都发不出去。
 */

import { toBase64 } from './base64'

/** 中转唯一会解析的东西:第一帧。 */
export type JoinFrame = { t: 'join'; role: 'host' | 'client'; room: string }

/**
 * host 那一侧的信封。**客户端那一侧没有信封** —— 它跟中转是一对一的,
 * join 之后就是原样的字节流,所以手机端只多一句开场白。
 *
 * ★daemon 跟中转只有一条 socket,却可能同时有手机和笔记本两个客户端连着。
 *  `cid` 是中转给每条逻辑连接分配的编号,daemon 靠它把两条会话分开 ——
 *  没有它,两次握手的帧会前后脚落在同一条流上,两把会话密钥串在一起,
 *  而现象只是「第二台设备一直转圈」,没有任何错误信息。
 */
export type HostEnvelope =
  | { t: 'open'; cid: string }
  | { t: 'close'; cid: string }
  | { t: 'data'; cid: string; d: string }

/** 中转自己生成的状态帧。它只会生成这一种。 */
export type RelayStatus = { t: 'relay'; status: 'waiting' | 'peer-online' | 'peer-offline' | 'error'; error?: string }

export const joinFrame = (role: 'host' | 'client', room: string): JoinFrame => ({ t: 'join', role, room })

/** 房间号:daemon 长期公钥的 base64。两端各自算得出同一个值。 */
export const roomFor = (publicKey: Uint8Array): string => toBase64(publicKey)

/** 是不是中转自己的状态帧(要跳过,它不属于两端的对话)。 */
export function asRelayStatus(raw: string): RelayStatus | null {
  let o: unknown
  try { o = JSON.parse(raw) } catch { return null }
  if (!o || typeof o !== 'object') return null
  const f = o as Record<string, unknown>
  if (f.t !== 'relay' || typeof f.status !== 'string') return null
  return { t: 'relay', status: f.status as RelayStatus['status'], error: typeof f.error === 'string' ? f.error : undefined }
}

/** cid 的形状。★来自网络,而且会被当 Map 的 key —— 必须卡死。 */
const CID_RE = /^[0-9]{1,16}$/

/**
 * 解中转发给 host 的信封。**任何不对的地方都返回 null。**
 * ★和 `relay/src/core.ts` 的 `parseHostEnvelope` 是同一份契约的两半,形状由测试钉住。
 */
export function parseHostEnvelope(raw: string): HostEnvelope | null {
  let o: unknown
  try { o = JSON.parse(raw) } catch { return null }
  if (!o || typeof o !== 'object') return null
  const f = o as Record<string, unknown>
  if (typeof f.cid !== 'string' || !CID_RE.test(f.cid)) return null
  if (f.t === 'open') return { t: 'open', cid: f.cid }
  if (f.t === 'close') return { t: 'close', cid: f.cid }
  if (f.t === 'data' && typeof f.d === 'string') return { t: 'data', cid: f.cid, d: f.d }
  return null
}

/** host → 中转:发给某一条逻辑连接。 */
export const hostData = (cid: string, d: string): string => JSON.stringify({ t: 'data', cid, d })
/** host → 中转:主动关掉某一条逻辑连接。 */
export const hostClose = (cid: string): string => JSON.stringify({ t: 'close', cid })

/**
 * 链路心跳的两个字面量。**和 `relay/src/core.ts` 里的 `PING`/`PONG` 必须一模一样**
 * (契约的两半,形状由 `relayWire.test.ts` 钉住)。
 *
 * ★★为什么需要它:同一个房间只准一个 host,而一条**死了但没关**的 socket
 *  (合盖、切网、拔网线)会把房间**永久**占住 —— 真主机回来只会看到
 *  「这个房间已经有一台主机连着了」,而那台就是它自己。
 * ★★**故意不叫 `ping`**:中转对客户端帧的承诺是「原样搬」,而 `ping` 这种四字母词
 *  客户端完全可能真的发。截住一个可能是真内容的字符串,是在哑管道上开一个静默的洞。
 * ★老中转不认这一帧,会静默丢掉(过不了 `parseHostEnvelope`)—— 所以发心跳的一侧
 *  必须能容忍**永远收不到 pong**,判据见 `relayHost.ts` 的 `pongSeen`。
 */
export const PING = 'relay-ping'
export const PONG = 'relay-pong'
