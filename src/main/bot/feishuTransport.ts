// Feishu (Lark) transport via the official long-connection (WSClient) — client-initiated, no public
// endpoint. The Feishu long connection needs the official SDK (@larksuiteoapi/node-sdk, ~30MB with
// protobufjs). To keep it out of the default bundle, we load it DYNAMICALLY: if it isn't installed the
// transport reports a clear error status telling the user to `npm i @larksuiteoapi/node-sdk`, and
// DingTalk/Telegram keep working. Install it to enable Feishu.

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
    // Variable specifier → the bundler/tsc treats this as an optional runtime import (no hard dep).
    let Lark: Record<string, unknown>
    try { Lark = (await import(/* @vite-ignore */ SDK)) as Record<string, unknown> }
    catch { this.status({ state: 'error', reason: '未安装飞书 SDK：npm i @larksuiteoapi/node-sdk' }); return }
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
