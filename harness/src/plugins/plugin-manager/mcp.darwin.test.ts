// 真 Seatbelt(09 Review Focus 4):临时 home,假服务在插件根里,经 probe_* 回报真实发生的事。
// 每条"读不到"都带能成功的对照,否则什么都干不了也会通过。测试进程自己在沙箱里时不能嵌套 → 整个文件跳过
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { alive, call, storeOf, stubPlugin, until } from '../../../test/managerRig'
import { calling, say } from '../../../test/memoryRig'
import { mcpRig, statusOf, type McpRig, type McpRigOpts } from '../../../test/mcpRig'
import { startFakeUpstream, type FakeServer } from '../../../test/fakeUpstream'
import { buildPlugin, FAKE_MCP, type PluginSpec } from '../../../test/pluginRig'
import { createGit } from '../../lib/git/snapshot'
import { createToolsCoding } from '../tools-coding'
import toolsRegistry from '../tools-registry'

function sandboxExecUsable(): boolean {
  if (process.platform !== 'darwin') return false
  return spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: 'ignore' }).status === 0
}
const usable = sandboxExecUsable()

let tmp = ''
const rigs: McpRig[] = []
let upstream: FakeServer

beforeAll(async () => {
  if (usable) upstream = await startFakeUpstream()
})
afterAll(async () => {
  await upstream?.close()
})
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-mcpd-')))
})
afterEach(async () => {
  for (const m of rigs.splice(0)) await m.dispose()
  rmSync(tmp, { recursive: true, force: true })
})

let n = 0
const plugin = (id: string, mcp: Record<string, object>, spec: Partial<PluginSpec> = {}) =>
  buildPlugin(join(tmp, `p${++n}`), {
    format: 'claude',
    id,
    mcp,
    extra: { 'fake-mcp.mjs': readFileSync(FAKE_MCP, 'utf8'), 'scenario.json': '{}', ...spec.extra },
    ...(spec.manifest && { manifest: spec.manifest }),
  })
const SERVER = { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/fake-mcp.mjs'] }

const jsonOf = (text: string) => {
  const lines = text.split('\n')
  if (!text.startsWith('<mcp-result')) throw new Error(`not a result: ${text}`)
  return JSON.parse(lines.slice(2, -1).join('\n'))
}

async function rig(o: McpRigOpts = {}) {
  const gitBase = { PATH: '/usr/bin:/bin', HOME: tmp, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  const m = await mcpRig({
    stub: false,
    level: 'full',
    kernel: {
      sandbox: {
        detect: () => ({ level: 'full' as const, missing: [] }),
        upstream: { url: new URL(`http://127.0.0.1:${upstream.port}`), noProxy: () => false },
        lookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
        git: createGit({ base: gitBase }),
      },
      ...o.kernel,
    },
    ...(o.config && { config: o.config }),
    ...(o.before && { before: o.before }),
    ...(o.after && { after: o.after }),
    ...(o.layout && { layout: o.layout }),
  })
  rigs.push(m)
  // node 从 PATH 来;它不在临时 home 下,不用放回
  m.r.env.PATH = `${dirname(process.execPath)}:/usr/bin:/bin`
  return m
}

interface Started {
  m: McpRig
  sid: string
  probe(server: string, tool: string, args?: object): Promise<any>
  data(server?: string, id?: string): string
  code(id?: string): string
}

/** grants 按服务名;第一轮钉住视图。auto:没网的服务不问,有网的卡片一律放行 */
async function started(m: McpRig, id = 'x', servers: Record<string, object> = { y: SERVER }, grants: Record<string, { network: string[]; cwd: 'none' | 'read' | 'write' }> = {}, cwd?: string): Promise<Started> {
  await m.r.install(plugin(id, servers), { servers: grants })
  const sid = await m.r.session({ approvalMode: 'auto', ...(cwd && { cwd }) })
  await m.r.turn(sid, 'pin')
  return {
    m,
    sid,
    probe: async (server, tool, args = {}) => jsonOf((await m.mcp(sid, { action: 'call', server, tool, arguments: args })).text),
    data: (server = 'y', pid = id) => join(m.r.dataDir, 'plugin-data', pid, server),
    code: (pid = id) => join(storeOf(m.r), pid, readdirSync(join(storeOf(m.r), pid))[0]),
  }
}

const denied = (r: any) => {
  expect(r.ok).toBe(false)
  expect(['EPERM', 'EACCES']).toContain(r.code)
}

describe.skipIf(!usable)('an MCP server under real Seatbelt', () => {
  it('reads: its root, its data and cwd yes; home, other plugins, credentials, the data dir, spill and shell tmp no', async () => {
    const m = await rig()
    const other = plugin('other', { z: SERVER }, { extra: { 'secret-code.txt': 'other code' } })
    await m.r.install(other)
    const home = m.r.home
    writeFileSync(join(home, 'notes.txt'), 'private notes')
    mkdirSync(join(home, '.ssh'))
    writeFileSync(join(home, '.ssh', 'id_rsa'), 'a private key')
    writeFileSync(join(m.r.cwd, 'in-cwd.txt'), 'cwd file')
    writeFileSync(join(m.r.dataDir, 'data-dir-file'), 'kernel data')
    const s = await started(m)
    await s.m.mcp(s.sid, { action: 'tools', server: 'x/y' })
    const otherData = s.data('z', 'other')
    mkdirSync(otherData, { recursive: true })
    writeFileSync(join(otherData, 'state'), 'other data')
    const spill = join(m.r.dataDir, 'sessions', s.sid, 'spill')
    mkdirSync(spill, { recursive: true })
    writeFileSync(join(spill, 'out.txt'), 'spilled output of the shell')
    const shellTmp = join(m.r.dataDir, 'sessions', s.sid, 'tmp')
    mkdirSync(shellTmp, { recursive: true })
    writeFileSync(join(shellTmp, 'a'), 'shell temp')
    writeFileSync(join(s.data(), 'own'), 'own data')

    // 对照
    expect(await s.probe('x/y', 'probe_read', { path: join(s.code(), 'scenario.json') })).toMatchObject({ ok: true })
    expect(await s.probe('x/y', 'probe_read', { path: join(s.data(), 'own') })).toMatchObject({ ok: true, text: 'own data' })
    expect(await s.probe('x/y', 'probe_read', { path: join(m.r.cwd, 'in-cwd.txt') })).toMatchObject({ ok: true, text: 'cwd file' })
    expect(await s.probe('x/y', 'probe_read', { path: '/etc/hosts' })).toMatchObject({ ok: true })

    for (const path of [
      join(home, 'notes.txt'),
      join(home, '.ssh', 'id_rsa'),
      join(s.code('other'), 'secret-code.txt'),
      join(otherData, 'state'),
      join(m.r.dataDir, 'data-dir-file'),
      join(spill, 'out.txt'),
      join(shellTmp, 'a'),
      join(m.r.dataDir, 'config.json'),
    ])
      denied(await s.probe('x/y', 'probe_read', { path }))
  }, 60_000)

  it('writes: own data yes; own root no, and the next start still passes its integrity check; cwd no by default', async () => {
    const m = await rig()
    const s = await started(m)
    expect(await s.probe('x/y', 'probe_write', { path: join(s.data(), 'w'), text: 'ok' })).toEqual({ ok: true })
    expect(readFileSync(join(s.data(), 'w'), 'utf8')).toBe('ok')
    denied(await s.probe('x/y', 'probe_write', { path: join(s.code(), 'evil.txt'), text: 'x' }))
    denied(await s.probe('x/y', 'probe_write', { path: join(m.r.cwd, 'evil.txt'), text: 'x' }))
    expect(existsSync(join(m.r.cwd, 'evil.txt'))).toBe(false)
    // 打码会盖住系统临时目录里长得像令牌的段:路径让服务自己比
    const ownTmp = join(m.r.dataDir, 'sessions', s.sid, 'mcp', createHash('sha256').update('x/y').digest('hex').slice(0, 12), 'tmp')
    const { same } = await s.probe('x/y', 'probe_env', { same: { HOME: s.data(), TMPDIR: ownTmp } })
    expect(same).toEqual({ HOME: true, TMPDIR: true })
    expect(await s.probe('x/y', 'probe_write', { path: join(ownTmp, 'mine'), text: 'mine' })).toEqual({ ok: true })
    // calls.jsonl 落回 $HOME:存储里写不进去
    expect(existsSync(join(s.data(), 'calls.jsonl'))).toBe(true)
    expect(existsSync(join(s.code(), 'calls.jsonl'))).toBe(false)
    process.kill(-s.m.pids[0], 'SIGKILL')
    await until(() => m.live().length === 0)
    expect((await s.probe('x/y', 'probe_read', { path: join(s.data(), 'w') })).text).toBe('ok')
  }, 60_000)

  it("cwd:'write' is writable; cwd:'none' is unreadable even outside home", async () => {
    const m = await rig()
    writeFileSync(join(m.r.cwd, 'f.txt'), 'x')
    const s = await started(m, 'x', { w: SERVER, n: SERVER }, { w: { network: [], cwd: 'write' }, n: { network: [], cwd: 'none' } })
    expect(await s.probe('x/w', 'probe_write', { path: join(m.r.cwd, 'made.txt'), text: 'yes' })).toEqual({ ok: true })
    expect(readFileSync(join(m.r.cwd, 'made.txt'), 'utf8')).toBe('yes')
    denied(await s.probe('x/n', 'probe_read', { path: join(m.r.cwd, 'f.txt') }))
    denied(await s.probe('x/n', 'probe_write', { path: join(m.r.cwd, 'made2.txt'), text: 'no' }))
    expect((await s.probe('x/n', 'probe_env', { cwdIs: s.data('n') })).cwdIs).toBe(true)
  }, 60_000)

  it("server A's data is unreadable by server B of the same plugin", async () => {
    const m = await rig()
    const s = await started(m, 'x', { a: SERVER, b: SERVER })
    expect(await s.probe('x/a', 'probe_write', { path: join(s.data('a'), 'state'), text: 'of a' })).toEqual({ ok: true })
    denied(await s.probe('x/b', 'probe_read', { path: join(s.data('a'), 'state') }))
    denied(await s.probe('x/b', 'probe_write', { path: join(s.data('a'), 'more'), text: 'x' }))
    const tmpOf = (server: string) => join(m.r.dataDir, 'sessions', s.sid, 'mcp', createHash('sha256').update(`x/${server}`).digest('hex').slice(0, 12), 'tmp')
    expect(await s.probe('x/a', 'probe_write', { path: join(tmpOf('a'), 't'), text: 'of a' })).toEqual({ ok: true })
    denied(await s.probe('x/b', 'probe_read', { path: join(tmpOf('a'), 't') }))
  }, 60_000)

  it('$TMPDIR of the worker and /tmp are unreadable', async () => {
    const m = await rig()
    const s = await started(m)
    const inTmp = join(realpathSync(tmpdir()), `mffai-mcpd-probe-${process.pid}-${++n}`)
    const inSlashTmp = `/tmp/mffai-mcpd-probe-${process.pid}-${++n}`
    writeFileSync(inTmp, 'tmp file')
    writeFileSync(inSlashTmp, 'slash tmp file')
    try {
      denied(await s.probe('x/y', 'probe_read', { path: inTmp }))
      denied(await s.probe('x/y', 'probe_read', { path: inSlashTmp }))
      denied(await s.probe('x/y', 'probe_write', { path: `${inSlashTmp}-w`, text: 'x' }))
      expect(existsSync(`${inSlashTmp}-w`)).toBe(false)
    } finally {
      rmSync(inTmp, { force: true })
      rmSync(inSlashTmp, { force: true })
    }
  }, 60_000)

  describe('production layout: what a program on PATH opens of home (C1)', () => {
    const put = (p: string, text = 'x') => {
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, text)
    }
    const program = (p: string) => {
      put(p, `#!/bin/sh\nexec ${process.execPath} "$@"\n`)
      chmodSync(p, 0o755)
    }
    const startOn = async (m: McpRig, bin: string) => {
      m.r.env.PATH = `${bin}:/usr/bin:/bin`
      return started(m, 'x', { y: { command: 'rt', args: ['${CLAUDE_PLUGIN_ROOT}/fake-mcp.mjs'] } })
    }

    it.each([
      ['Library/pnpm/rt', ['Library/pnpm/sibling'], ['Library/Cookies/Cookies.binarycookies', 'Library/Application Support/Google/Chrome/Default/Login Data', 'Library/Messages/chat.db']],
      ['.cargo/bin/rt', ['.cargo/bin/sibling'], ['.cargo/credentials.toml', '.cargo/credentials', '.cargo/registry/index']],
      ['.local/bin/rt', ['.local/bin/sibling'], ['.local/share/gh/token', '.local/share/opencode/auth.json']],
      ['.gem/bin/rt', ['.gem/bin/sibling'], ['.gem/credentials', '.gem/specs/x']],
      ['.config/bin/rt', ['.config/bin/sibling'], ['.config/gcloud/creds.json', '.config/other/token', '.config/kept.txt']],
      ['.npm-global/bin/rt', ['.npm-global/bin/sibling'], ['.npm-global/lib/secret', '.npm-global/etc/npmrc']],
    ])('%s: its directory reads, the rest of that part of home does not', async (prog, open, closed) => {
      const m = await rig({ layout: 'production' })
      program(join(m.r.home, prog))
      for (const f of [...open, ...closed, 'notes.txt']) put(join(m.r.home, f), 'content')
      const s = await startOn(m, join(m.r.home, dirname(prog)))
      for (const f of open) expect(await s.probe('x/y', 'probe_read', { path: join(m.r.home, f) })).toMatchObject({ ok: true })
      for (const f of [...closed, 'notes.txt']) denied(await s.probe('x/y', 'probe_read', { path: join(m.r.home, f) }))
    }, 60_000)

    it('~/.local/bin/x as a link: only the link directory and the real directory', async () => {
      const m = await rig({ layout: 'production' })
      program(join(m.r.home, '.local', 'share', 'tool', 'run'))
      mkdirSync(join(m.r.home, '.local', 'bin'), { recursive: true })
      symlinkSync(join(m.r.home, '.local', 'share', 'tool', 'run'), join(m.r.home, '.local', 'bin', 'rt'))
      for (const f of ['.local/share/tool/lib.txt', '.local/share/gh/token', '.local/share/opencode/auth.json']) put(join(m.r.home, f), 'content')
      const s = await startOn(m, join(m.r.home, '.local', 'bin'))
      expect(await s.probe('x/y', 'probe_read', { path: join(m.r.home, '.local/share/tool/lib.txt') })).toMatchObject({ ok: true })
      denied(await s.probe('x/y', 'probe_read', { path: join(m.r.home, '.local/share/gh/token') }))
      denied(await s.probe('x/y', 'probe_read', { path: join(m.r.home, '.local/share/opencode/auth.json') }))
    }, 60_000)

    it.each([
      ['.nvm/versions/node/v20', '.nvm/versions/node/v18', 'lib'],
      ['.fnm/node-versions/v20/installation', '.fnm/node-versions/v18/installation', 'lib'],
      ['.volta/tools/image/node/20.1', '.volta/tools/image/node/18.1', 'lib'],
      ['.asdf/installs/nodejs/20', '.asdf/installs/python/3.12', 'lib'],
      ['.local/share/mise/installs/python/3.12', '.local/share/mise/installs/python/3.11', 'lib'],
      ['.pyenv/versions/3.12', '.pyenv/versions/3.11', 'lib'],
      ['.rbenv/versions/3.3', '.rbenv/versions/3.2', 'lib'],
      ['.local/share/uv/tools/ruff', '.local/share/uv/tools/black', 'lib'],
      ['.local/share/uv/python/cpython-3.12', '.local/share/uv/python/cpython-3.11', 'lib'],
      ['.local/pipx/venvs/black', '.local/pipx/venvs/ruff', 'lib'],
      ['.bun/install/global', '.bun/install/cache', 'node_modules'],
    ])('known layout %s: its neighbour %s and its config do not read, its %s does', async (root, neighbour, part) => {
      const m = await rig({ layout: 'production' })
      program(join(m.r.home, root, 'bin', 'rt'))
      put(join(m.r.home, root, part, 'module.js'), 'runtime file')
      put(join(m.r.home, neighbour, part, 'module.js'), 'not this one')
      const token = '//registry.npmjs.org/:_authToken=npm_' + 'x'.repeat(36)
      for (const f of ['etc/npmrc', '.npmrc', 'pip.conf', 'share/secret', 'include/secret']) put(join(m.r.home, root, f), token)
      const s = await startOn(m, join(m.r.home, root, 'bin'))
      expect(await s.probe('x/y', 'probe_read', { path: join(m.r.home, root, part, 'module.js') })).toMatchObject({ ok: true, text: 'runtime file' })
      denied(await s.probe('x/y', 'probe_read', { path: join(m.r.home, neighbour, part, 'module.js') }))
      for (const f of ['etc/npmrc', '.npmrc', 'pip.conf', 'share/secret', 'include/secret']) denied(await s.probe('x/y', 'probe_read', { path: join(m.r.home, root, f) }))
    }, 60_000)

    it('I-1: a copied node in an nvm layout starts and runs node -e; its etc/npmrc token is unreadable, even with cwd at the runtime root', async () => {
      const m = await rig({ layout: 'production' })
      const root = join(m.r.home, '.nvm', 'versions', 'node', 'v20')
      mkdirSync(join(root, 'bin'), { recursive: true })
      copyFileSync(process.execPath, join(root, 'bin', 'node'), constants.COPYFILE_FICLONE)
      chmodSync(join(root, 'bin', 'node'), 0o755)
      // Homebrew 的 node 从 @loader_path/../lib 载 libnode:lib 读不到它就起不来
      const libs = join(dirname(process.execPath), '..', 'lib')
      mkdirSync(join(root, 'lib'), { recursive: true })
      for (const f of existsSync(libs) ? readdirSync(libs).filter(f => f.endsWith('.dylib')) : []) copyFileSync(join(libs, f), join(root, 'lib', f), constants.COPYFILE_FICLONE)
      const token = '//registry.npmjs.org/:_authToken=npm_' + 'y'.repeat(36)
      put(join(root, 'etc', 'npmrc'), token)
      put(join(root, '.npmrc'), token)
      m.r.env.PATH = `${join(root, 'bin')}:/usr/bin:/bin`
      const s = await started(m, 'x', { y: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/fake-mcp.mjs'] } })
      const self = join(root, 'bin', 'node')
      // 打码会盖住临时目录里像令牌的段:路径让子进程自己比
      const { exec } = await s.probe('x/y', 'probe_children', { exec: [self, '-e', `console.log(process.execPath === ${JSON.stringify(self)} ? 'ran here' : 'elsewhere')`] })
      expect(exec.status).toBe(0)
      expect(String(exec.stdout).trim()).toBe('ran here')
      denied(await s.probe('x/y', 'probe_read', { path: join(root, 'etc', 'npmrc') }))
      denied(await s.probe('x/y', 'probe_read', { path: join(root, '.npmrc') }))
      // 第二道墙:cwd 就是运行时根,整棵放回了,配置照样读不到
      const at = await started(m, 'x2', { y: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/fake-mcp.mjs'] } }, {}, root)
      expect(await at.probe('x2/y', 'probe_read', { path: join(root, 'bin', 'node') })).toMatchObject({ ok: true })
      denied(await at.probe('x2/y', 'probe_read', { path: join(root, 'etc', 'npmrc') }))
      denied(await at.probe('x2/y', 'probe_read', { path: join(root, '.npmrc') }))
    }, 90_000)

    it('containment holds with the data dir and the store inside home', async () => {
      const m = await rig({ layout: 'production' })
      put(join(m.r.home, 'notes.txt'), 'private')
      put(join(m.r.cwd, 'in-cwd.txt'), 'cwd')
      put(join(m.r.home, 'work', 'other', 'a.txt'), 'another project')
      const s = await started(m)
      expect(await s.probe('x/y', 'probe_read', { path: join(m.r.cwd, 'in-cwd.txt') })).toMatchObject({ ok: true })
      expect(await s.probe('x/y', 'probe_read', { path: join(s.code(), 'scenario.json') })).toMatchObject({ ok: true })
      expect(await s.probe('x/y', 'probe_write', { path: join(s.data(), 'w'), text: 'ok' })).toEqual({ ok: true })
      denied(await s.probe('x/y', 'probe_read', { path: join(m.r.home, 'notes.txt') }))
      denied(await s.probe('x/y', 'probe_read', { path: join(m.r.home, 'work', 'other', 'a.txt') }))
      denied(await s.probe('x/y', 'probe_read', { path: join(m.r.dataDir, 'config.json') }))
      denied(await s.probe('x/y', 'probe_write', { path: join(m.r.home, 'w'), text: 'x' }))
    }, 60_000)
  })

  it('m1: the per-user cache dir and /var/tmp are unreadable, and node still runs', async () => {
    const m = await rig()
    const s = await started(m)
    const cacheDir = execFileSync('/usr/bin/getconf', ['DARWIN_USER_CACHE_DIR'], { encoding: 'utf8' }).trim().replace(/\/$/, '')
    const inCache = join(realpathSync(cacheDir), `mffai-mcpd-probe-${process.pid}-${++n}`)
    const inVarTmp = `/var/tmp/mffai-mcpd-probe-${process.pid}-${++n}`
    writeFileSync(inCache, 'cache file')
    writeFileSync(inVarTmp, 'var tmp file')
    try {
      denied(await s.probe('x/y', 'probe_read', { path: inCache }))
      denied(await s.probe('x/y', 'probe_read', { path: inVarTmp }))
      denied(await s.probe('x/y', 'probe_write', { path: `${inVarTmp}-w`, text: 'x' }))
    } finally {
      rmSync(inCache, { force: true })
      rmSync(inVarTmp, { force: true })
      rmSync(`${inVarTmp}-w`, { force: true })
    }
  }, 60_000)

  it('a runtime root under a hidden root outside home still runs; a credential dir there is hidden', async () => {
    const m = await rig()
    const bin = join(m.r.root, 'rt', 'bin')
    mkdirSync(bin, { recursive: true })
    const prog = join(bin, 'rtnode')
    writeFileSync(prog, `#!/bin/sh\nexec ${process.execPath} "$@"\n`)
    chmodSync(prog, 0o755)
    writeFileSync(join(m.r.root, 'rt', 'kept.txt'), 'in the runtime root')
    writeFileSync(join(m.r.root, 'beside.txt'), 'beside it')
    m.r.env.PATH = `${bin}:/usr/bin:/bin`
    const s = await started(m, 'x', { y: { command: 'rtnode', args: ['${CLAUDE_PLUGIN_ROOT}/fake-mcp.mjs'] } })
    expect(await s.probe('x/y', 'probe_read', { path: join(m.r.root, 'rt', 'kept.txt') })).toMatchObject({ ok: true })
    denied(await s.probe('x/y', 'probe_read', { path: join(m.r.root, 'beside.txt') }))
  }, 60_000)

  it('a session at home: cwd_too_broad, never spawned', async () => {
    const m = await rig()
    await m.r.install(plugin('x', { y: SERVER }))
    const sid = await m.r.session({ approvalMode: 'auto', cwd: m.r.home })
    await m.r.turn(sid, 'pin')
    expect((await m.mcp(sid, { action: 'tools', server: 'x/y' })).text).toBe('cwd_too_broad')
    expect(m.spawns).toEqual([])
  }, 60_000)

  it("a store byte changed after startup: the next start refuses, the plugin's marker never written", async () => {
    const m = await rig()
    const s = await started(m)
    writeFileSync(join(s.code(), 'scenario.json'), '{"neverInit":true}')
    expect((await m.mcp(s.sid, { action: 'tools', server: 'x/y' })).text).toBe('integrity_failed')
    expect(m.spawns).toEqual([])
  }, 60_000)

  it('network with no hosts fails for a host on the default list, and direct', async () => {
    const m = await rig()
    const s = await started(m)
    const before = upstream.connects.length
    const via = await s.probe('x/y', 'probe_fetch', { host: 'github.com', port: 443 })
    expect(via).toMatchObject({ ok: false, status: 403, via: 'proxy' })
    expect((await s.probe('x/y', 'probe_fetch', { host: 'github.com', port: 443, direct: true, timeoutMs: 1500 })).ok).toBe(false)
    expect(upstream.connects.length).toBe(before)
  }, 60_000)

  it('network with no hosts fails for loopback even with allowLoopback:true, while the level says partial', async () => {
    const listening: Server = createServer(sock => sock.destroy())
    await new Promise<void>(res => listening.listen(0, '127.0.0.1', res))
    const port = (listening.address() as { port: number }).port
    try {
      const m = await rig({ config: { permissions: { sandbox: { allowLoopback: true } } } })
      const s = await started(m)
      const res = await s.probe('x/y', 'probe_fetch', { host: '127.0.0.1', port, direct: true, timeoutMs: 1500 })
      expect(res.ok).toBe(false)
      const { env } = await s.probe('x/y', 'probe_env')
      expect(env.NO_PROXY).toBe('')
      expect((await s.probe('x/y', 'probe_fetch', { host: '127.0.0.1', port })).ok).toBe(false)
    } finally {
      await new Promise<void>(res => listening.close(() => res()))
    }
  }, 60_000)

  it('a granted host through the fake upstream succeeds, only for that host', async () => {
    const m = await rig()
    const s = await started(m, 'x', { y: SERVER }, { y: { network: ['granted.example'], cwd: 'read' } })
    const before = upstream.connects.length
    expect(await s.probe('x/y', 'probe_fetch', { host: 'granted.example', port: 443 })).toMatchObject({ ok: true, status: 200 })
    expect(await s.probe('x/y', 'probe_fetch', { host: 'other.example', port: 443 })).toMatchObject({ ok: false, status: 403 })
    expect(await s.probe('x/y', 'probe_fetch', { host: 'github.com', port: 443 })).toMatchObject({ ok: false, status: 403 })
    expect(upstream.connects.slice(before).map(c => c.line)).toEqual(['CONNECT granted.example:443 HTTP/1.1'])
  }, 60_000)

  it('M3: after narrowing a grant, an immediate restart reaches no dropped host', async () => {
    const m = await rig()
    const s = await started(m, 'x', { y: SERVER }, { y: { network: ['granted.example', 'kept.example'], cwd: 'read' } })
    expect((await s.probe('x/y', 'probe_fetch', { host: 'granted.example', port: 443 })).ok).toBe(true)
    await call(m.r, 'plugins.grants.set', { commandId: 'g', id: 'x', grants: { servers: { y: { network: ['kept.example'], cwd: 'read' } } } })
    expect(m.live()).toEqual([])
    const before = upstream.connects.length
    expect(await s.probe('x/y', 'probe_fetch', { host: 'granted.example', port: 443 })).toMatchObject({ ok: false, status: 403 })
    expect((await s.probe('x/y', 'probe_fetch', { host: 'kept.example', port: 443 })).ok).toBe(true)
    expect(upstream.connects.slice(before).map(c => c.line)).toEqual(['CONNECT kept.example:443 HTTP/1.1'])
  }, 60_000)

  it("env: exactly the whitelist plus declared, under the sandbox's own additions", async () => {
    const m = await rig()
    Object.assign(m.r.env, { RANDOM_THING: 'nope', OPENAI_API_KEY: 'sk-' + 'a'.repeat(24) })
    const s = await started(m, 'x', { y: { ...SERVER, env: { DECLARED: 'v' } } })
    const { env } = await s.probe('x/y', 'probe_env')
    expect(env.RANDOM_THING).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.DECLARED).toBe('v')
    expect(env.MFFAI_SANDBOX).toBe('full')
  }, 60_000)

  it('a level of none through permissions.set: needs_sandbox, zero spawns, under allow shell(mcp *) too', async () => {
    const m = await rig({ config: { permissions: { allowUnsandboxedAuto: true, rules: [{ effect: 'allow', rule: 'shell(mcp *)' }] } } })
    const s = await started(m)
    await call(m.r, 'permissions.set', { commandId: 'off', config: { sandbox: { enabled: false } } })
    expect((await m.mcp(s.sid, { action: 'tools', server: 'x/y' })).text).toBe('needs_sandbox')
    expect((await m.mcp(s.sid, { action: 'call', server: 'x/y', tool: 'echo', arguments: {} })).text).toBe('needs_sandbox')
    expect(m.spawns).toEqual([])
    expect((await statusOf(m.r, s.sid))[0].state).toBe('needs_sandbox')
  }, 60_000)

  it("a session's write and sandboxed shell can't change the store, even at cwd = home", async () => {
    const m = await rig({ before: () => [toolsRegistry, createToolsCoding({ loginPath: async () => '' }), stubPlugin()] })
    await m.r.install(plugin('x', { y: SERVER }))
    const sid = await m.r.session({ approvalMode: 'auto', cwd: m.r.home })
    await m.r.turn(sid, 'pin')
    const store = storeOf(m.r)
    const code = join(store, 'x', readdirSync(join(store, 'x'))[0])
    const victim = join(code, 'scenario.json')
    const before = readFileSync(victim, 'utf8')
    m.queue.push(
      calling('w1', 'write', { path: victim, content: 'overwritten' }),
      calling('s1', 'shell', { command: `echo overwritten > ${JSON.stringify(victim)}; touch ${JSON.stringify(join(code, 'planted'))}; echo done` }),
      say('done'),
    )
    await m.r.turn(sid, 'go')
    expect(readFileSync(victim, 'utf8')).toBe(before)
    expect(existsSync(join(code, 'planted'))).toBe(false)
    expect((await m.mcp(sid, { action: 'tools', server: 'x/y' })).text).toBe('cwd_too_broad')
  }, 60_000)

  it("a session's write and sandboxed shell can't change dev-plugins, even at cwd = home with the data dir inside it", async () => {
    const m = await rig({ layout: 'production', before: () => [toolsRegistry, createToolsCoding({ loginPath: async () => '' }), stubPlugin()] })
    const src = join(m.r.root, 'dev-src')
    mkdirSync(src)
    writeFileSync(join(src, 'mff-plugin.json'), JSON.stringify({ id: 'dev-x', version: '1.0.0', main: 'p.mjs' }))
    writeFileSync(join(src, 'p.mjs'), 'export default {}\n')
    await call(m.r, 'plugins.dev.trust', { path: src, acknowledge: 'runs_with_full_access' })
    const root = join(m.r.dataDir, 'dev-plugins')
    const dir = join(root, 'dev-x')
    const copy = join(dir, readdirSync(dir)[0])
    const index = join(root, 'index.json')
    const before = [readFileSync(copy, 'utf8'), readFileSync(index, 'utf8')]
    const sid = await m.r.session({ approvalMode: 'auto', cwd: m.r.home })
    await m.r.turn(sid, 'pin')
    // 对照:同一条命令写得到 home 里的普通文件,说明命令真跑了
    const control = join(m.r.home, 'control.txt')
    m.queue.push(
      calling('w1', 'write', { path: copy, content: 'overwritten' }),
      calling('w2', 'write', { path: index, content: 'overwritten' }),
      calling('s1', 'shell', { command: `echo ran > ${JSON.stringify(control)}; echo overwritten > ${JSON.stringify(copy)}; echo overwritten > ${JSON.stringify(index)}; touch ${JSON.stringify(join(dir, 'planted'))}; mkdir ${JSON.stringify(join(root, 'dev-y'))}; echo done` }),
      say('done'),
    )
    await m.r.turn(sid, 'go')
    expect(readFileSync(control, 'utf8')).toBe('ran\n')
    expect([readFileSync(copy, 'utf8'), readFileSync(index, 'utf8')]).toEqual(before)
    expect(readdirSync(dir)).toEqual([copy.split('/').pop()])
    expect(readdirSync(root).sort()).toEqual(['dev-x', 'index.json'])
  }, 60_000)

  it('a detached child and the server are both gone after disable, proven by pid', async () => {
    const m = await rig()
    const s = await started(m)
    const { self, spawned } = await s.probe('x/y', 'probe_children', { spawn: true })
    expect(alive(spawned)).toBe(true)
    expect(m.pids).toContain(self.pid)
    await call(m.r, 'plugins.setEnabled', { commandId: 'off', id: 'x', enabled: false })
    await until(() => !alive(spawned), 6000)
    expect(alive(self.pid)).toBe(false)
  }, 60_000)

  it('a link planted in its own data dir reaches nothing: the rule follows the real path', async () => {
    const m = await rig()
    writeFileSync(join(m.r.home, 'notes.txt'), 'private notes')
    const s = await started(m)
    await s.m.mcp(s.sid, { action: 'tools', server: 'x/y' })
    symlinkSync(join(m.r.home, 'notes.txt'), join(s.data(), 'link-to-notes'))
    symlinkSync(s.data('z', 'other'), join(s.data(), 'link-to-other'))
    denied(await s.probe('x/y', 'probe_read', { path: join(s.data(), 'link-to-notes') }))
    denied(await s.probe('x/y', 'probe_write', { path: join(s.data(), 'link-to-notes'), text: 'x' }))
    expect(readFileSync(join(m.r.home, 'notes.txt'), 'utf8')).toBe('private notes')
  }, 60_000)

  it("a link it leaves as .spill is gone at the next start, so the plan's re-allowed path opens nothing", async () => {
    const m = await rig()
    writeFileSync(join(m.r.home, 'notes.txt'), 'private notes')
    const s = await started(m)
    await s.m.mcp(s.sid, { action: 'tools', server: 'x/y' })
    const spill = join(s.data(), '.spill')
    rmSync(spill, { recursive: true })
    symlinkSync(m.r.home, spill)
    process.kill(-m.pids[0], 'SIGKILL')
    await until(() => m.live().length === 0)
    denied(await s.probe('x/y', 'probe_read', { path: join(m.r.home, 'notes.txt') }))
    // 新的空目录:链接没了,里面什么都没有
    expect(await s.probe('x/y', 'probe_read', { path: join(spill, 'notes.txt') })).toMatchObject({ ok: false, code: 'ENOENT' })
    expect(lstatSync(spill).isDirectory()).toBe(true)
  }, 60_000)

  it("cwd:'write' still can't plant what runs outside the sandbox: git hooks and config, CLI project config", async () => {
    const m = await rig()
    const repo = join(m.r.root, 'repo')
    mkdirSync(repo)
    writeFileSync(join(repo, 'README'), 'x')
    const env = { PATH: '/usr/bin:/bin', HOME: m.r.home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, env, stdio: 'ignore' })
    git('init', '-q')
    git('add', '-A')
    git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init')
    const config = readFileSync(join(repo, '.git', 'config'), 'utf8')
    mkdirSync(join(repo, '.codex'))
    const s = await started(m, 'x', { y: SERVER }, { y: { network: [], cwd: 'write' } }, repo)
    expect(await s.probe('x/y', 'probe_write', { path: join(repo, 'ordinary.txt'), text: 'fine' })).toEqual({ ok: true })
    denied(await s.probe('x/y', 'probe_write', { path: join(repo, '.git', 'hooks', 'pre-commit'), text: '#!/bin/sh' }))
    denied(await s.probe('x/y', 'probe_write', { path: join(repo, '.git', 'config'), text: 'evil' }))
    denied(await s.probe('x/y', 'probe_write', { path: join(repo, '.codex', 'config.toml'), text: 'evil' }))
    expect(readFileSync(join(repo, '.git', 'config'), 'utf8')).toBe(config)
    expect(existsSync(join(repo, '.git', 'hooks', 'pre-commit'))).toBe(false)
  }, 60_000)

  it('rules through the real policy: deny read(**/x*) makes every call mustAsk; deny shell(git push*) alone does not', async () => {
    const untranslatable = await rig({ config: { permissions: { rules: [{ effect: 'deny', rule: 'read(**/x*)' }] } } })
    const a = await started(untranslatable)
    const started1 = await untranslatable.mcp(a.sid, { action: 'tools', server: 'x/y' }, { decide: 'allow_session' })
    expect(started1.cards.length).toBe(1)
    const c1 = await untranslatable.mcp(a.sid, { action: 'call', server: 'x/y', tool: 'echo', arguments: {} }, { decide: 'allow_session' })
    expect(c1.cards.length).toBe(1)
    expect(c1.cards[0].key).toBeUndefined()
    expect((await untranslatable.mcp(a.sid, { action: 'call', server: 'x/y', tool: 'echo', arguments: {} })).cards.length).toBe(1)
    const shellOnly = await rig({ config: { permissions: { rules: [{ effect: 'deny', rule: 'shell(git push*)' }] } } })
    const b = await started(shellOnly)
    expect((await shellOnly.mcp(b.sid, { action: 'call', server: 'x/y', tool: 'echo', arguments: {} })).cards).toEqual([])
  }, 60_000)

  it('a literal deny read rule reaches the sandbox: the file is unreadable in a kept cwd', async () => {
    const m = await rig({ config: { permissions: { rules: [{ effect: 'deny', rule: 'read(./private/**)' }] } } })
    mkdirSync(join(m.r.cwd, 'private'))
    writeFileSync(join(m.r.cwd, 'private', 'x.txt'), 'denied by the user')
    writeFileSync(join(m.r.cwd, 'open.txt'), 'open')
    const s = await started(m)
    expect(await s.probe('x/y', 'probe_read', { path: join(m.r.cwd, 'open.txt') })).toMatchObject({ ok: true })
    denied(await s.probe('x/y', 'probe_read', { path: join(m.r.cwd, 'private', 'x.txt') }))
  }, 60_000)

  it('I2: a detached child under the sandbox does not outlive kernel.close', async () => {
    const m = await rig()
    const s = await started(m)
    const { spawned } = await s.probe('x/y', 'probe_children', { spawn: true })
    expect(alive(spawned)).toBe(true)
    await m.r.kernel.close()
    try {
      await until(() => !alive(spawned), 1000)
    } finally {
      if (alive(spawned)) process.kill(spawned, 'SIGKILL')
    }
  }, 60_000)

  describe('I4: POSIX shared memory does not launder data between servers', () => {
    const PY = `
import ctypes, mmap, os, sys
libc = ctypes.CDLL(None, use_errno=True)
libc.shm_open.argtypes = [ctypes.c_char_p, ctypes.c_int, ctypes.c_int]
libc.shm_unlink.argtypes = [ctypes.c_char_p]
op, name, text = sys.argv[1], sys.argv[2].encode(), sys.argv[3] if len(sys.argv) > 3 else ''
if op == 'unlink':
    libc.shm_unlink(name); print('unlinked'); sys.exit(0)
flags = os.O_RDWR | os.O_CREAT if op == 'write' else os.O_RDONLY
fd = libc.shm_open(name, flags, 0o600)
if fd < 0:
    print('refused', ctypes.get_errno()); sys.exit(0)
if op == 'write':
    os.ftruncate(fd, 4096)
    m = mmap.mmap(fd, 4096); m[:len(text)] = text.encode(); m.close(); print('wrote')
else:
    m = mmap.mmap(fd, 4096, prot=mmap.PROT_READ); print('read', m[:64].rstrip(bytes(1)).decode())
`
    const py = (...a: string[]) => ['/usr/bin/python3', '-c', PY, ...a]
    const outside = (...a: string[]) => execFileSync(py(...a)[0], py(...a).slice(1), { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: tmp } }).trim()
    const inside = async (s: Started, server: string, ...a: string[]) => {
      const { exec } = await s.probe(server, 'probe_children', { exec: py(...a), timeoutMs: 45_000 })
      expect(exec.status).toBe(0) // python 真的跑起来了:失败不是因为根本没跑
      return String(exec.stdout).trim()
    }

    it.each([['/psm_mff_', 'psm'], ['/mp-mff_', 'mp'], ['/mffother_', 'other']])('%s: a no-network server cannot pass data to a networked one', async prefix => {
      const name = `${prefix}${process.pid}_${++n}`
      const m = await rig()
      const s = await started(m, 'x', { quiet: SERVER, net: SERVER }, { net: { network: ['granted.example'], cwd: 'read' } })
      try {
        // 对照:沙箱外同一段内存读写都行,所以下面的拒绝是沙箱给的
        expect(outside('write', name, 'from-outside')).toBe('wrote')
        expect(outside('read', name)).toBe('read from-outside')
        expect(await inside(s, 'x/quiet', 'read', name)).toMatch(/^refused/)
        expect(await inside(s, 'x/quiet', 'write', name, 'stolen-cwd-data')).toMatch(/^refused/)
        expect(await inside(s, 'x/net', 'read', name)).toMatch(/^refused/)
        expect(outside('read', name)).toBe('read from-outside')
      } finally {
        outside('unlink', name)
      }
    }, 120_000)
  })

  it("I6: under the sandbox too, a cwd:'write' server's timer writes nothing after its turn", async () => {
    const m = await rig()
    const s = await started(m, 'x', { y: SERVER }, { y: { network: [], cwd: 'write' } })
    const late = join(m.r.cwd, 'late.txt')
    expect(await s.probe('x/y', 'probe_write', { path: late, text: 'late', afterMs: 400 })).toMatchObject({ later: true })
    expect(m.live()).toEqual([])
    await new Promise(res => setTimeout(res, 700))
    expect(existsSync(late)).toBe(false)
    expect(await s.probe('x/y', 'probe_write', { path: join(m.r.cwd, 'in.txt'), text: 'in' })).toEqual({ ok: true })
    expect(m.pids.length).toBe(2)
  }, 60_000)

  it('kernel.close leaves no pid', async () => {
    const m = await rig()
    const s = await started(m)
    await m.mcp(s.sid, { action: 'tools', server: 'x/y' })
    expect(m.live().length).toBe(1)
    await m.r.kernel.close()
    await until(() => m.live().length === 0, 3000)
  }, 60_000)
})
