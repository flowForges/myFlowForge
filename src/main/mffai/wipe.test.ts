import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dataRoots, secretsAccountOf, SECRETS_SERVICE } from '@mffai/protocol'
import { wipeData, type WipeDeps } from './wipe'

const HOME = '/home/u'
const DIR = '/home/u/.myFlowForge/mff-ai'

function deps(over: Partial<WipeDeps> = {}) {
  const removed: string[] = []
  const runs: Array<[string, string[]]> = []
  const d: WipeDeps = {
    dataDir: DIR,
    enabled: false,
    platform: 'darwin',
    home: HOME,
    controlAlive: vi.fn(async () => false),
    rm: vi.fn(async (p: string) => { removed.push(p) }),
    exists: vi.fn(() => true),
    run: vi.fn(async (cmd: string, args: string[]) => { runs.push([cmd, args]); return 0 }),
    ...over,
  }
  return { d, removed, runs }
}

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

  it('a dataDir equal to MFFAI_DATA_DIR is accepted whatever its last segment, but never / or $HOME', async () => {
    const ok = deps({ dataDir: '/tmp/side/data', envDataDir: '/tmp/side/data' })
    expect(await wipeData(ok.d)).toMatchObject({ ok: true })
    for (const dataDir of ['/', HOME, 'rel/data']) {
      const t = deps({ dataDir, envDataDir: dataDir })
      expect(await wipeData(t.d), dataDir).toEqual({ ok: false, reason: 'bad_path' })
      expect(t.removed).toEqual([])
    }
    // MFFAI_DATA_DIR set to something else does not widen the rule
    const other = deps({ dataDir: '/tmp/side/data', envDataDir: '/tmp/side/other' })
    expect(await wipeData(other.d)).toEqual({ ok: false, reason: 'bad_path' })
  })
})

describe('wipeData removal', () => {
  it('removes exactly the four dataRoots, then the keychain entry on darwin; never the shared probe account', async () => {
    const t = deps()
    const r = await wipeData(t.d)
    const roots = dataRoots(DIR)
    expect(t.removed).toEqual([roots.data, roots.worktrees, roots.imWorktrees, roots.plugins])
    expect(t.removed).toEqual([DIR, `${DIR}-worktrees`, `${DIR}-im-worktrees`, `${DIR}-plugins`])
    const acct = secretsAccountOf(DIR)
    expect(t.runs).toEqual([['security', ['delete-generic-password', '-a', acct, '-s', SECRETS_SERVICE]]])
    expect(SECRETS_SERVICE).toBe('myflowforge-mffai')
    expect(JSON.stringify(t.runs)).not.toContain('mffai-probe')
    expect(r).toEqual({ ok: true, removed: [...t.removed, `${SECRETS_SERVICE}/${acct}`] })
  })

  it('linux runs secret-tool clear; a missing entry still counts as done', async () => {
    const t = deps({ platform: 'linux', run: vi.fn(async (cmd: string, args: string[]) => { t.runs.push([cmd, args]); return 1 }) })
    const r = await wipeData(t.d)
    expect(t.runs).toEqual([['secret-tool', ['clear', 'service', SECRETS_SERVICE, 'account', secretsAccountOf(DIR)]]])
    expect(r).toMatchObject({ ok: true })
    expect((r as { removed: string[] }).removed).not.toContain(`${SECRETS_SERVICE}/${secretsAccountOf(DIR)}`)
  })

  it('darwin: "not found" (44) is fine and not listed; a missing security binary does not fail the wipe', async () => {
    const nf = deps({ run: vi.fn(async () => 44) })
    expect(await wipeData(nf.d)).toEqual({ ok: true, removed: [DIR, `${DIR}-worktrees`, `${DIR}-im-worktrees`, `${DIR}-plugins`] })
    const gone = deps({ run: vi.fn(async () => { throw Object.assign(new Error('spawn security ENOENT'), { code: 'ENOENT' }) }) })
    expect(await wipeData(gone.d)).toMatchObject({ ok: true })
  })

  it('win32 runs nothing (the DPAPI blob lives in the data dir)', async () => {
    const t = deps({ platform: 'win32', dataDir: 'C:\\Users\\u\\.myFlowForge\\mff-ai', home: 'C:\\Users\\u' })
    const r = await wipeData(t.d)
    expect(t.runs).toEqual([])
    expect(t.removed).toEqual(Object.values(dataRoots('C:\\Users\\u\\.myFlowForge\\mff-ai')))
    expect(r).toMatchObject({ ok: true })
  })

  it('a root that does not exist is skipped and not listed', async () => {
    const t = deps({ exists: (p: string) => p === DIR })
    const r = await wipeData(t.d)
    expect(t.removed).toEqual([DIR])
    expect(r).toEqual({ ok: true, removed: [DIR, `${SECRETS_SERVICE}/${secretsAccountOf(DIR)}`] })
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
      dataDir: dir, enabled: false, platform: process.platform, home: join(base, 'home'),
      controlAlive: async () => false, rm: (p) => rm(p, { recursive: true, force: true }), exists: lexists, run: async () => 1,
    })
    expect(r).toEqual({ ok: true, removed: [roots.data, roots.worktrees, roots.imWorktrees, roots.plugins] })
    for (const p of Object.values(roots)) expect(lexists(p), p).toBe(false)
    expect(readFileSync(join(target, 'precious'), 'utf8')).toBe('p')
    expect(existsSync(join(base, 'mff-ai-other'))).toBe(true)
    expect(existsSync(join(base, 'mff-ai-worktrees2'))).toBe(true)
  })
})
