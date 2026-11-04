// state.json(07 spec §5.2):offset、配对、聊天映射、队列、卡片、投递。先写盘后确认,所以 ackOffset 只在写盘成功时动。
// 坏了或版本不认识就从空开始:没有配对 = 全部拒绝,失败方向是关
import { chmodSync, closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { Logger } from '../../kernel/log'

const Count = z.number().int().nonnegative()

export const StateSchema = z.object({
  version: z.literal(1),
  bot: z.object({ id: z.number().int(), username: z.string().optional() }).optional(),
  /** 下一个要的 update_id;内存里随每条更新推进,落盘见 ackOffset */
  offset: Count.default(0),
  lastUpdateAt: z.number().optional(),
  pairings: z.array(z.object({ accountId: z.string(), name: z.string(), pairedAt: z.number() })).default(() => []),
  senders: z.record(z.string(), z.object({ wrong: Count, lockedUntil: z.number().optional(), /** 上次错的时间:淘汰最旧的用,数字键的对象顺序靠不住 */ at: z.number().optional() })).default(() => ({})),
  leftChats: z.array(z.string()).default(() => []),
  /** 归 chats.ts */
  chats: z.record(z.string(), z.unknown()).default(() => ({})),
  /** 归 cards.ts */
  cards: z.array(z.unknown()).default(() => []),
  /** 归 projects.ts */
  worktrees: z.record(z.string(), z.unknown()).default(() => ({})),
  dropped: z
    .object({ unpaired: Count.default(0), stale: Count.default(0), group: Count.default(0), attachment: Count.default(0), badUpdate: Count.default(0) })
    .default(() => ({ unpaired: 0, stale: 0, group: 0, attachment: 0, badUpdate: 0 })),
  undelivered: Count.default(0),
})

export type TelegramStateData = z.infer<typeof StateSchema>
export type TelegramBot = NonNullable<TelegramStateData['bot']>

const empty = (): TelegramStateData => StateSchema.parse({ version: 1 })

export class TelegramState {
  /** 已经落盘的 offset:只有它能发给 Telegram,发出去就等于确认 */
  ackOffset: number
  readonly problems: string[] = []

  private constructor(
    private readonly file: string,
    readonly data: TelegramStateData,
    problems: string[],
  ) {
    this.ackOffset = data.offset
    this.problems.push(...problems)
  }

  static open(file: string, log: Logger): TelegramState {
    const dir = dirname(file)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new TelegramState(file, empty(), [])
      return TelegramState.recover(file, log)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return TelegramState.recover(file, log)
    }
    const result = StateSchema.safeParse(parsed)
    return result.success ? new TelegramState(file, result.data, []) : TelegramState.recover(file, log)
  }

  /** 不记原因的细节:zod 的问题和解析错误里可能带文件内容 */
  private static recover(file: string, log: Logger): TelegramState {
    const kept = `${file}.bad-${Date.now()}`
    try {
      renameSync(file, kept)
      log.warn('telegram state unreadable, starting empty')
    } catch (err) {
      log.warn('telegram state unreadable, could not set it aside', { code: (err as NodeJS.ErrnoException).code })
    }
    return new TelegramState(file, empty(), ['state_recovered'])
  }

  /** 临时文件 + 改名。抛错时旧文件和 ackOffset 都不动 */
  save(): void {
    const tmp = `${this.file}.tmp`
    try {
      const fd = openSync(tmp, 'w', 0o600)
      try {
        fchmodSync(fd, 0o600)
        writeSync(fd, JSON.stringify(this.data))
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, this.file)
    } catch (err) {
      rmSync(tmp, { force: true, recursive: true })
      throw err
    }
    this.ackOffset = this.data.offset
  }

  /** 这条处理完了 */
  advance(updateId: number): void {
    this.data.offset = Math.max(this.data.offset, updateId + 1)
  }

  /**
   * getMe 或 setToken 拿到的机器人。换了机器人(§5.1):清 offset、配对、聊天映射,卡片跟着聊天走;失败记录和退过的群也是旧机器人的。
   * 返回有没有改动,改了要存盘。旧 ackOffset 是另一个机器人的,不能再发出去
   */
  adoptBot(bot: TelegramBot): boolean {
    const old = this.data.bot
    if (old?.id === bot.id && old.username === bot.username) return false
    if (old && old.id !== bot.id) {
      this.data.offset = 0
      this.ackOffset = 0
      delete this.data.lastUpdateAt
      this.data.pairings = []
      this.data.senders = {}
      this.data.leftChats = []
      this.data.chats = {}
      this.data.cards = []
    }
    this.data.bot = bot
    return true
  }
}
