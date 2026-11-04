// 假 Bot API(07):只听 127.0.0.1。按我们相信的官方规则拒收,违反就让测试失败。
// requests[].path 里有令牌,这就是 Bot API 的形状;查"令牌没漏"看别处,不看这个字段
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export type PartialUpdate = Record<string, unknown> & { update_id?: number }

export interface FakeRequest {
  /** Bot API 方法名 */
  method: string
  path: string
  body: any
  at: number
}

export interface FakeMessage {
  id: number
  text: string
  entities?: unknown[]
  keyboard?: unknown
  silent?: boolean
}

export type FakeReply = { status: number; body?: object; headers?: Record<string, string> } | 'drop' | 'hang'

export interface FakeTelegram {
  base: string
  requests: FakeRequest[]
  push(update: PartialUpdate): number
  /** 编辑之后的当前内容,按发送顺序 */
  outbox(chatId: number | string): FakeMessage[]
  /** 接下来 n 次 method 这样回;先于这个方法的一切规则,不产生效果 */
  fail(method: string, n: number, reply: FakeReply): void
  /** 用户在手机上删了这条 */
  deleteMessage(chatId: number | string, messageId: number): void
  /** 还没有被任何一次 getUpdates 拿走的更新数 */
  undelivered(): number
  /** getUpdates → 409 */
  webhookActive: boolean
  /** Telegram 够不到:现有连接断开,新连接直接断,不记录 */
  offline: boolean
  close(): Promise<void>
}

export interface FakeTelegramOpts {
  token: string
  botId?: number
  username?: string
  /** 默认 Date.now;给的话 at 和默认 date 都用它 */
  now?: () => number
}

const MAX_TEXT = 4096
const MAX_CALLBACK_BYTES = 64
const MAX_ENTITIES = 100
const NOT_MODIFIED = 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message'
const WEBHOOK_CONFLICT = "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first"
const POLLER_CONFLICT = 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running'

/** 拒收的原因;undefined = 通过 */
function checkContent(body: Record<string, unknown>): string | undefined {
  const text = body.text
  if (typeof text !== 'string' || text.trim() === '') return 'Bad Request: message text is empty'
  if (text.length > MAX_TEXT) return 'Bad Request: message is too long'
  const entities = body.entities
  if (entities !== undefined) {
    if (!Array.isArray(entities) || entities.length > MAX_ENTITIES) return "Bad Request: can't parse entities"
    for (const e of entities as { offset?: unknown; length?: unknown }[]) {
      const { offset, length } = e ?? {}
      if (!Number.isInteger(offset) || !Number.isInteger(length) || (offset as number) < 0 || (length as number) <= 0 || (offset as number) + (length as number) > text.length) {
        return "Bad Request: can't parse entities: entity beyond the end of the text"
      }
    }
  }
  const rows = (body.reply_markup as { inline_keyboard?: unknown } | undefined)?.inline_keyboard
  if (Array.isArray(rows)) {
    for (const button of rows.flat() as { callback_data?: unknown }[]) {
      if (button?.callback_data === undefined) continue
      const bytes = typeof button.callback_data === 'string' ? Buffer.byteLength(button.callback_data) : 0
      if (bytes < 1 || bytes > MAX_CALLBACK_BYTES) return 'Bad Request: BUTTON_DATA_INVALID'
    }
  }
  return undefined
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const sameEntities = (a: unknown, b: unknown) => JSON.stringify(a ?? []) === JSON.stringify(b ?? [])

type Waiter = { res: ServerResponse; offset?: number; limit: number; timer: NodeJS.Timeout }

export async function startFakeTelegram(opts: FakeTelegramOpts): Promise<FakeTelegram> {
  const now = opts.now ?? Date.now
  const botId = opts.botId ?? 123456789
  const username = opts.username ?? 'fake_bot'
  const requests: FakeRequest[] = []
  let updates: (PartialUpdate & { update_id: number })[] = []
  /** 已经发出去过的 update_id:确认之前重投,但不算"没拿走" */
  const delivered = new Set<number>()
  const chats = new Map<string, (FakeMessage & { date: number })[]>()
  const failures = new Map<string, { left: number; reply: FakeReply }[]>()
  const hung = new Set<ServerResponse>()
  let waiter: Waiter | undefined
  let nextUpdate = 1
  let nextMessage = 1
  let webhookActive = false
  let offline = false
  let closed = false

  const json = (res: ServerResponse, status: number, body: object, headers: Record<string, string> = {}) => {
    if (res.writableEnded || res.destroyed) return
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }
  const ok = (res: ServerResponse, result: unknown) => json(res, 200, { ok: true, result })
  const refuse = (res: ServerResponse, status: number, description: string) => json(res, status, { ok: false, error_code: status, description })

  const available = (offset: number | undefined, limit: number) => {
    const out = updates.filter(u => offset === undefined || u.update_id >= offset).slice(0, limit)
    for (const u of out) delivered.add(u.update_id)
    return out
  }
  const endWaiter = (reply: (w: Waiter) => void) => {
    const w = waiter
    if (!w) return
    waiter = undefined
    clearTimeout(w.timer)
    reply(w)
  }
  const wake = () => endWaiter(w => ok(w.res, available(w.offset, w.limit)))

  const getUpdates = (res: ServerResponse, body: Record<string, unknown>) => {
    if (webhookActive) return refuse(res, 409, WEBHOOK_CONFLICT)
    // 同一时间只有一个长轮询:后来的顶掉先来的
    endWaiter(w => refuse(w.res, 409, POLLER_CONFLICT))
    const offset = typeof body.offset === 'number' ? body.offset : undefined
    // 带 offset 等于确认了比它小的,从此不再投递
    if (offset !== undefined) updates = updates.filter(u => u.update_id >= offset)
    const limit = typeof body.limit === 'number' ? body.limit : 100
    const ready = available(offset, limit)
    const seconds = typeof body.timeout === 'number' ? body.timeout : 0
    if (ready.length > 0 || seconds <= 0) return ok(res, ready)
    const w: Waiter = { res, offset, limit, timer: setTimeout(() => { if (waiter === w) wake() }, seconds * 1000) }
    waiter = w
    res.once('close', () => {
      if (waiter !== w) return
      waiter = undefined
      clearTimeout(w.timer)
    })
  }

  const messagesOf = (chatId: unknown) => {
    const key = String(chatId)
    let list = chats.get(key)
    if (!list) chats.set(key, (list = []))
    return list
  }

  const store = (body: Record<string, unknown>): FakeMessage => ({
    id: 0,
    text: body.text as string,
    ...(body.entities !== undefined && { entities: body.entities as unknown[] }),
    ...(body.reply_markup !== undefined && { keyboard: body.reply_markup }),
    ...(body.disable_notification === true && { silent: true }),
  })
  const messageResult = (m: FakeMessage & { date: number }, chatId: unknown) => ({ message_id: m.id, date: m.date, chat: { id: chatId, type: 'private' }, text: m.text, ...(m.entities && { entities: m.entities }) })

  const handlers: Record<string, (res: ServerResponse, body: Record<string, unknown>) => void> = {
    getMe: res => ok(res, { id: botId, is_bot: true, first_name: 'Fake', username }),
    getUpdates,
    deleteWebhook: res => {
      webhookActive = false
      ok(res, true)
    },
    sendMessage(res, body) {
      if (body.chat_id === undefined) return refuse(res, 400, 'Bad Request: chat_id is empty')
      const wrong = checkContent(body)
      if (wrong) return refuse(res, 400, wrong)
      const m = { ...store(body), id: nextMessage++, date: Math.floor(now() / 1000) }
      messagesOf(body.chat_id).push(m)
      ok(res, messageResult(m, body.chat_id))
    },
    editMessageText(res, body) {
      const wrong = checkContent(body)
      if (wrong) return refuse(res, 400, wrong)
      const list = body.chat_id === undefined ? [] : messagesOf(body.chat_id)
      const at = list.findIndex(m => m.id === body.message_id)
      if (at < 0) return refuse(res, 400, 'Bad Request: message to edit not found')
      const old = list[at]
      if (old.text === body.text && sameEntities(old.entities, body.entities) && same(old.keyboard, body.reply_markup)) return refuse(res, 400, NOT_MODIFIED)
      // 编辑不带 reply_markup 就没有键盘了;silent 是发送时定的,编辑改不了
      const m = { ...store({ ...body, disable_notification: old.silent }), id: old.id, date: old.date }
      list[at] = m
      ok(res, messageResult(m, body.chat_id))
    },
    answerCallbackQuery(res, body) {
      if (typeof body.callback_query_id !== 'string' || body.callback_query_id === '') return refuse(res, 400, 'Bad Request: query is too old or query ID is invalid')
      ok(res, true)
    },
    sendChatAction(res, body) {
      if (body.chat_id === undefined || typeof body.action !== 'string') return refuse(res, 400, 'Bad Request: chat_id is empty')
      ok(res, true)
    },
    leaveChat(res, body) {
      if (body.chat_id === undefined) return refuse(res, 400, 'Bad Request: chat_id is empty')
      ok(res, true)
    },
  }

  const handle = (req: IncomingMessage, res: ServerResponse, rawBody: string) => {
    if (offline) return void req.socket.destroy()
    const path = req.url ?? ''
    const m = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(path)
    if (!m) return refuse(res, 404, 'Not Found')
    const method = m[2]
    let body: Record<string, unknown> = {}
    let malformed = false
    if (rawBody !== '') {
      try {
        const parsed: unknown = JSON.parse(rawBody)
        if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>
        else malformed = true
      } catch {
        malformed = true
      }
    }
    requests.push({ method, path, body, at: now() })
    if (m[1] !== opts.token) return refuse(res, 401, 'Unauthorized')
    if (malformed) return refuse(res, 400, 'Bad Request: invalid JSON')
    const queue = failures.get(method)
    const failure = queue?.[0]
    if (failure) {
      if (--failure.left <= 0) queue?.shift()
      const { reply } = failure
      if (reply === 'drop') return void req.socket.destroy()
      if (reply === 'hang') {
        hung.add(res)
        res.once('close', () => hung.delete(res))
        return
      }
      return json(res, reply.status, reply.body ?? { ok: false, error_code: reply.status, description: `fake failure ${reply.status}` }, reply.headers)
    }
    const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined
    if (!handler) return refuse(res, 404, 'Not Found')
    handler(res, body)
  }

  const server = createServer((req, res) => {
    const parts: Buffer[] = []
    req.on('data', (c: Buffer) => parts.push(c))
    req.on('end', () => handle(req, res, Buffer.concat(parts).toString('utf8')))
    req.on('error', () => {})
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const fake: FakeTelegram = {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    push(update) {
      const id = update.update_id ?? nextUpdate
      nextUpdate = Math.max(nextUpdate, id + 1)
      const out: PartialUpdate & { update_id: number } = { ...update, update_id: id }
      const message = update.message
      if (message && typeof message === 'object') {
        out.message = { message_id: nextMessage++, date: Math.floor(now() / 1000), ...message }
      }
      updates.push(out)
      wake()
      return id
    },
    outbox: chatId => (chats.get(String(chatId)) ?? []).map(({ date: _date, ...m }) => m),
    fail(method, n, reply) {
      if (n <= 0) return
      const queue = failures.get(method) ?? []
      queue.push({ left: n, reply })
      failures.set(method, queue)
    },
    deleteMessage(chatId, messageId) {
      const list = chats.get(String(chatId))
      const at = list?.findIndex(m => m.id === messageId) ?? -1
      if (at >= 0) list?.splice(at, 1)
    },
    undelivered: () => updates.filter(u => !delivered.has(u.update_id)).length,
    get webhookActive() {
      return webhookActive
    },
    set webhookActive(v: boolean) {
      webhookActive = v
    },
    get offline() {
      return offline
    },
    set offline(v: boolean) {
      offline = v
      if (!v) return
      endWaiter(() => {})
      server.closeAllConnections()
    },
    async close() {
      if (closed) return
      closed = true
      endWaiter(() => {})
      const done = new Promise<void>(resolve => server.close(() => resolve()))
      server.closeAllConnections()
      await done
    },
  }
  return fake
}
