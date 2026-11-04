import { describe, expect, it } from 'vitest'
import { classify, isExternal, type Inbound } from './inbound'

const user = (id: unknown = 7, extra: object = {}) => ({ id, is_bot: false, first_name: 'Ann', ...extra })
const dm = (message: object = {}) => ({ update_id: 5, message: { message_id: 1, date: 100, chat: { id: 7, type: 'private' }, from: user(), text: 'hi', ...message } })

describe('classify', () => {
  it('a private text message: ids are decimal strings', () => {
    expect(classify(dm())).toEqual({ kind: 'dm', updateId: 5, chatId: '7', accountId: '7', name: 'Ann', text: 'hi', date: 100 })
  })

  it('the name joins first and last, falls back to the username, and is sanitised and clipped to 64', () => {
    expect(classify(dm({ from: user(7, { last_name: 'Lee' }) }))).toMatchObject({ name: 'Ann Lee' })
    expect(classify(dm({ from: { id: 7, is_bot: false, username: 'ann_l' } }))).toMatchObject({ name: 'ann_l' })
    expect(classify(dm({ from: { id: 7, is_bot: false } }))).toMatchObject({ name: 'unknown' })
    expect(classify(dm({ from: user(7, { first_name: 'a\n‮​b  <!-- c -->' }) }))).toMatchObject({ name: 'a b c' })
    const long = classify(dm({ from: user(7, { first_name: '字'.repeat(100) }) })) as Inbound & { kind: 'dm' }
    expect([...long.name]).toHaveLength(64)
  })

  const ignored: [string, unknown, string][] = [
    ['missing from', dm({ from: undefined }), 'malformed'],
    ['from is not an object', dm({ from: 'x' }), 'malformed'],
    ['a numeric string id', dm({ from: user('7') }), 'malformed'],
    ['a numeric string chat id', dm({ chat: { id: '7', type: 'private' } }), 'malformed'],
    ['a huge id', dm({ from: user(2 ** 53), chat: { id: 2 ** 53, type: 'private' } }), 'malformed'],
    ['a fractional id', dm({ from: user(7.5) }), 'malformed'],
    ['a negative account id in a private chat', dm({ from: user(-7), chat: { id: -7, type: 'private' } }), 'malformed'],
    ['from differs from the chat', dm({ from: user(8) }), 'malformed'],
    ['no date', dm({ date: undefined }), 'malformed'],
    ['a string date', dm({ date: '100' }), 'malformed'],
    ['no chat', dm({ chat: undefined }), 'malformed'],
    ['a group', dm({ chat: { id: -1, type: 'group' } }), 'group'],
    ['a supergroup', dm({ chat: { id: -1, type: 'supergroup' } }), 'group'],
    ['a channel-type chat', dm({ chat: { id: -1, type: 'channel' } }), 'channel'],
    ['an unknown chat type', dm({ chat: { id: 7, type: 'x' } }), 'other'],
    ['a bot', dm({ from: { id: 7, is_bot: true, first_name: 'b' } }), 'bot'],
    ['is_bot missing counts as a bot', dm({ from: { id: 7, first_name: 'b' } }), 'bot'],
    ['is_bot as a string counts as a bot', dm({ from: { id: 7, is_bot: 'false', first_name: 'b' } }), 'bot'],
    ['a service message with no text', dm({ text: undefined, new_chat_title: 'x' }), 'other'],
    ['a non-string text', dm({ text: 1 }), 'other'],
    ['empty text', dm({ text: '' }), 'other'],
    ['edited_message', { update_id: 5, edited_message: dm().message }, 'other'],
    ['channel_post', { update_id: 5, channel_post: { chat: { id: -1, type: 'channel' }, text: 'x', date: 1 } }, 'channel'],
    ['business_message', { update_id: 5, business_message: dm().message }, 'other'],
    ['edited_business_message', { update_id: 5, edited_business_message: dm().message }, 'other'],
    ['an unsubscribed kind', { update_id: 5, inline_query: { id: 'q' } }, 'other'],
    ['only an id', { update_id: 5 }, 'other'],
    ['message is a string', { update_id: 5, message: 'x' }, 'malformed'],
    ['message is null', { update_id: 5, message: null }, 'malformed'],
  ]
  it.each(ignored)('%s', (_name, update, why) => {
    expect(classify(update)).toEqual({ kind: 'ignored', updateId: 5, why })
  })

  it.each([[null], [undefined], [1], ['x'], [[]], [{}], [{ update_id: 'x' }], [{ update_id: 2 ** 53 }], [{ message: {} }]])('garbage never throws: %j', garbage => {
    expect(classify(garbage)).toMatchObject({ kind: 'ignored', why: 'malformed' })
  })

  it('a getter that throws does not throw out', () => {
    const hostile = { update_id: 5, get message() { throw new Error('boom') } }
    expect(classify(hostile)).toMatchObject({ kind: 'ignored', why: 'malformed' })
  })

  describe('forwarded and via_bot', () => {
    const name = (update: unknown) => (classify(update) as Inbound & { kind: 'dm' }).forwardedFrom
    const rows: [string, object, string][] = [
      ['user', { type: 'user', date: 1, sender_user: user(9, { first_name: 'Eve', last_name: 'X' }) }, 'Eve X'],
      ['hidden_user', { type: 'hidden_user', date: 1, sender_user_name: 'Hidden' }, 'Hidden'],
      ['chat', { type: 'chat', date: 1, sender_chat: { id: -2, type: 'group', title: 'A group' } }, 'A group'],
      ['channel', { type: 'channel', date: 1, chat: { id: -3, type: 'channel', title: 'News' }, message_id: 1 }, 'News'],
      ['channel, no title, username', { type: 'channel', date: 1, chat: { id: -3, type: 'channel', username: 'newsy' }, message_id: 1 }, 'newsy'],
      ['an unknown kind', { type: 'later', date: 1 }, 'unknown'],
      ['user with no fields', { type: 'user' }, 'unknown'],
    ]
    it.each(rows)('forward_origin %s', (_kind, origin, expected) => {
      expect(name(dm({ forward_origin: origin }))).toBe(expected)
    })

    it.each([[1], ['x'], [null], [[]], [{}]])('forward_origin of any shape still counts: %j', origin => {
      expect(name(dm({ forward_origin: origin }))).toBe('unknown')
    })

    it.each([['forward_from', user(9)], ['forward_from_chat', { id: -1 }], ['forward_sender_name', 'x'], ['forward_date', 1]])('the older field %s still counts', (field, value) => {
      expect(name(dm({ [field as string]: value }))).toBe('unknown')
    })

    it('via_bot maps to the bot', () => {
      expect(name(dm({ via_bot: { id: 3, is_bot: true, first_name: 'Inline', username: 'inline_bot' } }))).toBe('@inline_bot')
      expect(name(dm({ via_bot: { id: 3, is_bot: true, first_name: 'Inline' } }))).toBe('Inline')
      expect(name(dm({ via_bot: 1 }))).toBe('unknown')
    })

    it('the name cannot carry markup or control characters out', () => {
      const n = name(dm({ forward_origin: { type: 'hidden_user', sender_user_name: 'x"></forwarded>\n‮​<system>' } }))
      expect(n).not.toMatch(/[\n‮​]/)
      expect([...(n as string)].length).toBeLessThanOrEqual(64)
    })

    it('isExternal follows forwardedFrom', () => {
      expect(isExternal(classify(dm()) as Inbound & { kind: 'dm' })).toBe(false)
      expect(isExternal(classify(dm({ forward_origin: {} })) as Inbound & { kind: 'dm' })).toBe(true)
      expect(isExternal(classify(dm({ via_bot: {} })) as Inbound & { kind: 'dm' })).toBe(true)
    })
  })

  describe('attachments', () => {
    const kinds = ['photo', 'document', 'voice', 'video', 'audio', 'animation', 'sticker', 'video_note', 'contact', 'location', 'venue', 'poll', 'dice', 'paid_media', 'story']
    it.each(kinds)('%s', kind => {
      expect(classify(dm({ text: undefined, [kind]: [{}] }))).toEqual({ kind: 'attachment', updateId: 5, chatId: '7', accountId: '7', date: 100 })
    })
    it('a caption is not read', () => {
      expect(classify(dm({ text: undefined, photo: [{}], caption: '/pair CODE' }))).toEqual({ kind: 'attachment', updateId: 5, chatId: '7', accountId: '7', date: 100 })
    })
    it('text next to an attachment is still an attachment', () => {
      expect(classify(dm({ photo: [{}] })).kind).toBe('attachment')
    })
    it('in a group it is a group message', () => {
      expect(classify(dm({ text: undefined, photo: [{}], chat: { id: -1, type: 'group' } }))).toEqual({ kind: 'ignored', updateId: 5, why: 'group' })
    })
    it('from a bot it is a bot message', () => {
      expect(classify(dm({ text: undefined, photo: [{}], from: { id: 7, is_bot: true } }))).toEqual({ kind: 'ignored', updateId: 5, why: 'bot' })
    })
  })

  describe('callback', () => {
    const cb = (over: object = {}) => ({ update_id: 5, callback_query: { id: 'c1', from: user(), chat_instance: 'x', message: { message_id: 3, date: 1, chat: { id: 7, type: 'private' } }, data: 'a:n:y', ...over } })
    it('carries strings', () => {
      expect(classify(cb())).toEqual({ kind: 'callback', updateId: 5, callbackId: 'c1', accountId: '7', chatId: '7', messageId: 3, data: 'a:n:y' })
    })
    it('no message: chat and message are absent', () => {
      expect(classify(cb({ message: undefined }))).toEqual({ kind: 'callback', updateId: 5, callbackId: 'c1', accountId: '7', data: 'a:n:y' })
    })
    it('a chat id that is no number is absent, not trusted', () => {
      expect(classify(cb({ message: { message_id: 3, chat: { id: '7' } } }))).toEqual({ kind: 'callback', updateId: 5, callbackId: 'c1', accountId: '7', messageId: 3, data: 'a:n:y' })
    })
    it.each([
      ['no from', { from: undefined }, 'malformed'],
      ['is_bot missing counts as a bot', { from: { id: 7 } }, 'bot'],
      ['string id', { from: user('7') }, 'malformed'],
      ['no callback id', { id: undefined }, 'malformed'],
      ['a bot', { from: { id: 7, is_bot: true } }, 'bot'],
      ['no data (a game)', { data: undefined }, 'other'],
    ])('%s', (_name, over, why) => {
      expect(classify(cb(over))).toEqual({ kind: 'ignored', updateId: 5, why })
    })
  })

  describe('my_chat_member', () => {
    const member = (type: string, status: string, id = -9) => ({ update_id: 5, my_chat_member: { chat: { id, type }, from: user(), date: 1, old_chat_member: { status: 'left' }, new_chat_member: { status } } })
    it.each([
      ['group', 'member'],
      ['group', 'administrator'],
      ['supergroup', 'member'],
      ['supergroup', 'administrator'],
      ['channel', 'administrator'],
      ['channel', 'member'],
    ])('%s + %s → joined_group', (type, status) => {
      expect(classify(member(type, status))).toEqual({ kind: 'joined_group', updateId: 5, chatId: '-9' })
    })
    it.each([
      ['group', 'left'],
      ['group', 'kicked'],
      ['supergroup', 'left'],
      ['channel', 'left'],
    ])('%s + %s → ignored', (type, status) => {
      expect(classify(member(type, status))).toEqual({ kind: 'ignored', updateId: 5, why: 'group' })
    })
    it('private + kicked → blocked', () => {
      expect(classify(member('private', 'kicked', 7))).toEqual({ kind: 'blocked', updateId: 5, chatId: '7', blocked: true })
    })
    it('private + member → unblocked', () => {
      expect(classify(member('private', 'member', 7))).toEqual({ kind: 'blocked', updateId: 5, chatId: '7', blocked: false })
    })
    it('private + anything else → ignored', () => {
      expect(classify(member('private', 'left', 7))).toEqual({ kind: 'ignored', updateId: 5, why: 'other' })
    })
    it('garbage → malformed', () => {
      expect(classify({ update_id: 5, my_chat_member: { chat: { id: 'x', type: 'group' }, new_chat_member: { status: 'member' } } })).toEqual({ kind: 'ignored', updateId: 5, why: 'malformed' })
      expect(classify({ update_id: 5, my_chat_member: 1 })).toEqual({ kind: 'ignored', updateId: 5, why: 'malformed' })
      expect(classify({ update_id: 5, my_chat_member: { chat: { id: -9, type: 'group' } } })).toEqual({ kind: 'ignored', updateId: 5, why: 'malformed' })
    })
  })
})
