// Telegram transport via getUpdates long-polling — client-initiated HTTP, no public endpoint, no
// dependency (uses global fetch). Get a bot token from @BotFather and paste it in settings.

import type {
  BotTransport, InboundBotMessage, BotStatus, BotAddress, OutboundBotMessage, TelegramCreds,
} from './botTypes'
import { makeProxyFetch } from '../update/proxyFetch'

// api.telegram.org is often only reachable via the user's proxy (settings.termProxy). In-process
// undici fetch ignores HTTP_PROXY env, so route through an explicit ProxyAgent when a proxy is set.
function buildFetch(proxy?: string): typeof fetch {
  const p = proxy?.trim()
  if (!p) return fetch
  try { return makeProxyFetch(p) as typeof fetch } catch { return fetch }   // socks5:// → ProxyAgent throws
}

interface TgUpdate {
  update_id: number
  message?: {
    message_id: number
    text?: string
    chat: { id: number; type: string }
    from?: { id: number; first_name?: string; last_name?: string; username?: string }
  }
}

export class TelegramTransport implements BotTransport {
  readonly platform = 'telegram' as const
  private msgCbs: ((m: InboundBotMessage) => void)[] = []
  private statusCbs: ((s: BotStatus) => void)[] = []
  private stopped = false
  private offset = 0
  private backoff = 1000
  private fetch: typeof fetch

  constructor(private creds: TelegramCreds, proxy?: string) { this.fetch = buildFetch(proxy) }

  onMessage(cb: (m: InboundBotMessage) => void): void { this.msgCbs.push(cb) }
  onStatus(cb: (s: BotStatus) => void): void { this.statusCbs.push(cb) }
  private status(s: BotStatus) { for (const cb of this.statusCbs) cb(s) }

  private api(method: string): string { return `https://api.telegram.org/bot${this.creds.botToken}/${method}` }

  async start(): Promise<void> {
    this.stopped = false
    this.status({ state: 'connecting' })
    // validate the token up front so a bad token surfaces clearly instead of silently looping
    try {
      const r = await this.fetch(this.api('getMe'))
      const j = (await r.json()) as { ok?: boolean; description?: string }
      if (!j.ok) { this.status({ state: 'error', reason: j.description || 'getMe failed' }); return }
    } catch (e) { this.status({ state: 'error', reason: (e as Error).message }); return }
    this.status({ state: 'online' })
    void this.poll()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.status({ state: 'offline' })
  }

  private async poll(): Promise<void> {
    while (!this.stopped) {
      try {
        const url = `${this.api('getUpdates')}?timeout=50&offset=${this.offset}&allowed_updates=${encodeURIComponent('["message"]')}`
        const r = await this.fetch(url)
        const j = (await r.json()) as { ok?: boolean; result?: TgUpdate[] }
        if (!j.ok) { await this.wait(); continue }
        this.backoff = 1000
        for (const u of j.result ?? []) {
          this.offset = u.update_id + 1
          const m = this.parse(u)
          if (m) for (const cb of this.msgCbs) cb(m)
        }
      } catch { if (!this.stopped) await this.wait() }
    }
  }

  private async wait(): Promise<void> {
    const w = this.backoff
    this.backoff = Math.min(this.backoff * 2, 30000)
    await new Promise((res) => setTimeout(res, w))
  }

  private parse(u: TgUpdate): InboundBotMessage | null {
    const msg = u.message
    if (!msg?.text) return null
    const chatId = String(msg.chat.id)
    const chatType = msg.chat.type === 'private' ? 'private' : 'group'
    const senderId = String(msg.from?.id ?? msg.chat.id)
    const name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || msg.from?.username || ''
    const address: BotAddress = { platform: 'telegram', chatId, chatType, userId: senderId }
    return { platform: 'telegram', chatId, chatType, senderId, senderName: name, text: msg.text.trim(), address }
  }

  async send(to: BotAddress, msg: OutboundBotMessage): Promise<void> {
    if (msg.kind === 'text') { await this.post(to.chatId, msg.text); return }
    const body = renderBody(msg)
    const ok = await this.post(to.chatId, toTelegramMarkdown(body), 'Markdown')
    // Telegram 400s on markdown it can't parse (unbalanced * etc.) — resend as plain so we never drop it.
    if (!ok) await this.post(to.chatId, body, undefined)
  }

  private async post(chatId: string, text: string, parseMode?: string): Promise<boolean> {
    try {
      const r = await this.fetch(this.api('sendMessage'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, ...(parseMode ? { parse_mode: parseMode } : {}), disable_web_page_preview: true }),
      })
      const j = (await r.json()) as { ok?: boolean }
      return !!j.ok
    } catch { return false }
  }
}

// The bridge's non-text messages carry generic markdown. Flatten to a single string; card actions
// become reply-keyword hints (Telegram inline buttons would need callback wiring — keyword replies
// already work for every platform).
function renderBody(msg: Exclude<OutboundBotMessage, { kind: 'text' }>): string {
  if (msg.kind === 'md') return msg.text
  let out = `${msg.title}\n\n${msg.text}`
  if (msg.actions?.length) out += '\n\n' + msg.actions.map(a => `回复 ${a.key} → ${a.label}`).join('\n')
  return out
}

// Telegram legacy Markdown has no headings and uses single-* bold. Convert **bold** → *bold* and
// strip ATX heading markers to bold lines so agent output reads sensibly.
function toTelegramMarkdown(s: string): string {
  return s
    .replace(/^#{1,6}\s*(.+)$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
}
