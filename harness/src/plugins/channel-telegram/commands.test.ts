// 命令(07 spec §11),从一条私聊走到底。这里没有真 git:项目那一半在 projects.test.ts
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { calling, say } from '../../../test/memoryRig'
import { enterProject, chatOf, events, flow, gatedScript, gatedStream, handled, onDisk, online, pairedRig, sends, stateFile, texts, users, type ChatRigOpts } from '../../../test/telegramChats'
import type { TelegramRig } from '../../../test/telegramRig'
import { createLoopDefault } from '../loop-default'
import { createToolsCoding } from '../tools-coding'
import toolsRegistry from '../tools-registry'
import { Cards } from './cards'
import { Chats } from './chats'
import { COMMANDS, isCommandShaped, parseCommand } from './commands'
import { Sender } from './sender'
import { TelegramState } from './state'

const BUSY = '这轮还在跑,先 /cancel'
const ALL = ['/help', '/status', '/new', '/project', '/project api', '/project off', '/model', '/model 1', '/cancel', '/rollback', '/unpair', '/unpair confirm']

const rigs: TelegramRig[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(rigs.splice(0).map(r => r.close()))
})

async function rig(o: ChatRigOpts = {}): Promise<TelegramRig> {
  const r = await pairedRig(o)
  rigs.push(r)
  return r
}

const created = (r: TelegramRig) => events(r, 'session.created').map(e => e.payload as Record<string, unknown>)
const said = (r: TelegramRig) => texts(r).length

async function send(r: TelegramRig, text: string, o: Parameters<TelegramRig['dm']>[1] = {}) {
  await handled(r, r.dm(text, o))
  await flow(r)
}

const TWO_MODELS = { accounts: [{ id: 'acct', models: [{ id: 'first' }, { id: 'second' }] }] }

describe('parseCommand', () => {
  it.each([
    ['/help', { name: 'help', args: [] }],
    ['/new\n', { name: 'new', args: [] }],
    ['/project api', { name: 'project', args: ['api'] }],
    ['/project   api\n  x', { name: 'project', args: ['api', 'x'] }],
    ['/status@fake_bot', { name: 'status', args: [] }],
    ['/status@FAKE_BOT now', { name: 'status', args: ['now'] }],
    ['/usr local', { name: 'usr', args: ['local'] }],
  ])('%j', (text, parsed) => {
    expect(parseCommand(text, 'fake_bot')).toEqual(parsed)
  })

  it.each(['/usr/local/bin', '/status@other_bot', '/status@other_bot now', 'status', ' /status', '/STATUS', '/1', '/', '/a.b', 'hello /status'])('%j is not one', text => {
    expect(parseCommand(text, 'fake_bot')).toBeUndefined()
  })

  it('a plugin command is command-shaped and parses to nothing: 09 has no way in from here', () => {
    for (const text of ['/x:y', '/my-plugin:do.it now', '/x:y@bot', '/x:y@bot now']) {
      expect(isCommandShaped(text)).toBe(true)
      expect(parseCommand(text, 'fake_bot')).toBeUndefined()
    }
    for (const text of ['/usr/local:x', 'x:y', '/x:', '/:y', '/http://a:b/c', '/x:y@', '/x:y@a/b']) expect(isCommandShaped(text)).toBe(false)
  })

  it('no known username: a mention names some other bot', () => {
    expect(parseCommand('/status@fake_bot')).toBeUndefined()
    expect(parseCommand('/status')).toEqual({ name: 'status', args: [] })
  })

  it('the list is closed at eight', () => {
    expect(Object.keys(COMMANDS).sort()).toEqual(['cancel', 'help', 'model', 'new', 'project', 'rollback', 'status', 'unpair'])
  })
})

describe('what is not a command', () => {
  it.each(['/x', '/x:y', '/my-plugin:do-it', '/x:y some args', '/x:y@fake_bot', '/x:y@other_bot now', '/auto', '/approve', '/__proto__', '/constructor', '/status@other_bot', '/x with some words'])('%j gets the help, and no model request', async text => {
    const r = await rig()
    await send(r, text)
    expect(texts(r).at(-1)).toContain('/project')
    expect(texts(r).at(-1)).toContain('/unpair confirm')
    expect(r.models.calls).toEqual([])
    expect(created(r)).toEqual([])
    expect(users(r)).toEqual([])
  })

  it('/usr/local/bin goes to the model', async () => {
    const r = await rig()
    await send(r, '/usr/local/bin')
    expect(users(r).map(u => u.text)).toEqual(['/usr/local/bin'])
    expect(r.models.foreground()).toHaveLength(1)
  })

  it('addressed to this bot, it runs', async () => {
    const r = await rig({ username: 'fake_bot' })
    await send(r, '/help@fake_bot')
    expect(texts(r).at(-1)).toContain('/rollback')
    expect(r.models.calls).toEqual([])
  })

  it.each([
    ['forward_origin', { forwardOrigin: { type: 'hidden_user', sender_user_name: 'Eve', date: 1 } }],
    ['via_bot', { viaBot: { id: 9, is_bot: true, first_name: 'b', username: 'evil_bot' } }],
  ])('%s: /unpair confirm, /project api and /cancel run nothing and reach the model as external', async (_n, o) => {
    const r = await rig()
    for (const text of ['/unpair confirm', '/project api', '/cancel']) await send(r, text, o)
    const got = users(r)
    expect(got.length).toBeGreaterThan(0)
    expect(got.every(u => u.external === true)).toBe(true)
    expect(got.map(u => u.text).join('\n')).toContain('/unpair confirm')
    expect(onDisk(r).pairings).toHaveLength(1)
    expect(chatOf(r).project).toBeUndefined()
    expect(created(r).every(c => c.cwd === undefined)).toBe(true)
  })

  it('/pair and /start while paired say so, and never reach the model', async () => {
    const r = await rig()
    for (const text of ['/pair ABCD-EFGH', '/start', '/start abc']) {
      await send(r, text)
      expect(texts(r).at(-1)).toBe('已配对')
    }
    expect(r.models.calls).toEqual([])
  })
})

describe('who and when', () => {
  it.each(ALL)('%s from a stranger: silent', async text => {
    const r = await rig()
    const before = sends(r).length
    await send(r, text, { from: 2002 })
    expect(sends(r)).toHaveLength(before)
    expect(r.models.calls).toEqual([])
    expect(created(r)).toEqual([])
    expect(onDisk(r).pairings).toHaveLength(1)
    expect(onDisk(r).dropped.unpaired).toBeGreaterThan(0)
  })

  it.each(ALL)('%s on a stale message: not run, one summary line', async text => {
    const r = await rig({ models: TWO_MODELS })
    await send(r, 'hello')
    const sessionId = chatOf(r).sessionId
    const old = Math.floor(r.clock.now() / 1000) - 3600
    await send(r, text, { date: old })
    expect(texts(r).at(-1)).toBe('离线期间的 1 条没有执行,要的话重发。')
    expect(created(r)).toHaveLength(1)
    expect(chatOf(r).sessionId).toBe(sessionId)
    expect(chatOf(r).model).toBeUndefined()
    expect(onDisk(r).pairings).toHaveLength(1)
    expect(events(r, 'channel.unpaired')).toEqual([])
    expect(onDisk(r).dropped.stale).toBe(1)
  })

  it('a chat marked blocked gets the answer to a command: sending one means it is not blocked', async () => {
    const r = await rig()
    const seeded = onDisk(r)
    seeded.chats[String(r.owner)] = { blocked: true }
    writeFileSync(stateFile(r), JSON.stringify(seeded))
    await r.restart({ kill: true })
    await online(r)
    await send(r, '/help')
    expect(chatOf(r).blocked).toBeUndefined()
    expect(texts(r).at(-1)).toContain('/rollback')
  })
})

describe('/help and /status', () => {
  it('/help names all eight', async () => {
    const r = await rig()
    await send(r, '/help')
    for (const name of Object.keys(COMMANDS)) expect(texts(r).at(-1)).toContain(`/${name}`)
  })

  it.each([
    ['none', '未隔离'],
    ['partial', '部分'],
    ['full', '完整'],
  ] as const)('/status at %s says %s', async (level, word) => {
    const r = await rig({ level })
    await send(r, '/status')
    expect(texts(r).at(-1)).toContain(word)
  })

  it('/status: state, mode, model, turn, queue, approval, and no absolute path', async () => {
    const gated = gatedStream('thinking', ' done')
    const r = await rig({ models: { script: gatedScript(gated) } })
    await send(r, '/status')
    const idle = texts(r).at(-1)!
    expect(idle).toContain('online')
    expect(idle).toContain('纯对话')
    expect(idle).toContain('gpt-5')
    expect(idle).toContain('空闲')
    expect(idle).toContain('每次问')
    await handled(r, r.dm('one'))
    await flow(r)
    await send(r, 'two')
    await send(r, '/status')
    const running = texts(r).at(-1)!
    expect(running).toContain('运行中')
    expect(running).toContain('排队 1')
    for (const line of [idle, running]) {
      expect(line).not.toContain(r.root)
      expect(line).not.toMatch(/\/[A-Za-z]+\//)
    }
    gated.open()
    await flow(r)
  })
})

describe('/model', () => {
  it('lists the catalog', async () => {
    const r = await rig({ models: TWO_MODELS })
    await send(r, '/model')
    expect(texts(r).at(-1)).toContain('1. acct · first')
    expect(texts(r).at(-1)).toContain('2. acct · second')
    expect(r.models.calls).toEqual([])
  })

  it('/model 2 takes effect on the next /new: the session in use keeps its model', async () => {
    const r = await rig({ models: TWO_MODELS })
    await send(r, 'one')
    await send(r, '/model 2')
    expect(texts(r).at(-1)).toContain('second')
    expect(chatOf(r).model).toEqual({ accountId: 'acct', modelId: 'second' })
    await send(r, 'two')
    expect(r.models.foreground().map(c => c.ref.modelId)).toEqual(['first', 'first'])
    expect(created(r)).toHaveLength(1)

    await send(r, '/new')
    expect(created(r)[1].model).toEqual({ accountId: 'acct', modelId: 'second' })
    await send(r, 'three')
    expect(r.models.foreground().at(-1)!.ref.modelId).toBe('second')
  })

  it('survives a restart: the record keeps it', async () => {
    const r = await rig({ models: TWO_MODELS })
    await send(r, '/model 2')
    await r.restart({ kill: true })
    await online(r)
    await send(r, 'hello')
    expect(created(r).at(-1)!.model).toEqual({ accountId: 'acct', modelId: 'second' })
  })

  it.each(['/model 0', '/model 3', '/model x', '/model 1 2', '/model -1', '/model auto'])('%s changes nothing', async text => {
    const r = await rig({ models: TWO_MODELS })
    await send(r, text)
    expect(chatOf(r)?.model).toBeUndefined()
    expect(texts(r).at(-1)).toContain('1. acct · first')
  })

  it('a coding-tools-only choice in chat mode is refused at /new, a usable one lets him out', async () => {
    const accounts = [
      { id: 'plan', restriction: 'coding-tools-only' as const, models: [{ id: 'c' }] },
      { id: 'paid', models: [{ id: 'p' }] },
    ]
    const r = await rig({ models: { accounts } })
    await send(r, '/new')
    expect(texts(r).at(-1)).toContain('/project')
    expect(created(r)).toEqual([])
    await send(r, '/model 2')
    await send(r, '/new')
    expect(created(r).at(-1)!.model).toEqual({ accountId: 'paid', modelId: 'p' })
  })
})

describe('/new', () => {
  it('a new session in chat mode, once', async () => {
    const r = await rig({ botId: 555 })
    await send(r, 'hello')
    const first = chatOf(r).sessionId
    const id = r.dm('/new')
    await handled(r, id)
    await flow(r)
    expect(chatOf(r).sessionId).not.toBe(first)
    expect(created(r)).toEqual([{ title: 'Telegram', approvalMode: 'ask', origin: 'im', audience: 'owner' }, { title: 'Telegram', approvalMode: 'ask', origin: 'im', audience: 'owner' }])
    expect(r.rawBytes().includes(`tg:555:${id}:new`)).toBe(true)
    expect(r.models.foreground()).toHaveLength(1)
  })

  it('refused during a running turn', async () => {
    const gated = gatedStream('thinking', ' done')
    const r = await rig({ models: { script: gatedScript(gated) } })
    await send(r, 'one')
    const before = chatOf(r).sessionId
    await send(r, '/new')
    expect(texts(r).at(-1)).toBe(BUSY)
    expect(chatOf(r).sessionId).toBe(before)
    gated.open()
    await flow(r)
    expect(created(r)).toHaveLength(1)
  })

  it('refused with a message still in the debounce window: it was written for this session', async () => {
    const r = await rig()
    await send(r, 'first')
    const before = chatOf(r).sessionId
    await handled(r, r.dm('second'))
    await handled(r, r.dm('/new'))
    await flow(r)
    expect(texts(r)).toContain(BUSY)
    expect(chatOf(r).sessionId).toBe(before)
    expect(users(r).map(u => u.text)).toEqual(['first', 'second'])
  })

  it('redelivered after a crash: no second session', async () => {
    const r = await rig()
    await send(r, 'hello')
    const saved = readFileSync(stateFile(r))
    const id = r.dm('/new')
    await handled(r, id)
    await flow(r)
    const sessionId = chatOf(r).sessionId
    writeFileSync(stateFile(r), saved)
    await r.restart({ kill: true })
    r.fake.push({ update_id: id, message: { chat: { id: r.owner, type: 'private' }, from: { id: r.owner, is_bot: false, first_name: 'Owner' }, text: '/new' } })
    await online(r)
    await handled(r, id)
    await flow(r)
    expect(created(r)).toHaveLength(2)
    expect(chatOf(r).sessionId).toBe(sessionId)
  })
})

describe('redelivered after a crash', () => {
  const rewind = async (r: TelegramRig, text: string) => {
    const saved = readFileSync(stateFile(r))
    const id = r.dm(text)
    await handled(r, id)
    await flow(r)
    writeFileSync(stateFile(r), saved)
    await r.restart({ kill: true })
    r.fake.push({ update_id: id, message: { chat: { id: r.owner, type: 'private' }, from: { id: r.owner, is_bot: false, first_name: 'Owner' }, text } })
    await online(r)
    await handled(r, id)
    await flow(r)
  }

  it.each(['/help', '/status', '/project', '/project off', '/model', '/cancel', '/rollback', '/unpair', '/x'])('%s: no session, no turn, no model request', async text => {
    const r = await rig()
    await send(r, 'hello')
    const sessionId = chatOf(r).sessionId
    await rewind(r, text)
    expect(created(r)).toHaveLength(1)
    expect(chatOf(r).sessionId).toBe(sessionId)
    expect(users(r)).toHaveLength(1)
    expect(r.models.foreground()).toHaveLength(1)
    expect(onDisk(r).pairings).toHaveLength(1)
  })

  it('/model 2: the same choice', async () => {
    const r = await rig({ models: TWO_MODELS })
    await rewind(r, '/model 2')
    expect(chatOf(r).model).toEqual({ accountId: 'acct', modelId: 'second' })
    expect(r.models.calls).toEqual([])
  })

  it('/unpair confirm: unpaired either way. A crash in that window writes the event twice; the end state is the same', async () => {
    const r = await rig()
    await rewind(r, '/unpair confirm')
    expect(onDisk(r).pairings).toEqual([])
    expect(events(r, 'channel.unpaired').length).toBeGreaterThan(0)
  })
})

describe('a split paste', () => {
  const part = 'x'.repeat(3600)

  it.each(['/unpair confirm', '/model 2', '/cancel now', '/help'])('a fragment that reads %j is text, it runs nothing', async fragment => {
    const r = await rig({ models: TWO_MODELS })
    r.dm(part)
    await handled(r, r.dm(fragment))
    await flow(r)
    expect(onDisk(r).pairings).toHaveLength(1)
    expect(chatOf(r).model).toBeUndefined()
    expect(users(r).map(u => u.text)).toEqual([`${part}\n${fragment}`])
  })

  it('after the window a command is a command again; a short message opens no paste', async () => {
    const r = await rig()
    await send(r, part)
    await send(r, '/help')
    expect(texts(r).at(-1)).toContain('/rollback')
    await handled(r, r.dm('short'))
    await handled(r, r.dm('/help'))
    await flow(r)
    expect(users(r).map(u => u.text)).toEqual([part, 'short'])
  })
})

describe('/cancel', () => {
  it('cancels the turn and clears the queue', async () => {
    const gated = gatedStream('thinking', ' done')
    const r = await rig({ models: { script: gatedScript(gated) }, botId: 555 })
    await send(r, 'one')
    await send(r, 'two')
    const id = r.dm('/cancel')
    await handled(r, id)
    await flow(r)
    expect(chatOf(r).queue).toEqual([])
    expect(events(r, 'turn.failed').concat(events(r, 'turn.ended'))).toHaveLength(1)
    expect(texts(r)).toContain('已取消')
    expect(users(r).map(u => u.text)).toEqual(['one'])
    expect(r.rawBytes().includes(`tg:555:${id}:cancel`)).toBe(true)
  })

  it('with nothing running it says so and spends nothing', async () => {
    const r = await rig()
    await send(r, '/cancel')
    expect(texts(r).at(-1)).toBe('没有在跑的轮')
    expect(r.models.calls).toEqual([])
    expect(created(r)).toEqual([])
  })

  it('with only a queue it clears the queue', async () => {
    const r = await rig()
    await handled(r, r.dm('one'))
    await handled(r, r.dm('/cancel'))
    await flow(r)
    expect(texts(r).at(-1)).toBe('已清空排队')
    expect(users(r)).toEqual([])
    expect(r.models.calls).toEqual([])
  })
})

describe('/rollback', () => {
  it('in chat mode there is nothing to roll back', async () => {
    const r = await rig()
    await send(r, 'hello')
    await send(r, '/rollback')
    expect(texts(r).at(-1)).toBe('纯对话没有文件可回滚')
    expect(events(r, 'turn.rolledBack')).toEqual([])
  })

  it('with no session yet, the same', async () => {
    const r = await rig()
    await send(r, '/rollback')
    expect(texts(r).at(-1)).toBe('纯对话没有文件可回滚')
  })
})

describe('/unpair', () => {
  it.each(['/unpair', '/unpair yes', '/unpair confirm now', '/unpair CONFIRM'])('%s does nothing', async text => {
    const r = await rig()
    await send(r, text)
    expect(onDisk(r).pairings).toHaveLength(1)
    expect(events(r, 'channel.unpaired')).toEqual([])
    expect(texts(r).at(-1)).toContain('/unpair confirm')
  })

  it('/unpair confirm: event by im, saved, the next message is a stranger’s', async () => {
    const r = await rig()
    await send(r, 'hello')
    await send(r, '/unpair confirm')
    expect(onDisk(r).pairings).toEqual([])
    expect(events(r, 'channel.unpaired').map(e => e.payload)).toEqual([{ channel: 'telegram', accountId: String(r.owner), by: 'im' }])
    expect(texts(r).at(-1)).toBe('已解除配对')
    const before = sends(r).length
    await send(r, 'are you there')
    expect(sends(r)).toHaveLength(before)
    expect(r.models.foreground()).toHaveLength(1)
    expect(users(r).map(u => u.text)).toEqual(['hello'])
  })

  it('a save that fails is reported, not 已解除配对; revoked in memory all the same', async () => {
    const r = await rig()
    const real = TelegramState.prototype.save
    let failed = false
    vi.spyOn(TelegramState.prototype, 'save').mockImplementation(function (this: TelegramState) {
      if (!failed && this.data.pairings.length === 0) {
        failed = true
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
      }
      real.call(this)
    })
    await send(r, '/unpair confirm')
    expect(failed).toBe(true)
    expect(texts(r).at(-1)).toContain('没存上')
    expect(texts(r).at(-1)).not.toBe('已解除配对')
    const before = sends(r).length
    await send(r, 'hello')
    expect(sends(r)).toHaveLength(before)
  })

  it('/unpair confirm: revoke, then drop, then expire. Dropping after the expiry would throw away the 已失效 edits', async () => {
    const revoke = vi.spyOn(Chats.prototype, 'revoke')
    const drop = vi.spyOn(Sender.prototype, 'drop')
    const expire = vi.spyOn(Cards.prototype, 'expireAll')
    const r = await rig()
    await send(r, '/unpair confirm')
    const owner = String(r.owner)
    expect(revoke).toHaveBeenCalledExactlyOnceWith(owner)
    expect(drop).toHaveBeenCalledExactlyOnceWith(owner)
    expect(expire).toHaveBeenCalledOnce()
    const [a, b, c] = [revoke, drop, expire].map(f => f.mock.invocationCallOrder[0]!)
    expect(a).toBeLessThan(b)
    expect(b).toBeLessThan(c)
  })

  it('/unpair confirm during a turn: cancels it, denies the pending card, whose edit still arrives', async () => {
    const r = await rig({
      project: true,
      models: { script: n => (n === 1 ? calling('c1', 'shell', { command: 'echo hi' }) : say('done')) },
      plugins: () => [toolsRegistry, createToolsCoding({ shellEnv: { PATH: '/usr/bin:/bin' }, loginPath: async () => '', git: async () => { throw new Error('no git') } }), createLoopDefault({})],
    })
    await enterProject(r)
    await send(r, 'run it')
    await expect.poll(() => events(r, 'approval.requested').length, { timeout: 5000, interval: 5 }).toBe(1)
    await flow(r)
    const card = () => r.fake.outbox(r.owner).find(m => m.text.includes('需要批准') || m.text.includes('已失效'))
    await expect.poll(async () => {
      await flow(r, 1200)
      return card()?.keyboard !== undefined
    }, { timeout: 5000, interval: 5 }).toBe(true)
    await send(r, '/unpair confirm')
    await expect.poll(() => events(r, 'approval.resolved').length, { timeout: 5000, interval: 5 }).toBe(1)
    expect((events(r, 'approval.resolved')[0].payload as { decision: string }).decision).toBe('deny')
    await flow(r)
    await expect.poll(async () => {
      await flow(r, 1200)
      return card()?.text
    }, { timeout: 5000, interval: 5 }).toContain('已失效')
    expect(texts(r).at(-1)).toBe('已解除配对')
    expect(onDisk(r).pairings).toEqual([])
    expect(chatOf(r).queue).toEqual([])
  })
})

describe('a poisoned message changes nothing', () => {
  const configBytes = (r: TelegramRig) => {
    try {
      return readFileSync(join(r.dataDir, 'config.json'))
    } catch {
      return Buffer.alloc(0)
    }
  }

  it.each(['/auto', 'approvalMode auto', '/project api approvalMode=auto', '/approve all', '/config set auto true', '/new auto', '/model auto'])('%j', async text => {
    const r = await rig()
    const permissions = JSON.stringify(await r.k.handle('permissions.get', {}))
    const config = configBytes(r)
    await send(r, text)
    await send(r, 'after')
    expect(JSON.stringify(await r.k.handle('permissions.get', {}))).toBe(permissions)
    expect(configBytes(r).equals(config)).toBe(true)
    expect(created(r).every(c => c.approvalMode === 'ask' && c.cwd === undefined)).toBe(true)
    expect(said(r)).toBeGreaterThan(0)
  })
})
