import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootId, groupMembers, killLive, ownPgid, parseEntries, PgidRegistry, reapOrphans, startTime, type Kill, type ProcDeps } from './pgids'

const posix = process.platform === 'linux' || process.platform === 'darwin'

let root: string
let file: string
/** 本文件起的子进程(组长);afterEach 里没退的整组杀掉 */
let children: { c: ChildProcess; detached: boolean }[] = []
/** 孙进程 pid + 启动时间;afterEach 里启动时间仍一致才杀(不误伤复用的 pid) */
let grandkids: { pid: number; start: string }[] = []
/** 本文件建的登记;afterEach 里停掉刷新定时器 */
let registries: PgidRegistry[] = []
const roots: string[] = []
const newReg = (f: string, platform: NodeJS.Platform = process.platform, deps: ProcDeps = {}) => {
  const r = new PgidRegistry(f, platform, deps)
  registries.push(r)
  return r
}
/** 登记文件只认 0600 的普通文件 */
function writeEntries(f: string, text: string) {
  mkdirSync(join(f, '..'), { recursive: true })
  writeFileSync(f, text, { mode: 0o600 })
  chmodSync(f, 0o600)
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function waitFor(fn: () => boolean, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await sleep(20)
  }
  return fn()
}
const exited = (c: ChildProcess) => c.exitCode !== null || c.signalCode !== null

/** detached:自成一组,pgid = pid */
function spawnGroup(script: string, opts: { detached?: boolean } = {}): ChildProcess {
  const detached = opts.detached ?? true
  const c = spawn('/bin/sh', ['-c', script], { cwd: root, detached, stdio: 'ignore' })
  children.push({ c, detached })
  return c
}
async function grandkid(rel = 'pid'): Promise<number> {
  const f = join(root, rel)
  expect(await waitFor(() => existsSync(f) && readFileSync(f, 'utf8').trim() !== '')).toBe(true)
  const pid = Number(readFileSync(f, 'utf8').trim())
  const start = startTime(pid)
  if (start) grandkids.push({ pid, start })
  return pid
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-pgids-')))
  roots.push(root)
  file = join(root, 'run', 'shell-pgids')
})
afterEach(async () => {
  try {
    for (const r of registries) r.dispose()
  } catch {
    // 继续清理
  }
  registries = []
  // 还没被回收的子进程 pid 不会被复用,它自成的组也还是它的
  for (const { c, detached } of children) {
    if (exited(c) || !c.pid) continue
    try {
      process.kill(detached ? -c.pid : c.pid, 'SIGKILL')
    } catch {
      // 已退
    }
  }
  for (const g of grandkids) {
    try {
      if (startTime(g.pid) === g.start) process.kill(g.pid, 'SIGKILL')
    } catch {
      // 查完之后刚好退了
    }
  }
  await waitFor(() => children.every(x => exited(x.c)), 2000)
  children = []
  grandkids = []
  rmSync(root, { recursive: true, force: true })
})
afterAll(() => {
  // 万一哪次 afterEach 中途抛错:兜底删掉本文件建过的临时目录
  for (const d of roots) rmSync(d, { recursive: true, force: true })
})

describe('startTime', () => {
  it.skipIf(!posix)('is stable for a live pid and undefined for a dead one', async () => {
    const a = startTime(process.pid)
    expect(a).toBeTruthy()
    expect(startTime(process.pid)).toBe(a)
    const c = spawnGroup('exit 0')
    await waitFor(() => exited(c))
    expect(startTime(c.pid!)).toBeUndefined()
  })

  it('win32 → undefined', () => {
    expect(startTime(process.pid, 'win32')).toBeUndefined()
  })
})

describe('parseEntries', () => {
  it('skips garbage, bad pgids and dedupes', () => {
    const text = ['not json', '{"pgid":1,"start":"x"}', '{"pgid":0,"start":"x"}', '{"pgid":-5,"start":"x"}', '{"pgid":12,"start":7}', '{"pgid":12,"start":"a"}', '{"pgid":12,"start":"b","members":[{"pid":13,"start":"c"},{"pid":1,"start":"d"},"x"]}', ''].join('\n')
    expect(parseEntries(text)).toEqual([{ pgid: 12, start: 'b', members: [{ pid: 13, start: 'c' }] }])
  })
})

describe('reapOrphans', () => {
  it('missing file → no-op, nothing created', () => {
    const calls: unknown[] = []
    expect(reapOrphans(file, { kill: (...a) => calls.push(a) })).toEqual({ killed: [], skipped: [] })
    expect(calls).toEqual([])
    expect(existsSync(file)).toBe(false)
  })

  it('garbage file → no signal sent, file emptied', () => {
    const r = newReg(file) // 建目录
    r.clear()
    writeFileSync(file, 'garbage\n{"pgid":"x"}\n\u0000\u0001')
    const calls: unknown[] = []
    expect(reapOrphans(file, { kill: (...a) => calls.push(a) })).toEqual({ killed: [], skipped: [] })
    expect(calls).toEqual([])
    expect(readFileSync(file, 'utf8')).toBe('')
  })

  it.skipIf(!posix)('Review Focus 5: a crashed worker\'s live group is SIGKILLed and the file is emptied', async () => {
    const c = spawnGroup(`sleep 60 & echo $! > pid; wait`)
    const pid = await grandkid()
    const reg = newReg(file)
    reg.add(c.pid!) // 模拟上一个工作进程登记后崩溃:不 settle、不 killLive
    expect(readFileSync(file, 'utf8')).toContain(`"pgid":${c.pid}`)
    const res = reapOrphans(file)
    expect(res).toEqual({ killed: [c.pid], skipped: [] })
    expect(await waitFor(() => !alive(pid), 2000)).toBe(true)
    expect(await waitFor(() => exited(c), 2000)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('')
  })

  it.skipIf(!posix)('Review Focus 5: a reused pid (start mismatch) is never signalled', async () => {
    for (const detached of [true, false]) {
      const c = spawnGroup('sleep 60', { detached })
      await waitFor(() => startTime(c.pid!) !== undefined)
      writeEntries(join(root, 'f'), JSON.stringify({ pgid: c.pid, start: 'bogus' }) + '\n')
      const res = reapOrphans(join(root, 'f'))
      expect(res.killed).toEqual([])
      if (detached) expect(res.skipped).toEqual([c.pid])
      await sleep(100)
      expect(exited(c)).toBe(false)
      expect(alive(c.pid!)).toBe(true)
    }
  })

  it.skipIf(!posix)('leader gone, recorded member still in the group → killed', async () => {
    const c = spawnGroup(`sleep 60 >/dev/null 2>&1 & echo $! > pid`)
    const reg = newReg(file)
    reg.add(c.pid!)
    const pid = await grandkid()
    await waitFor(() => exited(c))
    reg.settle(c.pid!)
    await reg.idle()
    const entry = parseEntries(readFileSync(file, 'utf8'))[0]
    expect(entry.members?.map(m => m.pid)).toEqual([pid])
    expect(reapOrphans(file).killed).toEqual([c.pid])
    expect(await waitFor(() => !alive(pid), 2000)).toBe(true)
  })

  it.skipIf(!posix)('leader gone, no recorded member matches → skipped, group left alone', async () => {
    const c = spawnGroup(`sleep 60 >/dev/null 2>&1 & echo $! > pid`)
    const pid = await grandkid()
    await waitFor(() => exited(c))
    const f = join(root, 'f')
    writeEntries(f, JSON.stringify({ pgid: c.pid, start: 'whatever', members: [{ pid, start: 'bogus' }] }) + '\n')
    expect(reapOrphans(f)).toEqual({ killed: [], skipped: [c.pid] })
    expect(alive(pid)).toBe(true)
    writeEntries(f, JSON.stringify({ pgid: c.pid, start: 'whatever' }) + '\n')
    expect(reapOrphans(f)).toEqual({ killed: [], skipped: [c.pid] })
    expect(alive(pid)).toBe(true)
  })

  it('never signals pid ≤ 1, its own pid or its own group, even when the start time "matches"', () => {
    const own = 4242
    const sent: number[] = []
    const kill: Kill = (pid, sig) => {
      if (sig !== 0) sent.push(pid)
    }
    const f = join(root, 'f')
    const lines = [1, own, process.pid, 777].map(pgid => JSON.stringify({ pgid, start: 'S' }))
    writeEntries(f, ['{"pgid":0,"start":"S"}', '{"pgid":-1,"start":"S"}', ...lines].join('\n'))
    const res = reapOrphans(f, { kill, startTime: () => 'S', ownPgid: () => own, groupMembers: () => [] })
    expect(sent).toEqual([-777])
    expect(res).toEqual({ killed: [777], skipped: [own, process.pid] })
  })

  it('own group unknown → sends nothing', () => {
    const sent: number[] = []
    const f = join(root, 'f')
    writeEntries(f, JSON.stringify({ pgid: 777, start: 'S' }) + '\n')
    const res = reapOrphans(f, { kill: (pid, sig) => void (sig !== 0 && sent.push(pid)), startTime: () => 'S', ownPgid: () => undefined })
    expect(sent).toEqual([])
    expect(res.skipped).toEqual([777])
  })

  it('win32 → no-op', () => {
    const f = join(root, 'f')
    writeEntries(f, JSON.stringify({ pgid: 777, start: 'S' }) + '\n')
    const sent: unknown[] = []
    expect(reapOrphans(f, { platform: 'win32', kill: (...a) => sent.push(a), startTime: () => 'S' })).toEqual({ killed: [], skipped: [] })
    expect(sent).toEqual([])
  })
})

describe('PgidRegistry', () => {
  it.skipIf(!posix)('file is written atomically with mode 0600; a dead group is removed on settle', async () => {
    const reg = newReg(file)
    const c = spawnGroup('exit 0')
    reg.add(c.pid!)
    expect(parseEntries(readFileSync(file, 'utf8')).map(e => e.pgid)).toEqual([c.pid])
    expect(statSync(file).mode & 0o777).toBe(0o600)
    await waitFor(() => exited(c))
    reg.settle(c.pid!)
    expect(readFileSync(file, 'utf8')).toBe('')
    expect(reg.live()).toEqual([])
  })

  it.skipIf(!posix)('a group with a live background job stays registered; killLive ends it', async () => {
    const reg = newReg(file)
    const c = spawnGroup(`sleep 60 >/dev/null 2>&1 & echo $! > pid`)
    reg.add(c.pid!)
    const pid = await grandkid()
    await waitFor(() => exited(c))
    reg.settle(c.pid!)
    await reg.idle()
    expect(parseEntries(readFileSync(file, 'utf8')).map(e => e.pgid)).toEqual([c.pid])
    expect(reg.live()).toEqual([c.pid])
    await killLive(reg, 1000)
    expect(await waitFor(() => !alive(pid), 2000)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('')
  })

  it.skipIf(!posix)('killLive SIGKILLs a group that ignores SIGTERM after the grace period', async () => {
    const reg = newReg(file)
    const c = spawnGroup(`trap '' TERM; sleep 60 & echo $! > pid; wait`)
    reg.add(c.pid!)
    const pid = await grandkid()
    const t0 = Date.now()
    await killLive(reg, 300)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250)
    expect(await waitFor(() => !alive(pid) && exited(c), 2000)).toBe(true)
  })

  it('signal() refuses groups it never recorded', () => {
    const sent: unknown[] = []
    const reg = newReg(file, 'linux', { kill: (...a) => sent.push(a), startTime: () => 'S', ownPgid: () => 4242 })
    expect(reg.signal(777, 'SIGKILL')).toBe(false)
    reg.add(777)
    expect(reg.signal(777, 'SIGKILL')).toBe(true)
    expect(sent).toEqual([[-777, 'SIGKILL']])
  })

  it('errors are swallowed and logged', () => {
    writeFileSync(join(root, 'blocker'), '')
    const warns: string[] = []
    const reg = newReg(join(root, 'blocker', 'sub', 'f'), 'linux', { startTime: () => 'S', kill: () => true, log: { warn: m => warns.push(m) } })
    expect(() => reg.add(777)).not.toThrow()
    expect(() => reg.settle(777)).not.toThrow()
    expect(() => reg.clear()).not.toThrow()
    expect(warns.length).toBeGreaterThan(0)
  })

  it.skipIf(!posix)('groupMembers / ownPgid read the real process table', async () => {
    const c = spawnGroup(`sleep 60 & echo $! > pid; wait`)
    const pid = await grandkid()
    expect(groupMembers(c.pid!).map(m => m.pid).sort()).toEqual([c.pid, pid].sort())
    expect(groupMembers(c.pid!).find(m => m.pid === pid)?.start).toBe(startTime(pid))
    const own = ownPgid()
    expect(own).toBeGreaterThan(0)
    expect(own).not.toBe(c.pid)
  })
})

describe('review fixes', () => {
  /** 注入的 Linux 进程表:777 组长活着,启动时间 S */
  const fake = (over: ProcDeps = {}) => {
    const sent: number[] = []
    const deps: ProcDeps = {
      kill: (pid, sig) => void (sig !== 0 && sent.push(pid)),
      startTime: () => 'S',
      groupMembers: () => [],
      ownPgid: () => 4242,
      bootId: () => 'B2',
      ...over,
    }
    return { sent, deps }
  }
  const line = (e: object) => JSON.stringify(e) + '\n'

  it('C1: Linux entries from another boot (or without a boot id) are skipped even when the start time matches', () => {
    const f = join(root, 'f')
    const { sent, deps } = fake()
    writeEntries(f, line({ pgid: 777, start: 'S', boot: 'B1' }) + line({ pgid: 778, start: 'S' }) + line({ pgid: 779, start: 'S', boot: 'B2' }))
    const res = reapOrphans(f, { platform: 'linux', ...deps })
    expect(sent).toEqual([-779])
    expect(res).toEqual({ killed: [779], skipped: [777, 778] })
    expect(readFileSync(f, 'utf8')).toBe('')
  })

  it('C1: current boot id unreadable on Linux → nothing signalled', () => {
    const f = join(root, 'f')
    const { sent, deps } = fake({ bootId: () => undefined })
    writeEntries(f, line({ pgid: 779, start: 'S', boot: 'B2' }))
    expect(reapOrphans(f, { platform: 'linux', ...deps }).killed).toEqual([])
    expect(sent).toEqual([])
  })

  it('C1: the registry records the boot id', () => {
    const reg = newReg(file, 'linux', fake().deps)
    reg.add(777)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ pgid: 777, start: 'S', boot: 'B2' })
  })

  it.skipIf(process.platform !== 'linux')('C1: bootId reads the kernel boot id', () => {
    expect(bootId('linux')).toMatch(/^[0-9a-f-]{36}$/)
  })

  it.skipIf(!posix)('I1: members are refreshed while the command runs, so a crash after the leader exits still reaps', async () => {
    const reg = newReg(file, process.platform, { refreshMs: 100 })
    const c = spawnGroup(`sleep 60 >/dev/null 2>&1 & echo $! > pid; sleep 0.5; exit`)
    reg.add(c.pid!) // 不 settle:工作进程在命令跑着时崩了
    const pid = await grandkid()
    expect(await waitFor(() => exited(c), 3000)).toBe(true)
    await reg.idle()
    reg.dispose()
    expect(parseEntries(readFileSync(file, 'utf8'))[0].members?.map(m => m.pid)).toContain(pid)
    expect(reapOrphans(file).killed).toEqual([c.pid])
    expect(await waitFor(() => !alive(pid), 2000)).toBe(true)
  })

  it('I1: one listing per tick covers every running command; settled groups stop refreshing', async () => {
    const calls: number[][] = []
    const { deps } = fake({
      refreshMs: 30,
      listMembers: async pgids => {
        calls.push([...pgids])
        return new Map(pgids.map(g => [g, [{ pid: g + 1, start: 'M' }]]))
      },
    })
    const reg = newReg(file, 'linux', deps)
    reg.add(777)
    reg.add(888)
    expect(await waitFor(() => calls.length >= 1, 1000)).toBe(true)
    expect(calls[0].sort()).toEqual([777, 888])
    await reg.idle()
    expect(parseEntries(readFileSync(file, 'utf8')).map(e => e.members)).toEqual([[{ pid: 778, start: 'M' }], [{ pid: 889, start: 'M' }]])
    reg.settle(777)
    reg.settle(888)
    await reg.idle()
    const n = calls.length
    await sleep(120)
    expect(calls.length).toBe(n)
  })

  it('M2: a symlinked or loosely-permissioned registry file is refused', () => {
    const { sent, deps } = fake()
    const real = join(root, 'real')
    writeEntries(real, line({ pgid: 779, start: 'S', boot: 'B2' }))
    const link = join(root, 'link')
    symlinkSync(real, link)
    expect(reapOrphans(link, { platform: 'linux', ...deps })).toEqual({ killed: [], skipped: [] })
    chmodSync(real, 0o644)
    expect(reapOrphans(real, { platform: 'linux', ...deps })).toEqual({ killed: [], skipped: [] })
    expect(sent).toEqual([])
    expect(readFileSync(real, 'utf8')).not.toBe('') // 不认的文件不动
  })

  it('M3: an entry that could not be checked (ps failed) is kept for the next start', () => {
    const f = join(root, 'f')
    writeEntries(f, line({ pgid: 779, start: 'S', boot: 'B2' }))
    const broken = fake({ startTime: () => { throw new Error('ps timed out') } })
    expect(reapOrphans(f, { platform: 'linux', ...broken.deps })).toEqual({ killed: [], skipped: [779] })
    expect(parseEntries(readFileSync(f, 'utf8')).map(e => e.pgid)).toEqual([779])
    const ok = fake()
    expect(reapOrphans(f, { platform: 'linux', ...ok.deps }).killed).toEqual([779])
    expect(readFileSync(f, 'utf8')).toBe('')
  })

  it('M6: stale temp files next to the registry are removed on reap', () => {
    writeEntries(file, '')
    const dir = join(file, '..')
    writeFileSync(join(dir, 'shell-pgids.12345.tmp'), 'x')
    writeFileSync(join(dir, 'other.tmp'), 'x')
    reapOrphans(file, { platform: 'linux', ...fake().deps })
    expect(readdirSync(dir).sort()).toEqual(['other.tmp', 'shell-pgids'])
  })
})
