import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { Plugin, PluginContext } from '../src/kernel/pluginHost'
import { startFakeTelegram, type FakeTelegram } from './fakeTelegram'
import { telegramKernel, TEST_TOKEN, type TelegramRig } from './telegramRig'

const TOKEN = TEST_TOKEN
let fake: FakeTelegram | undefined
let rig: TelegramRig | undefined

afterEach(async () => {
  await fake?.close()
  fake = undefined
  await rig?.close()
  rig = undefined
})

async function start(o: Partial<Parameters<typeof startFakeTelegram>[0]> = {}) {
  fake = await startFakeTelegram({ token: TOKEN, ...o })
  return fake
}
const raw = (f: FakeTelegram, method: string, body: object = {}, token = TOKEN) =>
  fetch(`${f.base}/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual' })
const api = async (f: FakeTelegram, method: string, body: object = {}, token = TOKEN) => {
  const r = await raw(f, method, body, token)
  return { status: r.status, json: (await r.json()) as any }
}
const send = (f: FakeTelegram, body: object) => api(f, 'sendMessage', { chat_id: 7, text: 'hi', ...body })

describe('fake Bot API: the rules we believe the API enforces', () => {
  it('wrong token → 401, the request is still recorded; unknown path and method → 404', async () => {
    const f = await start()
    expect(await api(f, 'getMe', {}, 'nope')).toMatchObject({ status: 401, json: { ok: false, error_code: 401 } })
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0]).toMatchObject({ method: 'getMe', path: '/botnope/getMe' })
    expect((await fetch(`${f.base}/x`)).status).toBe(404)
    expect((await api(f, 'noSuchMethod')).status).toBe(404)
  })

  it('getMe answers with the bot', async () => {
    const f = await start({ botId: 99, username: 'mine_bot' })
    expect((await api(f, 'getMe')).json.result).toMatchObject({ id: 99, is_bot: true, username: 'mine_bot' })
  })

  it('text: over 4096 → 400, exactly 4096 passes, empty and blank → 400, UTF-16 length counts', async () => {
    const f = await start()
    expect((await send(f, { text: 'x'.repeat(4097) })).status).toBe(400)
    expect((await send(f, { text: 'x'.repeat(4096) })).status).toBe(200)
    expect((await send(f, { text: '' })).status).toBe(400)
    expect((await send(f, { text: ' \n' })).status).toBe(400)
    expect((await send(f, { text: undefined })).status).toBe(400)
    expect((await send(f, { text: '\u{1F600}'.repeat(2049) })).status).toBe(400)
    expect(f.outbox(7)).toHaveLength(1)
    const sent = (await send(f, { text: 'ok' })).json.result.message_id
    const editBy = (text: string) => api(f, 'editMessageText', { chat_id: 7, message_id: sent, text })
    expect((await editBy('x'.repeat(4097))).status).toBe(400)
    expect((await editBy('')).status).toBe(400)
  })

  it('chat_id is required', async () => {
    const f = await start()
    expect((await api(f, 'sendMessage', { text: 'x' })).status).toBe(400)
  })

  it('edit: replaces the content; identical → 400 not modified; a changed entity or keyboard is a change; unknown message → 400 not found', async () => {
    const f = await start()
    const id = (await send(f, { text: 'one' })).json.result.message_id
    expect((await api(f, 'editMessageText', { chat_id: 7, message_id: id, text: 'two' })).status).toBe(200)
    expect(f.outbox(7)).toEqual([expect.objectContaining({ id, text: 'two' })])
    const same = await api(f, 'editMessageText', { chat_id: 7, message_id: id, text: 'two' })
    expect(same.status).toBe(400)
    expect(same.json.description).toMatch(/message is not modified/)
    expect((await api(f, 'editMessageText', { chat_id: 7, message_id: id, text: 'two', entities: [{ type: 'bold', offset: 0, length: 1 }] })).status).toBe(200)
    expect((await api(f, 'editMessageText', { chat_id: 7, message_id: id, text: 'two', entities: [{ type: 'bold', offset: 0, length: 1 }], reply_markup: { inline_keyboard: [[{ text: 'a', callback_data: 'b' }]] } })).status).toBe(200)
    expect(f.outbox(7)[0].keyboard).toBeDefined()
    expect((await api(f, 'editMessageText', { chat_id: 7, message_id: id, text: 'two', entities: [{ type: 'bold', offset: 0, length: 1 }] })).status).toBe(200)
    expect(f.outbox(7)[0].keyboard).toBeUndefined()
    const missing = await api(f, 'editMessageText', { chat_id: 7, message_id: 123456, text: 'x' })
    expect(missing.status).toBe(400)
    expect(missing.json.description).toMatch(/message to edit not found/)
    expect((await api(f, 'editMessageText', { chat_id: 8, message_id: id, text: 'x' })).status).toBe(400)
  })

  it('a message the user deleted can no longer be edited', async () => {
    const f = await start()
    const id = (await send(f, { text: 'one' })).json.result.message_id
    f.deleteMessage(7, id)
    expect(f.outbox(7)).toEqual([])
    expect((await api(f, 'editMessageText', { chat_id: 7, message_id: id, text: 'x' })).json.description).toMatch(/to edit not found/)
  })

  it('callback_data: 1 to 64 bytes, counted in bytes', async () => {
    const f = await start()
    const markup = (data: string) => ({ reply_markup: { inline_keyboard: [[{ text: 'y', callback_data: data }]] } })
    expect((await send(f, markup('x'.repeat(64)))).status).toBe(200)
    expect((await send(f, markup('x'.repeat(65)))).status).toBe(400)
    expect((await send(f, markup('中'.repeat(22)))).status).toBe(400)
    expect((await send(f, markup(''))).status).toBe(400)
    const id = (await send(f, { text: 'edit me' })).json.result.message_id
    expect((await api(f, 'editMessageText', { chat_id: 7, message_id: id, text: 'edited', ...markup('x'.repeat(65)) })).status).toBe(400)
  })

  it('entities: offset or length past the end → 400, the end itself passes, UTF-16 units, at most 100', async () => {
    const f = await start()
    const e = (offset: number, length: number) => ({ type: 'bold', offset, length })
    expect((await send(f, { text: 'abc', entities: [e(0, 3)] })).status).toBe(200)
    expect((await send(f, { text: 'abc', entities: [e(0, 4)] })).status).toBe(400)
    expect((await send(f, { text: 'abc', entities: [e(3, 1)] })).status).toBe(400)
    expect((await send(f, { text: 'abc', entities: [e(-1, 1)] })).status).toBe(400)
    expect((await send(f, { text: 'abc', entities: [e(0, 0)] })).status).toBe(400)
    expect((await send(f, { text: '\u{1F600}', entities: [e(0, 2)] })).status).toBe(200)
    expect((await send(f, { text: '\u{1F600}', entities: [e(0, 3)] })).status).toBe(400)
    expect((await send(f, { text: 'x'.repeat(200), entities: Array.from({ length: 100 }, (_, i) => e(i, 1)) })).status).toBe(200)
    expect((await send(f, { text: 'x'.repeat(200), entities: Array.from({ length: 101 }, (_, i) => e(i, 1)) })).status).toBe(400)
    const id = (await send(f, { text: 'edit me' })).json.result.message_id
    expect((await api(f, 'editMessageText', { chat_id: 7, message_id: id, text: 'abc', entities: [e(0, 4)] })).status).toBe(400)
  })

  it('outbox keeps text, entities, keyboard and whether it was silent, per chat', async () => {
    const f = await start()
    const entities = [{ type: 'code', offset: 0, length: 1 }]
    const keyboard = { inline_keyboard: [[{ text: 'y', callback_data: 'a' }]] }
    await send(f, { text: 'a', entities, reply_markup: keyboard, disable_notification: true })
    await api(f, 'sendMessage', { chat_id: 8, text: 'other' })
    expect(f.outbox(7)).toEqual([{ id: expect.any(Number), text: 'a', entities, keyboard, silent: true }])
    expect(f.outbox(8).map(m => m.text)).toEqual(['other'])
    expect(f.outbox(9)).toEqual([])
    expect(f.outbox('8').map(m => m.text)).toEqual(['other'])
  })

  it('an edit does not make a silent message loud, or the reverse', async () => {
    const f = await start()
    const quiet = (await send(f, { text: 'a', disable_notification: true })).json.result.message_id
    const loud = (await send(f, { text: 'b' })).json.result.message_id
    await api(f, 'editMessageText', { chat_id: 7, message_id: quiet, text: 'a2' })
    await api(f, 'editMessageText', { chat_id: 7, message_id: loud, text: 'b2', disable_notification: true })
    expect(f.outbox(7).map(m => m.silent)).toEqual([true, undefined])
  })

  it('the other methods we use answer ok and are recorded', async () => {
    const f = await start()
    expect((await api(f, 'answerCallbackQuery', { callback_query_id: 'c', text: '已失效' })).json.result).toBe(true)
    expect((await api(f, 'answerCallbackQuery', {})).status).toBe(400)
    expect((await api(f, 'sendChatAction', { chat_id: 7, action: 'typing' })).json.result).toBe(true)
    expect((await api(f, 'leaveChat', { chat_id: -100 })).json.result).toBe(true)
    expect(f.requests.map(r => r.method)).toEqual(['answerCallbackQuery', 'answerCallbackQuery', 'sendChatAction', 'leaveChat'])
    expect(f.requests[0].body).toEqual({ callback_query_id: 'c', text: '已失效' })
    expect(f.requests[0].at).toEqual(expect.any(Number))
  })
})

describe('fake Bot API: getUpdates', () => {
  const ids = (r: { json: { result: { update_id: number }[] } }) => r.json.result.map(u => u.update_id)

  it('push assigns increasing ids and fills in date and message_id; the clock is injectable', async () => {
    const f = await start({ now: () => 5_000_000 })
    const a = f.push({ message: { text: 'a' } })
    const b = f.push({ message: { text: 'b', date: 42, message_id: 9 } })
    expect(b).toBeGreaterThan(a)
    const { json } = await api(f, 'getUpdates', {})
    expect(json.result[0].message).toMatchObject({ text: 'a', date: 5000 })
    expect(json.result[0].message.message_id).toEqual(expect.any(Number))
    expect(json.result[1].message).toMatchObject({ text: 'b', date: 42, message_id: 9 })
  })

  it('an explicit id is kept, and later ones go on from the highest; garbage goes out untouched', async () => {
    const f = await start()
    expect(f.push({ update_id: 500, message: { text: 'a' } })).toBe(500)
    expect(f.push({ message: { text: 'b' } })).toBe(501)
    expect(f.push({ update_id: 3, nonsense: true })).toBe(3)
    const { json } = await api(f, 'getUpdates', {})
    expect(json.result.at(-1)).toEqual({ update_id: 3, nonsense: true })
  })

  it('no offset redelivers everything unconfirmed; an offset confirms what is below it, for good', async () => {
    const f = await start()
    const a = f.push({ message: { text: 'a' } })
    const b = f.push({ message: { text: 'b' } })
    expect(ids(await api(f, 'getUpdates', {}))).toEqual([a, b])
    expect(ids(await api(f, 'getUpdates', {}))).toEqual([a, b])
    expect(f.undelivered()).toBe(0)
    expect(ids(await api(f, 'getUpdates', { offset: b }))).toEqual([b])
    expect(ids(await api(f, 'getUpdates', {}))).toEqual([b])
    expect(ids(await api(f, 'getUpdates', { offset: b + 1 }))).toEqual([])
    expect(ids(await api(f, 'getUpdates', {}))).toEqual([])
  })

  it('limit caps a batch', async () => {
    const f = await start()
    for (let i = 0; i < 3; i++) f.push({ message: { text: `${i}` } })
    expect(ids(await api(f, 'getUpdates', { limit: 2 }))).toHaveLength(2)
    expect(f.undelivered()).toBe(1)
  })

  it('answers at once when it has updates, after timeout otherwise, and a push wakes a waiting poll', async () => {
    const f = await start()
    const t0 = Date.now()
    expect(ids(await api(f, 'getUpdates', { timeout: 0.02 }))).toEqual([])
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15)
    const waiting = api(f, 'getUpdates', { timeout: 30 })
    for (let i = 0; i < 100 && f.requests.length < 2; i++) await new Promise(r => setTimeout(r, 2))
    const id = f.push({ message: { text: 'now' } })
    expect(ids(await waiting)).toEqual([id])
    expect(f.undelivered()).toBe(0)
  })

  it('an aborted poll takes nothing with it', async () => {
    const f = await start()
    const c = new AbortController()
    const polling = fetch(`${f.base}/bot${TOKEN}/getUpdates`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"timeout":30}', signal: c.signal }).catch(e => e.name)
    for (let i = 0; i < 100 && f.requests.length < 1; i++) await new Promise(r => setTimeout(r, 2))
    c.abort()
    expect(await polling).toBe('AbortError')
    await new Promise(r => setTimeout(r, 5))
    const id = f.push({ message: { text: 'kept' } })
    expect(ids(await api(f, 'getUpdates', {}))).toEqual([id])
  })

  it('webhookActive → 409 with the description, until deleteWebhook', async () => {
    const f = await start()
    f.webhookActive = true
    f.push({ message: { text: 'held back' } })
    const r = await api(f, 'getUpdates', {})
    expect(r.status).toBe(409)
    expect(r.json.description).toMatch(/webhook/)
    expect((await api(f, 'deleteWebhook')).json.result).toBe(true)
    expect(f.webhookActive).toBe(false)
    expect((await api(f, 'getUpdates', {})).json.result).toHaveLength(1)
  })

  it('a second poller terminates the first with 409 other_poller semantics', async () => {
    const f = await start()
    const first = api(f, 'getUpdates', { timeout: 30 })
    for (let i = 0; i < 100 && f.requests.length < 1; i++) await new Promise(r => setTimeout(r, 2))
    const second = api(f, 'getUpdates', { timeout: 0.01 })
    const r = await first
    expect(r.status).toBe(409)
    expect(r.json.description).toMatch(/other getUpdates/)
    expect((await second).status).toBe(200)
  })
})

describe('fake Bot API: fail', () => {
  it('a status with a default body, for n calls, then back to normal, only for that method', async () => {
    const f = await start()
    f.fail('sendMessage', 2, { status: 500 })
    expect(await send(f, {})).toMatchObject({ status: 500, json: { ok: false, error_code: 500 } })
    expect((await api(f, 'getMe')).status).toBe(200)
    expect((await send(f, {})).status).toBe(500)
    expect((await send(f, {})).status).toBe(200)
    expect(f.outbox(7)).toHaveLength(1)
  })

  it('a body and headers: 429 with retry_after, a redirect that is not followed', async () => {
    const f = await start()
    f.fail('sendMessage', 1, { status: 429, body: { ok: false, error_code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } } })
    expect((await send(f, {})).json.parameters.retry_after).toBe(7)
    f.fail('getMe', 1, { status: 302, headers: { location: 'http://127.0.0.1:1/elsewhere' } })
    const r = await raw(f, 'getMe')
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('http://127.0.0.1:1/elsewhere')
  })

  it('drop destroys the connection; the failed call has no effect', async () => {
    const f = await start()
    f.fail('sendMessage', 1, 'drop')
    await expect(send(f, {})).rejects.toThrow()
    expect(f.outbox(7)).toEqual([])
    expect(f.requests).toHaveLength(1)
  })

  it('hang never answers; the caller can abort; close releases what is left', async () => {
    const f = await start()
    f.fail('getMe', 2, 'hang')
    const c = new AbortController()
    const aborted = fetch(`${f.base}/bot${TOKEN}/getMe`, { method: 'POST', body: '{}', signal: c.signal }).catch(e => e.name)
    const left = fetch(`${f.base}/bot${TOKEN}/getMe`, { method: 'POST', body: '{}' }).then(() => 'answered', () => 'released')
    for (let i = 0; i < 100 && f.requests.length < 2; i++) await new Promise(r => setTimeout(r, 2))
    c.abort()
    expect(await aborted).toBe('AbortError')
    await f.close()
    fake = undefined
    expect(await left).toBe('released')
  })

  it('close releases a poll that is waiting', async () => {
    const f = await start()
    const poll = fetch(`${f.base}/bot${TOKEN}/getUpdates`, { method: 'POST', body: '{"timeout":600}' }).then(() => 'answered', () => 'released')
    for (let i = 0; i < 100 && f.requests.length < 1; i++) await new Promise(r => setTimeout(r, 2))
    await f.close()
    fake = undefined
    expect(['answered', 'released']).toContain(await poll)
  })

  it('offline: connections die, nothing is recorded, a waiting poll is released; back on, it all works', async () => {
    const f = await start()
    const poll = fetch(`${f.base}/bot${TOKEN}/getUpdates`, { method: 'POST', body: '{"timeout":600}' }).then(() => 'answered', () => 'released')
    for (let i = 0; i < 100 && f.requests.length < 1; i++) await new Promise(r => setTimeout(r, 2))
    f.offline = true
    expect(await poll).toBe('released')
    await expect(send(f, {})).rejects.toThrow()
    expect(f.requests).toHaveLength(1)
    f.offline = false
    expect((await send(f, {})).status).toBe(200)
  })

  it('a malformed body is a 400, not a crash', async () => {
    const f = await start()
    const r = await fetch(`${f.base}/bot${TOKEN}/sendMessage`, { method: 'POST', body: '{nope' })
    expect(r.status).toBe(400)
    expect((await api(f, 'getMe')).status).toBe(200)
  })
})

describe('telegramRig', () => {
  /** 轮询一次、把看到的更新和回显写下来的最小插件:只用来验夹具 */
  function pollerPlugin(seen: unknown[]): (env: { apiBase: string; timers: { setTimeout(fn: () => void, ms: number): unknown }; sleep(ms: number): Promise<void> }) => Plugin {
    return env => ({
      manifest: { id: 'probe-poller', version: '0', kernel: '^0.1.0' },
      activate(ctx: PluginContext) {
        let stop = false
        const c = new AbortController()
        const loop = async () => {
          let offset: number | undefined
          while (!stop) {
            try {
              const res = await fetch(`${env.apiBase}/bot${TEST_TOKEN}/getUpdates`, { method: 'POST', body: JSON.stringify({ timeout: 0.01, ...(offset !== undefined && { offset }) }), signal: c.signal })
              const body = (await res.json()) as { result: { update_id: number }[] }
              for (const u of body.result) {
                seen.push(u)
                offset = u.update_id + 1
                ctx.log.info('saw update', { marker: 'LOG-MARKER' })
                await fetch(`${env.apiBase}/bot${TEST_TOKEN}/sendMessage`, { method: 'POST', body: JSON.stringify({ chat_id: 1001, text: 'BODY-MARKER' }), signal: c.signal })
              }
            } catch {
              if (!stop) await env.sleep(1000)
            }
          }
        }
        const running = loop()
        ctx.effect(async () => {
          stop = true
          c.abort()
          await running
        })
      },
    })
  }

  it('dm and press build the shapes the API sends; forwarding and bots are options', async () => {
    const seen: any[] = []
    rig = await telegramKernel({ plugin: pollerPlugin(seen) })
    const r = rig
    const a = r.dm('hello')
    const b = r.dm('fwd', { from: 2, name: 'Other', forwardOrigin: { type: 'hidden_user', sender_user_name: 'x', date: 1 } })
    const c = r.press('a:n:y', { messageId: 77 })
    const d = r.dm('grp', { chatId: -5, chatType: 'group', viaBot: { id: 3, is_bot: true, first_name: 'b' }, isBot: true, date: 1 })
    await r.settle()
    expect(seen.map(u => u.update_id)).toEqual([a, b, c, d])
    expect(seen[0].message).toMatchObject({ text: 'hello', chat: { id: r.owner, type: 'private' }, from: { id: r.owner, is_bot: false }, date: Math.floor(r.clock.now() / 1000) })
    expect(seen[1].message).toMatchObject({ from: { id: 2, first_name: 'Other' }, chat: { id: 2 }, forward_origin: { type: 'hidden_user' } })
    expect(seen[2].callback_query).toMatchObject({ data: 'a:n:y', from: { id: r.owner }, message: { message_id: 77, chat: { id: r.owner } } })
    expect(seen[2].callback_query.id).toEqual(expect.any(String))
    expect(seen[3].message).toMatchObject({ date: 1, chat: { id: -5, type: 'group' }, from: { is_bot: true }, via_bot: { id: 3 } })
    expect(r.fake.outbox(r.owner).map(m => m.text)).toEqual(Array(4).fill('BODY-MARKER'))
  })

  it('settle advances the clock when asked, in steps: chained timers all run', async () => {
    rig = await telegramKernel({})
    const fired: number[] = []
    const t0 = rig.clock.now()
    const chain = () => {
      fired.push(rig!.clock.now() - t0)
      if (fired.length < 3) rig!.clock.timers.setTimeout(chain, 700)
    }
    rig.clock.timers.setTimeout(chain, 700)
    await rig.settle()
    expect(fired).toEqual([])
    await rig.settle({ advance: 2100 })
    expect(fired).toHaveLength(3)
    expect(rig.clock.now() - t0).toBe(2100)
  })

  it('settle waits for until, and gives up instead of hanging', async () => {
    rig = await telegramKernel({})
    let ready = false
    setTimeout(() => { ready = true }, 10)
    await rig.settle({ until: () => ready })
    expect(ready).toBe(true)
    await expect(rig.settle({ until: () => false, timeoutMs: 30 })).rejects.toThrow(/settle/)
  })

  it('rawBytes covers the log db after a checkpoint, plugin files, config and log lines; not the credentials file; requests only on request', async () => {
    const seen: unknown[] = []
    let ctx!: PluginContext
    const keep: Plugin = { manifest: { id: 'keep', version: '0', kernel: '^0.1.0' }, activate: c => { ctx = c } }
    rig = await telegramKernel({ plugin: pollerPlugin(seen), plugins: () => [keep], config: { channels: { telegram: { marker: 'CONFIG-MARKER' } } } })
    const r = rig
    await ctx.secrets.set('k', 'SECRET-MARKER')
    const { sessionId } = (await r.k.handle('session.create', { commandId: 'c1' })) as { sessionId: string }
    ctx.append({ type: 'message.user', sessionId, payload: { turnId: 't', text: 'EVENT-MARKER 中文标记' } })
    await r.settle()
    r.dm('x')
    await r.settle()
    const bytes = r.rawBytes()
    expect(bytes.includes('EVENT-MARKER 中文标记')).toBe(true)
    expect(bytes.includes('CONFIG-MARKER')).toBe(true)
    expect(bytes.includes('LOG-MARKER')).toBe(true)
    expect(bytes.includes('SECRET-MARKER')).toBe(false)
    expect(bytes.includes('BODY-MARKER')).toBe(false)
    expect(r.rawBytes({ requests: true }).includes('BODY-MARKER')).toBe(true)
    expect(bytes.includes(TEST_TOKEN)).toBe(false)
    expect(r.rawBytes({ requests: true }).includes(TEST_TOKEN)).toBe(false)
  })

  it('restart keeps dirs, models, the clock and the fake; the plugin factory runs again', async () => {
    let built = 0
    rig = await telegramKernel({ plugin: () => { built++; return { manifest: { id: 'p', version: '0', kernel: '^0.1.0' }, activate() {} } } })
    const { sessionId } = (await rig.k.handle('session.create', { commandId: 'c1' })) as { sessionId: string }
    const old = rig.k
    await rig.restart()
    expect(rig.k).not.toBe(old)
    expect(built).toBe(2)
    expect(rig.k.events.after(0).some(e => e.sessionId === sessionId)).toBe(true)
    expect(rig.k.events.after(0).filter(e => e.type === 'kernel.stopping')).toHaveLength(1)
  })

  it('restart({ kill }): the new kernel sees the disk as it was: no stopping event, an open turn is interrupted, later writes by the old kernel are gone', async () => {
    let sideFile = 0
    const holder: Plugin = {
      manifest: { id: 'holder', version: '0', kernel: '^0.1.0' },
      activate(ctx) {
        ctx.events.on('session.prompt', async (r: { sessionId: string; turnId: string; signal: AbortSignal }) => {
          ctx.append({ type: 'turn.started', sessionId: r.sessionId, payload: { turnId: r.turnId } })
          await new Promise<void>(res => r.signal.addEventListener('abort', () => res(), { once: true }))
          return true
        })
        ctx.effect(() => { sideFile++ })
      },
    }
    rig = await telegramKernel({ plugin: () => holder })
    const { sessionId } = (await rig.k.handle('session.create', { commandId: 'c1' })) as { sessionId: string }
    await rig.k.handle('session.prompt', { commandId: 'p1', sessionId, text: 'go' })
    await rig.settle()
    await rig.restart({ kill: true })
    expect(sideFile).toBe(1) // 旧内核确实被清理了:没有留下进程和句柄
    const evs = rig.k.events.after(0)
    expect(evs.filter(e => e.type === 'kernel.stopping')).toEqual([])
    expect(evs.filter(e => e.type === 'turn.failed').map(e => e.payload)).toEqual([expect.objectContaining({ reason: 'interrupted' })])
    expect(evs.filter(e => e.type === 'kernel.started')).toHaveLength(2)
  })

  it('restart({ kill }): the dying kernel reaches no one, and its poller is gone; unconfirmed updates come to the new one', async () => {
    const seen: string[] = []
    let dying = 0
    // 拿到一批就不再轮询,所以这批没有确认:等于崩溃在确认之前
    const onePoll = (env: { apiBase: string }): Plugin => ({
      manifest: { id: 'one-poll', version: '0', kernel: '^0.1.0' },
      activate(ctx) {
        const c = new AbortController()
        const running = (async () => {
          while (!c.signal.aborted) {
            const res = await fetch(`${env.apiBase}/bot${TEST_TOKEN}/getUpdates`, { method: 'POST', body: '{"timeout":0.01}', signal: c.signal })
            const body = (await res.json()) as { result: { message: { text: string } }[] }
            if (body.result.length === 0) continue
            seen.push(...body.result.map(u => u.message.text))
            return
          }
        })().catch(() => {})
        ctx.effect(async () => {
          c.abort()
          await running
          dying++
          // 关闭时再发一条:死掉的内核什么都送不出去
          await fetch(`${env.apiBase}/bot${TEST_TOKEN}/sendMessage`, { method: 'POST', body: JSON.stringify({ chat_id: 1001, text: 'FROM-THE-DEAD' }) }).catch(() => {})
        })
      },
    })
    rig = await telegramKernel({ plugin: onePoll })
    const r = rig
    r.dm('first')
    await r.settle({ until: () => seen.length === 1 })
    await r.restart({ kill: true })
    expect(dying).toBe(1)
    await r.settle({ until: () => seen.length === 2 })
    expect(seen).toEqual(['first', 'first'])
    expect(r.fake.offline).toBe(false)
    expect(r.fake.outbox(1001)).toEqual([])
  })

  it('level goes to the kernel; temp dirs are gone after close', async () => {
    rig = await telegramKernel({ level: 'partial' })
    const r = rig
    expect(r.k.status().sandbox?.level).toBe('partial')
    expect(r.home.startsWith(r.root)).toBe(true)
    const root = r.root
    await r.close()
    rig = undefined
    expect(existsSync(root)).toBe(false)
  })

  it('fake models are the ones in memoryRig', async () => {
    rig = await telegramKernel({})
    expect(rig.models.calls).toEqual([])
    expect(rig.models.service).toBeDefined()
  })
})
