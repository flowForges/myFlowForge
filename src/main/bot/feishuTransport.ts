// Feishu (Lark) transport via the official long-connection (WSClient) — client-initiated, no public
// endpoint. 飞书的长连接协议必须用官方 SDK(@larksuiteoapi/node-sdk,算上 protobufjs 约 18MB)——
// 钉钉和 Telegram 那两条是手写的,飞书这条不行。
//
// ★SDK 是**真依赖,随包发布**(package.json 的 dependencies 里),用户拿到的包里就有,不用自己装。
//
// ★★那为什么还用动态 import(而且是变量说明符)?两个真实理由,都不是"为了不打进包":
//   ① **不占启动路径**:18MB 带 protobufjs 的 SDK,require 一次是实打实的耗时。只有用户真的启用了
//      飞书才去加载它,其余人一分钱不花。
//   ② **坏了只坏一条**:顶层静态 import 一旦加载失败(包损坏、平台不兼容),整个 botBridge 模块都
//      起不来,钉钉和 Telegram 跟着陪葬。放在这里 catch 住,就只是"飞书这条连不上"。
//
// ★★★所以失败时**不要**再叫用户去 `npm i` —— 打好的 app 里根本执行不了(/Applications 没写权限,
//    也没有 npm),那句话只会让人以为功能坏了而无处下手。如实报出加载失败的原因才有用。

import type {
  BotTransport, InboundBotMessage, BotStatus, BotAddress, OutboundBotMessage, FeishuCreds,
} from './botTypes'

const SDK = '@larksuiteoapi/node-sdk'

export class FeishuTransport implements BotTransport {
  readonly platform = 'feishu' as const
  private msgCbs: ((m: InboundBotMessage) => void)[] = []
  private statusCbs: ((s: BotStatus) => void)[] = []
  private ws: { start: (o: unknown) => void } | null = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any = null
  private stopped = false

  constructor(private creds: FeishuCreds) {}

  onMessage(cb: (m: InboundBotMessage) => void): void { this.msgCbs.push(cb) }
  onStatus(cb: (s: BotStatus) => void): void { this.statusCbs.push(cb) }
  private status(s: BotStatus) { for (const cb of this.statusCbs) cb(s) }

  async start(): Promise<void> {
    this.stopped = false
    this.status({ state: 'connecting' })
    // 变量说明符 → 打包器不把它内联进 out/,运行时才去 node_modules 里取(理由见文件顶部)。
    let Lark: Record<string, unknown>
    try { Lark = (await import(/* @vite-ignore */ SDK)) as Record<string, unknown> }
    catch (e) {
      // ★原来这里是 `catch {}` —— 把真实原因整个丢掉,只回一句「去 npm i」。可 SDK 本来就随包发布,
      //  真走到这儿说明是**别的**问题(包损坏、架构不对、被安全软件拦了),而那句话既做不到也没线索。
      const why = e instanceof Error ? e.message : String(e)
      this.status({ state: 'error', reason: `飞书 SDK 加载失败(它本该随包自带,可能是安装包损坏)：${why}` })
      return
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const L = Lark as any
      const opts = { appId: this.creds.appId, appSecret: this.creds.appSecret }
      this.client = new L.Client(opts)
      const dispatcher = new L.EventDispatcher({}).register({
        'im.message.receive_v1': async (data: unknown) => { this.onEvent(data) },
      })
      this.ws = new L.WSClient(opts)
      this.ws!.start({ eventDispatcher: dispatcher })
      this.status({ state: 'online' })
    } catch (e) { this.status({ state: 'error', reason: (e as Error).message }) }
  }

  async stop(): Promise<void> {
    this.stopped = true
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    try { (this.ws as any)?.stop?.() } catch { /* ignore */ }
    this.ws = null; this.client = null
    this.status({ state: 'offline' })
  }

  private onEvent(data: unknown): void {
    if (this.stopped) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = data as any
    const msg = d?.message ?? d?.event?.message
    if (!msg || msg.message_type !== 'text') return
    let text = ''
    try { text = (JSON.parse(msg.content || '{}').text ?? '').trim() } catch { /* ignore */ }
    if (!text) return
    const chatId = msg.chat_id ?? ''
    const chatType = msg.chat_type === 'p2p' ? 'private' : 'group'
    const sender = d?.sender ?? d?.event?.sender
    const senderId = sender?.sender_id?.open_id ?? sender?.sender_id?.user_id ?? ''
    const address: BotAddress = { platform: 'feishu', chatId, chatType, userId: senderId }
    const m: InboundBotMessage = { platform: 'feishu', chatId, chatType, senderId, senderName: '', text, address }
    for (const cb of this.msgCbs) cb(m)
  }

  async send(to: BotAddress, msg: OutboundBotMessage): Promise<void> {
    if (!this.client) return
    const body = msg.kind === 'text'
      ? { msg_type: 'text', content: JSON.stringify({ text: msg.text }) }
      : { msg_type: 'interactive', content: JSON.stringify(feishuCard(msg)) }
    try {
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: to.chatId, msg_type: body.msg_type, content: body.content },
      })
    } catch { /* swallow — a failed push must not crash the bridge */ }
  }
}

// Feishu interactive card carrying a single markdown block (renders **bold**, links, lists).
function feishuCard(msg: Exclude<OutboundBotMessage, { kind: 'text' }>): unknown {
  let md = msg.kind === 'md' ? msg.text : `**${msg.title}**\n\n${msg.text}`
  if (msg.kind === 'card' && msg.actions?.length) {
    md += '\n\n' + msg.actions.map(a => `回复 **${a.key}** → ${a.label}`).join('\n')
  }
  return { config: { wide_screen_mode: true }, elements: [{ tag: 'markdown', content: md }] }
}
