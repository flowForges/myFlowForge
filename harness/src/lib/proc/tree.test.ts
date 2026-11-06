import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { cleanupFakes, installFake, isAlive, trackPid, waitDead, type FakeCli } from '../../../test/fakeCli'
import { procTable, type Kill, type ProcRow } from './pgids'
import { descendants, killLadder } from './tree'

const posix = process.platform === 'linux' || process.platform === 'darwin'
const OWN = 4243

afterEach(() => cleanupFakes())

const groupExists = (pgid: number) => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function start(fake: FakeCli): ChildProcess {
  const c = spawn(fake.file, [], { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH } })
  c.on('error', () => {})
  trackPid(c.pid!)
  return c
}

/** 真发信号,同时记下来 */
function recording() {
  const sent: [number, NodeJS.Signals][] = []
  const kill: Kill = (pid, sig) => {
    if (sig !== 0) sent.push([pid, sig])
    return process.kill(pid, sig)
  }
  return { sent, kill }
}

const row = (pid: number, ppid: number, start = 'S', pgid = pid): ProcRow => ({ pid, ppid, pgid, start })
const TREE = [row(4242, 1), row(5001, 4242)]

/** 假进程表 + 假时钟:不碰任何真进程 */
function scripted(over: { procTable?: () => ProcRow[]; alive?: () => boolean; ownPgid?: () => number | undefined } = {}) {
  const log: string[] = []
  let t = 0
  const table = over.procTable ?? (() => TREE)
  return {
    log,
    now: () => t,
    opts: {
      kill: ((pid, sig) => {
        if (sig !== 0) log.push(`${t} ${pid} ${sig}`)
      }) as Kill,
      alive: () => true,
      ownPgid: () => OWN,
      bootId: () => 'B',
      now: () => t,
      sleep: async (ms: number) => {
        t += ms
      },
      ...over,
      procTable: () => {
        log.push('snapshot')
        return table()
      },
    },
  }
}
const signals = (log: string[]) => log.filter(l => !l.startsWith('snapshot'))

describe('descendants', () => {
  const table = ['  10   1', '  11  10', '  12  11', '  13  10', '  20   1', ' garbage', ''].join('\n')

  it('walks children transitively and leaves out the root and strangers', () => {
    expect(descendants(10, () => table).sort()).toEqual([11, 12, 13])
    expect(descendants(12, () => table)).toEqual([])
  })

  it('ps failing gives []', () => {
    expect(descendants(10, () => { throw new Error('ps timed out') })).toEqual([])
  })

  it('pid ≤ 1 gives [], never the whole machine', () => {
    expect(descendants(1, () => table)).toEqual([])
    expect(descendants(0, () => table)).toEqual([])
    expect(descendants(-10, () => table)).toEqual([])
  })

  it('a ppid cycle ends', () => {
    expect(descendants(10, () => '10 11\n11 10\n')).toEqual([11])
  })

  it.skipIf(!posix)('reads the real process table', async () => {
    const c = spawn('/bin/sh', ['-c', 'sleep 30 & wait'], { detached: true, stdio: 'ignore' })
    trackPid(c.pid!)
    try {
      await vi.waitFor(() => expect(descendants(c.pid!).length).toBe(1), { timeout: 3000 })
    } finally {
      process.kill(-c.pid!, 'SIGKILL')
    }
  })
})

describe('killLadder order', () => {
  it('SIGINT goes first, the tree is read before the first SIGTERM, then SIGKILL inside the budget', async () => {
    const s = scripted()
    const res = await killLadder(4242, { ...s.opts, owned: () => true })
    expect(signals(s.log)).toEqual(['0 -4242 SIGINT', '3000 -4242 SIGTERM', '3000 5001 SIGTERM', '4800 -4242 SIGKILL', '4800 5001 SIGKILL'])
    expect(s.log.indexOf('snapshot')).toBeLessThan(s.log.findIndex(l => l.includes('SIGTERM')))
    expect(res.gone).toBe(false) // 假进程表里它们永远活着
  })

  it('reads the table before the SIGINT too: a wrapper that dies on SIGINT breaks the ppid chain', async () => {
    const s = scripted()
    await killLadder(4242, { ...s.opts, owned: () => true })
    expect(s.log[0]).toBe('snapshot')
    expect(s.log[1]).toBe('0 -4242 SIGINT')
  })

  it('one table per step, however large the tree: 4 reads for 200 processes', async () => {
    const big = [row(4242, 1), ...Array.from({ length: 200 }, (_, i) => row(5000 + i, 4242, 'S', 4242))]
    const s = scripted({ procTable: () => big })
    await killLadder(4242, { ...s.opts, owned: () => true })
    expect(s.log.filter(l => l === 'snapshot')).toHaveLength(4) // INT、TERM、KILL,最后一次去掉复用的 pid
  })

  it('fast: 1.5 s + 1 s', async () => {
    const s = scripted()
    await killLadder(4242, { ...s.opts, owned: () => true, fast: true })
    expect(signals(s.log)).toEqual(['0 -4242 SIGINT', '1500 -4242 SIGTERM', '1500 5001 SIGTERM', '2300 -4242 SIGKILL', '2300 5001 SIGKILL'])
  })

  it('fast turns true halfway (cancelled, then the kernel closes): the rest follows the short ladder from that moment', async () => {
    const s = scripted()
    let fast = false
    const sleep = s.opts.sleep!
    const opts = { ...s.opts, sleep: async (ms: number) => { await sleep(ms); if (s.opts.now!() >= 1000) fast = true } }
    await killLadder(4242, { ...opts, owned: () => true, fast: () => fast })
    // 1000 才变快:SIGINT 宽限到 min(3000, 1000+1500),SIGKILL 不晚于 1000+2500-200
    expect(signals(s.log)).toEqual(['0 -4242 SIGINT', '2500 -4242 SIGTERM', '2500 5001 SIGTERM', '3300 -4242 SIGKILL', '3300 5001 SIGKILL'])
  })

  it('fast that never turns true keeps the long ladder', async () => {
    const s = scripted()
    await killLadder(4242, { ...s.opts, owned: () => true, fast: () => false })
    expect(signals(s.log)).toEqual(['0 -4242 SIGINT', '3000 -4242 SIGTERM', '3000 5001 SIGTERM', '4800 -4242 SIGKILL', '4800 5001 SIGKILL'])
  })

  it('stops as soon as the group and the snapshot are gone', async () => {
    const s = scripted({ procTable: () => [row(4242, 1)], alive: () => false })
    const res = await killLadder(4242, { ...s.opts, owned: () => true })
    expect(signals(s.log)).toEqual(['0 -4242 SIGINT'])
    expect(res.gone).toBe(true)
  })

  it('group gone but a snapshot pid still alive → the ladder goes on, for that pid only', async () => {
    let n = 0
    const s = scripted({ alive: () => false, procTable: () => (n++ === 0 ? TREE : [row(5001, 1)]) })
    await killLadder(4242, s.opts)
    expect(signals(s.log).filter(l => l.includes(' 5001 ')).map(l => l.split(' ')[2])).toEqual(['SIGTERM', 'SIGKILL'])
    expect(signals(s.log).filter(l => l.includes('-4242'))).toEqual(['0 -4242 SIGINT'])
  })

  it('a member that only the wrapper\'s group knows about is walked from, too', async () => {
    let n = 0
    const s = scripted({
      procTable: () => (n++ === 0 ? [row(4242, 1), row(4300, 4242, 'S', 4242)] : [row(4300, 1, 'S', 4242), row(6000, 4300)]),
      alive: () => true,
    })
    await killLadder(4242, { ...s.opts, owned: () => false })
    expect(signals(s.log)).toContain('3000 6000 SIGTERM')
  })

  // 09 Task 11 抓到的:MCP 服务关了 stdin 就退,比梯子的第一张表还快;自成一会话的子进程被 launchd 收养,ppid 链断了
  it('a tree read before the ladder: the leader is already gone, its own-session child is still taken', async () => {
    const s = scripted({ procTable: () => [row(6100, 1, 'C', 6100)], alive: () => false })
    const res = await killLadder(4242, { ...s.opts, tree: [{ pid: 6100, start: 'C' }] })
    expect(signals(s.log).filter(l => l.includes(' 6100 ')).map(l => l.split(' ')[2])).toEqual(['SIGTERM', 'SIGKILL'])
    expect(signals(s.log).filter(l => l.includes('-4242'))).toEqual([])
    expect(res.gone).toBe(false)
  })

  it('the tree seed is checked against the table like any walked pid: a reused pid is left alone, and its children are not walked', async () => {
    const s = scripted({ procTable: () => [row(6100, 1, 'OTHER', 6100), row(6200, 6100)], alive: () => false })
    const res = await killLadder(4242, { ...s.opts, tree: [{ pid: 6100, start: 'C' }] })
    expect(signals(s.log)).toEqual([])
    expect(res.gone).toBe(true)
  })

  it('a seeded pid that is walked from: its children are taken too', async () => {
    const s = scripted({ procTable: () => [row(6100, 1, 'C', 6100), row(6200, 6100, 'D', 6100)], alive: () => false })
    await killLadder(4242, { ...s.opts, tree: [{ pid: 6100, start: 'C' }] })
    expect(signals(s.log)).toEqual(expect.arrayContaining([expect.stringMatching(/ 6200 SIGTERM$/), expect.stringMatching(/ 6200 SIGKILL$/)]))
  })
})

describe('killLadder never signals what it cannot verify', () => {
  it('a pid is only ever recorded with the start time from the row the walk saw', async () => {
    // 走树那一行是 OLD;之后同一个 pid 变成别的进程(NEW,ppid 已不通向我们)
    let n = 0
    const s = scripted({ procTable: () => (n++ === 0 ? [row(4242, 1), row(5001, 4242, 'OLD')] : [row(4242, 1), row(5001, 77, 'NEW')]) })
    await killLadder(4242, {
      ...s.opts,
      owned: () => true,
      startTime: () => { throw new Error('the ladder must not read start times separately') },
      groupMembers: () => { throw new Error('the ladder must not list the group separately') },
    })
    expect(s.log.filter(l => l.includes(' 5001 '))).toEqual([])
  })

  it('a reused snapshot pid is not walked for children either', async () => {
    let n = 0
    const s = scripted({ procTable: () => (n++ === 0 ? [row(4242, 1), row(5001, 4242, 'OLD')] : [row(4242, 1), row(5001, 77, 'NEW'), row(6000, 5001)]) })
    await killLadder(4242, { ...s.opts, owned: () => true })
    expect(s.log.filter(l => l.includes(' 6000 '))).toEqual([])
  })

  it('a reused pid does not count as not killed', async () => {
    let n = 0
    const s = scripted({ alive: () => false, procTable: () => (n++ === 0 ? TREE : [row(5001, 77, 'NEW')]) })
    const res = await killLadder(4242, { ...s.opts, owned: () => true })
    expect(res.gone).toBe(true)
  })

  it('leader pid reused mid-ladder → no further group signal', async () => {
    let n = 0
    const s = scripted({ procTable: () => (n++ === 0 ? [row(4242, 1)] : [row(4242, 77, 'SOMEONE-ELSE')]) })
    await killLadder(4242, s.opts)
    expect(signals(s.log)).toEqual(['0 -4242 SIGINT'])
  })

  it('table unreadable and leader not provably ours → no group signal and no pid signal', async () => {
    let n = 0
    const s = scripted({
      procTable: () => {
        if (n++ > 0) throw new Error('ps timed out')
        return TREE
      },
    })
    await killLadder(4242, s.opts)
    expect(signals(s.log)).toEqual(['0 -4242 SIGINT'])
  })

  it('M-5: table unreadable at signal time with an owned leader → the group is signalled, single pids are not', async () => {
    let n = 0
    const s = scripted({
      procTable: () => {
        if (n++ > 0) throw new Error('ps timed out')
        return TREE
      },
    })
    await killLadder(4242, { ...s.opts, owned: () => true })
    expect(signals(s.log)).toEqual(['0 -4242 SIGINT', '3000 -4242 SIGTERM', '4800 -4242 SIGKILL'])
  })

  it('M-3: one failed read does not lose the anchors', async () => {
    let n = 0
    const member = row(4300, 1, 'M', 4242)
    const s = scripted({
      alive: () => true,
      procTable: () => {
        const i = n++
        if (i === 0) return [row(4242, 1), member]
        if (i === 1) return [row(4242, 1)] // 组员这一次没读到
        return [member]
      },
    })
    await killLadder(4242, s.opts)
    expect(signals(s.log).some(l => l.includes('-4242 SIGKILL'))).toBe(true)
  })

  it('leader gone with no anchors → nothing to prove the group by, nothing sent, no waiting', async () => {
    const s = scripted({ procTable: () => [row(7000, 1, 'A', 4242)] })
    const res = await killLadder(4242, { ...s.opts, anchors: [] })
    expect(signals(s.log)).toEqual([])
    expect(s.now()).toBe(0)
    expect(res.gone).toBe(false) // 组还在,只是认不出:不能说没了
  })

  it('leader gone: a group is ours only when an anchor is still in it', async () => {
    const anchors = [{ pid: 7000, start: 'A' }]
    const ours = scripted({ procTable: () => [row(7000, 1, 'A', 4242)], alive: () => false })
    await killLadder(4242, { ...ours.opts, anchors })
    expect(signals(ours.log)[0]).toBe('0 -4242 SIGINT')

    const stranger = scripted({ procTable: () => [row(7000, 1, 'B', 4242)] })
    await killLadder(4242, { ...stranger.opts, anchors })
    expect(signals(stranger.log)).toEqual([])
  })

  it('never signals itself, its own group, or pid ≤ 1', async () => {
    const s = scripted({ procTable: () => [row(4242, 1), row(process.pid, 4242), row(OWN, 4242), row(1, 4242), row(5001, 4242)] })
    await killLadder(4242, { ...s.opts, owned: () => true })
    const targets = new Set(signals(s.log).map(l => Number(l.split(' ')[1])))
    expect([...targets].sort()).toEqual([-4242, 5001].sort())

    const own = scripted({ procTable: () => [row(OWN, 1)] })
    await killLadder(OWN, { ...own.opts, owned: () => true })
    expect(signals(own.log)).toEqual([])
  })

  it('I-3: own group unknown → sends nothing and says it is not gone', async () => {
    const s = scripted({ ownPgid: () => undefined })
    const res = await killLadder(4242, { ...s.opts, owned: () => true })
    expect(signals(s.log)).toEqual([])
    expect(res.gone).toBe(false)
  })

  it('I-3: a failed own-group lookup is retried on the next signal', async () => {
    let n = 0
    const s = scripted({ ownPgid: () => (n++ === 0 ? undefined : OWN) })
    await killLadder(4242, { ...s.opts, owned: () => true })
    expect(signals(s.log)).toContain('3000 -4242 SIGTERM')
    expect(signals(s.log)).not.toContain('0 -4242 SIGINT')
  })
})

describe.skipIf(!posix)('killLadder against real fakes (Review Focus 1)', () => {
  it('control: SIGTERM to the group leaves the forwarding fake\'s child alive (what real Codex does)', async () => {
    const fake = installFake({ forwarding: true })
    const c = start(fake)
    const child = await fake.waitPid('child')
    process.kill(-c.pid!, 'SIGTERM')
    expect(await waitDead(c.pid!, 3000)).toBe(true)
    await new Promise(res => setTimeout(res, 200))
    expect(isAlive(child)).toBe(true)
  })

  it('forwarding: the own-session child dies within 3 s on SIGINT and the ladder never needed SIGTERM or SIGKILL', async () => {
    const fake = installFake({ forwarding: true })
    const c = start(fake)
    const child = await fake.waitPid('child')
    const r = recording()
    const t0 = Date.now()
    await killLadder(c.pid!, { kill: r.kill, procTable: () => procTable(), alive: () => groupExists(c.pid!) })
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(isAlive(child)).toBe(false)
    expect(groupExists(c.pid!)).toBe(false)
    expect(r.sent).toEqual([[-c.pid!, 'SIGINT']])
  })

  it('a wrapper that dies on SIGINT does not save its own-session grandchild: the pre-SIGINT snapshot still has it', async () => {
    const fake = installFake({ grandchild: true, sleep: 60_000 })
    const c = start(fake)
    const grandchild = await fake.waitPid('grandchild')
    const r = recording()
    await killLadder(c.pid!, { kill: r.kill, procTable: () => procTable(), alive: () => groupExists(c.pid!) })
    expect(await waitDead(grandchild, 500)).toBe(true)
    expect(r.sent).toContainEqual([grandchild, 'SIGKILL'])
  })

  it('I-2: a group of 40 stubborn processes gets SIGKILL inside the budget', async () => {
    const c = spawn('/bin/sh', ['-c', `trap '' INT TERM; i=0; while [ $i -lt 40 ]; do sleep 60 & i=$((i+1)); done; wait`], { detached: true, stdio: 'ignore' })
    c.on('error', () => {})
    trackPid(c.pid!)
    try {
      await vi.waitFor(() => expect(descendants(c.pid!).length).toBe(40), { timeout: 15_000 })
      const t0 = Date.now()
      let killedAt = 0
      const kill: Kill = (pid, sig) => {
        if (sig === 'SIGKILL' && !killedAt) killedAt = Date.now() - t0
        return process.kill(pid, sig)
      }
      const res = await killLadder(c.pid!, { kill, procTable: () => procTable(), alive: () => groupExists(c.pid!) })
      expect(killedAt).toBeGreaterThan(0)
      expect(killedAt).toBeLessThanOrEqual(5000)
      expect(res.gone).toBe(true)
    } finally {
      try {
        process.kill(-c.pid!, 'SIGKILL')
      } catch {
        // 已经没了
      }
    }
  })

  for (const { fast, budget } of [{ fast: false, budget: 5000 }, { fast: true, budget: 2500 }]) {
    it(`stubborn${fast ? ' (fast)' : ''}: leader and own-session grandchild dead within ${budget} ms, grandchild killed by pid`, async () => {
      const fake = installFake({ stubborn: true })
      const c = start(fake)
      const grandchild = await fake.waitPid('grandchild')
      const r = recording()
      const t0 = Date.now()
      await killLadder(c.pid!, { fast, kill: r.kill, procTable: () => procTable(), alive: () => groupExists(c.pid!) })
      expect(await waitDead(grandchild, 500)).toBe(true)
      expect(await waitDead(c.pid!, 500)).toBe(true)
      expect(Date.now() - t0).toBeLessThanOrEqual(budget + 500) // 500 ms:信号送达与进程回收的调度余量
      expect(r.sent.map(x => x[1])).toEqual(expect.arrayContaining(['SIGINT', 'SIGTERM', 'SIGKILL']))
      expect(r.sent).toContainEqual([grandchild, 'SIGKILL'])
      expect(r.sent[0]).toEqual([-c.pid!, 'SIGINT'])
    })
  }
})
