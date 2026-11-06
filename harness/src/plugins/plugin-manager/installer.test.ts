// Review Focus 1、5 的 prepare / confirm / 篡改 / 升级这几行。都经真实内核的 RPC。fixture 里的脚本 touch 标记文件:判"不在"
import { spawn as nodeSpawn, execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { alive, call, confirm, eventsOf, gatedSpawn, prepare, refused, settled, snapshot, spySpawn, storeOf, until, withManager } from '../../../test/managerRig'
import { buildPlugin, buildRepo, pluginKernel, type PluginRig, type PluginSpec } from '../../../test/pluginRig'
import { nullLogger } from '../../kernel/log'
import { reapOrphans } from '../../lib/proc/pgids'
import type { PluginManagerOpts } from './index'
import { Installer } from './installer'
import { PluginStore } from './store'

let tmp: string
const rigs: PluginRig[] = []
const pidsToKill: number[] = []
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-installer-')))
})
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close()
  for (const p of pidsToKill.splice(0)) {
    try {
      process.kill(-p, 'SIGKILL')
    } catch {
      /* 已经没了 */
    }
  }
  rmSync(tmp, { recursive: true, force: true })
})

const rig = async (o: PluginManagerOpts = {}, extra: Parameters<typeof pluginKernel>[0] = {}) => {
  const r = await pluginKernel({ ...withManager(o), ...extra })
  rigs.push(r)
  return r
}
let dirs = 0
const plugin = (spec: PluginSpec) => buildPlugin(join(tmp, `p${++dirs}`), spec)
const repoOf = (root: string) => buildRepo(join(tmp, `r${++dirs}`), root)
const simple = (over: Partial<PluginSpec> = {}) => plugin({ format: 'claude', id: 'demo', skills: { s: 'body' }, ...over })
const installed = async (r: PluginRig, path: string, over: Record<string, unknown> = {}) => {
  const st = await prepare(r, { kind: 'path', path })
  expect(st.state).toBe('ready')
  return confirm(r, st, over)
}
const list = async (r: PluginRig) => (await call(r, 'plugins.list')).plugins
const stagingEntries = (r: PluginRig) => (existsSync(join(storeOf(r), '.staging')) ? readdirSync(join(storeOf(r), '.staging')) : [])

// ---------- Review Focus 1 ----------

function evilSpec(marker: string): PluginSpec {
  const touch = (n: string) => `touch ${join(marker, `ran-${n}`)}`
  return {
    format: 'claude',
    id: 'evil',
    skills: { s: { body: `run !\`${touch('skill')}\` now` } },
    commands: { c: `!\`${touch('command')}\`` },
    mcp: { srv: { command: 'sh', args: ['-c', touch('server')] } },
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: touch('hook') }] }] },
    extra: {
      'package.json': JSON.stringify({ name: 'evil', scripts: { preinstall: touch('preinstall'), install: touch('install'), postinstall: touch('postinstall'), prepare: touch('prepare') } }),
      '.husky/pre-commit': { mode: 0o755, text: `#!/bin/sh\n${touch('husky')}\n` },
      Makefile: `all:\n\t${touch('make')}\n`,
      '.gitmodules': `[submodule "x"]\n\tpath = x\n\turl = file://${join(tmp, 'other')}\n`,
      'bin/x': { mode: 0o755, text: `#!/bin/sh\n${touch('bin')}\n` },
      'monitors/monitors.json': JSON.stringify([{ name: 'm', command: touch('monitor') }]),
      'workflows/a.js': `require('child_process').execSync(${JSON.stringify(touch('workflow'))})`,
      '.gitattributes': '* filter=evil\n',
    },
  }
}

describe('nothing from a plugin runs', () => {
  it.each(['path', 'git'] as const)('evil fixture through prepare, status, confirm, setEnabled, restart, get (%s): no marker; only git is spawned', async kind => {
    const marker = join(tmp, 'markers')
    mkdirSync(marker)
    const root = plugin(evilSpec(marker))
    const spawned: string[][] = []
    const r = await rig({ spawn: spySpawn(spawned) })
    let source
    if (kind === 'git') {
      const { url } = repoOf(root)
      const repo = url.slice('file://'.length)
      // 仓库自己的配置想把钩子、过滤器指过来:拉取端不看对方的配置
      const hook = join(repo, 'evil-hook.sh')
      writeFileSync(hook, `#!/bin/sh\ntouch ${join(marker, 'ran-config')}\n`)
      chmodSync(hook, 0o755)
      appendFileSync(join(repo, '.git', 'config'), `[core]\n\thooksPath = ${repo}\n\tfsmonitor = ${hook}\n[filter "evil"]\n\tsmudge = ${hook}\n\tclean = ${hook}\n\trequired = true\n`)
      source = { kind: 'git' as const, url }
    } else {
      source = { kind: 'path' as const, path: root }
    }
    const st = await prepare(r, source)
    expect(st.state).toBe('ready')
    expect(st.consent!.notRun.scripts.join(' ')).toContain('postinstall')
    expect(st.consent!.notRun.hooks.map(h => h.event)).toEqual(['SessionStart'])
    expect(st.consent!.notRun.hooks[0].command).toContain('touch')
    expect(st.consent!.warnings).toEqual(expect.arrayContaining(['hooks_not_run', 'shell_in_text']))
    await confirm(r, st, { enable: false })
    await call(r, 'plugins.setEnabled', { commandId: `en-${kind}`, id: 'evil', enabled: true })
    await r.restart()
    await call(r, 'plugins.get', { id: 'evil' })
    expect(readdirSync(marker)).toEqual([])
    if (kind === 'path') expect(spawned).toEqual([])
    else expect(spawned.length).toBeGreaterThan(0)
    expect(spawned.every(c => c[0] === 'git')).toBe(true)
  })

  it('a manifest main is listed as not run, and the skills next to it still install', async () => {
    const r = await rig()
    const st = await prepare(r, { kind: 'path', path: plugin({ format: 'native', id: 'has-main', skills: { s: 'x' }, manifest: { main: './dist/p.mjs' }, extra: { 'dist/p.mjs': 'throw new Error("ran")' } }) })
    expect(st.state).toBe('ready')
    expect(st.consent!.notRun.main).toBe('./dist/p.mjs')
  })

  it('a local source with a hostile .git/config spawns no git and copies no .git; a nested sub/.git is not walked either', async () => {
    const marker = join(tmp, 'markers')
    mkdirSync(marker)
    const root = simple()
    const evil = join(tmp, 'evil.sh')
    writeFileSync(evil, `#!/bin/sh\ntouch ${join(marker, 'ran')}\n`)
    chmodSync(evil, 0o755)
    for (const dir of ['.git', 'sub/.git']) {
      mkdirSync(join(root, dir), { recursive: true })
      writeFileSync(join(root, dir, 'config'), `[core]\n\tfsmonitor = ${evil}\n`)
      writeFileSync(join(root, dir, 'HEAD'), 'ref: refs/heads/main\n')
    }
    writeFileSync(join(root, 'sub', 'kept.txt'), 'x')
    const spawned: string[][] = []
    const r = await rig({ spawn: spySpawn(spawned) })
    await installed(r, root)
    expect(spawned).toEqual([])
    expect(readdirSync(marker)).toEqual([])
    const code = snapshot(storeOf(r))
    expect(Object.keys(code).some(p => p.includes('.git'))).toBe(false)
    expect(Object.keys(code).some(p => p.endsWith('sub/kept.txt'))).toBe(true)
  })
})

describe('sources refused with nothing fetched', () => {
  const bad: [string, Record<string, unknown>, string][] = [
    ['ext::sh -c x', { url: 'ext::sh -c x' }, 'bad_url'],
    ['file:///x without the option', { url: 'file:///x' }, 'bad_url'],
    ['ssh://', { url: 'ssh://host/x.git' }, 'bad_url'],
    ['git@host:x', { url: 'git@host:x.git' }, 'bad_url'],
    ['http://', { url: 'http://host.example.com/x.git' }, 'bad_url'],
    ['https with a user', { url: 'https://user:pw@host.example.com/x' }, 'bad_url'],
    ['--upload-pack=x', { url: '--upload-pack=x' }, 'bad_url'],
    ['a ref of --foo', { url: 'https://host.example.com/x', ref: '--foo' }, 'bad_ref'],
    ['subpath with ..', { url: 'https://host.example.com/x', subpath: 'a/../b' }, 'bad_path'],
    ['absolute subpath', { url: 'https://host.example.com/x', subpath: '/etc' }, 'bad_path'],
  ]
  it.each(bad)('%s', async (_n, src, code) => {
    const spawned: string[][] = []
    const r = await rig({ allowFileProtocol: false, spawn: spySpawn(spawned) })
    expect(await refused(call(r, 'plugins.install.prepare', { source: { kind: 'git', ...src } }))).toBe(code)
    expect(spawned).toEqual([])
    expect(existsSync(storeOf(r))).toBe(false)
  })

  it('m10: a url whose path looks like a token is refused, so it can never sit in installed.json', async () => {
    const spawned: string[][] = []
    const r = await rig({ spawn: spySpawn(spawned) })
    const url = `https://host.example.com/sk-${'x'.repeat(24)}/repo.git`
    expect(await refused(call(r, 'plugins.install.prepare', { source: { kind: 'git', url } }))).toBe('bad_url')
    expect(spawned).toEqual([])
    expect(r.rawBytes().includes(url)).toBe(false)
  })

  it('a too-broad source is refused before any walk: no staging, no event, nothing copied, and the probe is fake', async () => {
    const r = await rig()
    writeFileSync(join(r.home, 'private.txt'), 'x')
    expect(await refused(call(r, 'plugins.install.prepare', { source: { kind: 'path', path: r.root } }))).toBe('path_refused')
    expect(eventsOf(r, 'plugins.install.state')).toEqual([])
    expect(existsSync(storeOf(r))).toBe(false)
  })

  it('m3: a source holding a credential root moved by env is refused; one beside it is not', async () => {
    const proj = join(tmp, 'proj')
    const gnupg = join(proj, 'gnupg')
    mkdirSync(gnupg, { recursive: true })
    buildPlugin(proj, { format: 'claude', id: 'plain', skills: { s: 'x' } })
    const r = await pluginKernel({ ...withManager(), kernel: { env: { PATH: '/usr/bin:/bin', HOME: tmp, USERPROFILE: tmp, GNUPGHOME: gnupg } } })
    rigs.push(r)
    expect(await refused(call(r, 'plugins.install.prepare', { source: { kind: 'path', path: proj } }))).toBe('path_refused')
    expect((await prepare(r, { kind: 'path', path: join(proj, 'plain') })).state).toBe('ready')
  })

  it('m3: a nested .ssh inside a source is allowed, and consent says so', async () => {
    const root = simple({ extra: { 'keys/.ssh/id_x': 'x' } })
    const st = await prepare(await rig(), { kind: 'path', path: root })
    expect(st.consent!.warnings).toContain('credentials_in_source')
    const clean = await prepare(await rig(), { kind: 'path', path: simple({ id: 'clean' }) })
    expect(clean.consent!.warnings).not.toContain('credentials_in_source')
  })

  it('local paths: a credential root, the data dir, the store, and anything holding the home or data dir', async () => {
    const r = await rig()
    const ssh = join(r.home, '.ssh')
    mkdirSync(ssh)
    mkdirSync(storeOf(r))
    for (const path of [ssh, r.dataDir, join(r.dataDir, 'plugins'), storeOf(r), r.home, r.root, join(tmp, 'missing'), 'relative/path']) {
      expect(await refused(call(r, 'plugins.install.prepare', { source: { kind: 'path', path } }))).toBe('path_refused')
    }
  })
})

describe('hostile trees', () => {
  const failsWith = async (r: PluginRig, source: Parameters<typeof prepare>[1], code: string, path?: string) => {
    const st = await prepare(r, source)
    expect(st.state).toBe('failed')
    expect(st.error).toBe(code)
    if (path !== undefined) expect(st.path).toBe(path)
    expect(st.consent).toBeUndefined()
    expect(stagingEntries(r)).toEqual([])
    expect(existsSync(storeOf(r))).toBe(false)
    return st
  }

  it('a symlink in a local source: symlink, named, staging gone; the failed event has only the code', async () => {
    const root = simple()
    symlinkSync('/etc/hosts', join(root, 'skills', 'link'))
    const r = await rig()
    await failsWith(r, { kind: 'path', path: root }, 'symlink', 'skills/link')
    const failed = eventsOf(r, 'plugins.install.state').at(-1)!.payload as Record<string, unknown>
    expect(failed).toMatchObject({ state: 'failed', error: 'symlink' })
    expect(JSON.stringify(failed)).not.toContain('skills/link')
  })

  it('a symlink in a git source: symlink, named, staging gone', async () => {
    const root = simple()
    symlinkSync('/etc/hosts', join(root, 'skills', 'link'))
    await failsWith(await rig(), { kind: 'git', url: repoOf(root).url }, 'symlink', 'skills/link')
  })

  it('a FIFO in a local source', async () => {
    const root = simple()
    execFileSync('mkfifo', [join(root, 'pipe')])
    await failsWith(await rig(), { kind: 'path', path: root }, 'bad_file_type', 'pipe')
  })

  it('a 5001st file and a 21 MB file in a local source', async () => {
    const many = simple()
    mkdirSync(join(many, 'data'))
    for (let i = 0; i < 5001; i++) writeFileSync(join(many, 'data', `f${i}`), '')
    const r = await rig()
    await failsWith(r, { kind: 'path', path: many }, 'too_many_files')
    const big = plugin({ format: 'claude', id: 'big', skills: { s: 'x' } })
    writeFileSync(join(big, 'blob'), '')
    truncateSync(join(big, 'blob'), 21 * 1024 * 1024)
    await failsWith(r, { kind: 'path', path: big }, 'file_too_large', 'blob')
  })

  it('a remote growing past 200 MB on the injected size probe', async () => {
    const r = await rig({ sizeOf: () => 201 * 1024 * 1024 })
    await failsWith(r, { kind: 'git', url: repoOf(simple()).url }, 'too_large')
  })

  it('not a plugin, a bad manifest and reserved ids fail with no staging', async () => {
    const r = await rig()
    const empty = join(tmp, 'empty')
    mkdirSync(empty)
    writeFileSync(join(empty, 'README'), 'x')
    await failsWith(r, { kind: 'path', path: empty }, 'not_a_plugin')
    for (const id of ['memory-default', 'dev-x', 'tools-registry']) await failsWith(r, { kind: 'path', path: plugin({ format: 'claude', id, skills: { s: 'x' } }) }, 'id_reserved')
  })

  it('a symlink outside subpath does not refuse the subtree; one inside does', async () => {
    const root = join(tmp, 'mono')
    mkdirSync(root)
    buildPlugin(join(root, 'plugins'), { format: 'claude', id: 'one', skills: { s: 'x' } })
    symlinkSync('/etc/hosts', join(root, 'outside'))
    const r = await rig()
    const { url } = repoOf(root)
    const ok = await prepare(r, { kind: 'git', url, subpath: 'plugins/one' })
    expect(ok.state).toBe('ready')
    expect(ok.consent!.id).toBe('one')
    await failsWith(await rig(), { kind: 'git', url, subpath: 'outside' }, 'symlink')
  })
})

describe('prepare runs in the background', () => {
  it('returns before the fetch ends; the group is registered, then settled; git and local both reach ready', async () => {
    const gate = join(tmp, 'gate')
    const pids: number[] = []
    const { url, commit } = repoOf(simple())
    const r = await rig({ spawn: gatedSpawn(gate, pids) })
    const { stagingId } = await call(r, 'plugins.install.prepare', { source: { kind: 'git', url } })
    expect((await call(r, 'plugins.install.status', { stagingId })).state).toBe('fetching')
    await until(() => pids.length > 0)
    pidsToKill.push(...pids)
    const registry = join(r.dataDir, 'run', 'shell-pgids')
    await until(() => existsSync(registry) && readFileSync(registry, 'utf8').includes(String(pids[0])))
    writeFileSync(gate, '')
    const st = await settled(r, stagingId)
    expect(st.state).toBe('ready')
    // 临时目录的地址长得像密钥,显示时打码;commit 不会
    expect(st.consent!.source).toMatchObject({ kind: 'git', commit })
    expect(st.consent!.warnings).not.toContain('unpinned_source')
    expect(eventsOf(r, 'plugins.install.state').map(e => (e.payload as { state: string }).state)).toEqual(['fetching', 'ready'])
    expect(pids.length).toBeGreaterThan(1)

    const local = await prepare(r, { kind: 'path', path: simple({ id: 'other' }) })
    expect(local.state).toBe('ready')
    expect(local.consent!.source.kind).toBe('path')
    expect(local.consent!.warnings).toContain('unpinned_source')
  })

  // Review Focus 4:工作进程在 git fetch 中途被杀,新工作进程启动时 reapOrphans 按登记文件收掉 git 的组
  it('a worker killed during git fetch: the git group is on record, and reapOrphans on the next start takes it', async () => {
    const gate = join(tmp, 'gate')
    const pids: number[] = []
    const r = await rig({ spawn: gatedSpawn(gate, pids) })
    await call(r, 'plugins.install.prepare', { source: { kind: 'git', url: repoOf(simple()).url } })
    await until(() => pids.length > 0)
    pidsToKill.push(...pids)
    const registry = join(r.dataDir, 'run', 'shell-pgids')
    await until(() => existsSync(registry) && readFileSync(registry, 'utf8').includes(String(pids[0])))
    // 崩溃那一刻的登记文件:内核关闭时会把它清掉,所以先拷一份
    const copy = join(tmp, 'pgids-after-crash')
    writeFileSync(copy, readFileSync(registry), { mode: 0o600 })
    expect(alive(pids[0])).toBe(true)
    const res = reapOrphans(copy, { platform: process.platform })
    expect(res.killed).toContain(pids[0])
    await until(() => !alive(pids[0]), 3000)
  })

  it('a local source also answers before the copy happens', async () => {
    const r = await rig()
    const { stagingId } = await call(r, 'plugins.install.prepare', { source: { kind: 'path', path: simple() } })
    expect((await call(r, 'plugins.install.status', { stagingId })).state).toBe('fetching')
    expect((await settled(r, stagingId)).state).toBe('ready')
  })

  it('cancel during a fetch kills the group, reports cancelled and not network, and leaves nothing', async () => {
    const gate = join(tmp, 'gate')
    const pids: number[] = []
    const r = await rig({ spawn: gatedSpawn(gate, pids) })
    const { stagingId } = await call(r, 'plugins.install.prepare', { source: { kind: 'git', url: repoOf(simple()).url } })
    await until(() => pids.length > 0)
    pidsToKill.push(...pids)
    expect(await call(r, 'plugins.install.cancel', { stagingId })).toEqual({ ok: true })
    await until(() => !alive(pids[0]))
    await until(() => !existsSync(storeOf(r)))
    const st = await call(r, 'plugins.install.status', { stagingId })
    expect(st).toMatchObject({ state: 'failed', error: 'cancelled' })
    // 被杀之后不再起下一条 git
    expect(pids).toHaveLength(1)
    expect(await refused(confirm(r, { stagingId, consentHash: 'x' }))).toBe('consent_stale')
  })

  describe('stopping between two git commands, when no group is registered to kill', () => {
    const between = (stop: (i: Installer, stagingId: string) => void) => {
      const dataDir = join(tmp, 'data')
      mkdirSync(dataDir)
      const { url } = repoOf(simple())
      const pids: number[] = []
      let stagingId = ''
      let spawned = 0
      const installer: Installer = new Installer({
        store: PluginStore.open({ dataDir }, nullLogger),
        commands: { validateCwd: p => p, holdsCredentialRoot: () => false, home: join(tmp, 'home') },
        deleteSecret: async () => {},
        append: () => {},
        log: nullLogger,
        dataDir,
        env: { PATH: '/usr/bin:/bin' },
        now: Date.now,
        timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: h => clearTimeout(h as NodeJS.Timeout) },
        reservedIds: () => new Set(),
        killPluginProcesses: async () => {},
        allowFileProtocol: true,
        spawn: ((cmd: string, args: string[], o: Parameters<typeof nodeSpawn>[2]) => {
          // 第二条换成不会自己退的程序:没人杀就一直在
          const second = ++spawned === 2
          if (second) stop(installer, stagingId)
          const c = second ? nodeSpawn('/bin/sleep', ['30'], o) : nodeSpawn(cmd, args, o)
          if (c.pid !== undefined) {
            pids.push(c.pid)
            pidsToKill.push(c.pid)
          }
          return c
        }) as unknown as typeof nodeSpawn,
      })
      ;({ stagingId } = installer.prepare({ kind: 'git', url }))
      return { installer, pids, dataDir, spawnedCount: () => spawned, stagingId }
    }

    it('close: the cwd is still there, so the next git starts, and dies as soon as its group is known', async () => {
      const t = between(i => void i.close())
      await until(() => t.pids.length === 2)
      await until(() => !alive(t.pids[1]), 1500)
      await t.installer.close()
      expect(t.spawnedCount()).toBe(2)
      expect(existsSync(`${t.dataDir}-plugins`)).toBe(false)
    })

    it('cancel: the staging is already gone, so the next git cannot start in it; the answer stays cancelled', async () => {
      const t = between((i, id) => void i.cancel(id))
      await until(() => t.spawnedCount() === 2)
      expect(t.installer.status(t.stagingId)).toMatchObject({ state: 'failed', error: 'cancelled' })
      await t.installer.close()
      expect(t.pids.filter(alive)).toEqual([])
      expect(existsSync(`${t.dataDir}-plugins`)).toBe(false)
    })
  })

  it('cancel of a ready staging removes it; an unknown id is fine', async () => {
    const r = await rig()
    const st = await prepare(r, { kind: 'path', path: simple() })
    expect(existsSync(storeOf(r))).toBe(true)
    await call(r, 'plugins.install.cancel', { stagingId: st.stagingId })
    expect(existsSync(storeOf(r))).toBe(false)
    expect(await call(r, 'plugins.install.cancel', { stagingId: 'nope' })).toEqual({ ok: true })
  })

  it('kernel.close during a fetch aborts it and leaves nothing', async () => {
    const gate = join(tmp, 'gate')
    const pids: number[] = []
    const r = await rig({ spawn: gatedSpawn(gate, pids) })
    await call(r, 'plugins.install.prepare', { source: { kind: 'git', url: repoOf(simple()).url } })
    await until(() => pids.length > 0)
    pidsToKill.push(...pids)
    await r.kernel.close()
    expect(alive(pids[0])).toBe(false)
    expect(existsSync(storeOf(r))).toBe(false)
    expect(pids).toHaveLength(1)
  })

  it('at most three stagings at once; a cancel frees a slot', async () => {
    const r = await rig()
    const ids: string[] = []
    for (const id of ['a1', 'a2', 'a3']) ids.push((await prepare(r, { kind: 'path', path: simple({ id }) })).stagingId)
    const path = simple({ id: 'a4' })
    expect(await refused(call(r, 'plugins.install.prepare', { source: { kind: 'path', path } }))).toBe('too_many_stagings')
    await call(r, 'plugins.install.cancel', { stagingId: ids[0] })
    expect((await prepare(r, { kind: 'path', path })).state).toBe('ready')
  })

  it('a failed staging does not hold a slot', async () => {
    const r = await rig()
    const bad = simple({ id: 'bad' })
    symlinkSync('/etc/hosts', join(bad, 'l'))
    for (let i = 0; i < 4; i++) expect((await prepare(r, { kind: 'path', path: bad })).state).toBe('failed')
    expect((await prepare(r, { kind: 'path', path: simple() })).state).toBe('ready')
  })

  it('status of an unknown id: staging_not_found', async () => {
    const r = await rig()
    expect(await refused(call(r, 'plugins.install.status', { stagingId: 'nope' }))).toBe('staging_not_found')
  })
})

// ---------- Review Focus 5 ----------

describe('consent binds what lands', () => {
  it('the same tree gives one hash across data dirs; one changed byte gives another', async () => {
    const root = simple({ mcp: { srv: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/x.js', '${CLAUDE_PLUGIN_DATA}/d'] } } })
    const a = await prepare(await rig(), { kind: 'path', path: root })
    const b = await prepare(await rig(), { kind: 'path', path: root })
    expect(a.consentHash).toBe(b.consentHash)
    expect(a.consent!.mcp[0].args).toEqual(['${PLUGIN_ROOT}/x.js', '${PLUGIN_DATA}/d'])
    writeFileSync(join(root, 'extra'), 'x')
    expect((await prepare(await rig(), { kind: 'path', path: root })).consentHash).not.toBe(a.consentHash)
  })

  it('a staged file edited after ready: consent_stale, nothing installed, nothing on disk', async () => {
    const r = await rig()
    const st = await prepare(r, { kind: 'path', path: simple() })
    const [job] = stagingEntries(r)
    const staged = join(storeOf(r), '.staging', job, 'tree', 'skills', 's', 'SKILL.md')
    writeFileSync(staged, `${readFileSync(staged, 'utf8')}!`)
    expect(await refused(confirm(r, st))).toBe('consent_stale')
    expect(await list(r)).toEqual([])
    expect(existsSync(storeOf(r))).toBe(false)
    expect(eventsOf(r, 'plugins.installed')).toEqual([])
  })

  it('a staged file added or chmod +x after ready: consent_stale', async () => {
    const r = await rig()
    const a = await prepare(r, { kind: 'path', path: simple() })
    writeFileSync(join(storeOf(r), '.staging', stagingEntries(r)[0], 'tree', 'new'), '')
    expect(await refused(confirm(r, a))).toBe('consent_stale')
    const b = await prepare(r, { kind: 'path', path: simple({ id: 'demo2' }) })
    chmodSync(join(storeOf(r), '.staging', stagingEntries(r)[0], 'tree', 'skills', 's', 'SKILL.md'), 0o755)
    expect(await refused(confirm(r, b))).toBe('consent_stale')
  })

  it('m1: a .git added to the staged tree after ready is consent_stale, though the walk skips it', async () => {
    const r = await rig()
    const st = await prepare(r, { kind: 'path', path: simple() })
    mkdirSync(join(storeOf(r), '.staging', stagingEntries(r)[0], 'tree', 'skills', '.git'))
    expect(await refused(confirm(r, st))).toBe('consent_stale')
    expect(await list(r)).toEqual([])
  })

  it('two stagings of one id: confirming the second after the first is consent_stale', async () => {
    const r = await rig()
    const root = simple()
    const first = await prepare(r, { kind: 'path', path: root })
    const second = await prepare(r, { kind: 'path', path: root })
    await confirm(r, first)
    expect(await refused(confirm(r, second))).toBe('consent_stale')
    expect(eventsOf(r, 'plugins.installed')).toHaveLength(1)
  })

  it('an upgrade computed against a version that has since changed is consent_stale', async () => {
    const r = await rig()
    const root = simple()
    await installed(r, root)
    writeFileSync(join(root, 'v2'), '')
    const a = await prepare(r, { kind: 'path', path: root })
    writeFileSync(join(root, 'v3'), '')
    const b = await prepare(r, { kind: 'path', path: root })
    await confirm(r, a)
    expect(await refused(confirm(r, b))).toBe('consent_stale')
  })

  it('an upgrade computed against a version that was uninstalled is consent_stale', async () => {
    const r = await rig()
    const root = simple()
    await installed(r, root)
    writeFileSync(join(root, 'v2'), '')
    const up = await prepare(r, { kind: 'path', path: root })
    expect(up.consent!.diff).toBeDefined()
    await call(r, 'plugins.uninstall', { commandId: 'u1', id: 'demo' })
    expect(await refused(confirm(r, up))).toBe('consent_stale')
  })

  it('an upgrade whose manifest has another id: id_changed, old version untouched', async () => {
    const r = await rig()
    const root = simple()
    await installed(r, root)
    const before = snapshot(storeOf(r))
    const manifest = join(root, '.claude-plugin', 'plugin.json')
    writeFileSync(manifest, JSON.stringify({ name: 'someone-else', version: '2.0.0' }))
    const { stagingId } = await call(r, 'plugins.upgrade.prepare', { id: 'demo' })
    const st = await settled(r, stagingId)
    expect(st.state).toBe('ready')
    expect(await refused(confirm(r, { stagingId, consentHash: st.consentHash }))).toBe('id_changed')
    expect(snapshot(storeOf(r))).toEqual(before)
    expect((await list(r)).map((p: { id: string }) => p.id)).toEqual(['demo'])
  })

  it('a wrong hash, a stale stagingId and an expired one: refused and nothing on disk', async () => {
    let t = 1_000_000
    const r = await rig({ now: () => t })
    const a = await prepare(r, { kind: 'path', path: simple() })
    expect(await refused(confirm(r, { stagingId: a.stagingId, consentHash: 'f'.repeat(64) }))).toBe('consent_stale')
    expect(existsSync(storeOf(r))).toBe(false)
    expect(await refused(confirm(r, a))).toBe('consent_stale')
    expect(await refused(confirm(r, { stagingId: 'never-was', consentHash: 'x' }))).toBe('consent_stale')

    const b = await prepare(r, { kind: 'path', path: simple({ id: 'demo2' }) })
    t += 60 * 60 * 1000 - 1
    expect((await call(r, 'plugins.install.status', { stagingId: b.stagingId })).state).toBe('ready')
    t += 1
    expect(await refused(confirm(r, b))).toBe('consent_stale')
    expect(await call(r, 'plugins.install.status', { stagingId: b.stagingId })).toMatchObject({ state: 'failed', error: 'expired' })
    expect(existsSync(storeOf(r))).toBe(false)
    expect(await list(r)).toEqual([])
  })

  it('an expired staging is cleaned by its timer, with no RPC asking', async () => {
    let t = 1_000_000
    const fired: (() => void)[] = []
    const r = await rig({ now: () => t, timers: { setTimeout: fn => fired.push(fn), clearTimeout: () => {} } })
    await prepare(r, { kind: 'path', path: simple() })
    expect(existsSync(storeOf(r))).toBe(true)
    t += 60 * 60 * 1000
    for (const f of fired) f()
    expect(existsSync(storeOf(r))).toBe(false)
  })

  it('confirm replayed by commandId installs once', async () => {
    const r = await rig()
    const st = await prepare(r, { kind: 'path', path: simple() })
    const a = await confirm(r, st, { commandId: 'same' })
    const b = await confirm(r, st, { commandId: 'same' })
    expect(b).toEqual(a)
    expect(a).toEqual({ ok: true, id: 'demo' })
    expect(eventsOf(r, 'plugins.installed')).toHaveLength(1)
  })

  it('a failed confirm leaves no receipt: the same commandId can succeed after fixing grants', async () => {
    const r = await rig()
    const st = await prepare(r, { kind: 'path', path: simple({ mcp: { srv: { command: 'node' } } }) })
    expect(await refused(confirm(r, st, { commandId: 'c1', grants: { servers: { nope: { network: [], cwd: 'read' } } } }))).toBe('grants_exceed_declared')
    expect(await confirm(r, st, { commandId: 'c1' })).toEqual({ ok: true, id: 'demo' })
  })

  it('bidi characters in args and hook text appear escaped in consent', async () => {
    const r = await rig()
    const st = await prepare(r, { kind: 'path', path: simple({ mcp: { srv: { command: 'node', args: ['a‮b'] } }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x​y' }] }] } }) })
    expect(st.consent!.mcp[0].args[0]).toBe('a\\u202Eb'.replace('\\u202E', '\\u202e'))
    expect(st.consent!.notRun.hooks[0].command).toBe('x\\u200by')
    expect(JSON.stringify(st.consent)).not.toMatch(/[‮​]/)
  })

  it('a secret-shaped literal in env is masked in status and plugins.get', async () => {
    const secret = `sk-${'x'.repeat(24)}`
    const r = await rig()
    const st = await prepare(r, { kind: 'path', path: simple({ mcp: { srv: { command: 'node', env: { LOOKS: secret } } } }) })
    expect(JSON.stringify(st)).not.toContain(secret)
    await confirm(r, st)
    expect(JSON.stringify(await call(r, 'plugins.get', { id: 'demo' }))).not.toContain(secret)
    expect(JSON.stringify(await call(r, 'plugins.list'))).not.toContain(secret)
    expect(readFileSync(join(r.dataDir, 'plugins', 'plugin-manager', 'installed.json'), 'utf8')).not.toContain(secret)
  })

  describe('narrow only', () => {
    it.each([
      ['permissions.filesystem', { filesystem: ['/'] }],
      ['network *', { network: ['*'] }],
      ['a path in network', { network: ['/etc/passwd'] }],
      ['cwd root', { cwd: 'root' }],
    ])('a native manifest with %s is rejected', async (_n, permissions) => {
      const r = await rig()
      const st = await prepare(r, { kind: 'path', path: plugin({ format: 'native', id: 'nat', mcp: { srv: { command: 'node', permissions } } }) })
      expect(st).toMatchObject({ state: 'failed', error: 'bad_manifest' })
    })

    const native = () => plugin({ format: 'native', id: 'nat', mcp: { srv: { command: 'node', permissions: { network: ['api.example.com'], cwd: 'read' } } } })
    it.each([
      ['a host beyond the declaration', { srv: { network: ['other.example.com'], cwd: 'read' } }, 'grants_exceed_declared'],
      ['cwd beyond the declaration', { srv: { network: [], cwd: 'write' } }, 'grants_exceed_declared'],
      ['a server that is not declared', { other: { network: [], cwd: 'read' } }, 'grants_exceed_declared'],
      ['an internal host', { srv: { network: ['localhost'], cwd: 'read' } }, 'bad_host'],
    ])('grants with %s are refused, staging kept', async (_n, servers, code) => {
      const r = await rig()
      const st = await prepare(r, { kind: 'path', path: native() })
      expect(await refused(confirm(r, st, { grants: { servers } }))).toBe(code)
      expect(await list(r)).toEqual([])
      expect(await confirm(r, st)).toEqual({ ok: true, id: 'nat' })
    })

    it('no grants: no hosts, cwd read; grants within the declaration land', async () => {
      const r = await rig()
      await installed(r, native())
      expect((await call(r, 'plugins.get', { id: 'nat' })).grants).toEqual({ servers: { srv: { network: [], cwd: 'read' } } })
      await call(r, 'plugins.grants.set', { commandId: 'g', id: 'nat', grants: { servers: { srv: { network: ['api.example.com'], cwd: 'none' } } } })
      expect((await call(r, 'plugins.get', { id: 'nat' })).grants).toEqual({ servers: { srv: { network: ['api.example.com'], cwd: 'none' } } })
    })

    it('defaultEnabled:true enables nothing: enable:false leaves it off', async () => {
      const r = await rig()
      await installed(r, simple({ manifest: { defaultEnabled: true } }), { enable: false })
      expect((await list(r))[0].enabled).toBe(false)
      expect(eventsOf(r, 'plugins.enabled')).toEqual([])
    })
  })

  describe('upgrade', () => {
    const base = () =>
      simple({
        skills: { same: 'same text', edited: 'old text' },
        mcp: { keep: { command: 'node', args: ['a'] }, drop: { command: 'node' } },
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'old-hook' }] }] },
      })
    const manifestPath = (root: string) => join(root, '.mcp.json')

    it('diff table: added, removed, changed args, new hook, skill text; unchanged skill is not reported', async () => {
      const r = await rig()
      const root = base()
      await installed(r, root)
      writeFileSync(manifestPath(root), JSON.stringify({ mcpServers: { keep: { command: 'node', args: ['b'] }, fresh: { command: 'node' } } }))
      writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'new-hook' }] }] } }))
      writeFileSync(join(root, 'skills', 'edited', 'SKILL.md'), '---\nname: edited\ndescription: edited skill\n---\nnew text\n')
      const { stagingId } = await call(r, 'plugins.upgrade.prepare', { id: 'demo' })
      const d = (await settled(r, stagingId)).consent!.diff!
      expect(d.mcp.added).toEqual(['fresh'])
      expect(d.mcp.removed).toEqual(['drop'])
      expect(d.mcp.changed).toEqual([{ name: 'keep', fields: ['args'] }])
      expect(d.notRun.hooksAdded.map(h => h.command)).toEqual(['new-hook'])
      expect(d.notRun.hooksRemoved.map(h => h.command)).toEqual(['old-hook'])
      // textHashes 没存的话 same 也会算变了
      expect(d.skills.textChanged).toEqual(['edited'])
      expect(d.integrity).not.toBeNull()
      expect(d.sourceChanged).toBe(false)
    })

    it('an upgrade changing only code shows no args change; the store path does not leak into args', async () => {
      const r = await rig()
      const root = simple({ mcp: { srv: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/x.js'] } }, extra: { 'x.js': '1' } })
      await installed(r, root)
      writeFileSync(join(root, 'x.js'), '2')
      const { stagingId } = await call(r, 'plugins.upgrade.prepare', { id: 'demo' })
      const d = (await settled(r, stagingId)).consent!.diff!
      expect(d.mcp.changed).toEqual([])
      expect(d.integrity).not.toBeNull()
    })

    it('new host in a native declaration, and a changed source, show in the diff', async () => {
      const r = await rig()
      const spec = (network: string[]): PluginSpec => ({ format: 'native', id: 'nat', mcp: { srv: { command: 'node', permissions: { network, cwd: 'read' } } } })
      await installed(r, plugin(spec(['a.example.com'])))
      const st = await prepare(r, { kind: 'path', path: plugin(spec(['a.example.com', 'b.example.com'])) })
      expect(st.consent!.diff!.network.added).toEqual(['b.example.com'])
      expect(st.consent!.diff!.sourceChanged).toBe(true)
      expect(st.consent!.warnings).toContain('source_changed')
    })

    it('any install of an id already installed goes through the same path: a diff and no silent overwrite', async () => {
      const r = await rig()
      await installed(r, simple())
      const st = await prepare(r, { kind: 'path', path: simple({ skills: { s: 'other' } }) })
      expect(st.consent!.diff).toBeDefined()
      expect(st.consent!.diff!.skills.textChanged).toEqual(['s'])
    })

    it('old version runs until confirm; confirm kills, swaps, removes the old dir, keeps plugin-data', async () => {
      const kills: string[] = []
      const r = await rig({ killPluginProcesses: async id => void kills.push(id) })
      const root = simple({ version: '1.0.0' })
      await installed(r, root)
      const data = join(r.dataDir, 'plugin-data', 'demo', 'srv')
      mkdirSync(data, { recursive: true })
      writeFileSync(join(data, 'state'), 'kept')
      const manifest = join(root, '.claude-plugin', 'plugin.json')
      writeFileSync(manifest, JSON.stringify({ name: 'demo', version: '2.0.0' }))
      const { stagingId } = await call(r, 'plugins.upgrade.prepare', { id: 'demo' })
      const st = await settled(r, stagingId)
      expect((await list(r))[0].version).toBe('1.0.0')
      expect(kills).toEqual([])
      const oldDirs = readdirSync(join(storeOf(r), 'demo'))
      await confirm(r, { stagingId, consentHash: st.consentHash })
      expect(kills).toEqual(['demo'])
      expect((await list(r))[0].version).toBe('2.0.0')
      const newDirs = readdirSync(join(storeOf(r), 'demo'))
      expect(newDirs).toHaveLength(1)
      expect(newDirs).not.toEqual(oldDirs)
      expect(readFileSync(join(data, 'state'), 'utf8')).toBe('kept')
      expect(eventsOf(r, 'plugins.upgraded')).toHaveLength(1)
      expect(eventsOf(r, 'plugins.installed')).toHaveLength(1)
      expect(stagingEntries(r)).toEqual([])
    })

    it('an upgrade to byte-identical content keeps a working dir', async () => {
      const r = await rig()
      const root = simple()
      await installed(r, root)
      const up = await prepare(r, { kind: 'path', path: root })
      expect(up.consent!.diff!.integrity).toBeNull()
      await confirm(r, up)
      await r.restart()
      expect((await list(r))[0]).toMatchObject({ state: 'ok', enabled: true })
    })

    it('grants after an upgrade are the intersection: a dropped host is gone, a new one is not granted by itself', async () => {
      const r = await rig()
      const spec = (network: string[], cwd: string, more = {}): PluginSpec => ({ format: 'native', id: 'nat', mcp: { srv: { command: 'node', permissions: { network, cwd } }, ...more } })
      await installed(r, plugin(spec(['a.example.com', 'b.example.com'], 'write')), { grants: { servers: { srv: { network: ['a.example.com', 'b.example.com'], cwd: 'write' } } } })
      const up = await prepare(r, { kind: 'path', path: plugin(spec(['b.example.com', 'c.example.com'], 'read', { fresh: { command: 'node', permissions: { network: ['d.example.com'], cwd: 'read' } } })) })
      await confirm(r, up)
      expect((await call(r, 'plugins.get', { id: 'nat' })).grants).toEqual({
        servers: { srv: { network: ['b.example.com'], cwd: 'read' }, fresh: { network: [], cwd: 'read' } },
      })
    })

    it('confirm.grants gives what is new, and is held to the new declaration', async () => {
      const r = await rig()
      const spec = (network: string[]): PluginSpec => ({ format: 'native', id: 'nat', mcp: { srv: { command: 'node', permissions: { network, cwd: 'read' } } } })
      await installed(r, plugin(spec(['a.example.com'])), { grants: { servers: { srv: { network: ['a.example.com'], cwd: 'read' } } } })
      const up = await prepare(r, { kind: 'path', path: plugin(spec(['c.example.com'])) })
      expect(await refused(confirm(r, up, { grants: { servers: { srv: { network: ['a.example.com'], cwd: 'read' } } } }))).toBe('grants_exceed_declared')
      await confirm(r, up, { grants: { servers: { srv: { network: ['c.example.com'], cwd: 'read' } } } })
      expect((await call(r, 'plugins.get', { id: 'nat' })).grants.servers.srv.network).toEqual(['c.example.com'])
    })

    it('I4: a staged file changed during an identical-content reinstall does not land, and the old dir survives', async () => {
      const holder: { edit?: () => void } = {}
      const r = await rig({ killPluginProcesses: async () => holder.edit?.() })
      const root = simple()
      await installed(r, root)
      const before = snapshot(join(storeOf(r), 'demo'))
      const up = await prepare(r, { kind: 'path', path: root })
      const staged = join(storeOf(r), '.staging', stagingEntries(r)[0], 'tree', 'skills', 's', 'SKILL.md')
      holder.edit = () => writeFileSync(staged, 'swapped after the re-hash')
      expect(await refused(confirm(r, up))).toBe('consent_stale')
      holder.edit = undefined
      expect(snapshot(join(storeOf(r), 'demo'))).toEqual(before)
      expect(eventsOf(r, 'plugins.upgraded')).toEqual([])
      await r.restart()
      expect((await list(r))[0]).toMatchObject({ enabled: true, state: 'ok' })
    })

    it('I4: a failed record write during an identical-content reinstall leaves the record pointing at a real dir', async () => {
      const r = await rig()
      const root = simple()
      await installed(r, root)
      const before = snapshot(join(storeOf(r), 'demo'))
      const up = await prepare(r, { kind: 'path', path: root })
      mkdirSync(join(r.dataDir, 'plugins', 'plugin-manager', 'installed.json.tmp'))
      expect(await refused(confirm(r, up))).toBe('store_error')
      expect(snapshot(join(storeOf(r), 'demo'))).toEqual(before)
      await r.restart()
      expect((await list(r))[0]).toMatchObject({ enabled: true, state: 'ok' })
    })

    it('I3: the store root swapped for a link during an upgrade: nothing in its target is deleted or written', async () => {
      const holder: { swap?: () => void } = {}
      const r = await rig({ killPluginProcesses: async () => holder.swap?.() })
      const root = simple()
      await installed(r, root)
      const oldDir = readdirSync(join(storeOf(r), 'demo'))[0]
      const victim = join(tmp, 'victim')
      mkdirSync(join(victim, 'demo', oldDir), { recursive: true })
      writeFileSync(join(victim, 'demo', oldDir, 'canary'), 'alive')
      writeFileSync(join(root, 'v2'), '')
      const up = await prepare(r, { kind: 'path', path: root })
      holder.swap = () => {
        renameSync(storeOf(r), join(tmp, 'moved'))
        symlinkSync(victim, storeOf(r))
      }
      await confirm(r, up)
      holder.swap = undefined
      expect(readFileSync(join(victim, 'demo', oldDir, 'canary'), 'utf8')).toBe('alive')
      expect(readdirSync(victim)).toEqual(['demo'])
    })

    it('I3: the store root swapped for a link before an in-place swap: refused, target untouched', async () => {
      const holder: { swap?: () => void } = {}
      const r = await rig({ killPluginProcesses: async () => holder.swap?.() })
      const root = simple()
      await installed(r, root)
      const dir = readdirSync(join(storeOf(r), 'demo'))[0]
      const up = await prepare(r, { kind: 'path', path: root })
      const victim = join(tmp, 'victim')
      mkdirSync(join(victim, 'demo', dir), { recursive: true })
      writeFileSync(join(victim, 'demo', dir, 'canary'), 'alive')
      holder.swap = () => {
        renameSync(storeOf(r), join(tmp, 'moved'))
        symlinkSync(victim, storeOf(r))
      }
      expect(await refused(confirm(r, up))).toBe('store_error')
      expect(readFileSync(join(victim, 'demo', dir, 'canary'), 'utf8')).toBe('alive')
    })

    it('I5: an old dir that cannot be removed does not fail the upgrade; a later start clears it', async () => {
      // 只读的子目录现在删得掉(I3);锁住它上面那层才真的删不掉。新版本要落进这一层,所以在杀进程那一步才锁
      const holder: { during?: () => void } = {}
      const r = await rig({ killPluginProcesses: async () => holder.during?.() })
      const root = simple({ extra: { 'locked/sub/f': 'x' } })
      await installed(r, root)
      const parent = join(storeOf(r), 'demo')
      writeFileSync(join(root, 'v2'), '')
      const up = await prepare(r, { kind: 'path', path: root })
      holder.during = () => chmodSync(parent, 0o555)
      try {
        expect(await confirm(r, up)).toEqual({ ok: true, id: 'demo' })
        expect(eventsOf(r, 'plugins.upgraded')).toHaveLength(1)
        expect(readdirSync(parent)).toHaveLength(2)
      } finally {
        chmodSync(parent, 0o755)
      }
      await r.restart()
      expect(readdirSync(join(storeOf(r), 'demo'))).toHaveLength(1)
      expect((await list(r))[0].state).toBe('ok')
    })

    it('I5: a landing job past its expiry neither expires nor spins the timer', async () => {
      let t = 1_000_000
      const armed: { fn: () => void; ms: number }[] = []
      const holder: { during?: () => void } = {}
      const r = await rig({ now: () => t, timers: { setTimeout: (fn, ms) => armed.push({ fn, ms }), clearTimeout: () => {} }, killPluginProcesses: async () => holder.during?.() })
      const root = simple()
      await installed(r, root)
      const up = await prepare(r, { kind: 'path', path: root })
      let spun = 0
      holder.during = () => {
        t += 2 * 60 * 60 * 1000
        const n = armed.length
        armed.at(-1)!.fn()
        spun = armed.slice(n).filter(a => a.ms <= 0).length
      }
      expect(await confirm(r, up)).toEqual({ ok: true, id: 'demo' })
      expect(spun).toBe(0)
    })

    it('m7: a plain setting that becomes sensitive on upgrade is dropped, and shows as not set', async () => {
      const r = await rig()
      const spec = (sensitive: boolean) => simple({ mcp: { srv: { command: 'node', env: { R: '${user_config.region}' } } }, manifest: { userConfig: { region: { title: 'R', sensitive } } } })
      await installed(r, spec(false))
      await call(r, 'plugins.settings.set', { id: 'demo', key: 'region', value: 'eu-plain-value' })
      await installed(r, spec(true))
      const row = (await call(r, 'plugins.get', { id: 'demo' })).settings.find((x: { key: string }) => x.key === 'region')
      expect(row).toEqual({ key: 'region', set: false, sensitive: true })
      expect(readFileSync(join(r.dataDir, 'plugins', 'plugin-manager', 'installed.json'), 'utf8')).not.toContain('eu-plain-value')
    })

    it('upgrade of a plugin not installed: plugin_not_installed; a ref on a local source: bad_ref', async () => {
      const r = await rig()
      expect(await refused(call(r, 'plugins.upgrade.prepare', { id: 'nope' }))).toBe('plugin_not_installed')
      await installed(r, simple())
      expect(await refused(call(r, 'plugins.upgrade.prepare', { id: 'demo', ref: 'main' }))).toBe('bad_ref')
    })

    it('a git plugin upgrades from its own url and keeps its subpath', async () => {
      const mono = join(tmp, 'mono')
      mkdirSync(mono)
      buildPlugin(join(mono, 'plugins'), { format: 'claude', id: 'one', skills: { s: 'x' } })
      const { url } = repoOf(mono)
      const r = await rig()
      const st = await prepare(r, { kind: 'git', url, subpath: 'plugins/one' })
      await confirm(r, st)
      const up = await call(r, 'plugins.upgrade.prepare', { id: 'one' })
      const s2 = await settled(r, up.stagingId)
      expect(s2.state).toBe('ready')
      expect(s2.consent!.source).toMatchObject({ kind: 'git', subpath: 'plugins/one' })
      expect(s2.consent!.diff!.sourceChanged).toBe(false)
    })
  })

  describe('tamper and restart', () => {
    const skillIn = (r: PluginRig, id = 'demo') => {
      const dir = join(storeOf(r), id)
      return join(dir, readdirSync(dir)[0], 'skills', 's', 'SKILL.md')
    }
    it('a byte changed between restarts: disabled, plugins.integrity.failed, in problems; enable refuses until it matches', async () => {
      const r = await rig()
      await installed(r, simple())
      const f = skillIn(r)
      const good = readFileSync(f)
      writeFileSync(f, 'tampered')
      await r.restart()
      const p = (await list(r))[0]
      expect(p).toMatchObject({ enabled: false, state: 'integrity_failed', problems: ['integrity_failed'] })
      expect(eventsOf(r, 'plugins.integrity.failed').map(e => e.payload)).toEqual([{ id: 'demo' }])
      expect(await refused(call(r, 'plugins.setEnabled', { commandId: 'e1', id: 'demo', enabled: true }))).toBe('integrity_failed')
      expect((await list(r))[0].enabled).toBe(false)
      writeFileSync(f, good)
      await call(r, 'plugins.setEnabled', { commandId: 'e2', id: 'demo', enabled: true })
      expect((await list(r))[0]).toMatchObject({ enabled: true, state: 'ok', problems: [] })
    })

    it('a disabled plugin is not hashed at start, and stays disabled through a restart', async () => {
      const r = await rig()
      await installed(r, simple(), { enable: false })
      writeFileSync(skillIn(r), 'tampered')
      await r.restart()
      expect((await list(r))[0]).toMatchObject({ enabled: false, state: 'ok' })
      expect(eventsOf(r, 'plugins.integrity.failed')).toEqual([])
    })

    it('enabling checks again, without a restart', async () => {
      const r = await rig()
      await installed(r, simple(), { enable: false })
      writeFileSync(skillIn(r), 'tampered')
      expect(await refused(call(r, 'plugins.setEnabled', { commandId: 'e1', id: 'demo', enabled: true }))).toBe('integrity_failed')
      expect(eventsOf(r, 'plugins.integrity.failed')).toHaveLength(1)
      expect((await list(r))[0].state).toBe('integrity_failed')
    })

    it('after a corrupt record: a reinstall replaces its own code and data, and another plugin\'s dirs stay', async () => {
      const r = await rig()
      const demo = simple()
      await installed(r, demo)
      await installed(r, simple({ id: 'other' }))
      const data = (id: string) => join(r.dataDir, 'plugin-data', id, 'srv')
      for (const id of ['demo', 'other']) {
        mkdirSync(data(id), { recursive: true })
        writeFileSync(join(data(id), 'state'), 'old')
      }
      writeFileSync(join(r.dataDir, 'plugins', 'plugin-manager', 'installed.json'), '{oops')
      await r.restart()
      expect(await list(r)).toEqual([])
      await installed(r, demo)
      expect(existsSync(data('demo'))).toBe(false)
      expect((await list(r))[0]).toMatchObject({ id: 'demo', state: 'ok', enabled: true })
      for (let i = 0; i < 2; i++) {
        await r.restart()
        expect(readdirSync(storeOf(r)).sort()).toEqual(['demo', 'other'])
        expect(existsSync(data('other'))).toBe(true)
        expect((await call(r, 'plugins.list')).problems).toEqual(['store_recovered'])
      }
    })

    it('a crash leaves stale staging and an unknown dir: the restart cleans them', async () => {
      const r = await rig()
      await installed(r, simple())
      await prepare(r, { kind: 'path', path: simple({ id: 'pending' }) })
      mkdirSync(join(storeOf(r), 'ghost', 'a'.repeat(12)), { recursive: true })
      await r.restart({ kill: true })
      expect(readdirSync(storeOf(r))).toEqual(['demo'])
      expect((await list(r)).map((p: { id: string }) => p.id)).toEqual(['demo'])
    })

    it('a failed write of the record rolls the install back', async () => {
      const r = await rig()
      const st = await prepare(r, { kind: 'path', path: simple() })
      mkdirSync(join(r.dataDir, 'plugins', 'plugin-manager', 'installed.json.tmp'))
      expect(await refused(confirm(r, st))).toBe('store_error')
      expect(await list(r)).toEqual([])
      expect(existsSync(join(storeOf(r), 'demo'))).toBe(false)
      expect(eventsOf(r, 'plugins.installed')).toEqual([])
    })

    it('a raw filesystem error during staging reaches RPC as a code, with no absolute path', async () => {
      const r = await rig()
      const root = simple()
      const hidden = join(root, 'skills', 's', 'SKILL.md')
      chmodSync(hidden, 0o000)
      try {
        const st = await prepare(r, { kind: 'path', path: root })
        expect(st.state).toBe('failed')
        expect(st.error).toMatch(/^[a-z_]+$/)
        expect(JSON.stringify(st)).not.toContain(r.root)
      } finally {
        chmodSync(hidden, 0o644)
      }
    })
  })
})

describe('stores planted by a session (bwrap: <data>-plugins does not exist yet)', () => {
  it('the store root swapped for a link to a copy of the staged tree, just before confirm: consent_stale, nothing lands', async () => {
    const r = await rig()
    const st = await prepare(r, { kind: 'path', path: simple() })
    const elsewhere = join(tmp, 'elsewhere')
    renameSync(storeOf(r), elsewhere)
    symlinkSync(elsewhere, storeOf(r))
    expect(await refused(confirm(r, st))).toBe('consent_stale')
    expect(readdirSync(elsewhere)).toEqual(['.staging'])
    expect(await list(r)).toEqual([])
  })

  it('a directory planted at the id being installed is gone by the time it lands; a plant at another id stays inert', async () => {
    const r = await rig()
    const code = storeOf(r)
    mkdirSync(join(code, 'demo', 'a'.repeat(12)), { recursive: true })
    writeFileSync(join(code, 'demo', 'a'.repeat(12), 'evil'), 'x')
    mkdirSync(join(code, 'ghost', 'a'.repeat(12)), { recursive: true })
    await installed(r, simple())
    expect(Object.keys(snapshot(join(code, 'demo'))).some(p => p.includes('evil'))).toBe(false)
    expect(readdirSync(join(code, 'demo'))).toHaveLength(1)
    expect((await list(r)).map((p: { id: string }) => p.id)).toEqual(['demo'])
    expect((await call(r, 'plugins.list')).problems).toEqual(['store_recovered'])
  })

  it('a symlink planted at the store root: nothing lands in its target', async () => {
    const r = await rig()
    const elsewhere = join(tmp, 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, storeOf(r))
    await installed(r, simple())
    expect(readdirSync(elsewhere)).toEqual([])
    expect((await list(r))[0].state).toBe('ok')
  })

  it('a symlink planted at <id> just before confirm: nothing lands in its target', async () => {
    const r = await rig()
    const st = await prepare(r, { kind: 'path', path: simple() })
    const elsewhere = join(tmp, 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, join(storeOf(r), 'demo'))
    await confirm(r, st)
    expect(readdirSync(elsewhere)).toEqual([])
    expect(renameProbe(join(storeOf(r), 'demo'))).toBe(true)
  })

  it('a directory planted at the target version dir is replaced', async () => {
    const r = await rig()
    const st = await prepare(r, { kind: 'path', path: simple() })
    const target = join(storeOf(r), 'demo', st.consent!.integrity.slice('sha256:'.length, 'sha256:'.length + 12))
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'evil'), 'x')
    await confirm(r, st)
    expect(existsSync(join(target, 'evil'))).toBe(false)
    await r.restart()
    expect((await list(r))[0]).toMatchObject({ enabled: true, state: 'ok' })
  })
})

const renameProbe = (p: string) => {
  const moved = `${p}.probe`
  renameSync(p, moved)
  renameSync(moved, p)
  return existsSync(p)
}
