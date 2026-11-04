// 记忆的实测数字(06 Task 12):默认跳过,MFFAI_MEASURE=1 才跑,只打印不设门槛。数字记在计划的 Verification results
import { randomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { Plugin, PluginContext } from '../src/kernel/pluginHost'
import type { MemoryService } from '../src/lib/memory/types'
import { createMemoryDefault, type MemoryDefaultPlugin } from '../src/plugins/memory-default/index'
import { MemoryFiles } from '../src/plugins/memory-default/files'
import { openStore } from '../src/plugins/memory-default/store'
import { memoryKernel, type MemoryRig } from './memoryRig'

const ON = process.env.MFFAI_MEASURE === '1'
const report = (what: string, numbers: Record<string, unknown>) => process.stderr.write(`MFFAI_MEASURE ${what} ${JSON.stringify(numbers)}\n`)
const ms = (t: number) => Math.round(performance.now() - t)
const MB = 1_048_576
const noLog = { info() {}, warn() {}, error() {}, debug() {} }
/** 像真的工具输出:可读文本,scrub 的正则都要走一遍 */
const textOf = (bytes: number) => {
  const line = `src/plugins/x/${randomBytes(6).toString('hex')}.ts:42: error TS2345 argument of type string 端口 5173 命令 npm run build\n`
  return line.repeat(Math.ceil(bytes / line.length)).slice(0, bytes)
}

describe.skipIf(!ON)('memory measurements', () => {
  const rigs: MemoryRig[] = []
  afterEach(async () => {
    for (const r of rigs.splice(0)) await r.close()
  })

  async function boot(kernel: Parameters<typeof memoryKernel>[0] = {}) {
    let ctx!: PluginContext
    const memory: MemoryDefaultPlugin = createMemoryDefault({ nightly: false })
    const probe: Plugin = { manifest: { id: 'probe', version: '0', kernel: '^0.1.0' }, activate: c => { ctx = c } }
    const r = await memoryKernel({ ...kernel, plugins: () => [memory, probe] })
    rigs.push(r)
    return { r, ctx: () => ctx, memory }
  }

  it('appending to one diary: cost of one memory_write by diary size', async () => {
    const r = await memoryKernel()
    rigs.push(r)
    const store = openStore(join(r.root, 'memory.sqlite'), { log: noLog })
    try {
      const files = new MemoryFiles(join(r.root, 'plugin'), store, { now: () => 1_793_000_000_000, log: noLog, append: () => {} })
      const rows: Record<string, number> = {}
      let n = 0
      for (const size of (process.env.MFFAI_MEASURE_DIARY ?? "0,50,300,1000").split(",").map(Number)) {
        for (; n < size; n++) files.appendDiary(`diary line ${n} 端口 ${5000 + n} 命令 npm run build`, { src: 'model', ts: 1_793_000_000_000 })
        const t = performance.now()
        for (let i = 0; i < 20; i++, n++) files.appendDiary(`diary line ${n} 端口 ${5000 + n} 命令 npm run build`, { src: 'model', ts: 1_793_000_000_000 })
        rows[`at${size}`] = Math.round((performance.now() - t) / 20 * 10) / 10
      }
      report('memory_write ms per write', rows)
    } finally {
      store.close()
    }
  }, 500_000)

  // 200 KB 一条:一小批十条,上限只在批之间查,这是最坏情况
  it.each([['small', 200, 20_000], ['large', 12_000, 20_000], ['huge', 200_000, 2000]])('contextFor and stop on a backlog, %s events', async (_name, bytes, count) => {
    const { r, ctx, memory } = await boot()
    const c = ctx()
    const memoryService = c.services.get<MemoryService>('memory')!
    const { sessionId } = await r.k.handle('session.create', { commandId: 'c', cwd: r.cwd }) as { sessionId: string }
    const another = (await r.k.handle('session.create', { commandId: 'd', cwd: r.cwd }) as { sessionId: string }).sessionId
    const body = textOf(bytes)
    const seed = performance.now()
    // 同步写完:中途让不出事件循环,接入一行都追不上,这就是"积压"
    for (let n = 0; n < count; n++) c.append({ type: 'tool.ended', sessionId: another, payload: { turnId: 't', callId: `c${n}`, name: 'read', ok: true, content: `${n} ${body}` } })
    const seedMs = ms(seed)

    const lag = () => c.events.after(memory.inspect().store.cursor(), -1).length
    const before = lag()
    const history = performance.now()
    const events = c.events.history(sessionId)
    const historyMs = ms(history)
    const samples: number[] = []
    for (let i = 0; i < 5; i++) {
      const t = performance.now()
      memoryService.contextFor({ sessionId, turnId: `t${i}`, text: '这个端口之前是怎么配置的', events, contextTokens: 100_000 })
      samples.push(ms(t))
    }
    const stop = performance.now()
    await r.k.close()
    const stopMs = ms(stop)
    report('contextFor backlog', { eventBytes: bytes, seedMs, backlog: before, historyMs, contextForMs: samples, kernelCloseMs: stopMs })
    expect(before).toBeGreaterThanOrEqual(count)
  }, 500_000)

  it.each([100, 500, 1000])('memory.delete and VACUUM on a %d MB log', async sizeMb => {
    const holds: { ms: number; at: number }[] = []
    let inHold = false
    let longestOutside = 0
    let heldMs = 0
    const { r } = await boot({
      kernel: {
        log: { ...noLog, child: () => noLog, error: (m: string, f?: object) => report('kernel error', { m, ...f }) } as never,
        holdWatchdog: async (m: number) => {
          holds.push({ ms: m, at: performance.now() })
          if (m > 0) inHold = true
          else {
            inHold = false
            heldMs = performance.now() - holds[holds.length - 2].at
          }
        },
      },
    })
    // 第二个连接往日志里灌,灌完重启:和慢慢用出来的一样是普通行,大小可控
    const file = join(r.dataDir, 'db', 'events.sqlite')
    const db = new DatabaseSync(file)
    const seed = performance.now()
    const insert = db.prepare('INSERT INTO events(ts, type, session_id, payload) VALUES (?, ?, ?, ?)')
    db.exec('BEGIN')
    const row = 8_000
    const rows = Math.ceil((sizeMb * MB) / row)
    for (let n = 0; n < rows; n++) {
      // delta 不进原始层:这里只量事件库,记忆库的大小另外报
      insert.run(1_793_000_000_000 + n, 'message.assistant.delta', 'seeded', JSON.stringify({ turnId: `t${Math.floor(n / 100)}`, text: `${n} ${textOf(row - 60)}` }))
      if (n % 5000 === 4999) {
        db.exec('COMMIT')
        db.exec('BEGIN')
      }
    }
    db.exec('COMMIT')
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    db.close()
    const seedMs = ms(seed)
    const boot0 = performance.now()
    report('seeded, booting', { sizeMb, heapMb: Math.round(process.memoryUsage().heapUsed / MB) })
    await r.restart()
    report('booted', { sizeMb, bootMs: ms(boot0), heapMb: Math.round(process.memoryUsage().heapUsed / MB) })

    await r.k.handle('memory.file.set', { commandId: 'set', file: 'USER.md', content: '- 一条用来删除的记忆内容足够长\n', expectedHash: ((await r.k.handle('memory.file.get', { file: 'USER.md' })) as { hash: string }).hash })
    const { items } = (await r.k.handle('memory.search', { query: '用来删除的记忆' })) as { items: { id: string }[] }
    expect(items.length).toBeGreaterThan(0)

    let last = performance.now()
    const beat = setInterval(() => {
      const now = performance.now()
      if (!inHold) longestOutside = Math.max(longestOutside, now - last)
      last = now
    }, 20)
    const t = performance.now()
    const out = await r.k.handle('memory.delete', { commandId: 'del', id: items[0].id })
    const deleteMs = ms(t)
    clearInterval(beat)
    expect(out).toMatchObject({ ok: true })
    const size = statSync(file).size
    expect(readFileSync(file).includes(Buffer.from('一条用来删除的记忆内容足够长'))).toBe(false)
    report('memory.delete', {
      sizeMb: Math.round(size / MB),
      seedMs,
      deleteMs,
      heldMs: Math.round(heldMs),
      grantedMs: holds[0]?.ms,
      perMbMs: Math.round((heldMs / (size / MB)) * 10) / 10,
      longestBlockOutsideHoldMs: Math.round(longestOutside),
      memoryDbMb: Math.round(statSync(join(r.dataDir, 'plugins', 'memory-default', 'memory.sqlite')).size / MB),
    })
  }, 500_000)
})
