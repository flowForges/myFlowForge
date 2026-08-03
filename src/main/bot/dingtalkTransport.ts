// DingTalk Stream Mode transport. Enterprise-internal-app robot over a client-initiated WebSocket —
// no public endpoint needed (desktop sits behind NAT). Protocol verified live against real creds
// 2026-08-03: oauth2/accessToken → gateway/connections/open → WS OPEN → ping/pong + message frames.
//
// Uses global fetch + WebSocket (Electron 42 bundles Node 22.x, undici globals unflagged). No new dep.

import type {
  BotTransport, InboundBotMessage, BotStatus, BotAddress, OutboundBotMessage, DingtalkCreds,
} from './botTypes'

const TOKEN_URL = 'https://api.dingtalk.com/v1.0/oauth2/accessToken'
const OPEN_URL = 'https://api.dingtalk.com/v1.0/gateway/connections/open'
const BATCH_SEND_URL = 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend'
const BOT_MSG_TOPIC = '/v1.0/im/bot/messages/get'

interface StreamFrame {
  specVersion?: string
  type?: string
  headers?: { topic?: string; messageId?: string; contentType?: string; eventType?: string }
  data?: string
}

export class DingTalkTransport implements BotTransport {
  readonly platform = 'dingtalk' as const
  private ws: WebSocket | null = null
  private msgCbs: ((m: InboundBotMessage) => void)[] = []
  private statusCbs: ((s: BotStatus) => void)[] = []
  private token: { value: string; expiresAt: number } | null = null
  private stopped = false
  private backoff = 1000
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private creds: DingtalkCreds) {}

  onMessage(cb: (m: InboundBotMessage) => void): void { this.msgCbs.push(cb) }
  onStatus(cb: (s: BotStatus) => void): void { this.statusCbs.push(cb) }
  private status(s: BotStatus) { for (const cb of this.statusCbs) cb(s) }

  async start(): Promise<void> {
    this.stopped = false
    await this.connect()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    try { this.ws?.close() } catch { /* ignore */ }
    this.ws = null
    this.status({ state: 'offline' })
  }

  // ---- connection ----

  private async connect(): Promise<void> {
    if (this.stopped) return
    this.status({ state: 'connecting' })
    try {
      const { endpoint, ticket } = await this.openConnection()
      const url = `${endpoint}?ticket=${encodeURIComponent(ticket)}`
      const ws = new WebSocket(url)
      this.ws = ws
      ws.addEventListener('open', () => { this.backoff = 1000; this.status({ state: 'online' }) })
      ws.addEventListener('message', (ev) => this.onFrame(ev))
      ws.addEventListener('error', () => { /* close will follow */ })
      ws.addEventListener('close', () => this.scheduleReconnect())
    } catch (e) {
      this.status({ state: 'error', reason: (e as Error).message })
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    const wait = this.backoff
    this.backoff = Math.min(this.backoff * 2, 30000)
    this.status({ state: 'connecting' })
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; void this.connect() }, wait)
  }

  private async openConnection(): Promise<{ endpoint: string; ticket: string }> {
    const r = await fetch(OPEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: this.creds.clientId,
        clientSecret: this.creds.clientSecret,
        ua: 'myflowforge-bot/1.0',
        subscriptions: [
          { type: 'SYSTEM', topic: '*' },
          { type: 'CALLBACK', topic: BOT_MSG_TOPIC },
        ],
      }),
    })
    const j = (await r.json()) as { endpoint?: string; ticket?: string; message?: string }
    if (!r.ok || !j.endpoint || !j.ticket) throw new Error(`open connection failed: ${r.status} ${j.message ?? JSON.stringify(j)}`)
    return { endpoint: j.endpoint, ticket: j.ticket }
  }

  // ---- inbound frames ----

  private onFrame(ev: MessageEvent): void {
    let frame: StreamFrame
    try { frame = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) } catch { return }
    const h = frame.headers ?? {}
    if (h.topic === 'ping') { this.ack(h.messageId, JSON.parse(frame.data || '{}')); return }
    if (h.topic === 'disconnect' || h.topic === 'reconnect') { try { this.ws?.close() } catch { /* ignore */ } return }
    if (h.topic === BOT_MSG_TOPIC) {
      this.ack(h.messageId, { response: {} })
      const m = this.parseBotMessage(frame.data)
      if (m) for (const cb of this.msgCbs) cb(m)
    }
  }

  private ack(messageId: string | undefined, data: unknown): void {
    if (!this.ws || this.ws.readyState !== 1) return
    try {
      this.ws.send(JSON.stringify({
        code: 200,
        headers: { messageId: messageId ?? '', contentType: 'application/json' },
        data: JSON.stringify(data ?? {}),
      }))
    } catch { /* ignore */ }
  }

  private parseBotMessage(raw: string | undefined): InboundBotMessage | null {
    if (!raw) return null
    let d: {
      conversationId?: string; conversationType?: string; senderStaffId?: string; senderId?: string
      senderNick?: string; text?: { content?: string }; sessionWebhook?: string; robotCode?: string; msgtype?: string
    }
    try { d = JSON.parse(raw) } catch { return null }
    if (d.msgtype && d.msgtype !== 'text') return null // only text driven for now
    const chatType = d.conversationType === '2' ? 'group' : 'private'
    const chatId = d.conversationId ?? d.senderStaffId ?? ''
    const userId = d.senderStaffId ?? d.senderId ?? ''
    const address: BotAddress = {
      platform: 'dingtalk',
      chatId,
      chatType,
      userId,
      robotCode: d.robotCode,
      replyWebhook: d.sessionWebhook,
    }
    return {
      platform: 'dingtalk',
      chatId,
      chatType,
      senderId: userId,
      senderName: d.senderNick ?? '',
      text: (d.text?.content ?? '').trim(),
      address,
    }
  }

  // ---- outbound ----

  async send(to: BotAddress, msg: OutboundBotMessage): Promise<void> {
    // Cheap path: fresh sessionWebhook (only present when replying to an inbound message, ~5min TTL).
    if (to.replyWebhook) {
      try { await this.sendViaWebhook(to.replyWebhook, msg); return } catch { /* fall through to proactive */ }
    }
    // Proactive 1:1 push: needs access token + robotCode + userId.
    if (to.userId && to.robotCode) { await this.sendViaBatch(to, msg); return }
    throw new Error('no reply channel: missing webhook and robotCode/userId')
  }

  private async sendViaWebhook(webhook: string, msg: OutboundBotMessage): Promise<void> {
    const body = msg.kind === 'text'
      ? { msgtype: 'text', text: { content: msg.text } }
      : { msgtype: 'markdown', markdown: { title: msg.title, text: renderCardMarkdown(msg) } }
    const r = await fetch(webhook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    if (!r.ok) throw new Error(`webhook send ${r.status}`)
  }

  private async sendViaBatch(to: BotAddress, msg: OutboundBotMessage): Promise<void> {
    const token = await this.getToken()
    const msgParam = msg.kind === 'text'
      ? { content: msg.text }
      : { title: msg.title, text: renderCardMarkdown(msg) }
    const r = await fetch(BATCH_SEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
      body: JSON.stringify({
        robotCode: to.robotCode,
        userIds: [to.userId],
        msgKey: msg.kind === 'text' ? 'sampleText' : 'sampleMarkdown',
        msgParam: JSON.stringify(msgParam),
      }),
    })
    if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`batchSend ${r.status} ${t.slice(0, 120)}`) }
  }

  private async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value
    const r = await fetch(TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey: this.creds.clientId, appSecret: this.creds.clientSecret }),
    })
    const j = (await r.json()) as { accessToken?: string; expireIn?: number; message?: string }
    if (!r.ok || !j.accessToken) throw new Error(`token failed: ${r.status} ${j.message ?? ''}`)
    this.token = { value: j.accessToken, expiresAt: Date.now() + (j.expireIn ?? 7200) * 1000 }
    return j.accessToken
  }
}

// A 1:1 robot has no interactive buttons, so actions render as reply-keyword hints in markdown.
function renderCardMarkdown(msg: Extract<OutboundBotMessage, { kind: 'card' }>): string {
  let out = `### ${msg.title}\n\n${msg.text}`
  if (msg.actions?.length) {
    out += '\n\n' + msg.actions.map(a => `- 回复 **${a.key}** → ${a.label}`).join('\n')
  }
  return out
}
