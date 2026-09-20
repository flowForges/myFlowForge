import { z } from 'zod'

/**
 * 远程连接的线协议。
 *
 * `ws` 已经负责分帧,所以每条消息就是一个 JSON 对象。**入站帧一律过 zod** ——
 * 网关是不可信输入的入口,对面可能是任何人,不许 `as` 硬转。
 *
 * 放在 src/shared 是有意的:第四期的手机端要 import 同一份(设计文档十、技术栈一节)。
 * 这里只有纯类型和纯函数,不碰 node、不碰 electron、不碰 ws。
 */
export const PROTOCOL_VERSION = 1

/** daemon → client,连上即发。★不带方法清单 —— 没鉴权的人不该知道对面有什么。 */
export const HelloFrame = z.object({
  t: z.literal('hello'),
  protocol: z.number().int(),
  version: z.string(),
  authRequired: z.boolean(),
})

/** client → daemon,仅在 authRequired 时。 */
export const AuthFrame = z.object({ t: z.literal('auth'), token: z.string() })

/**
 * client → daemon,自报家门。
 * 服务端把它记在这条连接上,答权限门时用来说清「是谁答的」(见 InvokeCtx.client)。
 * ★纯展示用,**不是身份凭证** —— 谁都能自称任何名字。真正的准入靠 token / SSH 隧道。
 */
export const IdentifyFrame = z.object({ t: z.literal('identify'), label: z.string().max(64) })

/**
 * daemon → client,鉴权通过后才发。
 * methods 就是 A 阶段那张方法表的 key 列表 —— 客户端据此把对不上的功能置灰(决策 B-2)。
 */
export const ReadyFrame = z.object({ t: z.literal('ready'), methods: z.array(z.string()) })

export const ReqFrame = z.object({
  t: z.literal('req'),
  id: z.number().int().nonnegative(),
  ch: z.string(),
  args: z.array(z.unknown()),
})

/**
 * ★`value` 必须是 `.optional()`,不能只写 `z.unknown()`。
 *
 * 大量 handler 是 void 的(`chat:send`、`chat:stop`、`chat:resolve`、`run2:*` …),网关那边发的是
 * `{ t:'res', id, ok:true, value: undefined }` —— 而 `JSON.stringify` **会把值为 undefined 的键整个删掉**,
 * 线上真正的字节是 `{"t":"res","id":1,"ok":true}`,根本没有 value 这个键。
 *
 * zod 3 里 `z.unknown()` 在对象里是隐式可选的,这么写能过;**zod 4 改了**,缺键即报
 * `expected nonoptional`。于是每一个 void handler 的响应都校验不过 → 被当坏帧丢掉 →
 * 调用方那个 promise **永远不 settle**。界面上不是报错,是发送键按下去什么也没发生、
 * 输入框里的字也不清 —— 而服务端其实**已经执行了**。真机上就是这么暴露的。
 *
 * 同一份文件在 `errorText` 那儿已经为「JSON.stringify(undefined) 返回 undefined」栽过一次,
 * 那次修的是 `error`,漏了 `value`。两个坑是同一个。
 */
export const ResFrame = z.union([
  z.object({ t: z.literal('res'), id: z.number().int().nonnegative(), ok: z.literal(true), value: z.unknown().optional() }),
  z.object({ t: z.literal('res'), id: z.number().int().nonnegative(), ok: z.literal(false), error: z.string() }),
])

/**
 * daemon → client 的事件。
 * ★`ctx.emit`(只回调用方)和 `broadcast`(发给所有人)在线上是**同一种帧** —— 客户端分不出
 * 也不需要分,渲染层本来就是同一个 `window.forge.on(...)` 收。区别只在服务端:emit 只往这一条
 * socket 写,broadcast 往所有 socket 写。
 */
export const EvtFrame = z.object({ t: z.literal('evt'), ch: z.string(), payload: z.unknown().optional() })

export const PingFrame = z.object({ t: z.literal('ping') })
export const PongFrame = z.object({ t: z.literal('pong') })

export const Frame = z.union([HelloFrame, AuthFrame, IdentifyFrame, ReadyFrame, ReqFrame, ResFrame, EvtFrame, PingFrame, PongFrame])

export type Frame = z.infer<typeof Frame>
export type HelloFrame = z.infer<typeof HelloFrame>
export type ReadyFrame = z.infer<typeof ReadyFrame>
export type ReqFrame = z.infer<typeof ReqFrame>
export type ResFrame = z.infer<typeof ResFrame>
export type EvtFrame = z.infer<typeof EvtFrame>

export function encodeFrame(f: Frame): string {
  return JSON.stringify(f)
}

/**
 * 解一条入站帧。**永远不抛** —— 对面发来的任何垃圾都只该让这一条消息被丢弃,
 * 不该让网关的消息循环崩掉(那等于一个任何人都能触发的拒绝服务)。
 */
export function decodeFrame(raw: string | Uint8Array): { ok: true; frame: Frame } | { ok: false; error: string } {
  let text: string
  try { text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw) }
  catch { return { ok: false, error: 'undecodable bytes' } }
  let json: unknown
  try { json = JSON.parse(text) }
  catch { return { ok: false, error: 'not json' } }
  const p = Frame.safeParse(json)
  if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? 'bad frame' }
  return { ok: true, frame: p.data }
}

/**
 * 把 handler 抛出来的任何东西压成一句话。
 *
 * ★**不能把整个 error 对象序列化过去**:它可能带着 stack、带着 cause 链、带着抛出者顺手挂上去的
 * 任意属性(比如一个 spawn 失败的 error 上就挂着完整的 env)。远程那一头拿到的只该是一句人话。
 */
export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  // ★`JSON.stringify(undefined)` 返回的是 undefined 而**不是**抛 —— TypeScript 把它标成 string 是撒谎。
  // 漏掉这层判断,res 帧的 error 就会是 undefined,对面 zod 校验不过直接丢帧,
  // 于是调用方那个 promise 永远挂着(而不是收到一个报错)。
  try { const s = JSON.stringify(e); return typeof s === 'string' ? s : String(e) }
  catch { return String(e) }
}
