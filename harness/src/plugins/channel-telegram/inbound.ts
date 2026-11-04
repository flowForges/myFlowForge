// 更新 → 分类(07 spec §5.2、§6、§12)。纯函数,永不抛错;字段不认识就当没有,形状不对的一律不当真。
// 账号和聊天的 id 只认安全整数,对外是十进制字符串
import { sanitizeLine } from '../../lib/memory/wrap'

export type IgnoredWhy = 'group' | 'bot' | 'channel' | 'malformed' | 'other'

export type Inbound =
  | { kind: 'dm'; updateId: number; chatId: string; accountId: string; name: string; text: string; /** 转发或经内联机器人来的:永远不是命令、不算配对、一律 external */ forwardedFrom?: string; date: number }
  | { kind: 'attachment'; updateId: number; chatId: string; accountId: string; date: number }
  | { kind: 'callback'; updateId: number; callbackId: string; accountId: string; chatId?: string; messageId?: number; data: string }
  | { kind: 'joined_group'; updateId: number; chatId: string }
  | { kind: 'blocked'; updateId: number; chatId: string; blocked: boolean }
  | { kind: 'ignored'; updateId: number; why: IgnoredWhy }

export type DmInbound = Extract<Inbound, { kind: 'dm' }>

type Obj = Record<string, unknown>

const NAME_MAX = 64
const UNKNOWN = 'unknown'
/** 新旧字段都算:文档里旧的 forward_from 系列已经没了,真来了也不能当成本人的话 */
const FORWARD_FIELDS = ['forward_origin', 'forward_from', 'forward_from_chat', 'forward_sender_name', 'forward_date']
const ATTACHMENT_FIELDS = ['photo', 'document', 'voice', 'video', 'audio', 'animation', 'sticker', 'video_note', 'contact', 'location', 'venue', 'poll', 'dice', 'game', 'invoice', 'paid_media', 'story', 'checklist']
const JOINED = new Set(['member', 'administrator'])

const obj = (v: unknown): Obj | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined)
const safeId = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** 进状态和事件的名字:一行、没有控制符和方向符,最多 64 字 */
function label(raw: string | undefined): string {
  const clean = raw === undefined ? '' : [...sanitizeLine(raw)].slice(0, NAME_MAX).join('').trim()
  return clean === '' ? UNKNOWN : clean
}

function personName(o: Obj | undefined): string | undefined {
  if (!o) return undefined
  const full = [str(o.first_name), str(o.last_name)].filter(Boolean).join(' ')
  return full || str(o.username)
}

function originName(origin: unknown): string | undefined {
  const o = obj(origin)
  if (!o) return undefined
  switch (o.type) {
    case 'user':
      return personName(obj(o.sender_user))
    case 'hidden_user':
      return str(o.sender_user_name)
    case 'chat': {
      const chat = obj(o.sender_chat)
      return str(chat?.title) ?? str(chat?.username)
    }
    case 'channel': {
      const chat = obj(o.chat)
      return str(chat?.title) ?? str(chat?.username)
    }
    default:
      return undefined
  }
}

function viaName(via: unknown): string | undefined {
  const o = obj(via)
  if (!o) return undefined
  const username = str(o.username)
  return username ? `@${username}` : personName(o)
}

/** 只要带了这些字段就算,不管形状:形状坏了不能变成"本人说的" */
function forwardedFrom(m: Obj): string | undefined {
  if (FORWARD_FIELDS.some(f => Object.hasOwn(m, f))) return label(originName(m.forward_origin))
  if (Object.hasOwn(m, 'via_bot')) return label(viaName(m.via_bot))
  return undefined
}

function classifyMessage(updateId: number, message: unknown): Inbound {
  const ignored = (why: IgnoredWhy): Inbound => ({ kind: 'ignored', updateId, why })
  const m = obj(message)
  const chat = obj(m?.chat)
  if (!m || !chat) return ignored('malformed')
  if (chat.type === 'group' || chat.type === 'supergroup') return ignored('group')
  if (chat.type === 'channel') return ignored('channel')
  if (chat.type !== 'private') return ignored('other')
  const from = obj(m.from)
  if (!from) return ignored('malformed')
  if (from.is_bot !== false) return ignored('bot')
  const account = safeId(from.id)
  // 私聊的 chat.id 就是对方的账号;对不上的不是 Telegram 发来的样子
  if (account === undefined || account <= 0 || safeId(chat.id) !== account) return ignored('malformed')
  const date = m.date
  if (typeof date !== 'number' || !Number.isFinite(date) || date <= 0) return ignored('malformed')
  const accountId = String(account)
  if (ATTACHMENT_FIELDS.some(f => m[f] !== undefined)) return { kind: 'attachment', updateId, chatId: accountId, accountId, date }
  const text = str(m.text)
  if (text === undefined) return ignored('other')
  const forwarded = forwardedFrom(m)
  return { kind: 'dm', updateId, chatId: accountId, accountId, name: label(personName(from)), text, ...(forwarded !== undefined && { forwardedFrom: forwarded }), date }
}

function classifyCallback(updateId: number, query: unknown): Inbound {
  const ignored = (why: IgnoredWhy): Inbound => ({ kind: 'ignored', updateId, why })
  const q = obj(query)
  const from = obj(q?.from)
  if (!q || !from) return ignored('malformed')
  if (from.is_bot !== false) return ignored('bot')
  const account = safeId(from.id)
  const callbackId = str(q.id)
  if (account === undefined || account <= 0 || !callbackId) return ignored('malformed')
  const data = str(q.data)
  if (data === undefined) return ignored('other')
  const message = obj(q.message)
  const chatId = safeId(obj(message?.chat)?.id)
  const messageId = safeId(message?.message_id)
  return {
    kind: 'callback',
    updateId,
    callbackId,
    accountId: String(account),
    ...(chatId !== undefined && { chatId: String(chatId) }),
    ...(messageId !== undefined && { messageId }),
    data,
  }
}

function classifyMember(updateId: number, update: unknown): Inbound {
  const ignored = (why: IgnoredWhy): Inbound => ({ kind: 'ignored', updateId, why })
  const u = obj(update)
  const chat = obj(u?.chat)
  const id = safeId(chat?.id)
  const status = obj(u?.new_chat_member)?.status
  if (!chat || id === undefined || typeof status !== 'string') return ignored('malformed')
  const chatId = String(id)
  if (chat.type === 'group' || chat.type === 'supergroup' || chat.type === 'channel') {
    return JOINED.has(status) ? { kind: 'joined_group', updateId, chatId } : ignored('group')
  }
  if (chat.type !== 'private') return ignored('other')
  if (status === 'kicked') return { kind: 'blocked', updateId, chatId, blocked: true }
  if (status === 'member') return { kind: 'blocked', updateId, chatId, blocked: false }
  return ignored('other')
}

function classifyChecked(update: unknown): Inbound {
  const u = obj(update)
  const updateId = safeId(u?.update_id)
  if (!u || updateId === undefined || updateId < 0) return { kind: 'ignored', updateId: -1, why: 'malformed' }
  if (Object.hasOwn(u, 'message')) return classifyMessage(updateId, u.message)
  if (Object.hasOwn(u, 'callback_query')) return classifyCallback(updateId, u.callback_query)
  if (Object.hasOwn(u, 'my_chat_member')) return classifyMember(updateId, u.my_chat_member)
  if (Object.hasOwn(u, 'channel_post')) return { kind: 'ignored', updateId, why: 'channel' }
  return { kind: 'ignored', updateId, why: 'other' }
}

export function classify(update: unknown): Inbound {
  try {
    return classifyChecked(update)
  } catch {
    return { kind: 'ignored', updateId: -1, why: 'malformed' }
  }
}

/** 不是用户本人写的:进内核要带 external(§12.1) */
export const isExternal = (dm: DmInbound): boolean => dm.forwardedFrom !== undefined
