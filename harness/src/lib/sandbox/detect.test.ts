import { describe, expect, it } from 'vitest'
import { BWRAP_PROBE, DARWIN_PROBE, detectSandbox, findBwrap, trustedBwrap, type BwrapFs, type RunFn } from './detect'

/** 按 (file, 是否带 --unshare-net) 给退出码;记下每次调用 */
function fakeRun(codes: { darwin?: number | Error; net?: number | Error; noNet?: number | Error }) {
  const calls: { file: string; args: string[]; timeoutMs: number }[] = []
  const run: RunFn = async (file, args, timeoutMs) => {
    calls.push({ file, args, timeoutMs })
    const c = file === '/usr/bin/sandbox-exec' ? codes.darwin : args.includes('--unshare-net') ? codes.net : codes.noNet
    if (c instanceof Error) throw c
    return c ?? 1
  }
  return { run, calls }
}

describe('detectSandbox (spec §7)', () => {
  it('darwin: probe exits 0 → full, with the exact probe argv and a 3 s timeout', async () => {
    const f = fakeRun({ darwin: 0 })
    expect(await detectSandbox({ platform: 'darwin', enabled: true, run: f.run })).toEqual({ level: 'full', missing: [] })
    expect(f.calls).toEqual([{ file: '/usr/bin/sandbox-exec', args: ['-p', '(version 1)(allow default)', '/usr/bin/true'], timeoutMs: 3000 }])
    expect(DARWIN_PROBE).toEqual(['-p', '(version 1)(allow default)', '/usr/bin/true'])
  })

  it('darwin: nested sandbox (exit 71), any other failure, or a spawn error → none + sandbox-exec', async () => {
    for (const c of [71, 1, new Error('ENOENT')]) {
      expect(await detectSandbox({ platform: 'darwin', enabled: true, run: fakeRun({ darwin: c }).run })).toEqual({ level: 'none', missing: ['sandbox-exec'] })
    }
  })

  it('linux: probe with --unshare-net passes → full, using the bwrap path found', async () => {
    const f = fakeRun({ net: 0 })
    const r = await detectSandbox({ platform: 'linux', enabled: true, run: f.run, findBwrap: () => '/opt/bin/bwrap' })
    expect(r).toEqual({ level: 'full', missing: [], bwrap: '/opt/bin/bwrap' })
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0].file).toBe('/opt/bin/bwrap')
    expect(f.calls[0].timeoutMs).toBe(3000)
  })

  it('linux: the probe uses the real flag set (R10, Task 8 M7)', async () => {
    const f = fakeRun({ net: 0 })
    await detectSandbox({ platform: 'linux', enabled: true, run: f.run, findBwrap: () => '/usr/bin/bwrap' })
    const a = f.calls[0].args
    for (const flag of ['--die-with-parent', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-net', '--proc', '--dev', '--tmpfs', '--setenv', '--unsetenv', '--chdir', '--']) {
      expect(a).toContain(flag)
    }
    expect(a).not.toContain('--new-session') // Task 4:真实参数不带它
    expect(a.slice(a.indexOf('--ro-bind'), a.indexOf('--ro-bind') + 3)).toEqual(['--ro-bind', '/', '/'])
    expect(a.slice(a.indexOf('--proc'), a.indexOf('--proc') + 2)).toEqual(['--proc', '/proc'])
    expect(a.slice(a.indexOf('--'))).toEqual(['--', '/bin/sh', '-c', 'true'])
    expect(BWRAP_PROBE(true)).toEqual(a)
  })

  it('linux: only passes without --unshare-net → partial + netns; the second probe is the same minus that flag', async () => {
    const f = fakeRun({ net: 1, noNet: 0 })
    expect(await detectSandbox({ platform: 'linux', enabled: true, run: f.run, findBwrap: () => '/usr/bin/bwrap' }))
      .toEqual({ level: 'partial', missing: ['netns'], bwrap: '/usr/bin/bwrap' })
    expect(f.calls).toHaveLength(2)
    expect(f.calls[1].args).toEqual(f.calls[0].args.filter(x => x !== '--unshare-net'))
  })

  it('linux: neither passes (or both throw) → none + userns', async () => {
    for (const codes of [{ net: 1, noNet: 1 }, { net: new Error('x'), noNet: new Error('y') }]) {
      expect(await detectSandbox({ platform: 'linux', enabled: true, run: fakeRun(codes).run, findBwrap: () => '/usr/bin/bwrap' }))
        .toEqual({ level: 'none', missing: ['userns'] })
    }
  })

  it('linux: no bwrap → none + bwrap, nothing run', async () => {
    const f = fakeRun({ net: 0 })
    expect(await detectSandbox({ platform: 'linux', enabled: true, run: f.run, findBwrap: () => undefined })).toEqual({ level: 'none', missing: ['bwrap'] })
    expect(f.calls).toEqual([])
  })

  it('win32 and other platforms → none + platform, nothing run', async () => {
    for (const platform of ['win32', 'freebsd'] as const) {
      const f = fakeRun({})
      expect(await detectSandbox({ platform, enabled: true, run: f.run })).toEqual({ level: 'none', missing: ['platform'] })
      expect(f.calls).toEqual([])
    }
  })

  it('sandbox.enabled:false → none + disabled on every platform, nothing run', async () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const f = fakeRun({ darwin: 0, net: 0 })
      expect(await detectSandbox({ platform, enabled: false, run: f.run, findBwrap: () => '/usr/bin/bwrap' })).toEqual({ level: 'none', missing: ['disabled'] })
      expect(f.calls).toEqual([])
    }
  })

  it('the default runner reports the exit code and kills a hung probe at the timeout', async () => {
    const { defaultRun } = await import('./detect')
    expect(await defaultRun('/bin/sh', ['-c', 'exit 3'], 3000)).toBe(3)
    const t = Date.now()
    expect(await defaultRun('/bin/sh', ['-c', 'sleep 10'], 200)).not.toBe(0)
    expect(Date.now() - t).toBeLessThan(2000)
    await expect(defaultRun('/nonexistent/mffai-probe', [], 1000)).rejects.toThrow()
  })
})

describe('findBwrap (review I2)', () => {
  type Node = { uid: number; mode: number; dir?: boolean; link?: string }
  const fsOf = (nodes: Record<string, Node>): BwrapFs => ({
    realpath: p => {
      let cur = p
      for (let i = 0; i < 8 && nodes[cur]?.link; i++) cur = nodes[cur].link!
      if (!nodes[cur]) throw new Error('ENOENT')
      return cur
    },
    stat: p => {
      const n = nodes[p]
      if (!n) throw new Error('ENOENT')
      return { uid: n.uid, mode: n.mode, isFile: () => !n.dir, isDirectory: () => !!n.dir }
    },
  })
  const rootDir = { uid: 0, mode: 0o755, dir: true }
  const sys = { '/': rootDir, '/usr': rootDir, '/usr/bin': rootDir, '/usr/local': rootDir, '/usr/local/bin': rootDir, '/home': rootDir }
  const userBin = { '/home/u': { uid: 1000, mode: 0o755, dir: true }, '/home/u/bin': { uid: 1000, mode: 0o755, dir: true }, '/home/u/bin/bwrap': { uid: 1000, mode: 0o755 } }

  it('prefers /usr/bin/bwrap over a PATH entry that comes first', () => {
    const fs = fsOf({ ...sys, ...userBin, '/usr/bin/bwrap': { uid: 0, mode: 0o755 } })
    expect(findBwrap('/home/u/bin:/usr/bin', fs)).toBe('/usr/bin/bwrap')
  })

  it('then /usr/local/bin/bwrap, then a trusted PATH entry', () => {
    expect(findBwrap('/home/u/bin', fsOf({ ...sys, ...userBin, '/usr/local/bin/bwrap': { uid: 0, mode: 0o755 } }))).toBe('/usr/local/bin/bwrap')
    const opt = { '/opt': rootDir, '/opt/bw': rootDir, '/opt/bw/bwrap': { uid: 0, mode: 0o755 } }
    expect(findBwrap('/home/u/bin:/opt/bw', fsOf({ ...sys, ...userBin, ...opt }))).toBe('/opt/bw/bwrap')
  })

  it('a user-owned bwrap on PATH is never used → none', async () => {
    const fs = fsOf({ ...sys, ...userBin })
    expect(findBwrap('/home/u/bin', fs)).toBeUndefined()
    const run: RunFn = async () => 0
    expect(await detectSandbox({ platform: 'linux', enabled: true, run, findBwrap: () => findBwrap('/home/u/bin', fs) })).toEqual({ level: 'none', missing: ['bwrap'] })
  })

  it('rejects group/other-writable files or directories, non-executables, and links into untrusted dirs; returns the realpath', () => {
    const f = (o: Partial<Node>) => trustedBwrap('/usr/bin/bwrap', fsOf({ ...sys, '/usr/bin/bwrap': { uid: 0, mode: 0o755, ...o } }))
    expect(f({})).toBe('/usr/bin/bwrap')
    expect(f({ mode: 0o775 })).toBeUndefined()
    expect(f({ mode: 0o757 })).toBeUndefined()
    expect(f({ mode: 0o644 })).toBeUndefined()
    expect(f({ uid: 1000 })).toBeUndefined()
    expect(trustedBwrap('/usr/bin/bwrap', fsOf({ ...sys, '/usr/bin': { uid: 0, mode: 0o777, dir: true }, '/usr/bin/bwrap': { uid: 0, mode: 0o755 } }))).toBeUndefined()
    // 链接到用户目录 → 拒;链接到可信位置 → 返回目标
    expect(trustedBwrap('/usr/bin/bwrap', fsOf({ ...sys, ...userBin, '/usr/bin/bwrap': { uid: 0, mode: 0o777, link: '/home/u/bin/bwrap' } }))).toBeUndefined()
    expect(trustedBwrap('/usr/local/bin/bwrap', fsOf({ ...sys, '/usr/local/bin/bwrap': { uid: 0, mode: 0o777, link: '/usr/bin/bwrap' }, '/usr/bin/bwrap': { uid: 0, mode: 0o755 } }))).toBe('/usr/bin/bwrap')
  })

  it('missing everywhere → undefined', () => {
    expect(findBwrap('/nope', fsOf(sys))).toBeUndefined()
  })
})
