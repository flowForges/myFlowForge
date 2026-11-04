import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKernel, type Kernel } from '../../kernel/kernel'
import type { Plugin, PluginContext } from '../../kernel/pluginHost'
import { RpcError } from '../../kernel/rpcError'
import { openSecretStore } from '../../kernel/secrets/secretStore'
import type { TelegramConfig, TelegramStatus } from '../../protocol/rpc'
import { NO_SANDBOX } from '../../../test/sandboxStub'
import { telegramKernel, TEST_TOKEN, type DmOpts, type TelegramEnv, type TelegramKernelOpts, type TelegramRig } from '../../../test/telegramRig'
import { BUILTIN_PLUGINS } from '../index'
import loopDirect from '../loop-direct'
import { createChannelTelegram, proxyKind, type ChannelTelegramOpts, type PairedDm } from './index'
import { TelegramState } from './state'

const HOUR = 3_600_000
const STABLE = 30_000
const SUCCESS = '配对成功。这里的对话和你的记忆内容会经过 Telegram 的服务器。'
const INVALID = '配对码无效或已过期'
const STRANGER = 2001

const rigs: TelegramRig[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(rigs.splice(0).map(r => r.close()))
})

type RigOpts = TelegramKernelOpts & { channel?: Partial<ChannelTelegramOpts> }

async function start(o: RigOpts = {}): Promise<TelegramRig> {
  const { channel, ...rest } = o
  const rig = await telegramKernel({ plugin: (env: TelegramEnv) => createChannelTelegram({ ...env, ...channel }), ...rest })
  rigs.push(rig)
  return rig
}

const status = (r: TelegramRig) => r.k.handle('channel.telegram.status', {}) as Promise<TelegramStatus>
const stateFile = (r: TelegramRig) => join(r.dataDir, 'plugins', 'channel-telegram', 'state.json')
const onDisk = (r: TelegramRig) => JSON.parse(readFileSync(stateFile(r), 'utf8'))
const sent = (r: TelegramRig, method = 'sendMessage') => r.fake.requests.filter(q => q.method === method)
const outbound = (r: TelegramRig) => r.fake.requests.filter(q => q.method !== 'getMe' && q.method !== 'getUpdates')
const events = (r: TelegramRig, type: string) => r.k.events.after(0).filter(e => e.type === type)
const textsTo = (r: TelegramRig, chat: number) => r.fake.outbox(chat).map(m => m.text)
const seconds = (r: TelegramRig) => Math.floor(r.clock.now() / 1000)

async function rpcError(p: Promise<unknown>): Promise<RpcError> {
  const e = await p.then(
    () => {
      throw new Error('expected a rejection')
    },
    (err: unknown) => err,
  )
  expect(e).toBeInstanceOf(RpcError)
  return e as RpcError
}

async function expectRefused(p: Promise<unknown>, message: string) {
  const e = await rpcError(p)
  expect(e.code).toBe(-32602)
  expect(e.message).toBe(message)
}

/** 轮询已经把这条更新处理完、落盘 */
async function handled(r: TelegramRig, updateId: number) {
  await expect.poll(() => onDisk(r).offset, { timeout: 3000, interval: 2 }).toBeGreaterThan(updateId)
}

async function withToken(o: RigOpts = {}): Promise<TelegramRig> {
  const r = await start(o)
  await r.k.handle('channel.telegram.setToken', { token: TEST_TOKEN })
  await expect.poll(async () => (await status(r)).state, { timeout: 3000, interval: 2 }).toBe('online')
  return r
}

/** 跳过一大段时间:途中 65 s 的中止会触发,轮询进退避,再走一点才回到 online */
async function jump(r: TelegramRig, ms: number) {
  r.clock.advance(ms)
  await r.settle()
  r.clock.advance(2000)
  await expect.poll(async () => (await status(r)).state, { timeout: 3000, interval: 2 }).toBe('online')
}

const begin = (r: TelegramRig) => r.k.handle('channel.telegram.pairing.begin', {}) as Promise<{ code: string; expiresAt: number; link?: string }>

async function paired(o: RigOpts = {}): Promise<TelegramRig> {
  const r = await withToken(o)
  const { code } = await begin(r)
  await handled(r, r.dm(`/pair ${code}`))
  return r
}

/** 收到的已配对私聊都记下来,不调模型 */
const recording = () => {
  const seen: PairedDm[] = []
  return { seen, channel: { onPairedDm: (d: PairedDm) => void seen.push(d) } }
}

describe('registration and activation', () => {
  it('BUILTIN_PLUGINS has it last', () => {
    expect(BUILTIN_PLUGINS.at(-1)?.manifest.id).toBe('channel-telegram')
  })

  /** 真的内置插件列表 + 默认的真地址:发一个请求这里就抛 */
  async function bootBuiltin(root: string, config: object = {}): Promise<Kernel> {
    const dataDir = join(root, 'data')
    const home = join(root, 'home')
    mkdirSync(dataDir, { recursive: true })
    mkdirSync(home, { recursive: true })
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ executors: { disabled: ['codex', 'qoder'] }, ...config }))
    return createKernel({ dataDir, home, env: { PATH: '/usr/bin:/bin', HOME: home, USERPROFILE: home }, sandbox: NO_SANDBOX, plugins: BUILTIN_PLUGINS, secrets: { osBackend: false } })
  }

  it.each([
    ['no token', {}, undefined, 'no_token'],
    ['enabled:false, no token', { channels: { telegram: { enabled: false } } }, undefined, 'disabled'],
    ['enabled:false with a token', { channels: { telegram: { enabled: false } } }, TEST_TOKEN, 'disabled'],
  ])('%s: zero fetch calls', async (_name, config, token, state) => {
    const root = mkdtempSync(join(tmpdir(), 'mffai-tg-builtin-'))
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('no request may leave')
    })
    let k: Kernel | undefined
    try {
      if (token) {
        const store = await openSecretStore({ dataDir: join(root, 'data'), osBackend: false })
        await store.set('channel-telegram/token', token)
      }
      k = await bootBuiltin(root, config)
      expect(k.status().plugins?.find((p: { id: string }) => p.id === 'channel-telegram')?.state).toBe('active')
      const s = (await k.handle('channel.telegram.status', {})) as TelegramStatus
      expect(s.state).toBe(state)
      expect(s.tokenSet).toBe(Boolean(token))
      await new Promise(res => setTimeout(res, 20))
      expect(spy).not.toHaveBeenCalled()
    } finally {
      await k?.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('no token: no poller, the rig fake sees nothing either', async () => {
    const r = await start()
    await r.settle()
    expect(r.fake.requests).toEqual([])
    expect((await status(r)).state).toBe('no_token')
    expect((await status(r)).tokenSet).toBe(false)
  })

  it('a stored token polls after a restart; activation returns while getMe hangs', async () => {
    const r = await withToken()
    r.fake.fail('getMe', 5, 'hang')
    const before = Date.now()
    await r.restart()
    expect(Date.now() - before).toBeLessThan(1500)
    expect((await status(r)).state).toBe('starting')
    expect((await status(r)).tokenSet).toBe(true)
  })

  it('state lives in a directory of its own, 0700 and 0600; the chmod stops there', async () => {
    const r = await withToken()
    await handled(r, r.dm('hello'))
    expect(statSync(join(r.dataDir, 'plugins', 'channel-telegram')).mode & 0o777).toBe(0o700)
    expect(statSync(stateFile(r)).mode & 0o777).toBe(0o600)
    const plain = join(r.root, 'plain-dir')
    mkdirSync(plain)
    expect(statSync(join(r.dataDir, 'plugins')).mode & 0o777).toBe(statSync(plain).mode & 0o777)
  })

  it('a broken config falls back to defaults with a warning, it does not fail activation', async () => {
    const r = await start({ config: { channels: { telegram: { enabled: 'yes', staleMinutes: -1, projects: 'x' } } } })
    expect(await r.k.handle('channel.telegram.config.get', {})).toEqual({ enabled: true, staleMinutes: 10, projects: [] })
    expect((await status(r)).problems).toContain('config_invalid')
    expect(r.logs.join('\n')).toContain('telegram config invalid')
  })

  it('unknown config fields are ignored, missing ones defaulted', async () => {
    const r = await start({ config: { channels: { telegram: { enabled: false, later: 1 } } } })
    expect(await r.k.handle('channel.telegram.config.get', {})).toEqual({ enabled: false, staleMinutes: 10, projects: [] })
    expect((await status(r)).problems).toEqual([])
  })

  it('proxyKind names a kind, never a URL; lowercase wins as it does in Node', () => {
    expect(proxyKind({})).toBe('none')
    expect(proxyKind({ HTTPS_PROXY: 'http://u:p@h:1' })).toBe('none')
    expect(proxyKind({ NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://u:p@h:1' })).toBe('env')
    expect(proxyKind({ NODE_USE_ENV_PROXY: '1', https_proxy: 'socks5://h:1', HTTPS_PROXY: 'http://h:1' })).toBe('socks')
    expect(proxyKind({ NODE_USE_ENV_PROXY: '1' })).toBe('none')
  })
})

describe('setToken', () => {
  it('checks the bot, stores, starts polling, echoes nothing', async () => {
    const r = await start({ username: 'my_bot', botId: 555 })
    const result = await r.k.handle('channel.telegram.setToken', { token: TEST_TOKEN })
    expect(result).toEqual({ ok: true, bot: { id: 555, username: 'my_bot' } })
    expect(JSON.stringify(result)).not.toContain(TEST_TOKEN)
    await expect.poll(async () => (await status(r)).state).toBe('online')
    const s = await status(r)
    expect(s.tokenSet).toBe(true)
    expect(s.bot).toEqual({ id: 555, username: 'my_bot' })
    expect(sent(r, 'getUpdates').length).toBeGreaterThan(0)
  })

  it.each([
    ['no colon', 'abc'],
    ['empty', ''],
    ['short id', `12345:${'A'.repeat(35)}`],
    ['long id', `1234567890123:${'A'.repeat(35)}`],
    ['short secret', `123456:${'A'.repeat(29)}`],
    ['a path', `123456:${'A'.repeat(30)}/../../x`],
    ['a query', `123456:${'A'.repeat(30)}?x=1`],
    ['a newline', `123456:${'A'.repeat(30)}\n`],
    ['a space', ` 123456:${'A'.repeat(30)}`],
  ])('a bad shape makes no request: %s', async (_name, token) => {
    const r = await start()
    await expectRefused(r.k.handle('channel.telegram.setToken', { token }), 'invalid_token')
    expect(r.fake.requests).toEqual([])
    expect((await status(r)).tokenSet).toBe(false)
  })

  it('a rejected token is not stored and polling does not start', async () => {
    const r = await start({ token: '999999:' + 'B'.repeat(35) })
    await expectRefused(r.k.handle('channel.telegram.setToken', { token: TEST_TOKEN }), 'unauthorized')
    expect((await status(r)).tokenSet).toBe(false)
    expect(sent(r, 'getUpdates')).toEqual([])
    await r.restart()
    expect((await status(r)).state).toBe('no_token')
  })

  it.each([
    ['500', { status: 500 }],
    ['a dropped connection', 'drop' as const],
    ['429', { status: 429, body: { parameters: { retry_after: 3 } } }],
  ])('%s → network, not stored', async (_name, reply) => {
    const r = await start()
    r.fake.fail('getMe', 1, reply)
    await expectRefused(r.k.handle('channel.telegram.setToken', { token: TEST_TOKEN }), 'network')
    expect((await status(r)).tokenSet).toBe(false)
  })

  it('getMe with no usable id → network, not stored', async () => {
    const r = await start()
    r.fake.fail('getMe', 1, { status: 200, body: { ok: true, result: { username: 'x' } } })
    await expectRefused(r.k.handle('channel.telegram.setToken', { token: TEST_TOKEN }), 'network')
    expect((await status(r)).tokenSet).toBe(false)
  })

  /** secretsBackend、secrets 换掉,其余用真的 */
  const lockedSecrets = (env: TelegramEnv): Plugin => {
    const p = createChannelTelegram(env)
    return {
      manifest: p.manifest,
      activate: ctx => {
        const fail = async () => {
          throw new Error('secrets unavailable')
        }
        return p.activate(Object.create(ctx, { secretsBackend: { value: 'unavailable' }, secrets: { value: { get: async () => undefined, set: fail, delete: fail } } }) as PluginContext)
      },
    }
  }

  it('secrets unavailable: -32602 secrets_unavailable before any request, and the state says so', async () => {
    const r = await telegramKernel({ plugin: lockedSecrets })
    rigs.push(r)
    expect((await status(r)).state).toBe('secrets_unavailable')
    await expectRefused(r.k.handle('channel.telegram.setToken', { token: TEST_TOKEN }), 'secrets_unavailable')
    expect(r.fake.requests).toEqual([])
  })

  it('a store that fails on write: secrets_unavailable, not an internal error, and no poller', async () => {
    const r = await telegramKernel({
      plugin: env => {
        const p = createChannelTelegram(env)
        return {
          manifest: p.manifest,
          activate: ctx => {
            const secrets = {
              get: ctx.secrets.get,
              delete: ctx.secrets.delete,
              set: async () => {
                throw new Error(`disk full ${TEST_TOKEN}`)
              },
            }
            return p.activate(Object.create(ctx, { secrets: { value: secrets } }) as PluginContext)
          },
        }
      },
    })
    rigs.push(r)
    const e = await rpcError(r.k.handle('channel.telegram.setToken', { token: TEST_TOKEN }))
    expect(e.message).toBe('secrets_unavailable')
    expect(sent(r, 'getUpdates')).toEqual([])
    expect(r.rawBytes().includes(TEST_TOKEN)).toBe(false)
  })

  it('the same bot with a new token keeps pairings and offset', async () => {
    const r = await paired()
    const { offset } = onDisk(r)
    await r.k.handle('channel.telegram.setToken', { token: TEST_TOKEN })
    const s = await status(r)
    expect(s.paired.map(p => p.accountId)).toEqual([String(r.owner)])
    expect(onDisk(r).offset).toBe(offset)
  })

  it('a changed bot clears offset, pairings and chats, through adoptBot, on disk before it polls', async () => {
    const r = await paired()
    const adopt = vi.spyOn(TelegramState.prototype, 'adoptBot')
    const other = 777
    r.fake.fail('getMe', 1, { status: 200, body: { ok: true, result: { id: other, username: 'other_bot' } } })
    const result = await r.k.handle('channel.telegram.setToken', { token: TEST_TOKEN })
    expect(result).toEqual({ ok: true, bot: { id: other, username: 'other_bot' } })
    expect(adopt).toHaveBeenCalledWith({ id: other, username: 'other_bot' })
    const disk = onDisk(r)
    expect(disk.pairings).toEqual([])
    expect(disk.chats).toEqual({})
    expect(disk.bot.id).toBe(other)
  })

  it('a code issued for the old bot does not pair on the new one', async () => {
    const r = await withToken()
    const { code } = await begin(r)
    r.fake.fail('getMe', 1, { status: 200, body: { ok: true, result: { id: 777, username: 'other_bot' } } })
    await r.k.handle('channel.telegram.setToken', { token: TEST_TOKEN })
    expect((await status(r)).pairing.active).toBe(false)
    await handled(r, r.dm(`/pair ${code}`))
    expect((await status(r)).paired).toEqual([])
  })

  it('two at once finish one after the other, and the second one decides', async () => {
    const r = await start()
    const results = await Promise.all([
      r.k.handle('channel.telegram.setToken', { token: TEST_TOKEN }),
      r.k.handle('channel.telegram.setToken', { token: TEST_TOKEN }),
    ])
    expect(results).toHaveLength(2)
    await expect.poll(async () => (await status(r)).state).toBe('online')
    expect(sent(r, 'getUpdates').filter(q => q.body.timeout > 0).length).toBeLessThanOrEqual(2)
  })
})

describe('the token goes nowhere', () => {
  const clean = async (r: TelegramRig, ...extra: unknown[]) => {
    const raw = r.rawBytes({ requests: true })
    expect(raw.includes(TEST_TOKEN)).toBe(false)
    expect(raw.includes(TEST_TOKEN.split(':')[1])).toBe(false)
    expect(JSON.stringify(await status(r))).not.toContain(TEST_TOKEN)
    expect(JSON.stringify(extra)).not.toContain(TEST_TOKEN)
    expect(JSON.stringify(r.k.events.after(0))).not.toContain(TEST_TOKEN)
  }

  it('through setToken, a 401, a dropped connection, a malformed setToken and restarts', async () => {
    const r = await start()
    const replies: unknown[] = []
    replies.push(await r.k.handle('channel.telegram.setToken', { token: TEST_TOKEN }))
    await expect.poll(async () => (await status(r)).state).toBe('online')
    await clean(r, replies)

    // 假服务器把 URL 写进错误正文
    const echo = { ok: false, description: `/bot${TEST_TOKEN}/getUpdates failed` }
    r.fake.fail('getMe', 1, { status: 401, body: echo })
    const e1 = await rpcError(r.k.handle('channel.telegram.setToken', { token: TEST_TOKEN }))
    replies.push(e1.message, e1.data, e1.stack)
    await clean(r, replies)

    r.fake.fail('getMe', 1, { status: 500, body: echo })
    const e2 = await rpcError(r.k.handle('channel.telegram.setToken', { token: TEST_TOKEN }))
    replies.push(e2.message, e2.data, e2.stack)

    r.fake.fail('getMe', 1, 'drop')
    const e3 = await rpcError(r.k.handle('channel.telegram.setToken', { token: TEST_TOKEN }))
    replies.push(e3.message, e3.data, e3.stack)

    const malformed = `${TEST_TOKEN}/x`
    const e4 = await rpcError(r.k.handle('channel.telegram.setToken', { token: malformed }))
    replies.push(e4.message, e4.data, e4.stack)
    expect(JSON.stringify(e4.data ?? null)).not.toContain('AAAA')
    await clean(r, replies)

    const update = r.fake.push({ message: { chat: { id: 1, type: 'private' }, from: { id: 1, is_bot: false, first_name: 'x' }, text: 'x' } })
    await handled(r, update)
    await r.restart()
    await expect.poll(async () => (await status(r)).state).toBe('online')
    r.clock.advance(STABLE)
    await clean(r, replies)

    r.fake.fail('getUpdates', 1, { status: 401, body: echo })
    await r.restart()
    r.fake.fail('getUpdates', 1, { status: 401, body: echo })
    await expect.poll(async () => (await status(r)).state, { timeout: 3000 }).toBe('unauthorized')
    await clean(r, replies)
    expect(events(r, 'channel.status').map(e => (e.payload as { state: string }).state)).toContain('unauthorized')

    await r.restart({ kill: true })
    await clean(r, replies)
  })

  it('no receipt holds it: setToken has no commandId even if a client sends one', async () => {
    const r = await start()
    await r.k.handle('channel.telegram.setToken', { token: TEST_TOKEN, commandId: 'c-token' })
    expect(r.rawBytes().includes(Buffer.from('c-token'))).toBe(false)
    expect(r.rawBytes().includes(TEST_TOKEN)).toBe(false)
  })

  it('every channel.status payload is a stable code', async () => {
    const r = await withToken()
    r.clock.advance(STABLE)
    await expect.poll(() => events(r, 'channel.status').length).toBeGreaterThan(0)
    for (const e of events(r, 'channel.status')) {
      expect(Object.keys(e.payload as object).sort().filter(k => !['channel', 'state', 'reason'].includes(k))).toEqual([])
    }
  })
})

describe('clearToken and clearWebhook', () => {
  it('clearToken stops polling, keeps pairings, kills an outstanding code, and survives a restart', async () => {
    const r = await paired()
    await r.k.handle('channel.telegram.unpair', { commandId: 'u1', accountId: String(r.owner) })
    const { code } = await begin(r)
    await r.k.handle('channel.telegram.clearToken', {})
    const s = await status(r)
    expect(s.state).toBe('no_token')
    expect(s.tokenSet).toBe(false)
    expect(s.pairing.active).toBe(false)
    expect(code).toBeTruthy()
    await r.settle()
    const before = r.fake.requests.length
    await r.settle({ advance: 120_000 })
    expect(r.fake.requests.length).toBe(before)
    await r.restart()
    expect((await status(r)).state).toBe('no_token')
  })

  it('clearToken leaves the paired account alone', async () => {
    const r = await paired()
    await r.k.handle('channel.telegram.clearToken', {})
    expect((await status(r)).paired.map(p => p.accountId)).toEqual([String(r.owner)])
  })

  it('401 stops the poll; a new token starts it again', async () => {
    const r = await withToken()
    r.fake.fail('getMe', 1, { status: 401 })
    await r.restart()
    await expect.poll(async () => (await status(r)).state).toBe('unauthorized')
    await r.settle()
    const before = r.fake.requests.length
    await r.settle()
    expect(r.fake.requests.length).toBe(before)
    await r.k.handle('channel.telegram.setToken', { token: TEST_TOKEN })
    await expect.poll(async () => (await status(r)).state).toBe('online')
  })

  it('clearWebhook: never automatic; on request it deletes and polling comes back at once', async () => {
    const r = await withToken()
    r.fake.webhookActive = true
    r.dm('wake the poll')
    await expect.poll(async () => (await status(r)).state).toBe('conflict')
    expect(sent(r, 'deleteWebhook')).toEqual([])
    expect(r.fake.webhookActive).toBe(true)
    await r.k.handle('channel.telegram.clearWebhook', { commandId: 'w1' })
    expect(r.fake.webhookActive).toBe(false)
    await expect.poll(async () => (await status(r)).state).toBe('online')
  })

  it('clearWebhook with no token is refused; a failure names a code', async () => {
    const r = await start()
    await expectRefused(r.k.handle('channel.telegram.clearWebhook', { commandId: 'w1' }), 'no_token')
    await r.k.handle('channel.telegram.setToken', { token: TEST_TOKEN })
    r.fake.fail('deleteWebhook', 1, { status: 401 })
    await expectRefused(r.k.handle('channel.telegram.clearWebhook', { commandId: 'w2' }), 'unauthorized')
    r.fake.fail('deleteWebhook', 1, 'drop')
    await expectRefused(r.k.handle('channel.telegram.clearWebhook', { commandId: 'w3' }), 'network')
  })
})

describe('channel.status', () => {
  const written = (r: TelegramRig) => events(r, 'channel.status').map(e => e.payload as { state: string; reason?: string })

  it('nothing at activation with no token; a change is written only after 30 s of being stable', async () => {
    const r = await start()
    expect(written(r)).toEqual([])
    await r.k.handle('channel.telegram.setToken', { token: TEST_TOKEN })
    await expect.poll(async () => (await status(r)).state).toBe('online')
    r.clock.advance(STABLE - 1)
    expect(written(r)).toEqual([])
    r.clock.advance(1)
    expect(written(r)).toEqual([{ channel: 'telegram', state: 'online' }])
  })

  it('a blip shorter than 30 s writes nothing', async () => {
    const r = await withToken()
    r.clock.advance(STABLE)
    const before = written(r).length
    r.fake.fail('getUpdates', 1, { status: 500 })
    r.dm('x')
    await expect.poll(async () => (await status(r)).state).toBe('reconnecting')
    r.clock.advance(2000)
    await expect.poll(async () => (await status(r)).state).toBe('online')
    r.clock.advance(STABLE)
    expect(written(r).length).toBe(before)
  })

  it('unauthorized and conflict are written at once', async () => {
    const r = await withToken()
    r.fake.webhookActive = true
    r.dm('x')
    await expect.poll(() => written(r).at(-1)).toEqual({ channel: 'telegram', state: 'conflict', reason: 'webhook' })
    const other = await withToken()
    other.fake.fail('getMe', 1, { status: 401 })
    await other.restart()
    await expect.poll(() => written(other).at(-1)).toEqual({ channel: 'telegram', state: 'unauthorized' })
  })

  it('a pending write does not fire after the plugin is gone', async () => {
    const r = await withToken()
    await r.restart()
    // 旧插件的定时器要是还在,这里就往关掉的库里写,抛错
    expect(() => r.clock.advance(STABLE)).not.toThrow()
  })
})

describe('pairing RPC', () => {
  it('code, expiry and link; link carries the code with no hyphen', async () => {
    const r = await withToken({ username: 'my_bot' })
    const { code, expiresAt, link } = await begin(r)
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
    expect(expiresAt).toBe(r.clock.now() + 5 * 60_000)
    expect(link).toBe(`https://t.me/my_bot?start=${code.replace('-', '')}`)
    expect((await status(r)).pairing).toEqual({ active: true, expiresAt })
  })

  it('cancel', async () => {
    const r = await withToken()
    const { code } = await begin(r)
    expect(await r.k.handle('channel.telegram.pairing.cancel', {})).toEqual({ ok: true })
    expect((await status(r)).pairing).toEqual({ active: false })
    await handled(r, r.dm(`/pair ${code}`))
    expect((await status(r)).paired).toEqual([])
  })

  it('while paired → -32602 full', async () => {
    const r = await paired()
    await expectRefused(begin(r), 'full')
  })

  it('in conflict → -32602 conflict, and an outstanding code dies the moment the conflict is seen', async () => {
    const r = await withToken()
    const { code } = await begin(r)
    r.fake.webhookActive = true
    r.dm('x')
    await expect.poll(async () => (await status(r)).state).toBe('conflict')
    expect((await status(r)).pairing.active).toBe(false)
    await expectRefused(begin(r), 'conflict')
    r.fake.webhookActive = false
    r.clock.advance(60_000)
    await handled(r, r.dm(`/pair ${code}`))
    expect((await status(r)).paired).toEqual([])
  })

  it.each([
    ['no token', async () => start(), 'no_token'],
    ['disabled', async () => start({ config: { channels: { telegram: { enabled: false } } } }), 'disabled'],
  ])('%s → refused', async (_name, make, message) => {
    await expectRefused(begin(await make()), message)
  })

  it('the code stays out of events, receipts, state, logs and every request but the reply-free pair message', async () => {
    const r = await withToken()
    const { code } = await begin(r)
    const plain = code.replace('-', '')
    const absent = () => {
      const raw = r.rawBytes({ requests: true })
      expect(raw.includes(code)).toBe(false)
      expect(raw.includes(plain)).toBe(false)
    }
    absent()
    await handled(r, r.dm(`/pair ${code}`))
    absent()
    expect((await status(r)).paired).toHaveLength(1)
    expect(JSON.stringify(await status(r))).not.toContain(plain)
  })

  it('begin takes no commandId: one sent by a client leaves no receipt', async () => {
    const r = await withToken()
    await r.k.handle('channel.telegram.pairing.begin', { commandId: 'c-begin' })
    expect(r.rawBytes().includes(Buffer.from('c-begin'))).toBe(false)
  })
})

describe('pairing in the chat', () => {
  it('the right code pairs: reply, event, status, on disk, with a sanitised name', async () => {
    const r = await withToken()
    const { code } = await begin(r)
    const id = r.dm(`/pair ${code}`, { name: 'Ann\n‮<b>' })
    await handled(r, id)
    await r.settle()
    expect(textsTo(r, r.owner)).toEqual([SUCCESS])
    const [event] = events(r, 'channel.paired')
    expect(event.payload).toEqual({ channel: 'telegram', accountId: String(r.owner), name: 'Ann <b>' })
    const s = await status(r)
    expect(s.paired[0]).toMatchObject({ accountId: String(r.owner), pairedAt: r.clock.now() })
    expect(typeof s.paired[0].accountId).toBe('string')
    expect(s.pairing.active).toBe(false)
    expect(onDisk(r).pairings).toHaveLength(1)
  })

  it.each([
    ['hyphenless', (c: string) => `/pair ${c.replace('-', '')}`],
    ['lower case', (c: string) => `/pair ${c.toLowerCase()}`],
    ['with the bot name', (c: string) => `/pair@fake_bot ${c}`],
    ['the deep link', (c: string) => `/start ${c.replace('-', '')}`],
  ])('form: %s', async (_name, form) => {
    const r = await withToken()
    const { code } = await begin(r)
    await handled(r, r.dm(form(code)))
    expect((await status(r)).paired).toHaveLength(1)
  })

  it('wrong, expired and no code get the same sentence', async () => {
    const r = await withToken()
    await handled(r, r.dm('/pair ZZZZ-ZZZZ', { from: 3001 })) // 没有码
    const a = await begin(r)
    await handled(r, r.dm('/pair ZZZZ-ZZZZ', { from: 3002 })) // 码错
    await jump(r, 5 * 60_000)
    await handled(r, r.dm(`/pair ${a.code}`, { from: 3003 })) // 过期
    await r.settle()
    for (const id of [3001, 3002, 3003]) expect(textsTo(r, id)).toEqual([INVALID])
  })

  it('a wrong code does not write the attempt: not the text, not in logs, events or state', async () => {
    const r = await withToken()
    await begin(r)
    await handled(r, r.dm('/pair ZZZZ-MARK', { from: 3001 }))
    expect(r.rawBytes().includes('ZZZZ')).toBe(false)
    expect(r.rawBytes().includes('MARK')).toBe(false)
  })

  it('three wrong codes lock that sender, across a restart; the sentence stops after 3', async () => {
    const r = await withToken()
    const { code } = await begin(r)
    for (let i = 0; i < 3; i++) await handled(r, r.dm('/pair ZZZZ-ZZZZ', { from: 3001 }))
    await handled(r, r.dm(`/pair ${code}`, { from: 3001 }))
    expect((await status(r)).paired).toEqual([])
    expect(onDisk(r).senders['3001'].lockedUntil).toBeGreaterThan(r.clock.now())

    await r.restart()
    await expect.poll(async () => (await status(r)).state).toBe('online')
    const next = await begin(r)
    await handled(r, r.dm(`/pair ${next.code}`, { from: 3001 }))
    await r.settle()
    expect((await status(r)).paired).toEqual([])
    expect(textsTo(r, 3001)).toEqual([INVALID, INVALID, INVALID])
  })

  it('ten wrong across senders burn the code and write channel.pairing.burned; the right code fails after that', async () => {
    const r = await withToken()
    const { code } = await begin(r)
    let last = 0
    for (let i = 0; i < 10; i++) last = r.dm('/pair ZZZZ-ZZZZ', { from: 3000 + Math.floor(i / 3) })
    await handled(r, last)
    expect(events(r, 'channel.pairing.burned').map(e => e.payload)).toEqual([{ channel: 'telegram' }])
    expect((await status(r)).pairing.active).toBe(false)
    await handled(r, r.dm(`/pair ${code}`, { from: 3100 }))
    expect((await status(r)).paired).toEqual([])
  })

  it.each([
    ['121 s before issue', 121, false],
    ['60 s before issue', 60, true],
    ['the same second', 0, true],
  ])('a correct code in a message dated %s', async (_name, before, ok) => {
    const r = await withToken()
    const { code } = await begin(r)
    await handled(r, r.dm(`/pair ${code}`, { date: seconds(r) - (before as number) }))
    expect((await status(r)).paired.length).toBe(ok ? 1 : 0)
  })

  it('a correct code in a group fails, and costs the code nothing', async () => {
    const r = await withToken()
    const { code } = await begin(r)
    for (const type of ['group', 'supergroup']) await handled(r, r.dm(`/pair ${code}`, { chatId: -5, chatType: type }))
    expect((await status(r)).paired).toEqual([])
    await r.settle()
    expect(sent(r)).toEqual([])
    expect((await status(r)).pairing.active).toBe(true)
    expect((await status(r)).dropped.group).toBe(2)
  })

  it.each([
    ['forward_origin', { forwardOrigin: { type: 'user', date: 1, sender_user: { id: 9, is_bot: false, first_name: 'Eve' } } } as DmOpts],
    ['via_bot', { viaBot: { id: 3, is_bot: true, first_name: 'Inline', username: 'inline_bot' } } as DmOpts],
  ])('a correct code by %s does not pair, is no attempt, gets no reply', async (_name, o) => {
    const r = await withToken()
    const { code } = await begin(r)
    await handled(r, r.dm(`/pair ${code}`, o))
    await handled(r, r.dm(`/start ${code.replace('-', '')}`, o))
    await r.settle()
    expect((await status(r)).paired).toEqual([])
    expect(sent(r)).toEqual([])
    expect((await status(r)).pairing.active).toBe(true)
    expect(onDisk(r).senders).toEqual({})
    expect((await status(r)).dropped.unpaired).toBe(2)
  })

  it('a correct code from a bot does not pair', async () => {
    const r = await withToken()
    const { code } = await begin(r)
    await handled(r, r.dm(`/pair ${code}`, { isBot: true }))
    expect((await status(r)).paired).toEqual([])
  })

  it('a used code fails for a second account', async () => {
    const r = await withToken()
    const { code } = await begin(r)
    await handled(r, r.dm(`/pair ${code}`))
    await handled(r, r.dm(`/pair ${code}`, { from: 3001 }))
    expect((await status(r)).paired.map(p => p.accountId)).toEqual([String(r.owner)])
  })

  it('bare /start from a stranger: silent, not an attempt, counted', async () => {
    const r = await withToken()
    await begin(r)
    await handled(r, r.dm('/start', { from: 3001 }))
    await handled(r, r.dm('/pair', { from: 3001 }))
    await r.settle()
    expect(sent(r)).toEqual([])
    expect(onDisk(r).senders).toEqual({})
    expect((await status(r)).dropped.unpaired).toBe(2)
  })

  it('a pairing that cannot be saved is not a pairing: rolled back, and the user is told it failed', async () => {
    const r = await withToken()
    const { code } = await begin(r)
    const save = vi.spyOn(TelegramState.prototype, 'save')
    save.mockImplementationOnce(() => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    })
    await handled(r, r.dm(`/pair ${code}`))
    await r.settle()
    expect((await status(r)).paired).toEqual([])
    expect(textsTo(r, r.owner)).toEqual([INVALID])
  })

  it('the event is on disk even when the crash comes right after: a pairing is never silent', async () => {
    const r = await withToken()
    const { code } = await begin(r)
    let eventsAtSave = -1
    const real = TelegramState.prototype.save
    vi.spyOn(TelegramState.prototype, 'save').mockImplementation(function (this: TelegramState) {
      if (this.data.pairings.length > 0 && eventsAtSave < 0) eventsAtSave = events(r, 'channel.paired').length
      return real.call(this)
    })
    await handled(r, r.dm(`/pair ${code}`))
    expect(eventsAtSave).toBe(1)
  })

  it('the /pair message of a paired account: already paired, nothing else', async () => {
    const r = await paired()
    await r.settle()
    const before = sent(r).length
    await handled(r, r.dm('/pair ZZZZ-ZZZZ'))
    await handled(r, r.dm('/start'))
    await r.settle()
    expect(sent(r).slice(before).map(q => q.body.text)).toEqual(['已配对', '已配对'])
    expect(events(r, 'channel.paired')).toHaveLength(1)
  })

  it('a pairing message redelivered after a crash does not pair twice or write a second event', async () => {
    const r = await withToken()
    const { code } = await begin(r)
    const real = TelegramState.prototype.save
    let crash: Promise<unknown> | undefined
    vi.spyOn(TelegramState.prototype, 'save').mockImplementation(function (this: TelegramState) {
      real.call(this)
      // 配对落盘的这一刻断电:这条更新的 offset 还没推进,没确认
      if (this.data.pairings.length > 0 && !crash) crash = r.restart({ kill: true })
    })
    const id = r.dm(`/pair ${code}`)
    await expect.poll(() => crash !== undefined, { timeout: 3000 }).toBe(true)
    await crash
    // 新内核的第一次请求可能碰上断掉的旧连接,走一次退避
    await expect
      .poll(
        () => {
          r.clock.advance(2000)
          return onDisk(r).offset
        },
        { timeout: 3000 },
      )
      .toBeGreaterThan(id)
    await r.settle()
    expect((await status(r)).paired).toHaveLength(1)
    expect(events(r, 'channel.paired')).toHaveLength(1)
    expect(textsTo(r, r.owner).at(-1)).toBe('已配对')
  })
})

describe('strangers cost nothing', () => {
  const forward = { type: 'hidden_user', date: 1, sender_user_name: 'Eve' }
  const rows: [string, (r: TelegramRig, marker: string) => number, keyof TelegramStatus['dropped']][] = [
    ['plain text', (r, m) => r.dm(`hello ${m}`, { from: STRANGER }), 'unpaired'],
    ['/status', (r, m) => r.dm(`/status ${m}`, { from: STRANGER }), 'unpaired'],
    ['/new', (r, m) => r.dm(`/new ${m}`, { from: STRANGER }), 'unpaired'],
    ['/project api', (r, m) => r.dm(`/project api ${m}`, { from: STRANGER }), 'unpaired'],
    ['/unpair confirm', (r, m) => r.dm(`/unpair confirm ${m}`, { from: STRANGER }), 'unpaired'],
    ['/start', r => r.dm('/start', { from: STRANGER }), 'unpaired'],
    ['a forwarded message', (r, m) => r.dm(`fwd ${m}`, { from: STRANGER, forwardOrigin: forward }), 'unpaired'],
    ['via_bot', (r, m) => r.dm(`via ${m}`, { from: STRANGER, viaBot: { id: 3, is_bot: true, first_name: 'b' } }), 'unpaired'],
    ['a photo with a caption', (r, m) => r.dm('', { from: STRANGER, extra: { text: undefined, photo: [{}], caption: m } }), 'unpaired'],
    ['a group message from the paired account', (r, m) => r.dm(`group ${m}`, { chatId: -5, chatType: 'group' }), 'group'],
    ['a supergroup photo from the paired account', (r, m) => r.dm('', { chatId: -5, chatType: 'supergroup', extra: { text: undefined, photo: [{}], caption: m } }), 'group'],
    ['a message with from.is_bot', (r, m) => r.dm(`bot ${m}`, { from: STRANGER, isBot: true }), 'unpaired'],
    ['a channel post', (r, m) => r.fake.push({ channel_post: { message_id: 1, date: seconds(r), chat: { id: -6, type: 'channel', title: m }, text: m } }), 'group'],
    ['a callback with a plausible nonce', (r, m) => r.press(`a:${m}:y`, { from: STRANGER }), 'unpaired'],
    ['a callback from another chat', (r, m) => r.press(`a:${m}:y`, { from: STRANGER, chatId: r.owner }), 'unpaired'],
    ['the owner pressing from another chat', (r, m) => r.press(`a:${m}:y`, { chatId: STRANGER }), 'unpaired'],
    ['a block by a stranger', (r, m) => r.fake.push({ my_chat_member: { chat: { id: STRANGER, type: 'private', first_name: m }, from: { id: STRANGER, is_bot: false, first_name: m }, date: seconds(r), old_chat_member: { status: 'member' }, new_chat_member: { status: 'kicked' } } }), 'unpaired'],
  ]

  it('after every row: no model, no session, no message, no text anywhere, no request, counted', async () => {
    const { seen, channel } = recording()
    const r = await paired({ plugins: () => [loopDirect], channel })
    await r.settle()
    const requestsBefore = outbound(r).length
    const before = onDisk(r).chats
    for (const [i, [name, send, bucket]] of rows.entries()) {
      const marker = `marker${i}x`
      const counted = (await status(r)).dropped[bucket]
      const id = send(r, marker)
      await handled(r, id)
      await r.settle()
      expect(r.models.calls, name).toEqual([])
      expect(events(r, 'session.created'), name).toEqual([])
      expect(events(r, 'message.user'), name).toEqual([])
      expect(r.rawBytes({ requests: true }).includes(marker), name).toBe(false)
      expect(outbound(r).length, name).toBe(requestsBefore)
      expect((await status(r)).dropped[bucket], name).toBe(counted + 1)
      expect(seen, name).toEqual([])
    }
    expect(onDisk(r).chats).toEqual(before)
    expect(textsTo(r, STRANGER)).toEqual([])
  })

  it('the same with nobody paired yet', async () => {
    const { seen, channel } = recording()
    const r = await withToken({ plugins: () => [loopDirect], channel })
    for (const [i, [name, send]] of rows.entries()) {
      const marker = `marker${i}x`
      await handled(r, send(r, marker))
      await r.settle()
      expect(r.rawBytes({ requests: true }).includes(marker), name).toBe(false)
    }
    expect(outbound(r)).toEqual([])
    expect(r.models.calls).toEqual([])
    expect(seen).toEqual([])
  })

  it('a stranger guessing gets the one sentence; other rows stay silent', async () => {
    const r = await withToken()
    await handled(r, r.dm('/pair ZZZZ-ZZZZ', { from: STRANGER }))
    await r.settle()
    expect(textsTo(r, STRANGER)).toEqual([INVALID])
    expect(outbound(r).map(q => q.method)).toEqual(['sendMessage'])
  })

  it('a flood of 1000 messages from 1000 senders: at most the global budget goes out, state stays bounded', async () => {
    const r = await withToken()
    const { code } = await begin(r)
    let last = 0
    for (let i = 0; i < 1000; i++) last = r.dm(`/pair WRONG${i}`, { from: 10_000 + i })
    await handled(r, last)
    await r.settle()
    expect(sent(r).length).toBeLessThanOrEqual(30)
    expect(outbound(r).every(q => q.method === 'sendMessage')).toBe(true)
    expect(Object.keys(onDisk(r).senders).length).toBeLessThanOrEqual(1000)
    expect(statSync(stateFile(r)).size).toBeLessThan(200_000)
    expect((await status(r)).dropped.unpaired).toBe(1000)
    expect(events(r, 'channel.pairing.burned')).toHaveLength(1)
    expect((await status(r)).pairing.active).toBe(false)
    expect(code).toBeTruthy()
  }, 20_000)

  it('the global budget is per hour', async () => {
    const r = await withToken()
    let last = 0
    for (let i = 0; i < 40; i++) last = r.dm('/pair ZZZZ-ZZZZ', { from: 10_000 + i })
    await handled(r, last)
    await r.settle()
    expect(sent(r)).toHaveLength(30)
    await jump(r, HOUR)
    await handled(r, r.dm('/pair ZZZZ-ZZZZ', { from: 20_000 }))
    await r.settle()
    expect(sent(r)).toHaveLength(31)
  }, 15_000)
})

describe('the paired account', () => {
  it('reaches the stub, which answers ok', async () => {
    const r = await paired()
    await handled(r, r.dm('hello'))
    await r.settle()
    expect(textsTo(r, r.owner)).toEqual([SUCCESS, 'ok'])
  })

  it('every send disables link previews', async () => {
    const r = await paired()
    await handled(r, r.dm('hello'))
    await r.settle()
    expect(sent(r).length).toBeGreaterThan(0)
    for (const q of sent(r)) expect(q.body.link_preview_options).toEqual({ is_disabled: true })
  })

  it('a stranger does not reach it, and the check is read fresh for every message', async () => {
    const { seen, channel } = recording()
    const r = await paired({ channel })
    await handled(r, r.dm('one'))
    expect(seen.map(s => s.dm.text)).toEqual(['one'])
    await r.k.handle('channel.telegram.unpair', { commandId: 'u1', accountId: String(r.owner) })
    await handled(r, r.dm('two'))
    expect(seen.map(s => s.dm.text)).toEqual(['one'])
    expect((await status(r)).dropped.unpaired).toBe(1)
  })

  it('an account paired mid-batch is paired for the next message in that batch', async () => {
    const { seen, channel } = recording()
    const r = await withToken({ channel })
    const { code } = await begin(r)
    // 断网时攒下,回来时一批收到
    r.fake.offline = true
    await expect.poll(async () => (await status(r)).state, { timeout: 3000, interval: 2 }).toBe('reconnecting')
    r.dm('before')
    r.dm(`/pair ${code}`)
    const id = r.dm('after')
    r.fake.offline = false
    r.clock.advance(2000)
    await handled(r, id)
    expect(seen.map(s => s.dm.text)).toEqual(['after'])
    expect((await status(r)).dropped.unpaired).toBe(1)
  })

  it('a text attachment from the paired account: one fixed line, nothing downloaded, counted', async () => {
    const { seen, channel } = recording()
    const r = await paired({ channel })
    await handled(r, r.dm('', { extra: { text: undefined, photo: [{ file_id: 'f' }], caption: '/unpair confirm' } }))
    await r.settle()
    expect(textsTo(r, r.owner).at(-1)).toBe('暂不支持附件,发文字吧')
    expect(sent(r, 'getFile')).toEqual([])
    expect(seen).toEqual([])
    expect((await status(r)).dropped.attachment).toBe(1)
    expect((await status(r)).paired).toHaveLength(1)
  })

  it('a callback from the paired account gets an answer and changes nothing yet', async () => {
    const r = await paired()
    await handled(r, r.press('a:nonce:y'))
    await r.settle()
    expect(sent(r, 'answerCallbackQuery').map(q => q.body.text)).toEqual(['已失效'])
  })

  it('a callback with no chat is not from the paired chat: no request', async () => {
    const r = await paired()
    await r.settle()
    const before = outbound(r).length
    const id = r.fake.push({ callback_query: { id: 'c', from: { id: r.owner, is_bot: false, first_name: 'x' }, chat_instance: 'x', data: 'a:n:y' } })
    await handled(r, id)
    await r.settle()
    expect(outbound(r).length).toBe(before)
  })

  it('block and unblock change the chat state, and a blocked chat is not written to', async () => {
    const r = await paired()
    await r.settle()
    const block = (status_: string) =>
      r.fake.push({ my_chat_member: { chat: { id: r.owner, type: 'private' }, from: { id: r.owner, is_bot: false, first_name: 'x' }, date: seconds(r), old_chat_member: { status: 'member' }, new_chat_member: { status: status_ } } })
    await handled(r, block('kicked'))
    expect(onDisk(r).chats[String(r.owner)].blocked).toBe(true)
    const before = sent(r).length
    await handled(r, r.dm('hello'))
    await r.settle()
    expect(sent(r).length).toBe(before)
    await handled(r, block('member'))
    expect(onDisk(r).chats[String(r.owner)]?.blocked).toBeUndefined()
    await handled(r, r.dm('hello'))
    await r.settle()
    expect(sent(r).length).toBe(before + 1)
  })

  it('pairing again after a block, unpair and unblock: the reply goes out', async () => {
    const r = await paired()
    await r.settle()
    const member = (status_: string) =>
      r.fake.push({ my_chat_member: { chat: { id: r.owner, type: 'private' }, from: { id: r.owner, is_bot: false, first_name: 'x' }, date: seconds(r), old_chat_member: { status: 'member' }, new_chat_member: { status: status_ } } })
    await handled(r, member('kicked'))
    await r.k.handle('channel.telegram.unpair', { commandId: 'u1', accountId: String(r.owner) })
    await handled(r, member('member')) // 没配对:这一条不记
    const { code } = await begin(r)
    await handled(r, r.dm(`/pair ${code}`))
    await r.settle()
    expect(textsTo(r, r.owner)).toEqual([SUCCESS, SUCCESS])
  })

  describe('forwarded and via_bot text', () => {
    const origins: [string, DmOpts][] = [
      ['forward_origin', { forwardOrigin: { type: 'user', date: 1, sender_user: { id: 9, is_bot: false, first_name: 'Eve' } } }],
      ['via_bot', { viaBot: { id: 3, is_bot: true, first_name: 'Inline', username: 'inline_bot' } }],
    ]
    const commands = ['/unpair confirm', '/project api', '/cancel', '/pair ZZZZ-ZZZZ', '/start']

    it.each(origins.flatMap(([name, o]) => commands.map(c => [name, c, o] as const)))('%s of %s: runs nothing and is external', async (_name, text, o) => {
      const { seen, channel } = recording()
      const r = await paired({ channel })
      await r.settle()
      const before = sent(r).length
      await handled(r, r.dm(text, o))
      await r.settle()
      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({ external: true })
      expect(seen[0].dm.forwardedFrom).toBeTruthy()
      expect(seen[0].dm.text).toBe(text)
      // 没有 已配对 之类的命令回复,配对还在
      expect(sent(r).length).toBe(before)
      expect((await status(r)).paired).toHaveLength(1)
      expect(events(r, 'channel.unpaired')).toEqual([])
    })

    it('typed directly, it is not external', async () => {
      const { seen, channel } = recording()
      const r = await paired({ channel })
      await handled(r, r.dm('hello'))
      expect(seen[0].external).toBe(false)
    })

    it('reaches the model as external, typed text does not', async () => {
      const r = await paired({ plugins: () => [loopDirect], channel: { onPairedDm: promptingHandler() } })
      await handled(r, r.dm('/unpair confirm', origins[0][1]))
      await handled(r, r.dm('typed'))
      await expect.poll(() => r.models.calls.length, { timeout: 3000 }).toBeGreaterThan(0)
      const users = events(r, 'message.user').map(e => e.payload as { text: string; external?: boolean })
      expect(users).toEqual([{ turnId: expect.any(String), text: '/unpair confirm', external: true }, ...users.slice(1)])
      expect(users.find(u => u.text === 'typed')?.external).toBeUndefined()
    })
  })
})

/** Task 9 之前的替身:和正式路径一样把 commandId 交给内核 */
function promptingHandler(after?: (d: PairedDm) => void | Promise<void>) {
  return async (d: PairedDm) => {
    const { sessionId } = await d.commands.call('session.create', { commandId: `${d.commandId}:session`, origin: 'im', audience: 'owner', approvalMode: 'ask', title: 'Telegram' })
    await d.commands.call('session.prompt', { commandId: d.commandId, sessionId, text: d.dm.text, ...(d.external && { external: true }) })
    await after?.(d)
  }
}

describe('redelivery', () => {
  it('commandId comes from the bot id and the update id, and nothing else', async () => {
    const { seen, channel } = recording()
    const r = await paired({ channel, botId: 555 })
    const id = r.dm('hello')
    await handled(r, id)
    expect(seen[0].commandId).toBe(`tg:555:${id}`)
  })

  it('a crash between handling and saving: the update comes back, the same commandId, one model request, one message', async () => {
    const ids: string[] = []
    let stuck = true
    const r = await paired({
      plugins: () => [loopDirect],
      channel: {
        onPairedDm: promptingHandler(async d => {
          ids.push(d.commandId)
          // 第一次卡在这里:处理完了,poller 还没落盘
          if (stuck) await new Promise(() => {})
        }),
      },
    })
    const ackBefore = onDisk(r).offset
    const id = r.dm('run me once')
    await expect.poll(() => ids.length, { timeout: 3000 }).toBe(1)
    await expect.poll(() => r.k.events.after(0).some(e => e.type === 'turn.ended'), { timeout: 3000 }).toBe(true)
    expect(r.models.calls).toHaveLength(1)
    // 真的还没确认
    expect(onDisk(r).offset).toBe(ackBefore)
    expect(ackBefore).toBeLessThanOrEqual(id)

    stuck = false
    await r.restart({ kill: true })
    await expect
      .poll(
        () => {
          r.clock.advance(2000)
          return ids.length
        },
        { timeout: 3000 },
      )
      .toBe(2)
    await handled(r, id)
    await r.settle()

    expect(ids[0]).toBe(ids[1])
    expect(r.models.calls).toHaveLength(1)
    expect(events(r, 'message.user')).toHaveLength(1)
    expect(events(r, 'session.created')).toHaveLength(1)
    // 重投的这次之后就确认了
    expect(r.fake.requests.filter(q => q.method === 'getUpdates').at(-1)?.body.offset).toBe(id + 1)
  }, 15_000)

  it('without the same commandId it would have run twice: two updates with the same text are two prompts', async () => {
    const r = await paired({ plugins: () => [loopDirect], channel: { onPairedDm: promptingHandler() } })
    await handled(r, r.dm('same'))
    await expect.poll(() => r.models.calls.length, { timeout: 3000 }).toBe(1)
    await expect.poll(() => r.k.events.after(0).filter(e => e.type === 'turn.ended').length, { timeout: 3000 }).toBe(1)
    await handled(r, r.dm('same'))
    await expect.poll(() => r.models.calls.length, { timeout: 3000 }).toBe(2)
  })

  it('a handler that throws: code only in the log, counted, the next update still runs', async () => {
    let n = 0
    const secretMessage = 'marker-in-throw'
    const r = await paired({
      channel: {
        onPairedDm: () => {
          if (n++ === 0) throw new Error(secretMessage)
        },
      },
    })
    await handled(r, r.dm('first'))
    await handled(r, r.dm('second'))
    expect(n).toBe(2)
    expect((await status(r)).dropped.badUpdate).toBe(1)
    expect(r.logs.join('\n')).not.toContain(secretMessage)
  })
})

describe('joined_group', () => {
  const joined = (r: TelegramRig, chat: number, status_ = 'member', type = 'group') =>
    r.fake.push({ my_chat_member: { chat: { id: chat, type, title: 'marker-group' }, from: { id: STRANGER, is_bot: false, first_name: 'x' }, date: seconds(r), old_chat_member: { status: 'left' }, new_chat_member: { status: status_ } } })

  it('leaves once and counts; the left event that follows makes no request', async () => {
    const r = await withToken()
    await handled(r, joined(r, -10))
    await r.settle()
    expect(sent(r, 'leaveChat').map(q => q.body.chat_id)).toEqual(['-10'])
    expect((await status(r)).dropped.group).toBe(1)
    await handled(r, joined(r, -10, 'left'))
    await handled(r, joined(r, -10))
    await r.settle()
    expect(sent(r, 'leaveChat')).toHaveLength(1)
    expect(r.rawBytes({ requests: true }).includes('marker-group')).toBe(false)
  })

  it('at most 30 per hour; a group over budget leaves on its next event', async () => {
    const r = await withToken()
    let last = 0
    for (let i = 0; i < 31; i++) last = joined(r, -100 - i)
    await handled(r, last)
    await r.settle()
    expect(sent(r, 'leaveChat')).toHaveLength(30)
    expect((await status(r)).dropped.group).toBe(31)
    await jump(r, HOUR)
    await handled(r, joined(r, -130))
    await r.settle()
    expect(sent(r, 'leaveChat').at(-1)?.body.chat_id).toBe('-130')
  }, 15_000)

  it('keeps a bounded record', async () => {
    const r = await start()
    await r.k.handle('channel.telegram.setToken', { token: TEST_TOKEN })
    await expect.poll(async () => (await status(r)).state).toBe('online')
    const seeded = onDisk(r)
    seeded.leftChats = [...Array(1000).keys()].map(i => String(-1000 - i))
    writeFileSync(stateFile(r), JSON.stringify(seeded))
    // 让插件读到种进去的文件:正常关闭会用内存里的盖掉,所以 kill
    await r.restart({ kill: true })
    await expect.poll(async () => (await status(r)).state).toBe('online')
    await handled(r, joined(r, -5))
    expect(onDisk(r).leftChats).toHaveLength(1000)
    expect(onDisk(r).leftChats).toContain('-5')
  })

  it('a failed leaveChat stays quiet: only a code in the log', async () => {
    const r = await withToken()
    r.fake.fail('leaveChat', 1, { status: 500, body: { ok: false, description: 'marker-desc' } })
    await handled(r, joined(r, -10))
    await r.settle()
    expect(r.logs.join('\n')).not.toContain('marker-desc')
  })
})

describe('unpair', () => {
  it('removes the account now, writes the event, saves, and the next message is a stranger’s', async () => {
    const { seen, channel } = recording()
    const r = await paired({ channel })
    expect(await r.k.handle('channel.telegram.unpair', { commandId: 'u1', accountId: String(r.owner) })).toEqual({ ok: true })
    expect(events(r, 'channel.unpaired').map(e => e.payload)).toEqual([{ channel: 'telegram', accountId: String(r.owner), by: 'app' }])
    expect(onDisk(r).pairings).toEqual([])
    await handled(r, r.dm('hello'))
    expect(seen).toEqual([])
  })

  it('an account that is not paired: ok, no event', async () => {
    const r = await paired()
    expect(await r.k.handle('channel.telegram.unpair', { commandId: 'u1', accountId: '999' })).toEqual({ ok: true })
    expect(events(r, 'channel.unpaired')).toEqual([])
    expect((await status(r)).paired).toHaveLength(1)
  })

  it('after unpairing a new code works, for someone else', async () => {
    const r = await paired()
    await r.k.handle('channel.telegram.unpair', { commandId: 'u1', accountId: String(r.owner) })
    const { code } = await begin(r)
    await handled(r, r.dm(`/pair ${code}`, { from: 3001 }))
    expect((await status(r)).paired.map(p => p.accountId)).toEqual(['3001'])
  })

  it('a save that fails: revoked in memory all the same, and the caller hears about it', async () => {
    const r = await paired()
    vi.spyOn(TelegramState.prototype, 'save').mockImplementationOnce(() => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    })
    const e = await rpcError(r.k.handle('channel.telegram.unpair', { commandId: 'u1', accountId: String(r.owner) }))
    expect(e.message).toBe('state_save_failed')
    expect((await status(r)).paired).toEqual([])
    expect((await status(r)).problems).toContain('state_save_failed')
    // 重试:这次落盘了
    expect(await r.k.handle('channel.telegram.unpair', { commandId: 'u1', accountId: String(r.owner) })).toEqual({ ok: true })
    expect(onDisk(r).pairings).toEqual([])
    expect((await status(r)).problems).not.toContain('state_save_failed')
    expect(events(r, 'channel.unpaired')).toHaveLength(1)
  })
})

describe('config', () => {
  const project = (r: TelegramRig, over: object = {}) => ({ name: 'api', path: r.cwd, auto: false, ...over })
  const set = (r: TelegramRig, config: unknown, commandId = 'c1') => r.k.handle('channel.telegram.config.set', { commandId, config })

  it('round-trips through config.json, and survives a restart', async () => {
    const r = await start()
    const config: TelegramConfig = { enabled: true, staleMinutes: 20, projects: [project(r)] }
    expect(await set(r, config)).toEqual({ ok: true })
    expect(await r.k.handle('channel.telegram.config.get', {})).toEqual(config)
    expect(JSON.parse(readFileSync(join(r.dataDir, 'config.json'), 'utf8')).channels.telegram).toEqual(config)
    await r.restart()
    expect(await r.k.handle('channel.telegram.config.get', {})).toEqual(config)
  })

  it('keeps other channels in the section', async () => {
    const r = await start({ config: { channels: { later: { x: 1 } } } })
    await set(r, { enabled: true, staleMinutes: 5, projects: [] })
    expect(JSON.parse(readFileSync(join(r.dataDir, 'config.json'), 'utf8')).channels.later).toEqual({ x: 1 })
  })

  it.each([
    ['a number', 5],
    ['staleMinutes zero', { staleMinutes: 0 }],
    ['staleMinutes fractional', { staleMinutes: 1.5 }],
    ['enabled a string', { enabled: 'yes' }],
    ['projects not a list', { projects: 'x' }],
    ['a name with dots', { projects: [{ name: '..', path: '/x', auto: false }] }],
    ['a name with a slash', { projects: [{ name: 'a/b', path: '/x', auto: false }] }],
    ['an empty name', { projects: [{ name: '', path: '/x', auto: false }] }],
  ])('%s → -32602 invalid_config, nothing written', async (_name, config) => {
    const r = await start()
    await expectRefused(set(r, config), 'invalid_config')
    expect(await r.k.handle('channel.telegram.config.get', {})).toEqual({ enabled: true, staleMinutes: 10, projects: [] })
  })

  it('two projects with one name are refused', async () => {
    const r = await start()
    await expectRefused(set(r, { projects: [project(r), project(r)] }), 'invalid_config')
  })

  it('a project path goes through validateCwd', async () => {
    const r = await start()
    await expectRefused(set(r, { projects: [project(r, { path: 'relative/path' })] }), 'invalid_project')
    await expectRefused(set(r, { projects: [project(r, { path: join(r.cwd, 'missing') })] }), 'invalid_project')
    await expectRefused(set(r, { projects: [project(r, { path: r.dataDir })] }), 'invalid_project')
  })

  it.each([
    ['none', false],
    ['partial', false],
    ['full', true],
  ] as const)('auto:true at level %s', async (level, ok) => {
    const r = await start({ level })
    const p = set(r, { projects: [project(r, { auto: true })] })
    if (ok) expect(await p).toEqual({ ok: true })
    else await expectRefused(p, 'auto_requires_full')
  })

  it('auto:false is fine at any level', async () => {
    const r = await start({ level: 'none' })
    expect(await set(r, { projects: [project(r)] })).toEqual({ ok: true })
  })

  it('enabled:false stops polling at once; enabled:true starts it', async () => {
    const r = await withToken()
    await expect.poll(() => sent(r, 'getUpdates').length).toBeGreaterThan(0)
    await set(r, { enabled: false }, 'c1')
    expect((await status(r)).state).toBe('disabled')
    const before = r.fake.requests.length
    await r.settle({ advance: 120_000 })
    expect(r.fake.requests.length).toBe(before)
    await set(r, { enabled: true }, 'c2')
    await expect.poll(async () => (await status(r)).state).toBe('online')
  })

  it('a pairing code dies when polling is switched off', async () => {
    const r = await withToken()
    await begin(r)
    await set(r, { enabled: false })
    expect((await status(r)).pairing.active).toBe(false)
  })
})

describe('status', () => {
  it('fits the schema, and only says the kind of proxy', async () => {
    const r = await paired()
    const s = await status(r)
    expect(s).toMatchObject({ enabled: true, tokenSet: true, secretsBackend: 'plaintext-file', proxy: 'none', undelivered: 0, problems: [] })
    expect(s.lastOkAt).toBe(r.clock.now())
  })

  it('a corrupt state file: no pairing, state_recovered, polling goes on, and nothing is trusted', async () => {
    const r = await paired()
    await r.restart({ kill: true })
    writeFileSync(stateFile(r), '{not json')
    await r.restart({ kill: true })
    const s = await status(r)
    expect(s.paired).toEqual([])
    expect(s.problems).toContain('state_recovered')
    await r.settle()
  })
})
