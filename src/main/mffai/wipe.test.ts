import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { autostartIds, dataRoots, secretsAccountOf, SECRETS_SERVICE } from '@mffai/protocol'
import { anyRootExists, launchdLabelOf, probeControl, wipeData, type WipeDeps } from './wipe'

const HOME = '/home/u'
const DIR = '/home/u/.myFlowForge/mff-ai'
const TMP = '/var/tmp-sys'
const PLIST = '/home/u/Library/LaunchAgents/com.myflowforge.mffai.plist'
const SECURITY = '/usr/bin/security'

function deps(over: Partial<WipeDeps> = {}) {
  const removed: string[] = []
  const runs: Array<[string, string[]]> = []
  const d: WipeDeps = {
    dataDir: DIR,
    enabled: false,
    platform: 'darwin',
    home: HOME,
    tmpDir: TMP,
    controlAlive: vi.fn(async () => false),
    rm: vi.fn(async (p: string) => { removed.push(p) }),
    exists: vi.fn(() => true),
    run: vi.fn(async (cmd: string, args: string[]) => { runs.push([cmd, args]); return 0 }),
    ...over,
  }
  return { d, removed, runs }
}

/** 删除顺序:三个兄弟根在前,数据根最后(失败一半时 dataExists 仍为真,标记也还在) */
const ROOTS_IN_ORDER = (dir: string) => { const r = dataRoots(dir); return [r.worktrees, r.imWorktrees, r.plugins, r.data] }

describe('wipeData guards', () => {
  it('refuses while enabled, without asking the control port or touching anything', async () => {
    const t = deps({ enabled: true })
    expect(await wipeData(t.d)).toEqual({ ok: false, reason: 'enabled' })
    expect(t.d.controlAlive).not.toHaveBeenCalled()
    expect(t.removed).toEqual([])
    expect(t.runs).toEqual([])
  })

  it('refuses while the control port answers', async () => {
    const t = deps({ controlAlive: vi.fn(async () => true) })
    expect(await wipeData(t.d)).toEqual({ ok: false, reason: 'running' })
    expect(t.removed).toEqual([])
    expect(t.runs).toEqual([])
  })

  it('refuses /, $HOME, relative paths, dot segments and a last segment other than mff-ai', async () => {
    for (const dataDir of ['/', HOME, `${HOME}/`, '.myFlowForge/mff-ai', 'mff-ai', '/home/u/.myFlowForge/other',
      '/home/u/.myFlowForge/mff-ai/..', '/home/u/x/../mff-ai', '', '/home/u/.myFlowForge/mff-ai-x', '/home/u/.myFlowForge/mff-ai/']) {
      const t = deps({ dataDir })
      expect(await wipeData(t.d), dataDir).toEqual({ ok: false, reason: 'bad_path' })
      expect(t.removed).toEqual([])
      expect(t.runs).toEqual([])
      expect(t.d.controlAlive).not.toHaveBeenCalled()
    }
  })

  it('a dataDir equal to MFFAI_DATA_DIR is accepted whatever its last segment, but never /, $HOME, ~/.myFlowForge, the temp dir or their ancestors', async () => {
    const ok = deps({ dataDir: '/srv/side/data', envDataDir: '/srv/side/data' })
    expect(await wipeData(ok.d)).toMatchObject({ ok: true })
    for (const dataDir of ['/', HOME, 'rel/data', '/home/u/.myFlowForge', '/home', TMP, '/var', '/HOME/U/.MYFLOWFORGE']) {
      const t = deps({ dataDir, envDataDir: dataDir })
      expect(await wipeData(t.d), dataDir).toEqual({ ok: false, reason: 'bad_path' })
      expect(t.removed).toEqual([])
    }
    // MFFAI_DATA_DIR set to something else does not widen the rule
    const other = deps({ dataDir: '/srv/side/data', envDataDir: '/srv/side/other' })
    expect(await wipeData(other.d)).toEqual({ ok: false, reason: 'bad_path' })
  })

  it('the MFFAI_DATA_DIR exemption needs a db/ or run/ marker in an existing data root', async () => {
    const dir = '/srv/side/data'
    const noMarker = deps({ dataDir: dir, envDataDir: dir, exists: (p: string) => !p.endsWith('/db') && !p.endsWith('/run') })
    expect(await wipeData(noMarker.d)).toEqual({ ok: false, reason: 'bad_path' })
    expect(noMarker.removed).toEqual([])
    const runOnly = deps({ dataDir: dir, envDataDir: dir, exists: (p: string) => !p.endsWith('/db') })
    expect(await wipeData(runOnly.d)).toMatchObject({ ok: true })
    expect(runOnly.removed).toContain(dir)
    // data root already gone (an earlier partial wipe): the siblings still go
    const gone = deps({ dataDir: dir, envDataDir: dir, exists: (p: string) => p !== dir && !p.startsWith(`${dir}/`) })
    expect(await wipeData(gone.d)).toMatchObject({ ok: true })
    expect(gone.removed).toEqual(ROOTS_IN_ORDER(dir).slice(0, 3))
  })
})

describe('wipeData removal', () => {
  it('removes the four dataRoots (data root last), the LaunchAgent plist and the keychain entry on darwin; never the probe account', async () => {
    const t = deps()
    const r = await wipeData(t.d)
    expect(t.removed).toEqual([...ROOTS_IN_ORDER(DIR), PLIST])
    expect(t.removed.slice(0, 4).sort()).toEqual(Object.values(dataRoots(DIR)).sort())
    const acct = secretsAccountOf(DIR)
    expect(t.runs).toEqual([[SECURITY, ['delete-generic-password', '-a', acct, '-s', SECRETS_SERVICE]]])
    expect(SECRETS_SERVICE).toBe('myflowforge-mffai')
    expect(JSON.stringify(t.runs)).not.toContain('mffai-probe')
    expect(r).toEqual({ ok: true, removed: [...t.removed, `${SECRETS_SERVICE}/${acct}`] })
  })

  it('the plist goes only when present, only on darwin, and only for the default data dir (Task 15 derives other labels)', async () => {
    expect(launchdLabelOf(DIR, HOME)).toBe('com.myflowforge.mffai')
    expect(launchdLabelOf('/srv/side/data', HOME)).toBe(`com.myflowforge.mffai.${secretsAccountOf('/srv/side/data')}`)
    const absent = deps({ exists: (p: string) => p !== PLIST })
    await wipeData(absent.d)
    expect(absent.removed).not.toContain(PLIST)
    const side = deps({ dataDir: '/srv/side/data', envDataDir: '/srv/side/data' })
    await wipeData(side.d)
    expect(side.removed.some((p) => p.includes('LaunchAgents'))).toBe(false)
    const linux = deps({ platform: 'linux' })
    await wipeData(linux.d)
    expect(linux.removed.some((p) => p.includes('LaunchAgents'))).toBe(false)
  })

  it('the ownership predicate and the default label come from @mffai/protocol, not a copy here (M4)', () => {
    const src = readFileSync(join(__dirname, 'wipe.ts'), 'utf8')
    expect(src).toContain('launchdPlistOwnedBy')
    expect(src).not.toContain("'com.myflowforge.mffai'")
    expect(src).not.toMatch(/xmlEsc/)
  })

  it('with readFile given (ipc.ts always gives it), each data dir removes only its own derived plist, and only when it names this data dir (Task 15)', async () => {
    const plist = (dir: string) => `<dict>\n  <key>MFFAI_DATA_DIR</key>\n    <string>${dir.replace(/&/g, '&amp;')}</string>\n</dict>`
    const SIDE = '/srv/side/mff-ai'
    expect(launchdLabelOf(SIDE, HOME)).toBe(autostartIds(SIDE, HOME).launchd)
    const SIDE_PLIST = `/home/u/Library/LaunchAgents/com.myflowforge.mffai.${secretsAccountOf(SIDE)}.plist`
    const side = deps({ dataDir: SIDE, readFile: (p: string) => (p === SIDE_PLIST ? plist(SIDE) : p === PLIST ? plist(DIR) : undefined) })
    await wipeData(side.d)
    expect(side.removed.filter((p) => p.includes('LaunchAgents'))).toEqual([SIDE_PLIST])
    const ours = deps({ readFile: (p: string) => (p === PLIST ? plist(DIR) : undefined) })
    await wipeData(ours.d)
    expect(ours.removed).toContain(PLIST)
    const other = deps({ readFile: () => plist('/home/u/.myFlowForge-test/mff-ai') })
    await wipeData(other.d)
    expect(other.removed).not.toContain(PLIST)
    const unreadable = deps({ readFile: () => undefined })
    await wipeData(unreadable.d)
    expect(unreadable.removed).not.toContain(PLIST)
    const amp = '/home/u/R&D/mff-ai'
    const ampPlist = `/home/u/Library/LaunchAgents/${autostartIds(amp, HOME).launchd}.plist`
    const esc = deps({ dataDir: amp, readFile: (p: string) => (p === ampPlist ? plist(amp) : undefined) })
    await wipeData(esc.d)
    expect(esc.removed).toContain(ampPlist)
    const linux = deps({ platform: 'linux', readFile: () => plist(DIR) })
    await wipeData(linux.d)
    expect(linux.removed.some((p) => p.includes('LaunchAgents'))).toBe(false)
  })

  it('MFFAI_DATA_DIR may not be the app data dir (sysDir) or its parent (Task 15)', async () => {
    const sys = '/home/u/.myFlowForge-test'
    for (const dir of [sys, '/home/u/.myFlowForge-test/']) {
      const t = deps({ dataDir: dir, envDataDir: dir, sysDir: sys })
      expect(await wipeData(t.d)).toEqual({ ok: false, reason: 'bad_path' })
      expect(t.removed).toEqual([])
    }
    const inside = '/home/u/.myFlowForge-test/side'
    const ok = deps({ dataDir: inside, envDataDir: inside, sysDir: sys })
    expect(await wipeData(ok.d)).toMatchObject({ ok: true })
  })

  it('linux runs secret-tool from a fixed system path; a missing entry still counts as done; none installed → nothing runs', async () => {
    const t = deps({ platform: 'linux', exists: (p: string) => p !== '/usr/bin/secret-tool', run: vi.fn(async (cmd: string, args: string[]) => { t.runs.push([cmd, args]); return 1 }) })
    const r = await wipeData(t.d)
    expect(t.runs).toEqual([['/usr/local/bin/secret-tool', ['clear', 'service', SECRETS_SERVICE, 'account', secretsAccountOf(DIR)]]])
    expect(r).toMatchObject({ ok: true })
    expect((r as { removed: string[] }).removed).not.toContain(`${SECRETS_SERVICE}/${secretsAccountOf(DIR)}`)
    const none = deps({ platform: 'linux', exists: (p: string) => !p.endsWith('/secret-tool') })
    await wipeData(none.d)
    expect(none.runs).toEqual([])
  })

  it('darwin: "not found" (44) is fine and not listed; a failing security does not fail the wipe', async () => {
    const nf = deps({ run: vi.fn(async () => 44) })
    expect(await wipeData(nf.d)).toEqual({ ok: true, removed: [...ROOTS_IN_ORDER(DIR), PLIST] })
    const gone = deps({ run: vi.fn(async () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }) })
    expect(await wipeData(gone.d)).toMatchObject({ ok: true })
  })

  it('win32 runs nothing (the DPAPI blob lives in the data dir)', async () => {
    const t = deps({ platform: 'win32', dataDir: 'C:\\Users\\u\\.myFlowForge\\mff-ai', home: 'C:\\Users\\u', tmpDir: 'C:\\Users\\u\\AppData\\Local\\Temp' })
    const r = await wipeData(t.d)
    expect(t.runs).toEqual([])
    expect(t.removed).toEqual(ROOTS_IN_ORDER('C:\\Users\\u\\.myFlowForge\\mff-ai'))
    expect(r).toMatchObject({ ok: true })
  })

  it('a root that does not exist is skipped and not listed', async () => {
    const t = deps({ exists: (p: string) => p === DIR, run: vi.fn(async () => 0) })
    const r = await wipeData(t.d)
    expect(t.removed).toEqual([DIR])
    expect(r).toEqual({ ok: true, removed: [DIR, `${SECRETS_SERVICE}/${secretsAccountOf(DIR)}`] })
  })

  it('anyRootExists is true while any of the four roots is left', () => {
    const r = dataRoots(DIR)
    expect(anyRootExists(DIR, () => false)).toBe(false)
    for (const p of Object.values(r)) expect(anyRootExists(DIR, (x) => x === p), p).toBe(true)
  })
})

describe('probeControl (fails closed)', () => {
  const refused = (code: string) => Object.assign(new Error(`connect ${code}`), { code })
  function probe(over: Partial<Parameters<typeof probeControl>[0]> = {}) {
    const d = {
      call: vi.fn(async (): Promise<unknown> => { throw refused('ECONNREFUSED') }),
      connect: vi.fn(async () => { throw refused('ECONNREFUSED') }),
      supervisorPid: vi.fn((): number | undefined => undefined),
      isAlive: vi.fn((_pid: number) => false),
      ...over,
    }
    return { d, alive: () => probeControl(d) }
  }

  it('nothing listening (ECONNREFUSED / ENOENT, incl. a win32 pipe) and no live supervisor pid → not alive', async () => {
    expect(await probe().alive()).toBe(false)
    expect(await probe({ call: vi.fn(async () => { throw refused('ENOENT') }) }).alive()).toBe(false)
  })

  it('a live pid in supervisor.json → alive, without asking the port', async () => {
    const t = probe({ supervisorPid: () => 4242, isAlive: (p) => p === 4242 })
    expect(await t.alive()).toBe(true)
    expect(t.d.call).not.toHaveBeenCalled()
    expect(await probe({ supervisorPid: () => 4242, isAlive: () => false }).alive()).toBe(false)
  })

  it('a stall, connection closed, unauthorized or any other error → alive', async () => {
    for (const msg of ['timeout', 'connection closed', 'unauthorized', 'EPIPE', 'weird']) {
      expect(await probe({ call: vi.fn(async () => { throw new Error(msg) }) }).alive(), msg).toBe(true)
    }
    expect(await probe({ call: vi.fn(async () => { throw refused('EACCES') }) }).alive()).toBe(true)
    expect(await probe({ call: vi.fn(async () => ({ state: 'running' })) }).alive()).toBe(true)
  })

  it('a garbage or missing token: probes the socket itself; it answering (or stalling) → alive, refused → not', async () => {
    const noToken = vi.fn(async () => { throw new Error('no token') })
    expect(await probe({ call: noToken, connect: vi.fn(async () => {}) }).alive()).toBe(true)
    expect(await probe({ call: noToken, connect: vi.fn(async () => { throw new Error('timeout') }) }).alive()).toBe(true)
    expect(await probe({ call: noToken, connect: vi.fn(async () => { throw refused('ENOENT') }) }).alive()).toBe(false)
  })
})

describe('wipeData on a real temp dir', () => {
  let base: string | undefined
  afterEach(() => { if (base) rmSync(base, { recursive: true, force: true }); base = undefined })

  const lexists = (p: string) => { try { lstatSync(p); return true } catch { return false } }

  it('removes the roots; a root that is a symlink is removed as a link and its target survives; siblings stay', async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-wipe-')))
    const dir = join(base, 'mff-ai')
    const roots = dataRoots(dir)
    mkdirSync(join(dir, 'db'), { recursive: true })
    writeFileSync(join(dir, 'db', 'events.sqlite'), 'x')
    mkdirSync(join(roots.worktrees, 'r1'), { recursive: true })
    // the plugins root is a symlink to a directory the user cares about
    const target = join(base, 'keep-me')
    mkdirSync(target)
    writeFileSync(join(target, 'precious'), 'p')
    symlinkSync(target, roots.plugins, 'dir')
    // the im-worktrees root is a dangling symlink: still removed
    symlinkSync(join(base, 'nowhere'), roots.imWorktrees, 'dir')
    // neighbours that only look alike
    mkdirSync(join(base, 'mff-ai-other'))
    mkdirSync(join(base, 'mff-ai-worktrees2'))

    const r = await wipeData({
      dataDir: dir, enabled: false, platform: process.platform, home: join(base, 'home'), tmpDir: join(base, 'tmp'),
      controlAlive: async () => false, rm: (p) => rm(p, { recursive: true, force: true }), exists: lexists, run: async () => 1,
    })
    expect(r).toEqual({ ok: true, removed: ROOTS_IN_ORDER(dir) })
    for (const p of Object.values(roots)) expect(lexists(p), p).toBe(false)
    expect(readFileSync(join(target, 'precious'), 'utf8')).toBe('p')
    expect(existsSync(join(base, 'mff-ai-other'))).toBe(true)
    expect(existsSync(join(base, 'mff-ai-worktrees2'))).toBe(true)
  })
})
