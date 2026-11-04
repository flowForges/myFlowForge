import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Logger } from '../../kernel/log'
import { TelegramState } from './state'

const posix = process.platform !== 'win32'

describe('TelegramState', () => {
  let root: string
  let dir: string
  let file: string
  let logs: string[]
  let log: Logger
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mffai-tg-state-'))
    dir = join(root, 'channel-telegram')
    file = join(dir, 'state.json')
    logs = []
    const line = (m: string, d?: unknown) => void logs.push(JSON.stringify({ m, d }))
    log = { info: line, warn: line, error: line }
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const seedRaw = (content: string) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, content)
  }

  it('没有文件:空状态,没有问题,也还没写盘', () => {
    const s = TelegramState.open(file, log)
    expect(s.data).toMatchObject({ version: 1, offset: 0, pairings: [], senders: {}, leftChats: [], chats: {}, cards: [], worktrees: {}, undelivered: 0 })
    expect(s.data.dropped).toEqual({ unpaired: 0, stale: 0, group: 0, attachment: 0, badUpdate: 0 })
    expect(s.data.bot).toBeUndefined()
    expect(s.data.lastUpdateAt).toBeUndefined()
    expect(s.problems).toEqual([])
    expect(s.ackOffset).toBe(0)
    expect(existsSync(file)).toBe(false)
  })

  it('两个空状态不共用默认值', () => {
    const a = TelegramState.open(file, log)
    a.data.pairings.push({ accountId: '1', name: 'x', pairedAt: 1 })
    a.data.dropped.group = 3
    const b = TelegramState.open(join(dir, 'other.json'), log)
    expect(b.data.pairings).toEqual([])
    expect(b.data.dropped.group).toBe(0)
  })

  it('存了再开,内容原样;opaque 的段不解释', () => {
    const s = TelegramState.open(file, log)
    s.data.bot = { id: 5, username: 'b' }
    s.data.offset = 42
    s.data.lastUpdateAt = 1000
    s.data.pairings.push({ accountId: '9', name: 'n', pairedAt: 2 })
    s.data.senders['7'] = { wrong: 2, lockedUntil: 99 }
    s.data.leftChats.push('-100')
    s.data.chats['9'] = { sessionId: 's', queue: [{ a: 1 }] }
    s.data.cards.push({ nonce: 'n', chatId: 9 })
    s.data.worktrees.wt_1 = { path: '/x' }
    s.data.dropped.badUpdate = 4
    s.data.undelivered = 2
    s.save()
    const again = TelegramState.open(file, log)
    expect(again.data).toEqual(s.data)
    expect(again.problems).toEqual([])
    expect(again.ackOffset).toBe(42)
  })

  it('ackOffset 只有写盘成功才动', () => {
    const s = TelegramState.open(file, log)
    s.advance(10)
    expect(s.data.offset).toBe(11)
    expect(s.ackOffset).toBe(0)
    s.save()
    expect(s.ackOffset).toBe(11)
    s.advance(20)
    rmSync(dir, { recursive: true })
    expect(() => s.save()).toThrow()
    expect(s.ackOffset).toBe(11)
  })

  it('advance 不往回走', () => {
    const s = TelegramState.open(file, log)
    s.advance(10)
    s.advance(3)
    expect(s.data.offset).toBe(11)
  })

  const bad: [string, string][] = [
    ['不是 JSON', '{"version":1,"offset":'],
    ['空文件', ''],
    ['不是对象', '[]'],
    ['版本更新', JSON.stringify({ version: 2, offset: 5, pairings: [{ accountId: '1', name: 'n', pairedAt: 1 }] })],
    ['没有版本', JSON.stringify({ offset: 5 })],
    ['字段类型不对', JSON.stringify({ version: 1, offset: 'many' })],
    ['offset 为负', JSON.stringify({ version: 1, offset: -1 })],
    ['配对不是列表', JSON.stringify({ version: 1, pairings: { accountId: '1' } })],
  ]
  for (const [name, content] of bad) {
    it(`坏文件(${name}):改名 .bad-*,从空开始,失败方向是关`, () => {
      seedRaw(content)
      const s = TelegramState.open(file, log)
      expect(s.problems).toContain('state_recovered')
      expect(s.data.pairings).toEqual([])
      expect(s.data.offset).toBe(0)
      expect(existsSync(file)).toBe(false)
      const kept = readdirSync(dir).filter(f => /^state\.json\.bad-\d+$/.test(f))
      expect(kept).toHaveLength(1)
      expect(readFileSync(join(dir, kept[0]), 'utf8')).toBe(content)
    })
  }

  it('坏文件的内容不进日志', () => {
    const marker = 'MARKER-' + 'q'.repeat(12)
    seedRaw(JSON.stringify({ version: 1, offset: marker }))
    TelegramState.open(file, log)
    seedRaw(`{"version":1,"x":"${marker}`)
    TelegramState.open(file, log)
    expect(logs.length).toBeGreaterThan(0)
    expect(logs.join('\n')).not.toContain(marker)
  })

  it('恢复之后再存一次,下次打开是干净的', () => {
    seedRaw('garbage')
    const s = TelegramState.open(file, log)
    s.save()
    const again = TelegramState.open(file, log)
    expect(again.problems).toEqual([])
  })

  it.runIf(posix)('写出来 0600,目录 0700,原来的宽权限也收紧', () => {
    mkdirSync(dir, { recursive: true, mode: 0o755 })
    writeFileSync(file, JSON.stringify({ version: 1 }))
    chmodSync(file, 0o644)
    chmodSync(dir, 0o755)
    const s = TelegramState.open(file, log)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    s.save()
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it.runIf(posix)('上次崩溃留下的宽权限临时文件:也按 0600 写', () => {
    const s = TelegramState.open(file, log)
    writeFileSync(`${file}.tmp`, 'old')
    chmodSync(`${file}.tmp`, 0o644)
    s.save()
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('写的是临时文件 + 改名,不留临时文件', () => {
    const s = TelegramState.open(file, log)
    s.save()
    s.save()
    expect(readdirSync(dir)).toEqual(['state.json'])
  })

  it('写失败:旧文件不动', () => {
    const s = TelegramState.open(file, log)
    s.data.offset = 1
    s.save()
    const before = readFileSync(file, 'utf8')
    // 临时文件的位置是目录:写不进去
    mkdirSync(`${file}.tmp`)
    s.data.offset = 2
    expect(() => s.save()).toThrow()
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  describe('adoptBot', () => {
    it('第一次:记下来,什么都不清', () => {
      const s = TelegramState.open(file, log)
      s.data.offset = 9
      expect(s.adoptBot({ id: 1, username: 'a' })).toBe(true)
      expect(s.data.bot).toEqual({ id: 1, username: 'a' })
      expect(s.data.offset).toBe(9)
    })

    it('同一个机器人换令牌、改用户名:配对和映射都留着', () => {
      const s = TelegramState.open(file, log)
      s.adoptBot({ id: 1, username: 'a' })
      s.data.offset = 9
      s.data.pairings.push({ accountId: '1', name: 'n', pairedAt: 1 })
      s.data.chats['1'] = {}
      expect(s.adoptBot({ id: 1, username: 'b' })).toBe(true)
      expect(s.adoptBot({ id: 1, username: 'b' })).toBe(false)
      expect(s.data.bot?.username).toBe('b')
      expect(s.data.offset).toBe(9)
      expect(s.data.pairings).toHaveLength(1)
      expect(s.data.chats['1']).toBeDefined()
    })

    it('换了机器人:失败记录和退过的群也是旧机器人的,一起清', () => {
      const s = TelegramState.open(file, log)
      s.adoptBot({ id: 1 })
      s.data.senders['7'] = { wrong: 3, lockedUntil: 9 }
      s.data.leftChats.push('-5')
      s.adoptBot({ id: 2 })
      expect(s.data.senders).toEqual({})
      expect(s.data.leftChats).toEqual([])
    })

    it('换了机器人:清 offset、配对、聊天映射、卡片', () => {
      const s = TelegramState.open(file, log)
      s.adoptBot({ id: 1, username: 'a' })
      s.data.offset = 9
      s.data.lastUpdateAt = 5
      s.data.pairings.push({ accountId: '1', name: 'n', pairedAt: 1 })
      s.data.chats['1'] = {}
      s.data.cards.push({ nonce: 'x' })
      s.save()
      expect(s.adoptBot({ id: 2, username: 'c' })).toBe(true)
      expect(s.data).toMatchObject({ bot: { id: 2, username: 'c' }, offset: 0, pairings: [], chats: {}, cards: [] })
      expect(s.data.lastUpdateAt).toBeUndefined()
      expect(s.ackOffset).toBe(0)
    })
  })
})
