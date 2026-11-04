// channel-telegram 插件(07 spec §4):装配、RPC、生命周期,以及所有更新的路由。
// 通往会话的路只有 handleUpdate 里的一条,每条消息现查 isPaired。令牌只在这里的闭包和 api.ts 里,日志和错误只有稳定代码
import { join } from 'node:path'
import { z } from 'zod'
import type { Plugin, PluginContext } from '../../kernel/pluginHost'
import { RpcError } from '../../kernel/rpcError'
import type { SandboxService, SessionCommands } from '../../lib/tools/types'
import { type ChannelState, type WorkerMethodName } from '../../protocol/index'
import type { TelegramConfig, TelegramStatus } from '../../protocol/rpc'
import { createApi, REAL_TIMERS, TelegramError, type ApiTimers } from './api'
import { classify, isExternal, type DmInbound, type Inbound } from './inbound'
import { manifest } from './manifest'
import { Pairing, PairingError, parsePairCommand } from './pairing'
import { codeOf, Poller, type PollerState } from './poller'
import { TelegramState, type TelegramBot } from './state'

const API_BASE = 'https://api.telegram.org'
const TOKEN_KEY = 'token'
/** 也挡住路径注入:令牌要拼进 URL */
const TOKEN_SHAPE = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/
const PAIRED_LINE = '配对成功。这里的对话和你的记忆内容会经过 Telegram 的服务器。'
const INVALID_LINE = '配对码无效或已过期'
const ALREADY_PAIRED_LINE = '已配对'
const NO_ATTACHMENTS_LINE = '暂不支持附件,发文字吧'
const STALE_BUTTON_LINE = '已失效'
const STATUS_STABLE_MS = 30_000
const LEAVE_WINDOW_MS = 3_600_000
const LEAVES_PER_WINDOW = 30
const LEFT_CHATS_MAX = 1000
/** 发送队列的上限;陌生人能触发的都有更小的预算。真正的发送器是 Task 8 */
const OUTBOX_MAX = 256
const SAVE_FAILED = 'state_save_failed'
const CONFIG_INVALID = 'config_invalid'

const ConfigSchema = z.object({
  enabled: z.boolean().default(true),
  staleMinutes: z.number().int().min(1).max(1440).default(10),
  projects: z
    .array(z.object({ name: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/), path: z.string().min(1), auto: z.boolean().default(false) }))
    .refine(list => new Set(list.map(p => p.name)).size === list.length)
    .default(() => []),
})

const DEFAULT_CONFIG: TelegramConfig = { enabled: true, staleMinutes: 10, projects: [] }

/** 一条已配对账号的私聊。Task 9 接手,在这之前只回 ok */
export interface PairedDm {
  dm: DmInbound
  /** tg:<botId>:<updateId>:重投时一样,内核回执挡住第二次执行 */
  commandId: string
  /** 不是用户本人写的(§12.1) */
  external: boolean
  commands: SessionCommands
  reply(text: string): void
}

export interface ChannelTelegramOpts {
  /** 只有代码能改:配置、环境变量、RPC 都送不走令牌(§4) */
  apiBase?: string
  now?(): number
  timers?: ApiTimers
  sleep?(ms: number): Promise<void>
  random?(): number
  pollTimeoutS?: number
  fetch?: typeof fetch
  onPairedDm?(d: PairedDm): void | Promise<void>
}

const ERR_INVALID_PARAMS = -32602
const refused = (code: string) => new RpcError(ERR_INVALID_PARAMS, code)

/** 只说是哪一类,不带 URL。Node 也是小写优先(§2) */
export function proxyKind(env: NodeJS.ProcessEnv): 'none' | 'env' | 'socks' {
  if (env.NODE_USE_ENV_PROXY !== '1') return 'none'
  const url = env.https_proxy ?? env.HTTPS_PROXY ?? env.http_proxy ?? env.HTTP_PROXY ?? env.all_proxy ?? env.ALL_PROXY
  if (!url) return 'none'
  return /^socks/i.test(url) ? 'socks' : 'env'
}

function readConfig(section: unknown, ctx: PluginContext, state: TelegramState): TelegramConfig {
  const bad = () => {
    ctx.log.warn('telegram config invalid, using defaults')
    state.problems.push(CONFIG_INVALID)
    return structuredClone(DEFAULT_CONFIG)
  }
  if (section === undefined || section === null) return structuredClone(DEFAULT_CONFIG)
  if (typeof section !== 'object' || Array.isArray(section)) return bad()
  const raw = (section as Record<string, unknown>).telegram
  if (raw === undefined) return structuredClone(DEFAULT_CONFIG)
  const parsed = ConfigSchema.safeParse(raw)
  return parsed.success ? parsed.data : bad()
}

export function createChannelTelegram(opts: ChannelTelegramOpts = {}): Plugin {
  return {
    manifest,
    async activate(ctx) {
      const base = opts.apiBase ?? API_BASE
      const now = opts.now ?? Date.now
      const timers = opts.timers ?? REAL_TIMERS
      const lifetime = new AbortController()
      const commands = ctx.services.get<SessionCommands>('sessionCommands')
      const sandbox = ctx.services.get<SandboxService>('sandbox')
      if (!commands || !sandbox) throw new Error('channel-telegram: kernel services missing')

      // ctx.dataDir 是这个插件自己的目录:TelegramState 要把上一层改成 0700
      const state = TelegramState.open(join(ctx.dataDir, 'state.json'), ctx.log)
      let channelsSection: unknown = ctx.config.channels
      let config = readConfig(channelsSection, ctx, state)
      let token: string | undefined
      let secretsFailed = false

      const api = createApi({ base, token: () => token, timers, ...(opts.fetch && { fetch: opts.fetch }) })

      // —— 状态和 channel.status(§13)
      let current: { state: ChannelState; reason?: string } = { state: 'no_token' }
      let written: string | undefined
      let statusTimer: unknown
      const statusKey = (s: { state: ChannelState; reason?: string }) => `${s.state}:${s.reason ?? ''}`
      const writeStatus = () => {
        if (statusKey(current) === written) return
        written = statusKey(current)
        ctx.append({ type: 'channel.status', payload: { channel: 'telegram', state: current.state, ...(current.reason !== undefined && { reason: current.reason }) } })
      }
      const setState = (s: ChannelState, reason?: string) => {
        current = { state: s, ...(reason !== undefined && { reason }) }
        timers.clearTimeout(statusTimer)
        statusTimer = undefined
        if (s === 'unauthorized' || s === 'conflict') writeStatus()
        else statusTimer = timers.setTimeout(writeStatus, STATUS_STABLE_MS)
      }

      const noteSaveFailure = (err: unknown) => {
        ctx.log.warn('telegram state save failed', { code: codeOf(err) })
        if (!state.problems.includes(SAVE_FAILED)) state.problems.push(SAVE_FAILED)
      }
      const noteSaved = () => {
        const at = state.problems.indexOf(SAVE_FAILED)
        if (at >= 0) state.problems.splice(at, 1)
      }

      // —— 发送:不挡轮询,失败只记代码。限速、重试、分块是 Task 8
      let outboxChain: Promise<void> = Promise.resolve()
      let outboxSize = 0
      const enqueue = (method: string, body: object) => {
        if (outboxSize >= OUTBOX_MAX) {
          ctx.log.warn('telegram outbox full', { method })
          return
        }
        outboxSize++
        outboxChain = outboxChain
          .then(async () => {
            if (lifetime.signal.aborted) return
            await api.call(method, body, { signal: lifetime.signal })
          })
          .catch(err => ctx.log.warn('telegram send failed', { method, code: codeOf(err) }))
          .finally(() => void outboxSize--)
      }
      const chatRecord = (chatId: string) => state.data.chats[chatId] as { blocked?: boolean } | undefined
      const reply = (chatId: string, text: string) => {
        if (chatRecord(chatId)?.blocked) return
        enqueue('sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: true } })
      }

      // —— 配对
      const pairing = new Pairing({
        state,
        now,
        onBurned: () => void ctx.append({ type: 'channel.pairing.burned', payload: { channel: 'telegram' } }),
      })
      const isPaired = (accountId: string, chatId: string | undefined) => chatId === accountId && state.data.pairings.some(p => p.accountId === accountId)

      /** 先写事件再落盘:崩溃在中间只是多一声铃,反过来就是一次没人看见的配对 */
      const completePairing = (i: DmInbound) => {
        const { pairings } = state.data
        pairings.push({ accountId: i.accountId, name: i.name, pairedAt: now() })
        ctx.append({ type: 'channel.paired', payload: { channel: 'telegram', accountId: i.accountId, name: i.name } })
        try {
          state.save()
          noteSaved()
        } catch (err) {
          // 下次启动就没了的配对不算配对
          pairings.pop()
          noteSaveFailure(err)
          ctx.append({ type: 'channel.unpaired', payload: { channel: 'telegram', accountId: i.accountId, by: 'im' } })
          reply(i.chatId, INVALID_LINE)
          return
        }
        // 他刚发了消息,不可能还封着机器人
        const { blocked: _blocked, ...record } = chatRecord(i.chatId) ?? {}
        if (Object.keys(record).length > 0) state.data.chats[i.chatId] = record
        else delete state.data.chats[i.chatId]
        reply(i.chatId, PAIRED_LINE)
      }

      const onStrangerDm = (i: DmInbound) => {
        const parsed = isExternal(i) ? undefined : parsePairCommand(i.text)
        if (parsed?.code === undefined) {
          state.data.dropped.unpaired++
          return
        }
        const result = pairing.attempt(i.accountId, parsed.code, i.date)
        if (result === 'ok') {
          completePairing(i)
          return
        }
        state.data.dropped.unpaired++
        // 锁上的人已经听过三遍了;回话的计数在内存里,重启不能多给一遍
        if (result === 'invalid' && pairing.replyAllowed(i.accountId)) reply(i.chatId, INVALID_LINE)
      }

      const onPairedDm = async (i: DmInbound) => {
        const external = isExternal(i)
        if (!external && parsePairCommand(i.text)) {
          reply(i.chatId, ALREADY_PAIRED_LINE)
          return
        }
        const botId = state.data.bot?.id
        // getMe 成功之前不会有更新;真到了这里不猜 commandId
        if (botId === undefined) throw new Error('no bot')
        const delivered: PairedDm = { dm: i, commandId: `tg:${botId}:${i.updateId}`, external, commands, reply: text => reply(i.chatId, text) }
        if (opts.onPairedDm) await opts.onPairedDm(delivered)
        else delivered.reply('ok')
      }

      // —— 退群:陌生人拉群不能让机器人无限发请求(R16)
      let leaves: number[] = []
      const onJoinedGroup = (chatId: string) => {
        state.data.dropped.group++
        const { leftChats } = state.data
        if (leftChats.includes(chatId)) return
        const since = now() - LEAVE_WINDOW_MS
        leaves = leaves.filter(t => t > since)
        if (leaves.length >= LEAVES_PER_WINDOW) return
        leaves.push(now())
        leftChats.push(chatId)
        if (leftChats.length > LEFT_CHATS_MAX) leftChats.splice(0, leftChats.length - LEFT_CHATS_MAX)
        enqueue('leaveChat', { chat_id: chatId })
      }

      const onBlocked = (i: Extract<Inbound, { kind: 'blocked' }>) => {
        if (!isPaired(i.chatId, i.chatId)) {
          state.data.dropped.unpaired++
          return
        }
        const { blocked: _old, ...rest } = chatRecord(i.chatId) ?? {}
        const next = i.blocked ? { ...rest, blocked: true } : rest
        if (Object.keys(next).length > 0) state.data.chats[i.chatId] = next
        else delete state.data.chats[i.chatId]
      }

      const handleUpdate = async (update: unknown): Promise<void> => {
        const i = classify(update)
        switch (i.kind) {
          case 'ignored':
            if (i.why === 'group' || i.why === 'channel') state.data.dropped.group++
            else if (i.why === 'bot') state.data.dropped.unpaired++
            else if (i.why === 'malformed') state.data.dropped.badUpdate++
            return
          case 'joined_group':
            return onJoinedGroup(i.chatId)
          case 'blocked':
            return onBlocked(i)
          case 'callback':
            // 陌生人的按钮:一个请求都不发,连 answerCallbackQuery 也不发
            if (!isPaired(i.accountId, i.chatId)) {
              state.data.dropped.unpaired++
              return
            }
            enqueue('answerCallbackQuery', { callback_query_id: i.callbackId, text: STALE_BUTTON_LINE })
            return
          case 'attachment':
            if (!isPaired(i.accountId, i.chatId)) {
              state.data.dropped.unpaired++
              return
            }
            state.data.dropped.attachment++
            reply(i.chatId, NO_ATTACHMENTS_LINE)
            return
          case 'dm':
            if (isPaired(i.accountId, i.chatId)) await onPairedDm(i)
            else onStrangerDm(i)
            return
        }
      }

      /** 一条的错不挡下一条(§5.2)。错误的文字里可能有消息内容,只记代码 */
      const onBatch = async (updates: unknown[]) => {
        for (const update of updates) {
          try {
            await handleUpdate(update)
          } catch (err) {
            ctx.log.warn('telegram update failed', { code: codeOf(err) })
            state.data.dropped.badUpdate++
          }
          state.advance((update as { update_id: number }).update_id)
        }
      }

      const onPollerState = (s: PollerState, reason?: string) => {
        // 别人在用这个令牌:截得到 /pair 码,已发的作废(§12.2)
        if (s === 'conflict') pairing.cancel()
        setState(s, reason)
      }

      const poller = new Poller({
        api,
        state,
        onBatch,
        onState: onPollerState,
        sleep: opts.sleep ?? (ms => new Promise(resolve => void setTimeout(resolve, ms).unref())),
        random: opts.random ?? Math.random,
        now,
        log: ctx.log,
        ...(opts.pollTimeoutS !== undefined && { pollTimeoutS: opts.pollTimeoutS }),
      })

      const secretsLocked = () => secretsFailed || ctx.secretsBackend === 'unavailable' || ctx.secretsBackend === 'unreadable'

      /** 该不该轮询只在这里定。没令牌、没启用:不发任何请求 */
      const settle = () => {
        if (!config.enabled) setState('disabled')
        else if (secretsLocked()) setState('secrets_unavailable')
        else if (!token) setState('no_token')
        else poller.start()
      }

      // 同一时间只有一个改令牌或启停的操作
      let serial: Promise<unknown> = Promise.resolve()
      const inOrder = <T>(run: () => Promise<T>): Promise<T> => {
        const result = serial.then(run, run)
        serial = result.catch(() => {})
        return result
      }

      const adopt = (bot: TelegramBot) => {
        const before = state.data.bot?.id
        if (!state.adoptBot(bot)) return
        if (before !== undefined && before !== bot.id) pairing.cancel()
        try {
          state.save()
          noteSaved()
        } catch (err) {
          // 内存里已经清了;没存上的话下次 getMe 再清一遍,失败方向是关
          noteSaveFailure(err)
        }
      }

      const register = (method: WorkerMethodName, handler: (params: never) => Promise<unknown>) => ctx.rpc.register(method, handler as (params: unknown) => Promise<unknown>)

      register('channel.telegram.status', async () => {
        const { bot, pairings, dropped, undelivered } = state.data
        const result: TelegramStatus = {
          state: current.state,
          ...(current.reason !== undefined && { reason: current.reason }),
          enabled: config.enabled,
          tokenSet: token !== undefined,
          ...(bot && { bot: { id: bot.id, username: bot.username ?? '' } }),
          secretsBackend: ctx.secretsBackend,
          proxy: proxyKind(process.env),
          ...(poller.lastOkAt !== undefined && { lastOkAt: poller.lastOkAt }),
          paired: pairings.map(p => ({ ...p })),
          pairing: pairing.status(),
          dropped: { ...dropped },
          undelivered,
          problems: [...state.problems],
        }
        return result
      })

      register('channel.telegram.setToken', (params: { token: string }) =>
        inOrder(async () => {
          const candidate = params.token
          if (!TOKEN_SHAPE.test(candidate)) throw refused('invalid_token')
          if (ctx.secretsBackend === 'unavailable' || ctx.secretsBackend === 'unreadable') throw refused('secrets_unavailable')
          const check = createApi({ base, token: () => candidate, timers, ...(opts.fetch && { fetch: opts.fetch }) })
          let me: { id?: unknown; username?: unknown } | null
          try {
            me = await check.call('getMe', {}, { signal: lifetime.signal })
          } catch (err) {
            throw refused(err instanceof TelegramError && err.code === 'unauthorized' ? 'unauthorized' : 'network')
          }
          if (typeof me?.id !== 'number' || !Number.isSafeInteger(me.id)) throw refused('network')
          const username = typeof me.username === 'string' ? me.username : ''
          try {
            await ctx.secrets.set(TOKEN_KEY, candidate)
          } catch {
            // 存储的错误不外传:后端的文字不归我们管
            throw refused('secrets_unavailable')
          }
          secretsFailed = false
          await poller.stop()
          adopt({ id: me.id, ...(username && { username }) })
          token = candidate
          settle()
          return { ok: true, bot: { id: me.id, username } }
        }),
      )

      register('channel.telegram.clearToken', () =>
        inOrder(async () => {
          try {
            await ctx.secrets.delete(TOKEN_KEY)
          } catch {
            throw refused('secrets_unavailable')
          }
          await poller.stop()
          token = undefined
          pairing.cancel()
          settle()
          return { ok: true }
        }),
      )

      register('channel.telegram.clearWebhook', () =>
        inOrder(async () => {
          if (!token) throw refused('no_token')
          try {
            await api.call('deleteWebhook', {}, { signal: lifetime.signal })
          } catch (err) {
            throw refused(err instanceof TelegramError && err.code === 'unauthorized' ? 'unauthorized' : 'network')
          }
          // conflict 的 60 s 不用等完
          await poller.stop()
          settle()
          return { ok: true }
        }),
      )

      register('channel.telegram.pairing.begin', async () => {
        if (!config.enabled) throw refused('disabled')
        if (!token) throw refused('no_token')
        if (current.state === 'conflict') {
          pairing.cancel()
          throw refused('conflict')
        }
        let issued: { code: string; expiresAt: number }
        try {
          issued = pairing.begin()
        } catch (err) {
          if (err instanceof PairingError) throw refused(err.code)
          throw err
        }
        const username = state.data.bot?.username
        return { ...issued, ...(username && { link: `https://t.me/${username}?start=${issued.code.replace('-', '')}` }) }
      })

      register('channel.telegram.pairing.cancel', async () => {
        pairing.cancel()
        return { ok: true }
      })

      /** 名单先改、事件先写:撤销不等落盘。没存上要让调用方知道,重试时再存 */
      register('channel.telegram.unpair', async (params: { accountId: string }) => {
        const { pairings } = state.data
        const at = pairings.findIndex(p => p.accountId === params.accountId)
        if (at >= 0) {
          pairings.splice(at, 1)
          ctx.append({ type: 'channel.unpaired', payload: { channel: 'telegram', accountId: params.accountId, by: 'app' } })
        } else if (!state.problems.includes(SAVE_FAILED)) {
          return { ok: true }
        }
        try {
          state.save()
          noteSaved()
        } catch (err) {
          noteSaveFailure(err)
          throw new RpcError(ERR_INVALID_PARAMS, SAVE_FAILED)
        }
        return { ok: true }
      })

      register('channel.telegram.config.get', async () => structuredClone(config))

      register('channel.telegram.config.set', (params: { config: unknown }) =>
        inOrder(async () => {
          const parsed = ConfigSchema.safeParse(params.config)
          if (!parsed.success) throw refused('invalid_config')
          const next: TelegramConfig = parsed.data
          for (const project of next.projects) {
            try {
              project.path = commands.validateCwd(project.path)
            } catch {
              throw refused('invalid_project')
            }
            if (project.auto && sandbox.status().level !== 'full') throw refused('auto_requires_full')
          }
          const others = channelsSection !== null && typeof channelsSection === 'object' ? channelsSection : {}
          const section = { ...others, telegram: next }
          ctx.updateConfig('channels', section)
          channelsSection = section
          const switched = next.enabled !== config.enabled
          config = next
          if (switched) {
            await poller.stop()
            if (!next.enabled) pairing.cancel()
            settle()
          }
          return { ok: true }
        }),
      )

      ctx.effect(async () => {
        lifetime.abort()
        timers.clearTimeout(statusTimer)
        statusTimer = undefined
        await poller.stop()
      })

      try {
        token = await ctx.secrets.get(TOKEN_KEY)
      } catch (err) {
        ctx.log.warn('telegram token unreadable', { code: codeOf(err) })
        secretsFailed = true
      }
      settle()
      // 启动就是这样的不算变化:不写事件
      if (current.state === 'no_token' || current.state === 'disabled') {
        timers.clearTimeout(statusTimer)
        statusTimer = undefined
        written = statusKey(current)
      }
    },
  }
}

export default createChannelTelegram()
