// Telegram 插件的测试夹具(07):真内核 + 假 Bot API + 假模型 + 假时钟,全在临时目录里。
// 进程内:不设 NODE_USE_ENV_PROXY,fetch 直连 127.0.0.1;传给内核的环境里没有代理变量
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createKernel, type Kernel, type KernelOpts } from '../src/kernel/kernel'
import type { Logger } from '../src/kernel/log'
import type { Plugin } from '../src/kernel/pluginHost'
import { createGit } from '../src/lib/git/snapshot'
import type { SandboxStatus } from '../src/protocol/rpc'
import { startFakeTelegram, type FakeTelegram } from './fakeTelegram'
import { fakeClock, fakeModels, type FakeClock, type FakeModels, type FakeModelsOpts } from './memoryRig'

/** 运行时拼的,仓库里的扫描碰不到 */
export const TEST_TOKEN = '123456789:' + 'A'.repeat(35)
const OWNER = 1001

/** 给被测插件的注入:apiBase 指向假服务器,时间都走假时钟 */
export interface TelegramEnv {
  apiBase: string
  now(): number
  timers: FakeClock['timers']
  sleep(ms: number): Promise<void>
}

export interface TelegramKernelOpts {
  /** 被测插件;每次开内核都调一次(插件有自己的状态) */
  plugin?: (env: TelegramEnv) => Plugin
  /** 排在被测插件前面的(循环、工具等) */
  plugins?: (env: TelegramEnv) => Plugin[]
  models?: FakeModelsOpts
  /** 写进 config.json 的初始内容 */
  config?: Record<string, unknown>
  /** 内核看到的沙箱级别,默认 none。注入 full、partial 又真跑命令的用例要带平台 skipIf */
  level?: SandboxStatus['level']
  token?: string
  botId?: number
  username?: string
  kernel?: Partial<Omit<KernelOpts, 'dataDir' | 'plugins' | 'home' | 'secrets' | 'log'>>
}

export interface DmOpts {
  from?: number
  chatId?: number
  chatType?: string
  name?: string
  /** 消息的 date(秒);默认假时钟的现在 */
  date?: number
  isBot?: boolean
  forwardOrigin?: object
  viaBot?: object
  /** 合进 message 的其他字段(photo 等) */
  extra?: object
}

export interface PressOpts {
  from?: number
  chatId?: number
  messageId?: number
}

export interface SettleOpts {
  /** 这段假时间走完,分步走,步间让出去,连环的定时器都跑得到 */
  advance?: number
  /** 活动停了还要等到这个成立(真 git 这类假服务器看不到的工作) */
  until?: () => boolean
  timeoutMs?: number
}

export interface TelegramRig {
  k: Kernel
  root: string
  dataDir: string
  home: string
  /** 一个空目录(不是 git 仓库) */
  cwd: string
  fake: FakeTelegram
  models: FakeModels
  clock: FakeClock
  logs: string[]
  /** 默认的配对账号(也是私聊的 chat id) */
  owner: number
  /**
   * kill:按崩溃算。新内核看到的是这一刻的磁盘,没有 kernel.stopping、状态没冲刷。
   * 不给 kill:正常 close。假服务器、假模型、假时钟都留着
   */
  restart(o?: { kill?: boolean }): Promise<Kernel>
  /**
   * 判"不在里面"用的字节:数据目录每个文件(sqlite 先 wal_checkpoint(TRUNCATE))+ 每行日志。Buffer.includes(string) 按 UTF-8 比。
   * 凭据文件除外:osBackend:false 时令牌本来就存在那里。requests:再加上假服务器收到的请求体(不含路径,路径里有令牌)
   */
  rawBytes(o?: { requests?: boolean }): Buffer
  /** 一条私聊消息,返回 update_id */
  dm(text: string, o?: DmOpts): number
  /** 按一下按钮,返回 update_id */
  press(data: string, o?: PressOpts): number
  /** 等到请求和事件都不再变:更新被拿走、内核不再写。getUpdates 本身不算活动 */
  settle(o?: SettleOpts): Promise<void>
  close(): Promise<void>
}

/** 假服务器里还压着更新时多等一会儿:轮询可能正在两次请求之间,也可能已经停了 */
const QUIET_ROUNDS = 5
const QUIET_ROUNDS_WITH_BACKLOG = 40
const ROUND_MS = 1
const SETTLE_TIMEOUT_MS = 5_000
const MAX_ADVANCE_STEPS = 50
/** 被测插件的停止步骤可能在等注入的定时器:关内核时让假时间也走,最多这么多 */
const CLOSE_TICK_MS = 20
const CLOSE_ADVANCE_LIMIT_MS = 2_000

const CREDENTIAL_FILES = new Set(['credentials.json', 'credentials.enc'])

const pause = (ms = ROUND_MS) => new Promise<void>(r => setTimeout(r, ms))

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : []))
}

export async function telegramKernel(opts: TelegramKernelOpts = {}): Promise<TelegramRig> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-telegram-')))
  const dataDir = join(root, 'data')
  const home = join(root, 'home')
  const cwd = join(root, 'work')
  for (const d of [dataDir, home, cwd]) mkdirSync(d)
  writeFileSync(join(root, 'gitconfig'), '')
  const env = { PATH: '/usr/bin:/bin', HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
  if (opts.config) writeFileSync(join(dataDir, 'config.json'), JSON.stringify(opts.config))

  const clock = fakeClock()
  const models = fakeModels(opts.models)
  const logs: string[] = []
  const line = (level: string) => (m: string, d?: unknown) => void logs.push(JSON.stringify({ level, m, d }))
  const log: Logger = { info: line('info'), warn: line('warn'), error: line('error') }
  const level = opts.level ?? 'none'

  let fake: FakeTelegram
  try {
    fake = await startFakeTelegram({
      token: opts.token ?? TEST_TOKEN,
      ...(opts.botId !== undefined && { botId: opts.botId }),
      ...(opts.username !== undefined && { username: opts.username }),
      now: clock.now,
    })
  } catch (err) {
    rmSync(root, { recursive: true, force: true })
    throw err
  }
  const envFor: TelegramEnv = {
    apiBase: fake.base,
    now: clock.now,
    timers: clock.timers,
    sleep: ms => new Promise(r => clock.timers.setTimeout(r, ms)),
  }

  const open = () =>
    createKernel({
      env,
      sandbox: {
        detect: () => ({ level, missing: level === 'full' ? [] : level === 'partial' ? ['netns' as const] : ['platform' as const] }),
        upstream: null,
        git: createGit({ base: env }),
      },
      ...opts.kernel,
      log,
      dataDir,
      home,
      plugins: [models.plugin, ...(opts.plugins?.(envFor) ?? []), ...(opts.plugin ? [opts.plugin(envFor)] : [])],
      secrets: { osBackend: false },
    })

  /** 停止步骤可能在等注入的定时器,光等是等不到的 */
  const closeKernel = async (k: Kernel) => {
    let done = false
    const closing = k.close().finally(() => {
      done = true
    })
    let advanced = 0
    while (!done && advanced < CLOSE_ADVANCE_LIMIT_MS) {
      await pause()
      if (done) break
      clock.advance(CLOSE_TICK_MS)
      advanced += CLOSE_TICK_MS
    }
    await closing
  }

  let k: Kernel
  try {
    k = await open()
  } catch (err) {
    await fake.close()
    rmSync(root, { recursive: true, force: true })
    throw err
  }

  const imageDirs = () => [dataDir, `${dataDir}-worktrees`, `${dataDir}-im-worktrees`].filter(d => existsSync(d))
  /**
   * 崩溃镜像:同步拷贝,中间插不进任何写入,所以等于这一刻断电的磁盘(-wal 一起)。
   * 用户仓库不在镜像里:崩溃和关闭都不该动它
   */
  const takeImage = () => {
    const image = join(root, 'crash-image')
    rmSync(image, { recursive: true, force: true })
    mkdirSync(image)
    const dirs = imageDirs()
    for (const d of dirs) cpSync(d, join(image, basename(d)), { recursive: true, verbatimSymlinks: true })
    return () => {
      for (const d of imageDirs()) rmSync(d, { recursive: true, force: true })
      for (const d of dirs) renameSync(join(image, basename(d)), d)
      rmSync(image, { recursive: true, force: true })
    }
  }

  let presses = 0
  const rig: TelegramRig = {
    k,
    root,
    dataDir,
    home,
    cwd,
    fake,
    models,
    clock,
    logs,
    owner: OWNER,
    async restart(o = {}) {
      if (o.kill) {
        const restore = takeImage()
        // 旧内核要真的关掉(进程组、句柄、轮询),但它关闭时做的一切都不算数:碰不到 Telegram,写的盘被镜像盖掉
        fake.offline = true
        try {
          await closeKernel(rig.k)
        } finally {
          fake.offline = false
        }
        restore()
      } else {
        await closeKernel(rig.k)
      }
      rig.k = await open()
      return rig.k
    },
    rawBytes(o = {}) {
      for (const f of walk(dataDir).filter(x => x.endsWith('.sqlite'))) {
        const db = new DatabaseSync(f)
        try {
          db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        } finally {
          db.close()
        }
      }
      // checkpoint 之后才读
      const parts = walk(dataDir)
        .filter(f => !CREDENTIAL_FILES.has(basename(f)))
        .map(f => readFileSync(f))
      parts.push(Buffer.from(logs.join('\n')))
      if (o.requests) parts.push(Buffer.from(JSON.stringify(fake.requests.map(r => r.body))))
      return Buffer.concat(parts)
    },
    dm(text, o = {}) {
      const from = o.from ?? OWNER
      const name = o.name ?? 'Owner'
      return fake.push({
        message: {
          ...(o.date !== undefined && { date: o.date }),
          chat: { id: o.chatId ?? from, type: o.chatType ?? 'private', first_name: name },
          from: { id: from, is_bot: o.isBot ?? false, first_name: name },
          text,
          ...(o.forwardOrigin && { forward_origin: o.forwardOrigin }),
          ...(o.viaBot && { via_bot: o.viaBot }),
          ...o.extra,
        },
      })
    },
    press(data, o = {}) {
      const from = o.from ?? OWNER
      return fake.push({
        callback_query: {
          id: `cb-${++presses}`,
          from: { id: from, is_bot: false, first_name: 'Owner' },
          chat_instance: 'x',
          message: { message_id: o.messageId ?? 1, date: Math.floor(clock.now() / 1000), chat: { id: o.chatId ?? from, type: 'private' } },
          data,
        },
      })
    },
    async settle(o = {}) {
      const started = Date.now()
      const limit = o.timeoutMs ?? SETTLE_TIMEOUT_MS
      const fingerprint = () => `${fake.requests.filter(r => r.method !== 'getUpdates').length}:${rig.k.events.lastSeq()}:${fake.undelivered()}`
      const quiet = async () => {
        let last = fingerprint()
        let same = 0
        while (same < (fake.undelivered() > 0 ? QUIET_ROUNDS_WITH_BACKLOG : QUIET_ROUNDS)) {
          await pause()
          const now = fingerprint()
          same = now === last ? same + 1 : 0
          last = now
          if (Date.now() - started > limit) return
        }
      }
      await quiet()
      if (o.advance) {
        const steps = Math.min(MAX_ADVANCE_STEPS, Math.max(1, Math.ceil(o.advance / 100)))
        const step = Math.floor(o.advance / steps)
        for (let i = 0; i < steps; i++) {
          clock.advance(i === steps - 1 ? o.advance - step * (steps - 1) : step)
          await quiet()
        }
      }
      while (o.until && !o.until()) {
        if (Date.now() - started > limit) throw new Error('settle: until never held')
        await pause()
      }
    },
    async close() {
      // 用例中途失败时内核可能已经关过:临时目录和假服务器照样要收
      try {
        await closeKernel(rig.k)
      } catch {
        /* 已关 */
      }
      await fake.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
  return rig
}
