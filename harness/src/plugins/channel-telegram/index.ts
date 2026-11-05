// channel-telegram 插件(07 spec §4):装配、RPC、生命周期,以及所有更新的路由。
// 通往会话的路只有 handleUpdate 里的一条,每条消息现查 isPaired。令牌只在这里的闭包和 api.ts 里,日志和错误只有稳定代码
import { realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { Approvals } from '../../kernel/approvals'
import type { Plugin, PluginContext } from '../../kernel/pluginHost'
import { RpcError } from '../../kernel/rpcError'
import type { Sessions } from '../../kernel/sessions'
import { createGit, type Git } from '../../lib/git/snapshot'
import { scrub } from '../../lib/memory/scrub'
import type { ModelsService } from '../../lib/models/types'
import type { SandboxService, SessionCommands } from '../../lib/tools/types'
import { type ChannelState, type WorkerMethodName } from '../../protocol/index'
import type { TelegramConfig, TelegramStatus } from '../../protocol/rpc'
import { createApi, REAL_TIMERS, TelegramError, type ApiTimers } from './api'
import { Cards } from './cards'
import { Chats } from './chats'
import { isCommandShaped, parseCommand, runCommand, type CommandDeps } from './commands'
import { classify, isExternal, type DmInbound, type Inbound } from './inbound'
import { manifest } from './manifest'
import { Pairing, PairingError, parsePairCommand } from './pairing'
import { codeOf, Poller, type PollerState } from './poller'
import { Projects } from './projects'
import { Sender } from './sender'
import { TelegramState, type TelegramBot } from './state'

const API_BASE = 'https://api.telegram.org'
const TOKEN_KEY = 'token'
/** 也挡住路径注入:令牌要拼进 URL */
const TOKEN_SHAPE = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/
const PAIRED_LINE = '配对成功。这里的对话和你的记忆内容会经过 Telegram 的服务器。'
const INVALID_LINE = '配对码无效或已过期'
const ALREADY_PAIRED_LINE = '已配对'
const NO_ATTACHMENTS_LINE = '暂不支持附件,发文字吧'
const STATUS_STABLE_MS = 30_000
const LEAVE_WINDOW_MS = 3_600_000
const LEAVES_PER_WINDOW = 30
const LEFT_CHATS_MAX = 1000
/** 关闭时最多再等这么久(§5.2) */
const FLUSH_MS = 500
const SAVE_FAILED = 'state_save_failed'
const CONFIG_INVALID = 'config_invalid'

const ConfigSchema = z.object({
  enabled: z.boolean().default(true),
  staleMinutes: z.number().int().min(1).max(1440).default(10),
  projects: z
    // off 是 /project off,叫这个名字的项目永远进不去
    .array(z.object({ name: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).refine(name => name !== 'off'), path: z.string().min(1), auto: z.boolean().default(false) }))
    .refine(list => new Set(list.map(p => p.name)).size === list.length)
    .default(() => []),
})

const DEFAULT_CONFIG: TelegramConfig = { enabled: true, staleMinutes: 10, projects: [] }

export interface ChannelTelegramOpts {
  /** 只有代码能改:配置、环境变量、RPC 都送不走令牌(§4) */
  apiBase?: string
  now?(): number
  timers?: ApiTimers
  sleep?(ms: number): Promise<void>
  random?(): number
  pollTimeoutS?: number
  fetch?: typeof fetch
  /** 进队列的防抖,默认 700 ms */
  debounceMs?: number
  /** 只给测试:一条配对私聊进队列之前。慢的一批、抛错的一条都靠它造出来 */
  beforePairedDm?(dm: DmInbound): void | Promise<void>
  /** worktree 和快照引用用的 git;测试注入隔离的环境 */
  git?: Git
  /** 只算沙箱写得到的根(~/.qoder),不读;默认真的 home */
  home?: string
  /** 系统临时目录,默认 os.tmpdir() 的 realpath */
  systemTmp?: string
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
  // 坏了就关:看不懂的配置不能把用户关掉的渠道重新打开。状态里报出来,config.set 一条好的就恢复
  const bad = () => {
    ctx.log.warn('telegram config invalid, channel disabled')
    state.problems.push(CONFIG_INVALID)
    return { ...structuredClone(DEFAULT_CONFIG), enabled: false }
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
      const sessions = ctx.services.get<Sessions>('sessions')
      const approvals = ctx.services.get<Approvals>('approvals')
      if (!commands || !sandbox || !sessions || !approvals) throw new Error('channel-telegram: kernel services missing')

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

      const saveNow = () => {
        try {
          state.save()
          noteSaved()
          return true
        } catch (err) {
          noteSaveFailure(err)
          return false
        }
      }
      const chatRecord = (chatId: string) => state.data.chats[chatId] as { blocked?: boolean } | undefined

      // —— 发送:不挡轮询,不挡轮。blocked 只记配对账号的:陌生人的 403 不能往 chats 里写东西
      const sender = new Sender({
        api,
        now,
        timers,
        random: opts.random ?? Math.random,
        onChange: chatId => {
          chats.onDeliveryChange(chatId)
          saveNow()
        },
        onUndelivered: chatId => chats.onUndelivered(chatId),
        isBlocked: chatId => chatRecord(chatId)?.blocked === true,
        onBlocked: chatId => {
          if (!isPaired(chatId, chatId)) return
          chats.setBlocked(chatId, true)
          saveNow()
        },
        log: ctx.log,
      })
      const reply = (chatId: string, text: string) => void sender.send(chatId, { text })

      /** 出站文本:scrub 再加令牌字面值(§9.4)。令牌在这个闭包里 */
      const mask = (text: string) => {
        const masked = scrub(text).text
        return token ? masked.split(token).join('***') : masked
      }
      const cards: Cards = new Cards({
        state,
        sender,
        approvals,
        sandbox,
        isPaired: (accountId, chatId) => isPaired(accountId, chatId),
        active: (): boolean => chats.isRunning(),
        mask,
        timers,
        save: saveNow,
        log: ctx.log,
      })
      const chats = new Chats({
        state,
        cards,
        commands,
        sessions,
        models: () => ctx.services.get<ModelsService>('models'),
        sender,
        history: sessionId => ctx.events.history(sessionId),
        now,
        timers,
        ...(opts.debounceMs !== undefined && { debounceMs: opts.debounceMs }),
        log: ctx.log,
        isPaired: chatId => isPaired(chatId, chatId),
        mask,
        staleMs: () => config.staleMinutes * 60_000,
        save: saveNow,
      })
      ctx.events.onAppend(e => chats.onEvent(e))
      const projects = new Projects({
        // ctx.dataDir 是 <数据目录>/plugins/<id>
        dataDir: dirname(dirname(ctx.dataDir)),
        tmpDir: join(ctx.dataDir, 'tmp'),
        home: opts.home ?? process.env.HOME ?? homedir(),
        systemTmp: opts.systemTmp ?? realpathSync(tmpdir()),
        git: opts.git ?? createGit(),
        state,
        chats,
        commands,
        sandbox,
        sessions,
        config: () => config,
        history: sessionId => ctx.events.history(sessionId),
        eventsAfter: (seq, limit) => ctx.events.after(seq, limit),
        save: saveNow,
        notify: (chatId, text) => {
          if (isPaired(chatId, chatId)) reply(chatId, text)
        },
        now,
        log: ctx.log,
      })

      // —— 配对
      const pairing = new Pairing({
        state,
        now,
        onBurned: () => void ctx.append({ type: 'channel.pairing.burned', payload: { channel: 'telegram' } }),
      })
      const isPaired = (accountId: string, chatId: string | undefined) => chatId === accountId && state.data.pairings.some(p => p.accountId === accountId)

      /** 事件最先:写不进去就什么都没发生;崩溃在中间只是多一声铃,反过来就是一次没人看见的配对 */
      const completePairing = (i: DmInbound) => {
        const { pairings } = state.data
        ctx.append({ type: 'channel.paired', payload: { channel: 'telegram', accountId: i.accountId, name: i.name } })
        pairings.push({ accountId: i.accountId, name: i.name, pairedAt: now() })
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
        chats.setBlocked(i.chatId, false)
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

      /** 撤销:名单先改、事件在后,上面的一切都到不了他。发送器清空在卡片之前,卡片最后那次改动不能被它清掉 */
      const revokeAccount = (accountId: string, by: 'app' | 'im') => {
        const at = state.data.pairings.findIndex(p => p.accountId === accountId)
        if (at < 0) return false
        state.data.pairings.splice(at, 1)
        // 私聊的 chat id 就是账号 id
        chats.revoke(accountId)
        sender.drop(accountId)
        cards.expireAll()
        ctx.append({ type: 'channel.unpaired', payload: { channel: 'telegram', accountId, by } })
        return true
      }

      const commandDeps: CommandDeps = {
        chats,
        projects,
        commands,
        sessions,
        sandbox,
        models: () => ctx.services.get<ModelsService>('models'),
        history: sessionId => ctx.events.history(sessionId),
        channelState: () => current.state,
        unpair: accountId => void revokeAccount(accountId, 'im'),
        botId: () => {
          const id = state.data.bot?.id
          if (id === undefined) throw new Error('no bot')
          return id
        },
        mask,
        reply,
      }

      const onPairedDm = async (i: DmInbound) => {
        const external = isExternal(i)
        if (!external && parsePairCommand(i.text)) {
          reply(i.chatId, ALREADY_PAIRED_LINE)
          return
        }
        // getMe 成功之前不会有更新;真到了这里不猜 commandId
        const botId = state.data.bot?.id
        if (botId === undefined) throw new Error('no bot')
        if (opts.beforePairedDm) {
          await opts.beforePairedDm(i)
          // 等的时候可能撤销、换机器人了
          if (state.data.bot?.id !== botId || !isPaired(i.accountId, i.chatId)) return
        }
        // 转发的永远不是命令(R15)。命令的效果和 offset 同一次落盘,和排队的消息一样
        if (!external && isCommandShaped(i.text)) {
          if (chats.admit(i)) await runCommand(parseCommand(i.text, state.data.bot?.username), i, commandDeps, ctx.log)
          state.advance(i.updateId)
          saveNow()
          return
        }
        chats.onDm(i)
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
        sender.fire('leaveChat', { chat_id: chatId })
      }

      const onBlocked = (i: Extract<Inbound, { kind: 'blocked' }>) => {
        if (!isPaired(i.chatId, i.chatId)) {
          state.data.dropped.unpaired++
          return
        }
        chats.setBlocked(i.chatId, i.blocked)
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
            cards.onCallback(i)
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
        // 处理到一半换了机器人:剩下的不处理,offset 不推进。名单和 offset 已经是新机器人的了
        const botId = state.data.bot?.id
        try {
          for (const update of updates) {
            if (state.data.bot?.id !== botId) return
            try {
              await handleUpdate(update)
            } catch (err) {
              ctx.log.warn('telegram update failed', { code: codeOf(err) })
              if (state.data.bot?.id === botId) state.data.dropped.badUpdate++
            }
            if (state.data.bot?.id !== botId) return
            state.advance((update as { update_id: number }).update_id)
          }
        } finally {
          chats.endBatch()
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
        const off = !config.enabled ? 'disabled' : secretsLocked() ? 'secrets_unavailable' : !token ? 'no_token' : undefined
        if (off) {
          chats.pause()
          setState(off)
        } else {
          chats.resume()
          cards.resume()
          poller.start()
        }
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
        // 旧机器人的轮要在聊天映射清掉之前取消:配对没了就是撤销
        if (before !== undefined && before !== bot.id) {
          chats.revokeAll()
          cards.forget()
        }
        if (!state.adoptBot(bot)) return
        if (before !== undefined && before !== bot.id) {
          pairing.cancel()
          sender.dropAll()
        }
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
        if (!revokeAccount(params.accountId, 'app') && !state.problems.includes(SAVE_FAILED)) return { ok: true }
        try {
          state.save()
          noteSaved()
        } catch (err) {
          noteSaveFailure(err)
          throw new RpcError(ERR_INVALID_PARAMS, SAVE_FAILED)
        }
        return { ok: true }
      })

      register('channel.telegram.chats', async () => ({ chats: chats.list(), worktrees: projects.list() }))

      register('channel.telegram.worktree.discard', async (params: { worktreeId: string }) => {
        await projects.discard(params.worktreeId)
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
          const invalid = state.problems.indexOf(CONFIG_INVALID)
          if (invalid >= 0) state.problems.splice(invalid, 1)
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
        // 关内核时轮已经停了:终态在这里交给发送器。发不出去的 delivery 还开着,下次启动补
        chats.dispose()
        cards.dispose()
        await sender.flush(FLUSH_MS)
        sender.close()
        saveNow()
      })

      try {
        projects.reconcile()
      } catch (err) {
        // 根读不了不挡激活:名额的问题,建新的时候会说
        ctx.log.warn('telegram worktree reconcile failed', { code: codeOf(err) })
      }

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
