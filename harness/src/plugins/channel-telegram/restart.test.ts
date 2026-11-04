// 重启和断网(07 Review Focus 5):kill = 不 close 就换内核,新内核看到的是那一刻的磁盘
import { writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { say } from '../../../test/memoryRig'
import { asOneBatch, chatOf, events, flow, gatedScript, gatedStream, handled, HOUR, online, onDisk, pairedRig, sends, stateFile, texts, users, type ChatRigOpts } from '../../../test/telegramChats'
import type { TelegramRig } from '../../../test/telegramRig'
import { TelegramState } from './state'

const INTERRUPTED = '后台重启,这轮中断了'
const MINUTE = 60_000

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

const status = (r: TelegramRig) => r.k.handle('channel.telegram.status', {}) as Promise<{ undelivered: number; dropped: { stale: number } }>
const staleLines = (r: TelegramRig) => texts(r).filter(t => t.includes('没有执行'))
const count = (r: TelegramRig, needle: string) => texts(r).filter(t => t.includes(needle)).length

/** 磁盘上的 state.json 就停在这一刻:之后的 save 都写不进去。kill 之后新内核看到的就是它 */
function freezeDiskAfter(when: (data: Record<string, any>) => boolean) {
  const real = TelegramState.prototype.save
  let frozen = false
  vi.spyOn(TelegramState.prototype, 'save').mockImplementation(function (this: TelegramState) {
    if (frozen) throw Object.assign(new Error('disk gone'), { code: 'EIO' })
    real.call(this)
    if (when(this.data)) frozen = true
  })
  return () => frozen
}

/** Telegram 再投一遍:假服务器看到更高的 offset 就把它扔了,所以要放回去 */
const redeliver = (r: TelegramRig, updateId: number, text: string) =>
  r.fake.push({ update_id: updateId, message: { chat: { id: r.owner, type: 'private', first_name: 'Owner' }, from: { id: r.owner, is_bot: false, first_name: 'Owner' }, text } })

describe('a kill around the queue', () => {
  it('after the state write and before the next getUpdates: one model request', async () => {
    const r = await rig()
    const id = r.dm('run me once')
    await handled(r, id)
    await r.restart({ kill: true })
    await online(r)
    await flow(r)
    expect(r.models.foreground()).toHaveLength(1)
    expect(users(r).map(u => u.text)).toEqual(['run me once'])
    expect(r.fake.requests.filter(q => q.method === 'getUpdates').at(-1)?.body.offset).toBe(id + 1)
  })

  it('the update comes back anyway (offset on disk is older than the queue): still one model request', async () => {
    const r = await rig()
    const id = r.dm('run me once')
    await handled(r, id)
    const seeded = onDisk(r)
    seeded.offset = id
    writeFileSync(stateFile(r), JSON.stringify(seeded))
    await r.restart({ kill: true })
    await online(r)
    redeliver(r, id, 'run me once')
    await handled(r, id)
    await flow(r)
    expect(r.models.foreground()).toHaveLength(1)
    expect(users(r).map(u => u.text)).toEqual(['run me once'])
  })

  it('an update that already ran comes back: the receipt stops it, no second message.user, no second reply', async () => {
    const r = await rig({ models: { script: () => say('the only answer') } })
    const id = r.dm('run me once')
    await handled(r, id)
    await flow(r)
    expect(count(r, 'the only answer')).toBe(1)
    const seeded = onDisk(r)
    seeded.offset = id
    writeFileSync(stateFile(r), JSON.stringify(seeded))
    await r.restart({ kill: true })
    await online(r)
    redeliver(r, id, 'run me once')
    await handled(r, id)
    await flow(r)
    expect(users(r).map(u => u.text)).toEqual(['run me once'])
    expect(r.models.foreground()).toHaveLength(1)
    expect(count(r, 'the only answer')).toBe(1)
  })

  it('a failed save: nothing is confirmed, the update comes back after a kill and runs once', async () => {
    const r = await rig()
    const before = onDisk(r).offset
    vi.spyOn(TelegramState.prototype, 'save').mockImplementation(() => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    })
    const id = r.dm('run me once')
    await expect.poll(() => r.fake.requests.filter(q => q.method === 'getUpdates').some(q => q.body.offset === undefined || q.body.offset <= id)).toBe(true)
    await r.settle()
    expect(onDisk(r).offset).toBe(before)
    vi.restoreAllMocks()
    await r.restart({ kill: true })
    await online(r)
    await flow(r)
    await flow(r)
    expect(users(r).map(u => u.text)).toEqual(['run me once'])
    expect(events(r, 'session.created')).toHaveLength(1)
  })

  it('a kill with messages queued behind a turn: fresh ones run after the restart', async () => {
    const g = gatedStream('working ', 'x')
    const r = await rig({ models: { script: gatedScript(g) } })
    await handled(r, r.dm('start'))
    await flow(r)
    await handled(r, r.dm('queued one'))
    await handled(r, r.dm('queued two'))
    await r.restart({ kill: true })
    await online(r)
    await flow(r)
    expect(users(r).map(u => u.text)).toEqual(['start', 'queued one\nqueued two'])
    expect(count(r, INTERRUPTED)).toBe(1)
    expect(staleLines(r)).toEqual([])
  })

  it('a kill with messages queued, back too late: they do not run, one summary line goes out', async () => {
    const g = gatedStream('working ', 'x')
    const r = await rig({ models: { script: gatedScript(g) } })
    await handled(r, r.dm('start'))
    await flow(r)
    await handled(r, r.dm('queued one'))
    await handled(r, r.dm('queued two'))
    await r.settle()
    r.clock.advance(11 * MINUTE)
    await r.restart({ kill: true })
    await online(r)
    await flow(r)
    expect(users(r).map(u => u.text)).toEqual(['start'])
    expect(staleLines(r)).toEqual(['离线期间的 2 条没有执行,要的话重发。'])
    expect((await status(r)).dropped.stale).toBe(2)
    expect(chatOf(r).queue).toEqual([])
  })
})

describe('a frozen batch', () => {
  /** 冻结批次已落盘、提示已进内核、清 batch 没落盘,这时断电 */
  async function killedWithFrozenBatch(r: TelegramRig) {
    freezeDiskAfter(d => d.chats[String(1001)]?.batch !== undefined)
    r.dm('frozen')
    await expect.poll(() => chatOf(r).queue?.length === 1, { timeout: 3000 }).toBe(true)
    await r.settle({ advance: 800 })
    await expect.poll(() => r.models.foreground().length, { timeout: 3000 }).toBe(1)
    vi.restoreAllMocks()
    expect(chatOf(r).batch?.text).toBe('frozen')
  }

  it('a kill after session.prompt and before the batch is cleared, a new message after the restart: one prompt for the batch, the new one after it', async () => {
    const r = await rig({ models: { script: gatedScript(gatedStream('half ', 'x')) } })
    await killedWithFrozenBatch(r)
    await r.restart({ kill: true })
    await online(r)
    const id = r.dm('new message')
    await handled(r, id)
    await flow(r)
    expect(chatOf(r).batch).toBeUndefined()
    expect(users(r).map(u => u.text)).toEqual(['frozen', 'new message'])
    expect(r.models.foreground()).toHaveLength(2)
    expect(events(r, 'session.created')).toHaveLength(1)
    expect(count(r, INTERRUPTED)).toBe(1)
    expect(texts(r).at(-1)).toBe('reply 2')
  })

  it('stale with a receipt: no second message.user, the batch is cleared, and the turn is still reported once', async () => {
    const r = await rig({ models: { script: gatedScript(gatedStream('half ', 'x')) } })
    await killedWithFrozenBatch(r)
    r.clock.advance(11 * MINUTE)
    await r.restart({ kill: true })
    await online(r)
    await flow(r)
    expect(users(r).map(u => u.text)).toEqual(['frozen'])
    expect(chatOf(r).batch).toBeUndefined()
    expect(staleLines(r)).toEqual([])
    expect(count(r, INTERRUPTED)).toBe(1)
    expect(r.models.foreground()).toHaveLength(1)
  })

  it('stale with no receipt: it does not run and goes into the summary', async () => {
    const r = await rig()
    await handled(r, r.dm('first'))
    await flow(r)
    const seeded = onDisk(r)
    const sessionId = seeded.chats[String(r.owner)].sessionId
    seeded.chats[String(r.owner)].batch = { commandId: 'tg:123456789:900-901', sessionId, text: 'yesterday\ndeploy', external: false, date: Math.floor((r.clock.now() - HOUR) / 1000), updateIds: [900, 901] }
    writeFileSync(stateFile(r), JSON.stringify(seeded))
    await r.restart({ kill: true })
    await online(r)
    await flow(r)
    expect(users(r).map(u => u.text)).toEqual(['first'])
    expect(chatOf(r).batch).toBeUndefined()
    expect(staleLines(r)).toEqual(['离线期间的 2 条没有执行,要的话重发。'])
  })

  it('fresh with no receipt: it runs under its own commandId', async () => {
    const r = await rig()
    await handled(r, r.dm('first'))
    await flow(r)
    const seeded = onDisk(r)
    const sessionId = seeded.chats[String(r.owner)].sessionId
    seeded.chats[String(r.owner)].batch = { commandId: 'tg:123456789:900-900', sessionId, text: 'just frozen', external: true, date: Math.floor(r.clock.now() / 1000), updateIds: [900] }
    writeFileSync(stateFile(r), JSON.stringify(seeded))
    await r.restart({ kill: true })
    await online(r)
    await flow(r)
    expect(users(r).at(-1)).toMatchObject({ text: 'just frozen', external: true })
    expect(r.rawBytes().includes('tg:123456789:900-900')).toBe(true)
    await r.restart({ kill: true })
    await online(r)
    await flow(r)
    expect(users(r).filter(u => u.text === 'just frozen')).toHaveLength(1)
  })
})

describe('a backlog', () => {
  it('older than staleMinutes: nothing runs, commands included, one line for the whole batch', async () => {
    const r = await rig()
    const old = Math.floor((r.clock.now() - 11 * MINUTE) / 1000)
    await asOneBatch(r, () => {
      r.dm('部署', { date: old })
      r.dm('/rollback', { date: old })
      return r.dm('/project api', { date: old })
    })
    await flow(r)
    expect(users(r)).toEqual([])
    expect(events(r, 'session.created')).toEqual([])
    expect(r.models.calls).toEqual([])
    expect(staleLines(r)).toEqual(['离线期间的 3 条没有执行,要的话重发。'])
    expect((await status(r)).dropped.stale).toBe(3)
  })

  it('a message queued for a long turn is not stale while the daemon runs', async () => {
    const g = gatedStream('working ', 'x')
    const r = await rig({ models: { script: gatedScript(g) } })
    await handled(r, r.dm('start'))
    await flow(r)
    await handled(r, r.dm('wait for me'))
    await r.settle()
    await r.settle({ advance: 20 * MINUTE })
    g.open()
    await flow(r)
    expect(users(r).map(u => u.text)).toEqual(['start', 'wait for me'])
    expect(staleLines(r)).toEqual([])
  })

  it('staleMinutes comes from the config', async () => {
    const r = await rig()
    await r.k.handle('channel.telegram.config.set', { commandId: 'c', config: { staleMinutes: 30 } })
    await handled(r, r.dm('old but allowed', { date: Math.floor((r.clock.now() - 11 * MINUTE) / 1000) }))
    await flow(r)
    expect(users(r).map(u => u.text)).toEqual(['old but allowed'])
  })
})

describe('a worker killed mid-turn', () => {
  it('the interruption is said once, not again after a second restart; the message already out is edited, not repeated', async () => {
    const g = gatedStream('half of the answer ', 'x')
    const r = await rig({ models: { script: gatedScript(g) } })
    await handled(r, r.dm('start'))
    await flow(r)
    const before = sends(r).length
    await r.restart({ kill: true })
    await online(r)
    await flow(r)
    expect(events(r, 'turn.failed').map(e => (e.payload as { reason: string }).reason)).toEqual(['interrupted'])
    expect(count(r, INTERRUPTED)).toBe(1)
    expect(texts(r).at(-1)).toBe(`half of the answer\n${INTERRUPTED}`)
    expect(sends(r).length).toBe(before)
    expect(chatOf(r).delivery.done).toBe(true)
    await r.restart({ kill: true })
    await online(r)
    await flow(r)
    expect(count(r, INTERRUPTED)).toBe(1)
    expect(sends(r).length).toBe(before)
    expect(r.models.foreground()).toHaveLength(1)
  })

  it('a kill before the first chunk went out: one message says so', async () => {
    const g = gatedStream('', 'x')
    const r = await rig({ models: { script: gatedScript(g) } })
    const before = sends(r).length
    await handled(r, r.dm('start'))
    await r.settle({ advance: 800 })
    await expect.poll(() => r.models.foreground().length).toBe(1)
    await r.restart({ kill: true })
    await online(r)
    await flow(r)
    expect(sends(r).length).toBe(before + 1)
    expect(count(r, INTERRUPTED)).toBe(1)
  })

  it('a clean restart mid-turn: exactly one reply, no second run', async () => {
    const g = gatedStream('half ', 'x')
    const r = await rig({ models: { script: gatedScript(g) } })
    await handled(r, r.dm('start'))
    await flow(r)
    const before = sends(r).length
    await r.restart()
    await online(r)
    await flow(r)
    expect(r.models.foreground()).toHaveLength(1)
    expect(sends(r).length).toBe(before)
    expect(events(r, 'turn.failed')).toHaveLength(1)
    expect(chatOf(r).delivery.done).toBe(true)
    await r.restart()
    await online(r)
    await flow(r)
    expect(sends(r).length).toBe(before)
  })

  it('the next message after an interruption runs normally', async () => {
    const g = gatedStream('half ', 'x')
    const r = await rig({ models: { script: gatedScript(g) } })
    await handled(r, r.dm('start'))
    await flow(r)
    await r.restart({ kill: true })
    await online(r)
    await flow(r)
    await handled(r, r.dm('again'))
    await flow(r)
    expect(texts(r).at(-1)).toBe('reply 2')
  })

  it('a turn the fresh kernel has no delivery for (killed right after the batch): the batch replays and the turn is reported', async () => {
    const g = gatedStream('half ', 'x')
    const r = await rig({ models: { script: gatedScript(g) } })
    freezeDiskAfter(d => d.chats[String(1001)]?.batch !== undefined)
    r.dm('start')
    await r.settle({ advance: 800 })
    await expect.poll(() => r.models.foreground().length).toBe(1)
    vi.restoreAllMocks()
    const on = chatOf(r)
    expect(on.batch?.text).toBe('start')
    expect(on.delivery).toBeUndefined()
    await r.restart({ kill: true })
    await online(r)
    await flow(r)
    expect(users(r).map(u => u.text)).toEqual(['start'])
    expect(count(r, INTERRUPTED)).toBe(1)
    expect(chatOf(r).batch).toBeUndefined()
    expect(r.models.foreground()).toHaveLength(1)
  })
})

describe('Telegram down', () => {
  it('a turn that finished while Telegram was down: the final text arrives when it returns', async () => {
    const g = gatedStream('start of it ', 'and the end')
    const r = await rig({ models: { script: gatedScript(g) } })
    await handled(r, r.dm('go'))
    await flow(r)
    r.fake.offline = true
    g.open()
    await r.settle({ advance: 5000 })
    await expect.poll(() => events(r, 'turn.ended').length, { timeout: 3000 }).toBe(1)
    await r.settle({ advance: 5000 })
    r.fake.offline = false
    await flow(r, 70_000)
    expect(texts(r).at(-1)).toBe('start of it and the end')
    expect(chatOf(r).delivery.done).toBe(true)
  })

  it('the same across a restart', async () => {
    const r = await rig({ models: { script: () => say('the whole answer') } })
    await handled(r, r.dm('sent before the outage'))
    r.fake.offline = true
    await r.settle({ advance: 800 })
    await expect.poll(() => events(r, 'turn.ended').length, { timeout: 3000 }).toBe(1)
    await r.settle({ advance: 3000 })
    expect(chatOf(r).delivery.done).toBe(false)
    await r.restart({ kill: true })
    await online(r)
    await flow(r)
    expect(count(r, 'the whole answer')).toBe(1)
    expect(chatOf(r).delivery.done).toBe(true)
  })

  it('an hour of failures counts one undelivered now; the next start delivers it and the count is back to 0', async () => {
    const r = await rig({ models: { script: () => say('the answer') } })
    r.fake.fail('sendMessage', 10_000, { status: 500 })
    await handled(r, r.dm('go'))
    await flow(r)
    await expect.poll(() => events(r, 'turn.ended').length, { timeout: 3000 }).toBe(1)
    expect((await status(r)).undelivered).toBe(0)
    for (let i = 0; i < 70; i++) await r.settle({ advance: MINUTE })
    expect((await status(r)).undelivered).toBe(1)
    expect(chatOf(r).delivery.done).toBe(false)
    r.fake.clearFailures()
    await r.restart({ kill: true })
    await online(r)
    await flow(r, 3 * MINUTE)
    expect(count(r, 'the answer')).toBe(1)
    expect((await status(r)).undelivered).toBe(0)
    expect(chatOf(r).delivery.done).toBe(true)
  }, 30_000)

  it('a turn starting while the previous final is still undelivered: both arrive, also across a restart', async () => {
    const r = await rig({ models: { script: n => say(n === 1 ? 'answer one' : 'answer two') } })
    r.fake.fail('sendMessage', 3, { status: 500 })
    await handled(r, r.dm('first'))
    await r.settle({ advance: 800 })
    await expect.poll(() => events(r, 'turn.ended').length, { timeout: 3000 }).toBe(1)
    await r.settle()
    await handled(r, r.dm('second'))
    await r.settle({ advance: 800 })
    await expect.poll(() => events(r, 'turn.ended').length, { timeout: 3000 }).toBe(2)
    await r.settle()
    const on = chatOf(r)
    expect(on.delivery.done).toBe(false)
    await r.restart({ kill: true })
    await online(r)
    await flow(r, 2 * MINUTE)
    expect(texts(r).slice(-2)).toEqual(['answer one', 'answer two'])
    expect(count(r, 'answer one')).toBe(1)
    expect(count(r, 'answer two')).toBe(1)
    expect(chatOf(r).undone ?? []).toEqual([])
  })
})
