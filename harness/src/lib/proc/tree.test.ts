import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { cleanupFakes, installFake, isAlive, trackPid, waitDead, type FakeCli } from '../../../test/fakeCli'
import { groupMembers, startTime, type Kill, type ProcDeps } from './pgids'
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

/** 假进程表 + 假时钟:不碰任何真进程 */
function scripted(over: ProcDeps & { alive?: () => boolean } = {}) {
  const log: string[] = []
  let t = 0
  return {
    log,
    now: () => t,
    opts: {
      kill: ((pid, sig) => {
        if (sig !== 0) log.push(`${t} ${pid} ${sig}`)
      }) as Kill,
      descendants: ((root: number) => {
        log.push(`snapshot ${root}`)
        return root === 4242 ? [5001] : []
      }) as typeof descendants,
      alive: () => true,
      startTime: () => 'S',
      groupMembers: () => [],
      ownPgid: () => OWN,
      bootId: () => 'B',
      now: () => t,
      sleep: async (ms: number) => {
        t += ms
      },
      ...over,
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
  it('SIGINT goes first, the tree is snapshotted before the first SIGTERM, then SIGKILL at the budget', async () => {
    const s = scripted()
    await killLadder(4242, { ...s.opts, owned: () => true })
    expect(signals(s.log)).toEqual(['0 -4242 SIGINT', '3000 -4242 SIGTERM', '3000 5001 SIGTERM', '4900 -4242 SIGKILL', '4900 5001 SIGKILL'])
    expect(s.log.findIndex(l => l.startsWith('snapshot'))).toBeLessThan(s.log.findIndex(l => l.includes('SIGTERM')))
  })

  it('takes a snapshot before the SIGINT too: a wrapper that dies on SIGINT breaks the ppid chain', async () => {
    const s = scripted()
    await killLadder(4242, { ...s.opts, owned: () => true })
    expect(s.log[0]).toBe('snapshot 4242')
    expect(s.log[1]).toBe('0 -4242 SIGINT')
  })

  it('fast: 1.5 s + 1 s', async () => {
    const s = scripted()
    await killLadder(4242, { ...s.opts, owned: () => true, fast: true })
    expect(signals(s.log)).toEqual(['0 -4242 SIGINT', '1500 -4242 SIGTERM', '1500 5001 SIGTERM', '2400 -4242 SIGKILL', '2400 5001 SIGKILL'])
  })

  it('stops as soon as the group and the snapshot are gone', async () => {
    const s = scripted({ descendants: () => [], alive: () => false })
    await killLadder(4242, { ...s.opts, owned: () => true })
    expect(signals(s.log)).toEqual(['0 -4242 SIGINT'])
  })

  it('group gone but a snapshot pid still alive → the ladder goes on, for that pid only', async () => {
    let leaderUp = true
    const s = scripted({ alive: () => false, startTime: pid => (pid === 4242 && !leaderUp ? undefined : 'S') })
    const sleep = s.opts.sleep
    await killLadder(4242, {
      ...s.opts,
      sleep: async ms => {
        leaderUp = false
        await sleep(ms)
      },
    })
    expect(signals(s.log).filter(l => l.includes('5001')).map(l => l.split(' ')[2])).toEqual(['SIGTERM', 'SIGKILL'])
  })
})

describe('killLadder never signals what it cannot verify', () => {
  it('a snapshot pid whose start time changed (pid reused) is never signalled', async () => {
    let first = true
    let walks = 0
    const s = scripted({
      descendants: () => (walks++ === 0 ? [5001] : []),
      startTime: pid => {
        if (pid !== 5001) return 'S'
        if (first) {
          first = false
          return 'OLD'
        }
        return 'NEW'
      },
    })
    await killLadder(4242, { ...s.opts, owned: () => true })
    expect(s.log.filter(l => l.includes(' 5001 '))).toEqual([])
  })

  it('a reused snapshot pid is not walked for children either', async () => {
    const walked: number[] = []
    let n = 0
    const s = scripted({
      descendants: root => {
        walked.push(root)
        return root === 4242 && walked.length === 1 ? [5001] : root === 4242 ? [] : [6000]
      },
      startTime: pid => (pid === 5001 && n++ > 0 ? 'NEW' : 'S'),
    })
    await killLadder(4242, { ...s.opts, owned: () => true })
    expect(walked.filter(r => r === 5001)).toEqual([])
    expect(s.log.filter(l => l.includes(' 6000 '))).toEqual([])
  })

  it('leader pid reused mid-ladder → no further group signal', async () => {
    let lead = 'S'
    const s = scripted({ startTime: pid => (pid === 4242 ? lead : 'S'), descendants: () => [], alive: () => true })
    const p = killLadder(4242, {
      ...s.opts,
      sleep: async ms => {
        await s.opts.sleep(ms)
        lead = 'SOMEONE-ELSE'
      },
    })
    await p
    expect(signals(s.log)).toEqual(['0 -4242 SIGINT'])
  })

  it('ps failing while verifying → no group signal', async () => {
    let boom = false
    const s = scripted({
      descendants: () => [],
      startTime: () => {
        if (boom) throw new Error('ps timed out')
        return 'S'
      },
    })
    await killLadder(4242, {
      ...s.opts,
      sleep: async ms => {
        await s.opts.sleep(ms)
        boom = true
      },
    })
    expect(signals(s.log)).toEqual(['0 -4242 SIGINT'])
  })

  it('leader gone with no anchors → nothing to prove the group by, nothing sent, no waiting', async () => {
    const s = scripted({ startTime: () => undefined, descendants: () => [] })
    await killLadder(4242, { ...s.opts, anchors: [] })
    expect(signals(s.log)).toEqual([])
    expect(s.now()).toBe(0)
  })

  it('leader gone: a group is ours only when an anchor is still in it', async () => {
    const anchors = [{ pid: 7000, start: 'A' }]
    const ours = scripted({ startTime: () => undefined, descendants: () => [], groupMembers: () => [{ pid: 7000, start: 'A' }], alive: () => false })
    await killLadder(4242, { ...ours.opts, anchors })
    expect(signals(ours.log)[0]).toBe('0 -4242 SIGINT')

    const stranger = scripted({ startTime: () => undefined, descendants: () => [], groupMembers: () => [{ pid: 7000, start: 'B' }] })
    await killLadder(4242, { ...stranger.opts, anchors })
    expect(signals(stranger.log)).toEqual([])
  })

  it('never signals itself, its own group, or pid ≤ 1', async () => {
    const s = scripted({ descendants: () => [1, 0, -5, process.pid, OWN, 5001] })
    await killLadder(4242, { ...s.opts, owned: () => true })
    const targets = new Set(signals(s.log).map(l => Number(l.split(' ')[1])))
    expect([...targets].sort()).toEqual([-4242, 5001].sort())

    const own = scripted({ descendants: () => [] })
    await killLadder(OWN, { ...own.opts, owned: () => true })
    expect(signals(own.log)).toEqual([])
  })

  it('own group unknown → sends nothing', async () => {
    const s = scripted({ ownPgid: () => undefined })
    await killLadder(4242, { ...s.opts, owned: () => true })
    expect(signals(s.log)).toEqual([])
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
  }, 10_000)

  it('forwarding: the own-session child dies within 3 s on SIGINT and the ladder never needed SIGTERM or SIGKILL', async () => {
    const fake = installFake({ forwarding: true })
    const c = start(fake)
    const child = await fake.waitPid('child')
    const r = recording()
    const t0 = Date.now()
    await killLadder(c.pid!, { kill: r.kill, descendants, startTime, groupMembers, alive: () => groupExists(c.pid!) })
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(isAlive(child)).toBe(false)
    expect(groupExists(c.pid!)).toBe(false)
    expect(r.sent).toEqual([[-c.pid!, 'SIGINT']])
  }, 10_000)

  it('a wrapper that dies on SIGINT does not save its own-session grandchild: the pre-SIGINT snapshot still has it', async () => {
    const fake = installFake({ grandchild: true, sleep: 60_000 })
    const c = start(fake)
    const grandchild = await fake.waitPid('grandchild')
    const r = recording()
    await killLadder(c.pid!, { kill: r.kill, descendants, startTime, groupMembers, alive: () => groupExists(c.pid!) })
    expect(await waitDead(grandchild, 500)).toBe(true)
    expect(r.sent).toContainEqual([grandchild, 'SIGKILL'])
  }, 12_000)

  for (const { fast, budget } of [{ fast: false, budget: 5000 }, { fast: true, budget: 2500 }]) {
    it(`stubborn${fast ? ' (fast)' : ''}: leader and own-session grandchild dead within ${budget} ms, grandchild killed by pid`, async () => {
      const fake = installFake({ stubborn: true })
      const c = start(fake)
      const grandchild = await fake.waitPid('grandchild')
      const r = recording()
      const t0 = Date.now()
      await killLadder(c.pid!, { fast, kill: r.kill, descendants, startTime, groupMembers, alive: () => groupExists(c.pid!) })
      expect(await waitDead(grandchild, 500)).toBe(true)
      expect(await waitDead(c.pid!, 500)).toBe(true)
      expect(Date.now() - t0).toBeLessThanOrEqual(budget + 500) // 500 ms:信号送达与进程回收的调度余量
      expect(r.sent.map(x => x[1])).toEqual(expect.arrayContaining(['SIGINT', 'SIGTERM', 'SIGKILL']))
      expect(r.sent).toContainEqual([grandchild, 'SIGKILL'])
      expect(r.sent[0]).toEqual([-c.pid!, 'SIGINT'])
    }, 12_000)
  }
})
