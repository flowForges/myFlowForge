// MCP 宿主(09 spec §10.3、Review Focus 4、6)。沙箱是记录选项的 stub,进程是真的假服务;
// 真 Seatbelt 的行在 mcp.darwin.test.ts,卡片和门在 mcpTool.test.ts。每个用例结束都证明 pid 没了
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { alive, call, confirm, eventsOf, installedFile, prepare, refused, snapshot, storeOf, stubPlugin, until } from '../../../test/managerRig'
import { fakeClock } from '../../../test/memoryRig'
import { fakeOutside, mcpRig, statusEvents, statusOf, type McpRig, type McpRigOpts } from '../../../test/mcpRig'
import { buildPlugin, type PluginSpec } from '../../../test/pluginRig'
import { wipeSessionTmp } from '../../kernel/sandbox'
import { DEFAULT_CALL_MS, DEFAULT_INIT_MS } from '../../lib/mcp/client'
import { MAX_LINE } from '../../lib/mcp/stdio'
import { pgidFile, reapOrphans } from '../../lib/proc/pgids'
import toolsRegistry from '../tools-registry'
import { heldTop, IDLE_MS, tempTops, MAX_PER_SESSION, MAX_SERVERS, resolveProgram, runtimeRoots } from './mcpHost'

let tmp: string
const rigs: McpRig[] = []
const stray: number[] = []
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-mcph-')))
})
afterEach(async () => {
  for (const m of rigs.splice(0)) await m.dispose()
  for (const p of stray.splice(0)) {
    try {
      process.kill(p, 'SIGKILL')
    } catch {
      /* 已经没了 */
    }
    await until(() => !alive(p), 3000)
  }
  rmSync(tmp, { recursive: true, force: true })
})

let n = 0
const dirFor = () => join(tmp, `d${++n}`)
const planOf = (m: McpRig, i = -1) => m.sandbox!.plans.at(i)!
const bodyOf = (text: string) => {
  const lines = text.split('\n')
  return lines.slice(2, -1).join('\n')
}
const jsonOf = (text: string) => JSON.parse(bodyOf(text))

interface SetupOpts extends McpRigOpts {
  spec?: Partial<PluginSpec>
  grants?: Record<string, { network: string[]; cwd: 'none' | 'read' | 'write' }>
  cwd?: string
  sessionCwd?: (m: McpRig) => string
  approvalMode?: 'ask' | 'auto'
}

async function rigOnly(o: McpRigOpts = {}) {
  const m = await mcpRig(o)
  rigs.push(m)
  return m
}

/** 插件 x;mcp 是服务配置。第一轮钉住视图 */
async function setup(mcp: Record<string, unknown>, o: SetupOpts = {}) {
  const m = await rigOnly(o)
  await m.r.install(buildPlugin(dirFor(), { format: 'claude', id: 'x', mcp, ...o.spec }), { servers: o.grants ?? {} })
  const sid = await m.r.session({ approvalMode: o.approvalMode ?? 'auto', ...(o.cwd && { cwd: o.cwd }), ...(o.sessionCwd && { cwd: o.sessionCwd(m) }) })
  await m.r.turn(sid, 'pin')
  return { ...m, sid }
}

const fake = (scenario: object = {}, sub?: string) => fakeOutside(dirFor(), scenario, sub)
const statusEventsOf = async (m: McpRig & { sid: string }) => statusEvents(m.r, m.sid).map(s => s.state)

describe('the plan each server gets', () => {
  it('default: read-only cwd, its own data, no hosts, the home directory and temp hidden', async () => {
    const f = fake()
    const m = await setup({ y: f.entry() })
    await m.mcp(m.sid, { action: 'tools', server: 'x/y' })
    const p = planOf(m)
    const version = join(storeOf(m.r), 'x', readdirSync(join(storeOf(m.r), 'x'))[0])
    const data = join(m.r.dataDir, 'plugin-data', 'x', 'y')
    expect(p.file).toBe(realpathSync(process.execPath))
    expect(p.args).toEqual([join(f.dir, 'fake-mcp.mjs')])
    expect(p.s.sessionId).toBe(m.sid)
    expect(p.s.cwd).toBe(m.r.cwd)
    expect(p.s.spillDir).toBe(join(data, '.spill'))
    expect(p.x.readOnly).toBe(true)
    expect(p.x.allowRead).toEqual([data])
    expect(p.x.allowWrite).toEqual([data])
    expect(p.x.allowHosts).toEqual([])
    expect(p.x.exactHosts).toBe(true)
    expect(p.x.denyRead).toEqual([])
    expect(p.x.denyWrite).toEqual([])
    expect(new Set(p.x.hide!.tops)).toEqual(new Set([m.r.home, storeOf(m.r), realpathSync(tmpdir()), ...tempTops(realpathSync(tmpdir()))]))
    expect(new Set(p.x.hide!.keep)).toEqual(new Set([m.r.cwd, version]))
    expect(p.x.tmpDir).toMatch(new RegExp(`^${m.r.dataDir}/sessions/${m.sid}/mcp/[0-9a-f]{12}/tmp$`))
    expect(p.x.proxyScope).toMatch(/^mcp_[0-9a-f]{12}$/)
    expect(p.env.HOME).toBe(data)
    // 落盘目录是空的,数据目录是真目录
    expect(readdirSync(p.s.spillDir)).toEqual([])
    expect(lstatSync(data).isDirectory()).toBe(true)
  })

  it('cwd:write is a writable cwd; hosts are exactly the granted ones, sorted', async () => {
    const m = await setup({ y: fake().entry() }, { grants: { y: { network: ['b.example', 'a.example'], cwd: 'write' } } })
    await m.mcp(m.sid, { action: 'tools', server: 'x/y' })
    const p = planOf(m)
    expect(p.x.readOnly).toBe(false)
    expect(p.x.allowHosts).toEqual(['a.example', 'b.example'])
    expect(p.x.hide!.keep).toContain(m.r.cwd)
  })

  it("cwd:none hides the session's cwd, keeps it out of keep, and the process starts in its data dir", async () => {
    const f = fake()
    const m = await setup({ y: f.entry() }, { grants: { y: { network: [], cwd: 'none' } } })
    await m.mcp(m.sid, { action: 'tools', server: 'x/y' })
    const p = planOf(m)
    const data = join(m.r.dataDir, 'plugin-data', 'x', 'y')
    expect(p.x.readOnly).toBe(true)
    expect(p.x.hide!.tops).toContain(m.r.cwd)
    expect(p.x.hide!.keep).not.toContain(m.r.cwd)
    expect(f.calls('initialize')[0].cwd).toBe(realpathSync(data))
  })

  it('other cwd grants start in the session cwd', async () => {
    const f = fake()
    const m = await setup({ y: f.entry() })
    await m.mcp(m.sid, { action: 'tools', server: 'x/y' })
    expect(f.calls('initialize')[0].cwd).toBe(m.r.cwd)
  })

  it('user rules reach the plan through execPolicy', async () => {
    const m = await setup({ y: fake().entry() }, { stub: { ruleDenyRead: ['/secret/r'], ruleDenyWrite: ['/secret/w'] } })
    await m.mcp(m.sid, { action: 'tools', server: 'x/y' })
    expect(planOf(m).x.denyRead).toEqual(['/secret/r'])
    expect(planOf(m).x.denyWrite).toEqual(['/secret/w'])
  })

  it('M3: every start has its own proxy scope, and a restart waits for the old exit and release', async () => {
    const m = await setup({ y: fake({ crashOnCall: 1 }).entry() })
    await m.mcp(m.sid, { action: 'tools', server: 'x/y' })
    await m.mcp(m.sid, { action: 'call', server: 'x/y', tool: 'echo', arguments: {} })
    await until(() => m.sandbox!.released === 1)
    expect(m.live()).toEqual([])
    await m.mcp(m.sid, { action: 'tools', server: 'x/y' })
    expect(m.sandbox!.plans.length).toBe(2)
    expect(m.sandbox!.plans[0].x.proxyScope).not.toBe(m.sandbox!.plans[1].x.proxyScope)
  })

  it('the temp dir is emptied at each start, and a link planted as spill is replaced, its target untouched', async () => {
    const m = await setup({ y: fake().entry() })
    await m.mcp(m.sid, { action: 'tools', server: 'x/y' })
    const p = planOf(m)
    await call(m.r, 'plugins.setEnabled', { commandId: 'off', id: 'x', enabled: false })
    await call(m.r, 'plugins.setEnabled', { commandId: 'on', id: 'x', enabled: true })
    mkdirSync(p.x.tmpDir!, { recursive: true })
    writeFileSync(join(p.x.tmpDir!, 'left'), 'x')
    const target = join(tmp, 'other-plugin-data')
    mkdirSync(target)
    writeFileSync(join(target, 'keep'), 'secret')
    rmSync(p.s.spillDir, { recursive: true, force: true })
    symlinkSync(target, p.s.spillDir)
    await m.mcp(m.sid, { action: 'tools', server: 'x/y' })
    expect(lstatSync(p.s.spillDir).isSymbolicLink()).toBe(false)
    expect(readdirSync(p.s.spillDir)).toEqual([])
    expect(readFileSync(join(target, 'keep'), 'utf8')).toBe('secret')
    expect(existsSync(join(p.x.tmpDir!, 'left'))).toBe(false)
  })

  it('the spawn is a new process group, on pipes', async () => {
    const f = fake()
    const m = await setup({ y: f.entry() })
    await m.mcp(m.sid, { action: 'tools', server: 'x/y' })
    // detached:进程组 id 就是它自己的 pid
    const { pid } = (await statusOf(m.r, m.sid)).find(s => s.state === 'running')!
    expect(pid).toBe(m.pids[0])
    process.kill(-pid!, 0)
  })
})

describe('refused before any spawn', () => {
  it('a session at the home directory: cwd_too_broad', async () => {
    const m = await setup({ y: fake().entry() }, { sessionCwd: x => x.r.home })
    expect((await m.mcp(m.sid, { action: 'tools', server: 'x/y' })).text).toBe('cwd_too_broad')
    expect(m.spawns).toEqual([])
    expect(m.sandbox!.plans).toEqual([])
  })

  it('a session above the home directory: cwd_too_broad, also for cwd:none', async () => {
    const m = await setup({ y: fake().entry() }, { sessionCwd: x => dirname(x.r.home), grants: { y: { network: [], cwd: 'none' } } })
    expect((await m.mcp(m.sid, { action: 'tools', server: 'x/y' })).text).toBe('cwd_too_broad')
    expect(m.spawns).toEqual([])
  })

  it.each([
    ['/private/var/folders/aa/bb/T', ['/private/var/folders/aa/bb/T', '/private/var/folders/aa/bb', '/tmp', '/var/tmp']],
    ['/var/folders/aa/bb/T', ['/var/folders/aa/bb/T', '/var/folders/aa/bb', '/tmp', '/var/tmp']],
    // 别的位置的上一级是系统的、用户的,不是这次的临时区:不隐藏
    ['/tmp', ['/tmp', '/var/tmp']],
    ['/private/tmp', ['/private/tmp', '/tmp', '/var/tmp']],
    ['/home/tmp', ['/home/tmp', '/tmp', '/var/tmp']],
    ['/Users/me/x/tmp', ['/Users/me/x/tmp', '/tmp', '/var/tmp']],
    ['/private/var/tmp', ['/private/var/tmp', '/tmp', '/var/tmp']],
    ['/var/folders/aa/T', ['/var/folders/aa/T', '/tmp', '/var/tmp']],
  ])('m1: temp roots for %s', (tmpReal, want) => {
    expect(tempTops(tmpReal).sort()).toEqual([...want].sort())
  })

  it('heldTop: a kept path holding any hidden root or the data dir, in either spelling', () => {
    const base = join(tmp, 'layout')
    const a = join(base, 'a')
    const top = join(a, 'top')
    const data = join(a, 'data')
    mkdirSync(top, { recursive: true })
    mkdirSync(data)
    const link = join(base, 'link')
    symlinkSync(a, link)
    expect(heldTop(a, [top], data)).toBe(true)
    expect(heldTop(top, [top], data)).toBe(true)
    expect(heldTop(join(a, 'beside'), [top], data)).toBe(false)
    expect(heldTop(join(top, 'inside'), [top], data)).toBe(false)
    // 数据目录在 keep 里:计划的 tmp、落盘、服务数据全被再拒一次
    expect(heldTop(a, [join(base, 'elsewhere')], data)).toBe(true)
    // 里面的:沙箱会把它丢掉,等于没有 cwd
    expect(heldTop(join(data, 'sub'), [], data)).toBe(true)
    expect(heldTop(link, [top], join(base, 'elsewhere'))).toBe(true)
    expect(heldTop(a, [join(link, 'top')], join(base, 'elsewhere'))).toBe(true)
  })

  it('a planExec that throws is sandbox_unavailable, never unsandboxed', async () => {
    const m = await setup({ y: fake().entry() }, { stub: { planError: true } })
    expect((await m.mcp(m.sid, { action: 'tools', server: 'x/y' })).text).toBe('sandbox_unavailable')
    expect(m.spawns).toEqual([])
  })

  it.each([
    ['level none', { level: 'none' as const, missing: ['platform'] }],
    ['partial from netns', { level: 'partial' as const, missing: ['netns'] }],
    ['partial from netns among others', { level: 'partial' as const, missing: ['proxy', 'netns'] }],
  ])('%s: needs_sandbox, zero spawns, for tools and call', async (_n, stub) => {
    const m = await setup({ y: fake().entry() }, { stub, config: { permissions: { allowUnsandboxedAuto: true } } })
    expect((await m.mcp(m.sid, { action: 'tools', server: 'x/y' })).text).toBe('needs_sandbox')
    expect((await m.mcp(m.sid, { action: 'call', server: 'x/y', tool: 'echo', arguments: {} })).text).toBe('needs_sandbox')
    expect(m.spawns).toEqual([])
    expect(m.sandbox!.plans).toEqual([])
  })

  it.each([
    ['loopback', ['loopback']],
    ['proxy', ['proxy']],
  ])('partial from %s starts', async (_n, missing) => {
    const f = fake()
    const m = await setup({ y: f.entry() }, { stub: { level: 'partial', missing } })
    const { text } = await m.mcp(m.sid, { action: 'tools', server: 'x/y' })
    expect(text).toContain('echo')
    expect(m.spawns.length).toBe(1)
  })

  it('a plan that came back unsandboxed at full: not spawned, released, needs_sandbox', async () => {
    const m = await setup({ y: fake().entry() }, { stub: { sandboxed: false } })
    expect((await m.mcp(m.sid, { action: 'tools', server: 'x/y' })).text).toBe('needs_sandbox')
    expect(m.spawns).toEqual([])
    expect(m.sandbox!.released).toBe(1)
  })

  it('the start checks the level itself: it does not lean on permission()', async () => {
    const m = await setup({ y: fake().entry() })
    m.sandbox!.set({ level: 'none', missing: ['disabled'] })
    await expect(m.host().client(m.sid, 'x', 'y')).rejects.toMatchObject({ code: 'needs_sandbox' })
    m.sandbox!.set({ level: 'partial', missing: ['netns'] })
    await expect(m.host().client(m.sid, 'x', 'y')).rejects.toMatchObject({ code: 'needs_sandbox' })
    expect(m.spawns).toEqual([])
    expect(m.sandbox!.plans).toEqual([])
  })
})

describe('the problems table: never spawned', () => {
  const ok = () => fake().entry()
  it.each([
    ['${TOKEN} in args', { command: 'node', args: ['${TOKEN}'] }, 'arg_env_ref'],
    ['${user_config.k} in command', { command: '${user_config.k}' }, 'bad_command'],
    ['NODE_OPTIONS', { command: 'node', env: { NODE_OPTIONS: 'x' } }, 'dangerous_env'],
    ['node_options', { command: 'node', env: { node_options: 'x' } }, 'dangerous_env'],
    ['DYLD_INSERT_LIBRARIES', { command: 'node', env: { DYLD_INSERT_LIBRARIES: 'x' } }, 'dangerous_env'],
    ['GCONV_PATH', { command: 'node', env: { GCONV_PATH: 'x' } }, 'dangerous_env'],
    ['PATH', { command: 'node', env: { PATH: 'x' } }, 'dangerous_env'],
    ['HTTP_PROXY', { command: 'node', env: { HTTP_PROXY: 'x' } }, 'dangerous_env'],
    ['http_proxy', { command: 'node', env: { http_proxy: 'x' } }, 'dangerous_env'],
    ['docker', { command: 'docker', args: ['run'] }, 'runtime_unsupported'],
    ['../x', { command: '../x' }, 'command_outside_root'],
  ])('%s → %s', async (_n, bad, problem) => {
    const m = await setup({ good: ok(), bad })
    const before = m.pids.length
    const { text } = await m.mcp(m.sid, { action: 'tools', server: 'x/bad' })
    expect(text).toBe(`server_problem: ${problem}`)
    expect(m.pids.length).toBe(before)
    expect(m.sandbox!.plans).toEqual([])
    expect((await call(m.r, 'plugins.get', { id: 'x' })).servers.find((s: { name: string }) => s.name === 'bad')).toMatchObject({ state: 'problem', reason: problem })
  })

  it('an absolute command under home: bad_command', async () => {
    const m = await rigOnly()
    await m.r.install(buildPlugin(dirFor(), { format: 'claude', id: 'x', mcp: { good: ok(), bad: { command: join(m.r.home, 'Documents', 'a', 'b') } } }))
    const sid = await m.r.session({ approvalMode: 'auto' })
    await m.r.turn(sid, 'pin')
    expect((await m.mcp(sid, { action: 'tools', server: 'x/bad' })).text).toBe('server_problem: bad_command')
    expect(m.spawns).toEqual([])
  })

  it('an absolute command whose real path is under home: bad_command at the start', async () => {
    const m = await rigOnly()
    const real = join(m.r.home, 'Documents', 'tool')
    mkdirSync(dirname(real), { recursive: true })
    writeFileSync(real, '#!/bin/sh\n')
    chmodSync(real, 0o755)
    const link = join(tmp, 'looks-outside')
    symlinkSync(real, link)
    await m.r.install(buildPlugin(dirFor(), { format: 'claude', id: 'x', mcp: { y: { command: link } } }))
    const sid = await m.r.session({ approvalMode: 'auto' })
    await m.r.turn(sid, 'pin')
    expect((await m.mcp(sid, { action: 'tools', server: 'x/y' })).text).toBe('bad_command')
    expect(m.spawns).toEqual([])
  })

  it('an absolute command in the plugin store: bad_command, another plugin is not a program', async () => {
    const m = await rigOnly()
    await m.r.install(buildPlugin(dirFor(), { format: 'claude', id: 'other', extra: { 'run.sh': { mode: 0o755, text: '#!/bin/sh\n' } } }))
    const code = join(storeOf(m.r), 'other', readdirSync(join(storeOf(m.r), 'other'))[0], 'run.sh')
    await m.r.install(buildPlugin(dirFor(), { format: 'claude', id: 'x', mcp: { y: { command: code } } }))
    const sid = await m.r.session({ approvalMode: 'auto' })
    await m.r.turn(sid, 'pin')
    expect((await m.mcp(sid, { action: 'tools', server: 'x/y' })).text).toBe('bad_command')
    expect(m.spawns).toEqual([])
  })
})

describe('programs', () => {
  const exe = (p: string, text = '#!/bin/sh\n') => {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, text)
    chmodSync(p, 0o755)
    return p
  }

  it('resolveProgram: in the root, on PATH, absolute; never relative to cwd', () => {
    const root = join(tmp, 'root')
    const inRoot = exe(join(root, 'bin', 'srv'))
    const onPath = exe(join(tmp, 'p1', 'tool'))
    const later = exe(join(tmp, 'p2', 'tool'))
    expect(resolveProgram('${PLUGIN_ROOT}/bin/srv', root, '')).toBe(inRoot)
    expect(resolveProgram('bin/srv', root, '')).toBe(inRoot)
    expect(resolveProgram('./bin/srv', root, '')).toBe(inRoot)
    expect(resolveProgram('tool', root, `${dirname(onPath)}:${dirname(later)}`)).toBe(onPath)
    expect(resolveProgram(inRoot, root, '')).toBe(inRoot)
    // PATH 里的相对项丢掉:相对 cwd 解析就是仓库里放什么跑什么
    exe(join(process.cwd(), '.mff-test-never-here-x'), '#!/bin/sh\n')
    try {
      expect(resolveProgram('.mff-test-never-here-x', root, `.:${dirname(onPath)}`)).toBeUndefined()
    } finally {
      rmSync(join(process.cwd(), '.mff-test-never-here-x'))
    }
    expect(resolveProgram('tool', root, '')).toBeUndefined()
    expect(resolveProgram('nope', root, dirname(onPath))).toBeUndefined()
    expect(resolveProgram('bin/nope', root, '')).toBeUndefined()
  })

  it('resolveProgram: a directory or a file without an exec bit is not a program', () => {
    const root = join(tmp, 'root')
    const dir = join(tmp, 'p1')
    mkdirSync(join(dir, 'isdir'), { recursive: true })
    writeFileSync(join(dir, 'plain'), 'x')
    expect(resolveProgram('isdir', root, dir)).toBeUndefined()
    expect(resolveProgram('plain', root, dir)).toBeUndefined()
  })

  it('resolveProgram follows a PATH link to the real program', () => {
    const real = exe(join(tmp, 'real', 'bin', 'tool'))
    const dir = join(tmp, 'p1')
    mkdirSync(dir)
    symlinkSync(real, join(dir, 'tool'))
    expect(resolveProgram('tool', join(tmp, 'root'), dir)).toBe(real)
  })

  describe('runtimeRoots (C1)', () => {
    const home = '/h'
    it.each([
      // 自己所在的目录,从不上两级
      ['/h/.cargo/bin/x', ['/h/.cargo/bin']],
      ['/h/.local/bin/x', ['/h/.local/bin']],
      ['/h/.gem/bin/x', ['/h/.gem/bin']],
      ['/h/.config/bin/x', ['/h/.config/bin']],
      ['/h/.npm-global/bin/x', ['/h/.npm-global/bin']],
      ['/h/Library/pnpm/x', ['/h/Library/pnpm']],
      ['/h/.bun/bin/bun', ['/h/.bun/bin']],
    ])('%s keeps only %j', (real, want) => {
      expect(runtimeRoots(real, home, true)).toEqual(want)
    })

    it('a link on PATH: the link directory and the real directory, nothing above', () => {
      expect(runtimeRoots('/h/.local/share/tool/run', home, true, [], '/h/.local/bin/tool').sort()).toEqual(['/h/.local/bin', '/h/.local/share/tool'])
    })

    it.each([
      ['/h/.nvm/versions/node/v20/lib/node_modules/npm/bin/npx-cli.js', '/h/.nvm/versions/node/v20'],
      ['/h/.nvm/versions/node/v20/bin/node', '/h/.nvm/versions/node/v20'],
      ['/h/.fnm/node-versions/v20/installation/bin/node', '/h/.fnm/node-versions/v20'],
      ['/h/.volta/tools/image/node/20.1/bin/node', '/h/.volta/tools/image/node/20.1'],
      ['/h/.asdf/installs/nodejs/20/bin/node', '/h/.asdf/installs/nodejs/20'],
      ['/h/.local/share/mise/installs/python/3.12/bin/python', '/h/.local/share/mise/installs/python/3.12'],
      ['/h/.pyenv/versions/3.12/bin/python', '/h/.pyenv/versions/3.12'],
      ['/h/.rbenv/versions/3.3/bin/ruby', '/h/.rbenv/versions/3.3'],
      ['/h/.local/share/uv/tools/ruff/bin/ruff', '/h/.local/share/uv/tools/ruff'],
      ['/h/.local/share/uv/python/cpython-3.12/bin/python3', '/h/.local/share/uv/python/cpython-3.12'],
      ['/h/.local/pipx/venvs/black/bin/black', '/h/.local/pipx/venvs/black'],
      ['/h/.bun/install/global/node_modules/x/cli.js', '/h/.bun/install/global'],
    ])('known layout, on the real path: %s → %s', (real, root) => {
      expect(runtimeRoots(real, home, true)).toContain(root)
    })

    it.each([
      // 位置不对、缺版本段、程序就是根本身:都不算
      '/h/sub/.nvm/versions/node/v20/bin/node',
      '/h/.nvm/versions/other/v20/bin/node',
      '/h/.asdf/installs/nodejs/bin',
      '/h/.local/share/uv/other/x/bin/y',
      '/h/.bun/install/other/bin/x',
    ])('not a known layout: %s keeps only its own directory', real => {
      expect(runtimeRoots(real, home, true)).toEqual([dirname(real)])
    })

    it('the layout is matched on the real path, never on where PATH found it', () => {
      expect(runtimeRoots('/h/tools/run/x', home, true, [], '/h/.nvm/versions/node/v20/bin/x').sort()).toEqual(['/h/.nvm/versions/node/v20/bin', '/h/tools/run'])
    })

    it.each([
      ['/h/bin/x', undefined],
      ['/h/x', undefined],
      ['/h/.nvm/versions/node/v20/bin/node', '/h/bin/node'],
      ['/h/bin/node', '/h/.local/bin/node'],
    ])('a program in home or a direct child: runtime_too_broad (%s, hit %s)', (real, hit) => {
      expect(() => runtimeRoots(real, home, true, [], hit)).toThrow('runtime_too_broad')
    })

    it('only names from PATH; outside home as before, under a hidden root only', () => {
      expect(runtimeRoots('/h/Documents/a/b', home, false)).toEqual([])
      expect(runtimeRoots('/h/bin/x', home, false)).toEqual([])
      expect(runtimeRoots('/bin/x', home, true)).toEqual([])
      expect(runtimeRoots('/usr/local/bin/node', home, true)).toEqual([])
      expect(runtimeRoots('/opt/homebrew/Cellar/node/20/bin/node', home, true)).toEqual([])
      expect(runtimeRoots('/hx/bin/x', home, true)).toEqual([])
      expect(runtimeRoots('/private/tmp/rt/bin/node', home, true, ['/private/tmp'])).toEqual(['/private/tmp/rt'])
      expect(runtimeRoots('/private/tmp/bin/node', home, true, ['/private/tmp'])).toEqual([])
    })
  })

  it('a program in a direct child of home: refused before spawning, no crash budget used', async () => {
    const m = await rigOnly({ layout: 'production' })
    const f = fake()
    const prog = exe(join(m.r.home, 'bin', 'rtnode'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`)
    m.r.env.PATH = `${dirname(prog)}:/usr/bin:/bin`
    await m.r.install(buildPlugin(dirFor(), { format: 'claude', id: 'x', mcp: { y: { command: 'rtnode', args: [join(f.dir, 'fake-mcp.mjs')] } } }))
    const sid = await m.r.session({ approvalMode: 'auto' })
    await m.r.turn(sid, 'pin')
    for (let i = 0; i < 4; i++) expect((await m.mcp(sid, { action: 'tools', server: 'x/y' })).text).toBe('runtime_too_broad')
    expect(m.spawns).toEqual([])
    expect(m.sandbox!.plans).toEqual([])
    expect(m.host().failureCount(sid, 'x', 'y')).toBe(0)
  })

  it('a name on PATH: the program and the runtime root under home come from PATH', async () => {
    const m = await rigOnly()
    const f = fake()
    const prog = exe(join(m.r.home, '.rt', 'bin', 'rtnode'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`)
    m.r.env.PATH = `${dirname(prog)}:/usr/bin:/bin`
    await m.r.install(buildPlugin(dirFor(), { format: 'claude', id: 'x', mcp: { y: { command: 'rtnode', args: [join(f.dir, 'fake-mcp.mjs')] } } }))
    const sid = await m.r.session({ approvalMode: 'auto' })
    await m.r.turn(sid, 'pin')
    expect((await m.mcp(sid, { action: 'tools', server: 'x/y' })).text).toContain('echo')
    expect(planOf(m).x.hide!.keep).toContain(join(m.r.home, '.rt', 'bin'))
    expect(planOf(m).x.hide!.keep).not.toContain(join(m.r.home, '.rt'))
  })

  it('a runtime root holding a hidden root is refused with a stable code', async () => {
    const m = await rigOnly()
    const f = fake()
    // 程序在 <临时>/bin 下:两级上去是装着 home、data 的目录
    const prog = exe(join(m.r.root, 'bin', 'rtnode'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`)
    m.r.env.PATH = `${dirname(prog)}:/usr/bin:/bin`
    await m.r.install(buildPlugin(dirFor(), { format: 'claude', id: 'x', mcp: { y: { command: 'rtnode', args: [join(f.dir, 'fake-mcp.mjs')] } } }))
    const sid = await m.r.session({ approvalMode: 'auto' })
    await m.r.turn(sid, 'pin')
    expect((await m.mcp(sid, { action: 'tools', server: 'x/y' })).text).toBe('keep_too_broad')
    expect(m.spawns).toEqual([])
  })

  it('a name that PATH finds in the plugin store or the data dir: bad_command, another plugin is not a runtime', async () => {
    const m = await rigOnly()
    await m.r.install(buildPlugin(dirFor(), { format: 'claude', id: 'other', extra: { 'bin/othertool': { mode: 0o755, text: '#!/bin/sh\n' } } }))
    const code = join(storeOf(m.r), 'other', readdirSync(join(storeOf(m.r), 'other'))[0], 'bin')
    const inData = exe(join(m.r.dataDir, 'plugin-data', 'other', 'z', 'datatool'))
    m.r.env.PATH = `${code}:${dirname(inData)}:/usr/bin:/bin`
    await m.r.install(buildPlugin(dirFor(), { format: 'claude', id: 'x', mcp: { y: { command: 'othertool' }, z: { command: 'datatool' } } }))
    const sid = await m.r.session({ approvalMode: 'auto' })
    await m.r.turn(sid, 'pin')
    expect((await m.mcp(sid, { action: 'tools', server: 'x/y' })).text).toBe('bad_command')
    expect((await m.mcp(sid, { action: 'tools', server: 'x/z' })).text).toBe('bad_command')
    expect(m.spawns).toEqual([])
  })

  it('a program missing: server_failed with program_not_found, in status too', async () => {
    const m = await setup({ y: { command: 'surely-no-such-program-here' } })
    const { text } = await m.mcp(m.sid, { action: 'tools', server: 'x/y' })
    expect(text).toBe('server_failed: program_not_found')
    expect(m.spawns).toEqual([])
    expect((await statusOf(m.r, m.sid))[0]).toMatchObject({ server: 'y', state: 'server_failed', reason: 'program_not_found' })
    expect(statusEvents(m.r, m.sid)).toContainEqual({ plugin: 'x', server: 'y', state: 'server_failed', reason: 'program_not_found' })
  })

  it('a .mcp.json server with a relative command in the root runs from the store', async () => {
    const m = await rigOnly()
    const script = `#!${process.execPath}\nprocess.stdin.on('data', d => { for (const l of String(d).split('\\n').filter(Boolean)) { const q = JSON.parse(l); if (q.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: { protocolVersion: '2025-06-18' } }) + '\\n'); if (q.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: { tools: [{ name: 'inroot', inputSchema: {} }] } }) + '\\n') } }); process.stdin.on('end', () => process.exit(0))\n`
    await m.r.install(buildPlugin(dirFor(), { format: 'claude', id: 'x', mcp: { y: { command: './bin/srv' } }, extra: { 'bin/srv': { mode: 0o755, text: script } } }))
    const sid = await m.r.session({ approvalMode: 'auto' })
    await m.r.turn(sid, 'pin')
    expect((await m.mcp(sid, { action: 'tools', server: 'x/y' })).text).toContain('inroot')
    const version = join(storeOf(m.r), 'x', readdirSync(join(storeOf(m.r), 'x'))[0])
    expect(planOf(m).file).toBe(join(realpathSync(version), 'bin', 'srv'))
  })
})

describe('env: exactly the whitelist plus what was declared', () => {
  const KEEP = new Set(['PATH', 'HOME', 'TMPDIR', 'LANG', 'TERM', 'USER', 'LOGNAME', 'SHELL', 'TZ', 'MFFAI', 'GIT_TERMINAL_PROMPT', 'CI', '__CF_USER_TEXT_ENCODING'])
  const PLUGIN_VARS = ['CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'MFF_PLUGIN_ROOT', 'MFF_PLUGIN_DATA']

  it('names: whitelist + declared + the four plugin variables, nothing else; HOME is its data dir', async () => {
    const f = fake()
    const m = await rigOnly()
    Object.assign(m.r.env, { RANDOM_THING: 'nope', ANTHROPIC_API_KEY: 'sk-' + 'w'.repeat(24), AWS_SECRET_ACCESS_KEY: 'nope', USERPROFILE: m.r.home })
    await m.r.install(buildPlugin(dirFor(), { format: 'claude', id: 'x', mcp: { y: f.entry({ env: { DECLARED_A: 'literal-a' } }) } }))
    const sid = await m.r.session({ approvalMode: 'auto' })
    await m.r.turn(sid, 'pin')
    const data = join(m.r.dataDir, 'plugin-data', 'x', 'y')
    const { text } = await m.mcp(sid, { action: 'call', server: 'x/y', tool: 'probe_env', arguments: { same: { HOME: data, CLAUDE_PLUGIN_DATA: data, MFF_PLUGIN_DATA: data } } })
    const { env, same } = jsonOf(text)
    const names = new Set(f.calls('initialize')[0].envNames)
    for (const v of ['DECLARED_A', ...PLUGIN_VARS, 'HOME', 'PATH']) expect(names.has(v)).toBe(true)
    const extra = [...names].filter(k => !KEEP.has(k) && k !== 'DECLARED_A' && !PLUGIN_VARS.includes(k) && !k.startsWith('LC_') && !k.startsWith('NODE_'))
    expect(extra).toEqual([])
    expect(names.has('USERPROFILE')).toBe(false)
    // 打码会盖住临时目录里长得像令牌的段:路径让服务自己比
    expect(same).toEqual({ HOME: true, CLAUDE_PLUGIN_DATA: true, MFF_PLUGIN_DATA: true })
    expect(env.DECLARED_A).toBe('literal-a')
    expect(planOf(m).env.CLAUDE_PLUGIN_ROOT).toBe(planOf(m).env.MFF_PLUGIN_ROOT)
    expect(planOf(m).env.CLAUDE_PLUGIN_ROOT!.startsWith(join(storeOf(m.r), 'x'))).toBe(true)
  })

  it('${ANTHROPIC_API_KEY} in env is not resolved from the worker: it is a setting to fill in', async () => {
    const f = fake()
    const m = await rigOnly()
    const key = 'sk-' + 'q'.repeat(24)
    m.r.env.ANTHROPIC_API_KEY = key
    await m.r.install(buildPlugin(dirFor(), { format: 'claude', id: 'x', mcp: { y: f.entry({ env: { ANTHROPIC_API_KEY: '${ANTHROPIC_API_KEY}' } }) } }))
    const sid = await m.r.session({ approvalMode: 'auto' })
    await m.r.turn(sid, 'pin')
    expect((await m.mcp(sid, { action: 'tools', server: 'x/y' })).text).toBe('needs_config')
    expect(m.spawns).toEqual([])
    await call(m.r, 'plugins.settings.set', { commandId: 'c', id: 'x', key: 'ANTHROPIC_API_KEY', value: 'filled-by-the-user' })
    await m.mcp(sid, { action: 'tools', server: 'x/y' })
    expect(planOf(m).env.ANTHROPIC_API_KEY).toBe('filled-by-the-user')
    expect(JSON.stringify(planOf(m).env)).not.toContain(key)
    expect(m.r.rawBytes().includes(Buffer.from('filled-by-the-user'))).toBe(false)
  })

  it("no other plugin's secret and no model key; a secret is in the env, never in argv", async () => {
    const f = fake()
    const secret = 'plain-secret-value-1'
    const seeded: Promise<void>[] = []
    const m = await rigOnly({ before: () => [toolsRegistry, stubPlugin([], ctx => void seeded.push(ctx.secrets.set('model-key', 'other-store-value')))] })
    await Promise.all(seeded)
    await m.r.install(buildPlugin(dirFor(), { format: 'claude', id: 'other', mcp: { z: f.entry({ env: { OTHER: '${OTHER_TOKEN}' } }) } }))
    await m.r.install(buildPlugin(dirFor(), { format: 'claude', id: 'x', mcp: { y: f.entry({ env: { MINE: 'prefix ${user_config.tok} suffix' } }) }, manifest: { userConfig: { tok: { title: 't', sensitive: true, required: true } } } }))
    await call(m.r, 'plugins.settings.set', { commandId: 'c1', id: 'other', key: 'OTHER_TOKEN', value: 'value-of-the-other-plugin' })
    await call(m.r, 'plugins.settings.set', { commandId: 'c2', id: 'x', key: 'tok', value: secret })
    const sid = await m.r.session({ approvalMode: 'auto' })
    await m.r.turn(sid, 'pin')
    await m.mcp(sid, { action: 'tools', server: 'x/y' })
    // 到这里服务已经拿到了,而事件、日志、记录里都没有:下面 probe_env 故意把它打印出来才进事件
    expect(m.r.rawBytes().includes(Buffer.from(secret))).toBe(false)
    const { env, argv } = jsonOf((await m.mcp(sid, { action: 'call', server: 'x/y', tool: 'probe_env', arguments: {} })).text)
    expect(env.MINE).toBe(`prefix ${secret} suffix`)
    expect(JSON.stringify(env)).not.toContain('value-of-the-other-plugin')
    expect(JSON.stringify(env)).not.toContain('other-store-value')
    expect(JSON.stringify(argv)).not.toContain(secret)
    expect(JSON.stringify(f.calls().map(c => c.argv))).not.toContain(secret)
    expect(JSON.stringify(m.spawns)).not.toContain(secret)
    const { children, self } = jsonOf((await m.mcp(sid, { action: 'call', server: 'x/y', tool: 'probe_children', arguments: {} })).text)
    expect(JSON.stringify({ children, self })).not.toContain(secret)
  })

  it('secrets are read only for keys in the record: a key not listed stays unread', async () => {
    const reads: string[] = []
    const f = fake()
    const m = await rigOnly({ manager: { mcpSecrets: real => ({ get: k => (reads.push(k), real.get(k)) }) } })
    await m.r.install(buildPlugin(dirFor(), { format: 'claude', id: 'x', mcp: { y: f.entry({ env: { A: '${user_config.tok}', B: '${user_config.opt}' } }) }, manifest: { userConfig: { tok: { title: 't', sensitive: true, required: true }, opt: { title: 'o', sensitive: true, required: false } } } }))
    await call(m.r, 'plugins.settings.set', { commandId: 'c', id: 'x', key: 'tok', value: 'first-secret-value' })
    const sid = await m.r.session({ approvalMode: 'auto' })
    await m.r.turn(sid, 'pin')
    const { env } = jsonOf((await m.mcp(sid, { action: 'call', server: 'x/y', tool: 'probe_env', arguments: {} })).text)
    expect(reads).toEqual(['x/tok'])
    expect(env.A).toBe('first-secret-value')
    // 可选的没填:这个变量不设,不是空串
    expect('B' in env).toBe(false)
  })

  it('a setting value is substituted once: a value holding ${...} stays literal', async () => {
    const f = fake()
    const m = await rigOnly()
    await m.r.install(buildPlugin(dirFor(), { format: 'claude', id: 'x', mcp: { y: f.entry({ args: [join(f.dir, 'fake-mcp.mjs'), '--m=${user_config.mode}'], env: { M: '${user_config.mode}' } }) }, manifest: { userConfig: { mode: { title: 'm', sensitive: false, required: true } } } }))
    await call(m.r, 'plugins.settings.set', { commandId: 'c', id: 'x', key: 'mode', value: '${PLUGIN_ROOT}' })
    const sid = await m.r.session({ approvalMode: 'auto' })
    await m.r.turn(sid, 'pin')
    const { env, argv } = jsonOf((await m.mcp(sid, { action: 'call', server: 'x/y', tool: 'probe_env', arguments: {} })).text)
    expect(env.M).toBe('${PLUGIN_ROOT}')
    expect(argv.at(-1)).toBe('--m=${PLUGIN_ROOT}')
  })

  it('a setting referenced in args whose value turned out secret-shaped never reaches argv', async () => {
    const f = fake()
    const m = await rigOnly()
    const shaped = 'sk-' + 'z'.repeat(30)
    await m.r.install(buildPlugin(dirFor(), { format: 'claude', id: 'x', mcp: { y: f.entry({ args: [join(f.dir, 'fake-mcp.mjs'), '--m=${user_config.mode}'] }) }, manifest: { userConfig: { mode: { title: 'm', sensitive: false, required: true } } } }))
    await call(m.r, 'plugins.settings.set', { commandId: 'c', id: 'x', key: 'mode', value: shaped })
    const sid = await m.r.session({ approvalMode: 'auto' })
    await m.r.turn(sid, 'pin')
    expect((await m.mcp(sid, { action: 'tools', server: 'x/y' })).text).toBe('server_problem: arg_env_ref')
    expect(m.spawns).toEqual([])
    expect(m.sandbox!.plans).toEqual([])
  })

  it('${CLAUDE_PROJECT_DIR} is the cwd, except that cwd:none gets nothing of it', async () => {
    const f = fake()
    const m = await setup({ r: f.entry({ args: [join(f.dir, 'fake-mcp.mjs'), '${CLAUDE_PROJECT_DIR}'] }), n: f.entry({ args: [join(f.dir, 'fake-mcp.mjs'), '${CLAUDE_PROJECT_DIR}'], env: { P: '${MFF_PROJECT_DIR}' } }) }, { grants: { n: { network: [], cwd: 'none' } } })
    await m.mcp(m.sid, { action: 'tools', server: 'x/r' })
    expect(planOf(m).args.at(-1)).toBe(m.r.cwd)
    await m.mcp(m.sid, { action: 'tools', server: 'x/n' })
    expect(planOf(m).args.at(-1)).toBe(join(m.r.dataDir, 'plugin-data', 'x', 'n'))
    expect(planOf(m).env.P).toBe(join(m.r.dataDir, 'plugin-data', 'x', 'n'))
    expect(JSON.stringify(planOf(m).args)).not.toContain(m.r.cwd)
  })

  it('secrets locked: a stable code, not an internal error', async () => {
    const f = fake()
    const m = await rigOnly({ manager: { mcpSecrets: () => ({ get: async () => { throw new Error('/path/to/keychain denied') } }) } })
    await m.r.install(buildPlugin(dirFor(), { format: 'claude', id: 'x', mcp: { y: f.entry({ env: { A: '${user_config.tok}' } }) }, manifest: { userConfig: { tok: { title: 't', sensitive: true, required: true } } } }))
    await call(m.r, 'plugins.settings.set', { commandId: 'c', id: 'x', key: 'tok', value: 'value-x' })
    const sid = await m.r.session({ approvalMode: 'auto' })
    await m.r.turn(sid, 'pin')
    expect((await m.mcp(sid, { action: 'tools', server: 'x/y' })).text).toBe('secrets_unavailable')
    expect(m.spawns).toEqual([])
  })

  it('required config unset: needs_config, nothing started; set, it starts', async () => {
    const f = fake()
    const m = await rigOnly()
    await m.r.install(buildPlugin(dirFor(), { format: 'claude', id: 'x', mcp: { y: f.entry({ env: { A: '${user_config.tok}' } }) }, manifest: { userConfig: { tok: { title: 't', sensitive: true, required: true } } } }))
    const sid = await m.r.session({ approvalMode: 'auto' })
    await m.r.turn(sid, 'pin')
    expect((await m.mcp(sid, { action: 'tools', server: 'x/y' })).text).toBe('needs_config')
    expect(m.spawns).toEqual([])
    await call(m.r, 'plugins.settings.set', { commandId: 'c', id: 'x', key: 'tok', value: 'value-x' })
    expect((await m.mcp(sid, { action: 'tools', server: 'x/y' })).text).toContain('echo')
  })
})

describe('only the record that was consented to', () => {
  const editRecord = (m: McpRig, edit: (rec: any) => void) => {
    const file = installedFile(m.r)
    const j = JSON.parse(readFileSync(file, 'utf8'))
    edit(j.plugins[0])
    writeFileSync(file, JSON.stringify(j))
  }

  it('a store byte changed after startup: integrity_failed, never spawned, the plugin turned off', async () => {
    const f = fake()
    const m = await setup({ y: f.entry() }, { spec: { extra: { 'a.txt': 'one' } } })
    const version = join(storeOf(m.r), 'x', readdirSync(join(storeOf(m.r), 'x'))[0])
    writeFileSync(join(version, 'a.txt'), 'two')
    expect((await m.mcp(m.sid, { action: 'tools', server: 'x/y' })).text).toBe('integrity_failed')
    expect(m.spawns).toEqual([])
    expect(eventsOf(m.r, 'plugins.integrity.failed').length).toBe(1)
    expect((await call(m.r, 'plugins.list')).plugins[0]).toMatchObject({ enabled: false, state: 'integrity_failed' })
    expect((await m.mcp(m.sid, { action: 'tools', server: 'x/y' })).text).toBe('plugin_disabled')
  })

  it('M13: a running server is not rechecked, its next start is', async () => {
    const f = fake()
    const m = await setup({ y: f.entry() }, { spec: { extra: { 'a.txt': 'one' } } })
    await m.mcp(m.sid, { action: 'tools', server: 'x/y' })
    const version = join(storeOf(m.r), 'x', readdirSync(join(storeOf(m.r), 'x'))[0])
    writeFileSync(join(version, 'a.txt'), 'two')
    expect((await m.mcp(m.sid, { action: 'call', server: 'x/y', tool: 'echo', arguments: { a: 1 } })).text).toContain('"a":1')
    process.kill(-m.pids[0], 'SIGKILL')
    await until(() => m.live().length === 0)
    expect((await m.mcp(m.sid, { action: 'call', server: 'x/y', tool: 'echo', arguments: {} })).text).toBe('integrity_failed')
    expect(m.pids.length).toBe(1)
  })

  it('grants in the record beyond the declaration: fail closed at the start', async () => {
    const f = fake()
    const m = await rigOnly()
    const mcp = { y: f.entry({ permissions: { network: ['a.example'], cwd: 'read' } }) }
    await m.r.install(buildPlugin(dirFor(), { format: 'native', id: 'x', mcp }), { servers: { y: { network: [], cwd: 'read' } } })
    editRecord(m, rec => {
      rec.grants = { servers: { y: { network: ['evil.example'], cwd: 'write' } } }
    })
    await m.r.restart()
    const sid = await m.r.session({ approvalMode: 'auto' })
    await m.r.turn(sid, 'pin')
    expect((await m.mcp(sid, { action: 'tools', server: 'x/y' })).text).toBe('grants_invalid')
    expect(m.spawns).toEqual([])
    expect(m.sandbox!.plans).toEqual([])
  })

  it('a record whose consent does not match the tree: never spawned', async () => {
    const f = fake()
    const m = await rigOnly()
    await m.r.install(buildPlugin(dirFor(), { format: 'claude', id: 'x', mcp: { y: f.entry() } }))
    editRecord(m, rec => {
      rec.consent.mcp[0].args = ['what the user saw']
    })
    await m.r.restart()
    const sid = await m.r.session({ approvalMode: 'auto' })
    await m.r.turn(sid, 'pin')
    expect((await m.mcp(sid, { action: 'tools', server: 'x/y' })).text).toBe('consent_mismatch')
    expect(m.spawns).toEqual([])
  })

  it('a link at plugin-data/<id>: refused, nothing written through it', async () => {
    const f = fake()
    const m = await setup({ y: f.entry() })
    const target = join(tmp, 'elsewhere')
    mkdirSync(target)
    mkdirSync(join(m.r.dataDir, 'plugin-data'), { recursive: true })
    symlinkSync(target, join(m.r.dataDir, 'plugin-data', 'x'))
    expect((await m.mcp(m.sid, { action: 'tools', server: 'x/y' })).text).toBe('data_dir_unsafe')
    expect(m.spawns).toEqual([])
    expect(readdirSync(target)).toEqual([])
  })

  it('m2: what a server locked inside .spill does not stop the next start; the dir is empty and real', async () => {
    const f = fake()
    const m = await setup({ y: f.entry() })
    await m.mcp(m.sid, { action: 'tools', server: 'x/y' })
    const spill = planOf(m).s.spillDir
    mkdirSync(join(spill, 'k'))
    writeFileSync(join(spill, 'k', 'f'), 'x')
    if (process.platform === 'darwin') execFileSync('/usr/bin/chflags', ['uchg', join(spill, 'k', 'f')])
    chmodSync(join(spill, 'k'), 0)
    await call(m.r, 'plugins.setEnabled', { commandId: 'off', id: 'x', enabled: false })
    await call(m.r, 'plugins.setEnabled', { commandId: 'on', id: 'x', enabled: true })
    expect((await m.mcp(m.sid, { action: 'tools', server: 'x/y' })).text).toContain('echo')
    expect(readdirSync(spill)).toEqual([])
  })

  it('m2: a data dir that cannot be prepared is one stable code with no path, and uses the failure budget', async () => {
    const f = fake()
    const m = await setup({ y: f.entry() })
    const data = join(m.r.dataDir, 'plugin-data', 'x', 'y')
    mkdirSync(data, { recursive: true })
    chmodSync(data, 0o555)
    try {
      for (let i = 1; i <= 3; i++) {
        expect((await m.mcp(m.sid, { action: 'tools', server: 'x/y' })).text).toBe('data_dir_unsafe')
        expect(m.host().failureCount(m.sid, 'x', 'y')).toBe(i)
      }
      expect((await m.mcp(m.sid, { action: 'tools', server: 'x/y' })).text).toBe('server_failed: data_dir_unsafe')
      expect(statusEvents(m.r, m.sid)).toContainEqual({ plugin: 'x', server: 'y', state: 'server_failed', reason: 'data_dir_unsafe' })
      expect(m.spawns).toEqual([])
      expect(m.sandbox!.plans).toEqual([])
    } finally {
      chmodSync(data, 0o755)
    }
  })

  it('a link at plugin-data/<id>/<server>: refused', async () => {
    const f = fake()
    const m = await setup({ y: f.entry() })
    const target = join(tmp, 'elsewhere')
    mkdirSync(target)
    mkdirSync(join(m.r.dataDir, 'plugin-data', 'x'), { recursive: true })
    symlinkSync(target, join(m.r.dataDir, 'plugin-data', 'x', 'y'))
    expect((await m.mcp(m.sid, { action: 'tools', server: 'x/y' })).text).toBe('data_dir_unsafe')
    expect(m.spawns).toEqual([])
    expect(readdirSync(target)).toEqual([])
  })
})

describe('protocol hostility: a stable code, the process gone, the turn goes on', () => {
  it.each<[string, object, string]>([
    ['a 5 MB line', { hugeLine: 5 * 1024 * 1024 }, 'protocol_error'],
    ['one byte past MAX_LINE', { hugeLine: MAX_LINE + 1 }, 'protocol_error'],
    ['201 tools', { toolCount: 195 }, 'too_many_tools'],
  ])('%s → %s, killed', async (_n, scenario, code) => {
    const m = await setup({ y: fake(scenario).entry() })
    const { text } = await m.mcp(m.sid, { action: 'tools', server: 'x/y' })
    expect(text).toBe(code)
    await until(() => m.host().status(m.sid)[0].state === 'stopped', 6000)
    expect(m.live()).toEqual([])
    // 这一轮照常结束,下一轮也能问模型
    await m.r.turn(m.sid, 'next')
    expect(m.r.events(m.sid).filter(e => e.type === 'turn.ended').length).toBeGreaterThanOrEqual(3)
  })

  it('exactly MAX_LINE junk bytes is not the limit: the process stays up, no answer ends in call_timeout', async () => {
    const clock = fakeClock()
    const f = fake({ hugeLine: MAX_LINE })
    const m = await setup({ y: f.entry() }, { clock })
    const run = m.mcp(m.sid, { action: 'tools', server: 'x/y' })
    await until(() => f.calls('tools/list').length === 1)
    await new Promise(res => setTimeout(res, 150))
    expect(m.live().length).toBe(1)
    clock.advance(DEFAULT_CALL_MS)
    expect((await run).text).toBe('call_timeout')
    expect(m.live().length).toBe(1)
  })

  it('a 3 MB call result passes through and is spilled by the registry', async () => {
    const f = fake()
    const m = await setup({ y: f.entry() })
    const { text } = await m.mcp(m.sid, { action: 'call', server: 'x/y', tool: 'echo', arguments: { big: 'b'.repeat(3 * 1024 * 1024) } })
    expect(text).toContain('已截断,完整输出')
    expect(m.live().length).toBe(1)
  })

  it('a server that never answers initialize: init_timeout on the injected clock, killed, one failure', async () => {
    const clock = fakeClock()
    const f = fake({ neverInit: true, stubborn: true })
    const m = await setup({ y: f.entry() }, { clock })
    const run = m.mcp(m.sid, { action: 'tools', server: 'x/y' })
    await until(() => f.calls('initialize').length === 1)
    clock.advance(DEFAULT_INIT_MS)
    expect((await run).text).toBe('init_timeout')
    await until(() => m.live().length === 0, 6000)
    expect(statusEvents(m.r, m.sid).map(s => s.state)).toContain('stopped')
  }, 20_000)

  it('a bad version in the answer to initialize: protocol_error and killed', async () => {
    const dir = dirFor()
    mkdirSync(dir)
    const bad = join(dir, 'bad.mjs')
    writeFileSync(bad, `process.stdin.on('data', d => { for (const l of String(d).split('\\n').filter(Boolean)) { const q = JSON.parse(l); if (q.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: { protocolVersion: '1.0' } }) + '\\n') } }); setInterval(() => {}, 1000)\n`)
    const m = await setup({ y: { command: process.execPath, args: [bad] } })
    expect((await m.mcp(m.sid, { action: 'tools', server: 'x/y' })).text).toBe('protocol_error')
    await until(() => m.live().length === 0, 6000)
  }, 20_000)

  it('exits mid-call: server_exited; the next call starts it again', async () => {
    const f = fake({ crashOnCall: 7 })
    const m = await setup({ y: f.entry() })
    expect((await m.mcp(m.sid, { action: 'call', server: 'x/y', tool: 'echo', arguments: {} })).text).toBe('server_exited')
    await until(() => m.live().length === 0)
    expect((await m.mcp(m.sid, { action: 'tools', server: 'x/y' })).text).toContain('echo')
    expect(m.pids.length).toBe(2)
  })

  it('a server that closes stdout but keeps running is killed, a grandchild holding stderr delays nothing', async () => {
    const dir = dirFor()
    mkdirSync(dir)
    const s = join(dir, 'closer.mjs')
    writeFileSync(s, `import { closeSync } from 'node:fs'\nprocess.stdin.on('data', d => { for (const l of String(d).split('\\n').filter(Boolean)) { const q = JSON.parse(l); if (q.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: { protocolVersion: '2025-06-18' } }) + '\\n'); if (q.method === 'tools/list') closeSync(1) } })\nprocess.on('SIGTERM', () => {})\nsetInterval(() => {}, 1000)\n`)
    const m = await setup({ y: { command: process.execPath, args: [s] } })
    expect((await m.mcp(m.sid, { action: 'tools', server: 'x/y' })).text).toBe('server_exited')
    await until(() => m.live().length === 0, 6000)
  }, 20_000)

  it('non-JSON on stdout and answers to unknown ids are ignored', async () => {
    const m = await setup({ y: fake({ garbage: true, unknownId: true }).entry() })
    expect((await m.mcp(m.sid, { action: 'tools', server: 'x/y' })).text).toContain('echo')
    expect(m.live().length).toBe(1)
  })

  it('sampling and roots requests get -32601, no model call; instructions reach nothing', async () => {
    const f = fake({ serverRequests: ['sampling/createMessage', 'roots/list'], instructions: 'OBEY-THE-SERVER-INSTRUCTIONS' })
    const m = await setup({ y: f.entry() })
    const before = m.r.models.calls.length
    await m.mcp(m.sid, { action: 'tools', server: 'x/y' })
    await until(() => f.calls('response').length === 2)
    expect(f.calls('response').map(c => c.params.error.code)).toEqual([-32601, -32601])
    // 假模型只多了这一轮的两次请求(工具调用前、后),服务要不来
    expect(m.r.models.calls.length - before).toBe(2)
    expect(JSON.stringify(m.r.models.calls.map(c => c.req))).not.toContain('OBEY-THE-SERVER-INSTRUCTIONS')
    expect(m.r.rawBytes().includes(Buffer.from('OBEY-THE-SERVER-INSTRUCTIONS'))).toBe(false)
  })

  it('stderr with a secret goes nowhere, and stderr noise is no failure', async () => {
    const leak = 'sk-' + 'e'.repeat(30)
    const m = await setup({ y: fake({ stderr: [`token=${leak}`, 'xcrun: error: cannot be used within an App Sandbox', 'xcrun_db-abc'] }).entry() })
    const { text } = await m.mcp(m.sid, { action: 'tools', server: 'x/y' })
    expect(text).toContain('echo')
    expect(m.r.rawBytes().includes(Buffer.from(leak))).toBe(false)
    expect((await statusOf(m.r, m.sid))[0].state).toBe('running')
  })
})

describe('lifecycle', () => {
  it('idle reap at 10 minutes on the injected clock, not one tick before; use pushes it back', async () => {
    const clock = fakeClock()
    const f = fake()
    const m = await setup({ y: f.entry() }, { clock })
    await m.mcp(m.sid, { action: 'tools', server: 'x/y' })
    clock.advance(IDLE_MS - 1000)
    await m.mcp(m.sid, { action: 'call', server: 'x/y', tool: 'echo', arguments: {} })
    clock.advance(IDLE_MS - 1000)
    // 杀是异步的:等一下才证明第一个定时器没有动手
    await new Promise(res => setTimeout(res, 100))
    expect(m.live().length).toBe(1)
    clock.advance(1000)
    await until(() => m.host().status(m.sid)[0].state === 'stopped', 6000)
    expect(m.live()).toEqual([])
    // 收掉不算失败;下次要用再起
    expect(m.host().failureCount(m.sid, 'x', 'y')).toBe(0)
    await m.mcp(m.sid, { action: 'tools', server: 'x/y' })
    expect(m.pids.length).toBe(2)
  }, 20_000)

  it('a call the idle clock runs past is not reaped under it', async () => {
    const clock = fakeClock()
    const f = fake({ callDelayMs: 60_000 })
    const m = await setup({ y: f.entry() }, { clock })
    const run = m.mcp(m.sid, { action: 'call', server: 'x/y', tool: 'echo', arguments: {} })
    await until(() => f.calls('tools/call').length === 1)
    // 同一拍里过了调用的期限和空闲的期限:答复的收尾是微任务,定时器这时还看得到它忙
    clock.advance(IDLE_MS + 1000)
    expect((await run).text).toBe('call_timeout')
    await new Promise(res => setTimeout(res, 50))
    expect(m.live().length).toBe(1)
    expect((await statusEventsOf(m)).includes('stopped')).toBe(false)
  })

  const servers = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`s${i}`, fake({}, `srv${i}`).entry()]))

  it(`a ${MAX_PER_SESSION + 1}th in a session evicts the idlest`, async () => {
    const clock = fakeClock()
    const m = await setup(servers(MAX_PER_SESSION + 1), { clock })
    for (let i = 0; i < MAX_PER_SESSION; i++) {
      await m.mcp(m.sid, { action: 'tools', server: `x/s${i}` })
      clock.advance(1000)
    }
    // s0 刚用过,s1 成了最久没用的
    await m.mcp(m.sid, { action: 'call', server: 'x/s0', tool: 'echo', arguments: {} })
    clock.advance(1000)
    expect(m.live().length).toBe(MAX_PER_SESSION)
    await m.mcp(m.sid, { action: 'tools', server: `x/s${MAX_PER_SESSION}` })
    expect(m.live().length).toBe(MAX_PER_SESSION)
    const running = (await statusOf(m.r, m.sid)).filter(s => s.state === 'running').map(s => s.server).sort()
    expect(running).toEqual(['s0', 's2', 's3', 's4'])
    // 收最久没用的不算失败
    expect(statusEvents(m.r, m.sid).filter(s => s.server === 's1' && s.state === 'server_failed')).toEqual([])
  }, 30_000)

  it(`a ${MAX_SERVERS + 1}th overall evicts the idlest of any session`, async () => {
    const clock = fakeClock()
    const m = await setup(servers(MAX_PER_SESSION), { clock })
    const sessions = [m.sid]
    for (let i = 0; i < 2; i++) {
      const s = await m.r.session({ approvalMode: 'auto' })
      await m.r.turn(s, 'pin')
      sessions.push(s)
    }
    for (const s of sessions.slice(0, 2))
      for (let i = 0; i < MAX_PER_SESSION; i++) {
        await m.mcp(s, { action: 'tools', server: `x/s${i}` })
        clock.advance(1000)
      }
    expect(m.live().length).toBe(MAX_SERVERS)
    await m.mcp(sessions[2], { action: 'tools', server: 'x/s0' })
    expect(m.live().length).toBe(MAX_SERVERS)
    expect((await statusOf(m.r, sessions[0])).filter(s => s.state === 'running').map(s => s.server).sort()).toEqual(['s1', 's2', 's3'])
  }, 40_000)

  it('all busy: too_many_servers, nothing spawned, the calls in flight unharmed', async () => {
    const dirs = Array.from({ length: MAX_PER_SESSION }, (_, i) => fake({ callDelayMs: 800 }, `busy${i}`))
    const spec = Object.fromEntries(dirs.map((d, i) => [`s${i}`, d.entry()]))
    const m = await setup({ ...spec, last: fake({}, 'last').entry() })
    const signal = new AbortController().signal
    const inFlight = dirs.map((_, i) => m.host().callTool(m.sid, 'x', `s${i}`, 'echo', { i }, signal, true))
    await until(() => dirs.every(d => d.calls('tools/call').length === 1))
    expect(m.live().length).toBe(MAX_PER_SESSION)
    await expect(m.host().client(m.sid, 'x', 'last')).rejects.toMatchObject({ code: 'too_many_servers' })
    expect(m.pids.length).toBe(MAX_PER_SESSION)
    for (const r of await Promise.all(inFlight)) expect(r.isError).toBe(false)
    // 不忙了:这回能收最久没用的
    await m.host().client(m.sid, 'x', 'last')
    expect(m.live().length).toBe(MAX_PER_SESSION)
  }, 20_000)

  it('three crashes in 10 minutes: server_failed, sticky, no fourth spawn; a grant change clears it', async () => {
    const f = fake({ crashOnCall: 1 })
    const m = await setup({ y: f.entry() })
    const go = () => m.mcp(m.sid, { action: 'call', server: 'x/y', tool: 'echo', arguments: {} })
    expect((await go()).text).toBe('server_exited')
    await until(() => m.live().length === 0)
    expect((await go()).text).toBe('server_exited')
    await until(() => m.live().length === 0)
    expect((await go()).text).toBe('server_exited')
    await until(() => m.host().status(m.sid)[0].state === 'server_failed', 6000)
    expect(m.live()).toEqual([])
    expect(m.pids.length).toBe(3)
    const { text } = await go()
    expect(text).toBe('server_failed: server_exited')
    expect(m.pids.length).toBe(3)
    expect((await statusOf(m.r, m.sid))[0]).toMatchObject({ state: 'server_failed', reason: 'server_exited' })
    expect(statusEvents(m.r, m.sid)).toContainEqual({ plugin: 'x', server: 'y', state: 'server_failed', reason: 'server_exited' })
    await call(m.r, 'plugins.grants.set', { commandId: 'g', id: 'x', grants: { servers: { y: { network: ['a.example'], cwd: 'read' } } } })
    await go()
    expect(m.pids.length).toBe(4)
  })

  it('crashes spread over more than 10 minutes do not add up', async () => {
    const clock = fakeClock()
    const f = fake({ crashOnCall: 1 })
    const m = await setup({ y: f.entry() }, { clock })
    for (let i = 0; i < 4; i++) {
      expect((await m.mcp(m.sid, { action: 'call', server: 'x/y', tool: 'echo', arguments: {} })).text).toBe('server_exited')
      await until(() => m.live().length === 0)
      clock.advance(6 * 60_000)
    }
    expect(m.pids.length).toBe(4)
  })

  it('three consecutive call timeouts: killed, one failure counted', async () => {
    const clock = fakeClock()
    const f = fake({ callDelayMs: 60_000 })
    const m = await setup({ y: f.entry() }, { clock })
    const timeout = async (i: number) => {
      const run = m.mcp(m.sid, { action: 'call', server: 'x/y', tool: 'echo', arguments: { i } })
      await until(() => f.calls('tools/call').length === i)
      clock.advance(DEFAULT_CALL_MS)
      expect((await run).text).toBe('call_timeout')
    }
    await timeout(1)
    await timeout(2)
    expect(m.live().length).toBe(1)
    await timeout(3)
    await until(() => m.live().length === 0, 6000)
    expect(m.host().failureCount(m.sid, 'x', 'y')).toBe(1)
    const cancels = f.calls('notifications/cancelled')
    expect(cancels.length).toBe(3)
  }, 20_000)

  it('abort sends notifications/cancelled and the process survives', async () => {
    const f = fake({ callDelayMs: 60_000 })
    const m = await setup({ y: f.entry() })
    const run = m.mcp(m.sid, { action: 'call', server: 'x/y', tool: 'echo', arguments: {} })
    await until(() => f.calls('tools/call').length === 1)
    const turnId = m.r.events(m.sid).filter(e => e.type === 'turn.started').at(-1)!.payload as { turnId: string }
    await call(m.r, 'session.cancel', { commandId: 'cancel', sessionId: m.sid, turnId: turnId.turnId })
    await run.catch(() => {})
    await until(() => f.calls('notifications/cancelled').length === 1)
    expect(m.live().length).toBe(1)
    expect((await statusOf(m.r, m.sid))[0].state).toBe('running')
  })

  it('a second session gets a second process; both see the same data dir, which is by design', async () => {
    const f = fake()
    const m = await setup({ y: f.entry() })
    const other = await m.r.session({ approvalMode: 'auto' })
    await m.r.turn(other, 'pin')
    const data = join(m.r.dataDir, 'plugin-data', 'x', 'y', 'shared.txt')
    await m.mcp(m.sid, { action: 'tools', server: 'x/y' })
    await m.mcp(other, { action: 'call', server: 'x/y', tool: 'probe_write', arguments: { path: data, text: 'from the second' } })
    expect(m.live().length).toBe(2)
    // 同一个服务的数据目录是它自己的,不按会话分:spec §10.3、M17
    expect(jsonOf((await m.mcp(m.sid, { action: 'call', server: 'x/y', tool: 'probe_read', arguments: { path: data } })).text)).toMatchObject({ ok: true, text: 'from the second' })
  })

  it('status events only on change, and carry no server text', async () => {
    const m = await setup({ y: fake().entry() })
    await m.mcp(m.sid, { action: 'tools', server: 'x/y' })
    await m.mcp(m.sid, { action: 'tools', server: 'x/y' })
    await m.mcp(m.sid, { action: 'call', server: 'x/y', tool: 'echo', arguments: {} })
    expect(statusEvents(m.r, m.sid).map(s => s.state)).toEqual(['starting', 'running'])
    await call(m.r, 'plugins.setEnabled', { commandId: 'off', id: 'x', enabled: false })
    expect(statusEvents(m.r, m.sid).map(s => s.state)).toEqual(['starting', 'running', 'stopped'])
  })
})

describe('grants, enable and uninstall', () => {
  it.each([
    ['widening', [{ network: [], cwd: 'read' }, { network: ['a.example'], cwd: 'read' }]],
    ['narrowing', [{ network: ['a.example'], cwd: 'read' }, { network: [], cwd: 'read' }]],
  ] as const)('grants.set %s kills the process, and the next plan has the new hosts', async (_n, [from, to]) => {
    const f = fake()
    const m = await setup({ y: f.entry() }, { grants: { y: { network: [...from.network], cwd: from.cwd } } })
    await m.mcp(m.sid, { action: 'tools', server: 'x/y' })
    expect(m.live().length).toBe(1)
    await call(m.r, 'plugins.grants.set', { commandId: 'g', id: 'x', grants: { servers: { y: { network: [...to.network], cwd: to.cwd } } } })
    expect(m.live().length).toBe(0)
    await m.mcp(m.sid, { action: 'tools', server: 'x/y' })
    expect(planOf(m).x.allowHosts).toEqual([...to.network])
    expect(m.sandbox!.plans[0].x.proxyScope).not.toBe(planOf(m).x.proxyScope)
  })

  it('a stop closes stdin first: a server that reacts to it finishes cleanly', async () => {
    const dir = dirFor()
    mkdirSync(dir)
    const eof = join(dir, 'eof')
    const script = join(dir, 'graceful.mjs')
    writeFileSync(script, `import { writeFileSync } from 'node:fs'\nprocess.on('SIGINT', () => {})\nprocess.stdin.on('data', d => { for (const l of String(d).split('\\n').filter(Boolean)) { const q = JSON.parse(l); if (q.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: { protocolVersion: '2025-06-18' } }) + '\\n'); if (q.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: { tools: [] } }) + '\\n') } })\nprocess.stdin.on('end', () => { writeFileSync(${JSON.stringify(eof)}, 'x'); process.exit(0) })\n`)
    const m = await setup({ y: { command: process.execPath, args: [script] } })
    await m.mcp(m.sid, { action: 'tools', server: 'x/y' })
    await call(m.r, 'plugins.setEnabled', { commandId: 'off', id: 'x', enabled: false })
    expect(m.live()).toEqual([])
    expect(existsSync(eof)).toBe(true)
  }, 20_000)

  it('a stubborn server is still gone when the RPC answers, within the fast ladder', async () => {
    const m = await setup({ y: fake({ stubborn: true }).entry() })
    await m.mcp(m.sid, { action: 'tools', server: 'x/y' })
    const t0 = Date.now()
    await call(m.r, 'plugins.setEnabled', { commandId: 'off', id: 'x', enabled: false })
    expect(m.live().length).toBe(0)
    expect(Date.now() - t0).toBeLessThan(5000)
  }, 20_000)

  it('a start caught in flight by a grant change never spawns with the old grants', async () => {
    const f = fake()
    const m = await setup({ y: f.entry() })
    const real = m.sandbox!.planExec
    let open!: () => void
    const gate = new Promise<void>(res => (open = res))
    m.sandbox!.planExec = async (...a) => {
      const p = await real(...a)
      await gate
      return p
    }
    const run = m.mcp(m.sid, { action: 'tools', server: 'x/y' })
    await until(() => m.sandbox!.plans.length === 1)
    const change = call(m.r, 'plugins.grants.set', { commandId: 'g', id: 'x', grants: { servers: { y: { network: ['a.example'], cwd: 'read' } } } })
    await new Promise(res => setTimeout(res, 20))
    open()
    await change
    const { text } = await run
    expect(text === 'server_stopped' || text === 'grants_changed').toBe(true)
    expect(m.spawns).toEqual([])
    expect(m.sandbox!.released).toBe(1)
  })

  it('a record changed under a start in flight with no kill (a setting): the env read before it is not used', async () => {
    const f = fake()
    const m = await rigOnly()
    await m.r.install(buildPlugin(dirFor(), { format: 'claude', id: 'x', mcp: { y: f.entry({ env: { A: '${user_config.mode}' } }) }, manifest: { userConfig: { mode: { title: 'm', sensitive: false, required: true }, unrelated: { title: 'u', sensitive: false, required: false } } } }))
    await call(m.r, 'plugins.settings.set', { commandId: 'c1', id: 'x', key: 'mode', value: 'first' })
    const sid = await m.r.session({ approvalMode: 'auto' })
    await m.r.turn(sid, 'pin')
    const real = m.sandbox!.planExec
    let open!: () => void
    const gate = new Promise<void>(res => (open = res))
    m.sandbox!.planExec = async (...a) => {
      const p = await real(...a)
      await gate
      return p
    }
    const run = m.mcp(sid, { action: 'tools', server: 'x/y' })
    await until(() => m.sandbox!.plans.length === 1)
    await call(m.r, 'plugins.settings.set', { commandId: 'c2', id: 'x', key: 'unrelated', value: 'second' })
    open()
    expect((await run).text).toBe('grants_changed')
    expect(m.spawns).toEqual([])
    expect(m.sandbox!.released).toBe(1)
  })

  describe('I5: a changed setting does not stay live in a running server', () => {
    const CONFIG = { userConfig: { tok: { title: 't', sensitive: true, required: true }, mode: { title: 'm', sensitive: false, required: false }, unused: { title: 'u', sensitive: false, required: false } } }
    const start = async () => {
      const a = fake({}, 'a')
      const b = fake({}, 'b')
      const m = await rigOnly()
      await m.r.install(buildPlugin(dirFor(), { format: 'claude', id: 'x', manifest: CONFIG, mcp: { uses: a.entry({ env: { T: '${user_config.tok}', M: '${user_config.mode}' } }), other: b.entry() } }))
      await call(m.r, 'plugins.settings.set', { commandId: 'c0', id: 'x', key: 'tok', value: 'first-value' })
      const sid = await m.r.session({ approvalMode: 'auto' })
      await m.r.turn(sid, 'pin')
      await m.mcp(sid, { action: 'tools', server: 'x/uses' })
      const usesPid = m.pids[0]
      await m.mcp(sid, { action: 'tools', server: 'x/other' })
      const otherPid = m.pids[1]
      return { m, sid, usesPid, otherPid }
    }

    it('rotating a secret kills the server that references it, not the other; the next start has the new value', async () => {
      const { m, sid, usesPid, otherPid } = await start()
      await call(m.r, 'plugins.settings.set', { commandId: 'c1', id: 'x', key: 'tok', value: 'second-value' })
      expect(alive(usesPid)).toBe(false)
      expect(alive(otherPid)).toBe(true)
      await m.mcp(sid, { action: 'tools', server: 'x/uses' })
      expect(planOf(m).env.T).toBe('second-value')
    })

    it('clearing a secret kills it, and the server now needs config', async () => {
      const { m, sid, usesPid, otherPid } = await start()
      await call(m.r, 'plugins.settings.clear', { commandId: 'c1', id: 'x', key: 'tok' })
      expect(alive(usesPid)).toBe(false)
      expect(alive(otherPid)).toBe(true)
      expect((await m.mcp(sid, { action: 'tools', server: 'x/uses' })).text).toBe('needs_config')
    })

    it('a plain setting too, set and cleared', async () => {
      const { m, sid, usesPid } = await start()
      await call(m.r, 'plugins.settings.set', { commandId: 'c1', id: 'x', key: 'mode', value: 'fast' })
      expect(alive(usesPid)).toBe(false)
      await m.mcp(sid, { action: 'tools', server: 'x/uses' })
      expect(planOf(m).env.M).toBe('fast')
      const next = m.pids.at(-1)!
      await call(m.r, 'plugins.settings.clear', { commandId: 'c2', id: 'x', key: 'mode' })
      expect(alive(next)).toBe(false)
    })

    it('a key no server references kills nothing', async () => {
      const { m, usesPid, otherPid } = await start()
      await call(m.r, 'plugins.settings.set', { commandId: 'c1', id: 'x', key: 'unused', value: 'v' })
      await call(m.r, 'plugins.settings.clear', { commandId: 'c2', id: 'x', key: 'unused' })
      expect(alive(usesPid)).toBe(true)
      expect(alive(otherPid)).toBe(true)
    })

    it('a secret write that fails leaves the server alone', async () => {
      const f = fake()
      const m = await rigOnly()
      await m.r.install(buildPlugin(dirFor(), { format: 'claude', id: 'x', manifest: CONFIG, mcp: { uses: f.entry({ env: { T: '${user_config.tok}' } }) } }))
      await call(m.r, 'plugins.settings.set', { commandId: 'c0', id: 'x', key: 'tok', value: 'first-value' })
      const sid = await m.r.session({ approvalMode: 'auto' })
      await m.r.turn(sid, 'pin')
      await m.mcp(sid, { action: 'tools', server: 'x/uses' })
      expect(await refused(call(m.r, 'plugins.settings.set', { commandId: 'c1', id: 'x', key: 'tok', value: 'bad\0value' }))).toBe('bad_value')
      expect(m.live().length).toBe(1)
    })
  })

  it('killPlugin alone stops a start in flight: the record has not moved, the mark has', async () => {
    const m = await setup({ y: fake().entry() })
    const real = m.sandbox!.planExec
    let open!: () => void
    const gate = new Promise<void>(res => (open = res))
    m.sandbox!.planExec = async (...a) => {
      const p = await real(...a)
      await gate
      return p
    }
    const run = m.mcp(m.sid, { action: 'tools', server: 'x/y' })
    await until(() => m.sandbox!.plans.length === 1)
    const killing = m.host().killPlugin('x')
    open()
    await killing
    expect((await run).text).toBe('server_stopped')
    expect(m.spawns).toEqual([])
    expect(m.sandbox!.released).toBe(1)
  })

  it('disable: settings, grants and data remain, the process is gone, and tools answers plugin_disabled', async () => {
    const f = fake()
    const m = await setup({ y: f.entry() }, { grants: { y: { network: ['a.example'], cwd: 'read' } } })
    const data = join(m.r.dataDir, 'plugin-data', 'x', 'y')
    await m.mcp(m.sid, { action: 'tools', server: 'x/y' })
    await m.mcp(m.sid, { action: 'call', server: 'x/y', tool: 'probe_write', arguments: { path: join(data, 'kept.txt'), text: 'kept' } })
    await call(m.r, 'plugins.setEnabled', { commandId: 'off', id: 'x', enabled: false })
    expect(m.live().length).toBe(0)
    expect(readFileSync(join(data, 'kept.txt'), 'utf8')).toBe('kept')
    expect((await call(m.r, 'plugins.get', { id: 'x' })).grants.servers.y.network).toEqual(['a.example'])
    expect((await m.mcp(m.sid, { action: 'tools', server: 'x/y' })).text).toBe('plugin_disabled')
    expect(m.pids.length).toBe(1)
    expect((await call(m.r, 'plugins.get', { id: 'x' })).servers[0].state).toBe('disabled')
  })

  it('Review Focus 6: uninstall with a live server leaves nothing, and no pid', async () => {
    const f = fake()
    const m = await rigOnly()
    const shots = () => ({
      store: snapshot(storeOf(m.r)),
      data: snapshot(join(m.r.dataDir, 'plugin-data')),
      record: existsSync(installedFile(m.r)) ? readFileSync(installedFile(m.r), 'utf8') : null,
      config: existsSync(join(m.r.dataDir, 'config.json')) ? readFileSync(join(m.r.dataDir, 'config.json'), 'utf8') : null,
    })
    const before = shots()
    const secretValue = 'uninstall-secret-value'
    await m.r.install(buildPlugin(dirFor(), { format: 'claude', id: 'x', mcp: { y: f.entry({ env: { A: '${user_config.tok}' } }) }, manifest: { userConfig: { tok: { title: 't', sensitive: true, required: true }, plain: { title: 'p', sensitive: false, required: false } } } }))
    await call(m.r, 'plugins.settings.set', { commandId: 'c1', id: 'x', key: 'tok', value: secretValue })
    await call(m.r, 'plugins.settings.set', { commandId: 'c2', id: 'x', key: 'plain', value: 'plain-value' })
    const sid = await m.r.session({ approvalMode: 'auto' })
    await m.r.turn(sid, 'pin')
    const data = join(m.r.dataDir, 'plugin-data', 'x', 'y')
    await m.mcp(sid, { action: 'call', server: 'x/y', tool: 'probe_write', arguments: { path: join(data, 'state.txt'), text: 'left' } })
    const tmpOf = planOf(m).x.tmpDir!
    expect(existsSync(join(data, 'state.txt'))).toBe(true)
    expect(m.live().length).toBe(1)
    await call(m.r, 'plugins.uninstall', { commandId: 'u', id: 'x' })
    expect(m.live().length).toBe(0)
    expect(shots()).toEqual(before)
    expect(existsSync(dirname(tmpOf))).toBe(false)
    // 同 id 再装,看不到旧设置
    await m.r.install(buildPlugin(dirFor(), { format: 'claude', id: 'x', mcp: { y: f.entry({ env: { A: '${user_config.tok}' } }) }, manifest: { userConfig: { tok: { title: 't', sensitive: true, required: true } } } }))
    expect((await m.mcp(sid, { action: 'tools', server: 'x/y' })).text).toBe('needs_config')
  })

  describe('I3: a server cannot make uninstall leave data behind', () => {
    const lockedInstall = async (lock: (dir: string) => void) => {
      const f = fake()
      const m = await rigOnly({ layout: 'production' })
      const src = buildPlugin(dirFor(), { format: 'claude', id: 'x', mcp: { y: f.entry() } })
      await m.r.install(src)
      const sid = await m.r.session({ approvalMode: 'auto' })
      await m.r.turn(sid, 'pin')
      await m.mcp(sid, { action: 'tools', server: 'x/y' })
      const data = join(m.r.dataDir, 'plugin-data', 'x', 'y')
      mkdirSync(join(data, 'k'))
      writeFileSync(join(data, 'k', 'f'), 'old state')
      lock(data)
      return { m, sid, src, data }
    }

    it.skipIf(process.platform !== 'darwin')('uchg on a file', async () => {
      const { m, src, data } = await lockedInstall(d => execFileSync('/usr/bin/chflags', ['uchg', join(d, 'k', 'f')]))
      expect(await call(m.r, 'plugins.uninstall', { commandId: 'u', id: 'x' })).toEqual({ ok: true })
      expect(existsSync(join(m.r.dataDir, 'plugin-data', 'x'))).toBe(false)
      await m.r.install(src)
      expect(existsSync(data)).toBe(false)
    })

    it('chmod 000 on a directory', async () => {
      const { m, src, data } = await lockedInstall(d => chmodSync(join(d, 'k'), 0))
      expect(await call(m.r, 'plugins.uninstall', { commandId: 'u', id: 'x' })).toEqual({ ok: true })
      expect(existsSync(join(m.r.dataDir, 'plugin-data', 'x'))).toBe(false)
      await m.r.install(src)
      expect(existsSync(join(data, 'k'))).toBe(false)
    })

    it('a link in the data dir: its target untouched', async () => {
      const outside = join(tmp, 'outside')
      mkdirSync(outside)
      writeFileSync(join(outside, 'keep'), 'x')
      chmodSync(outside, 0o555)
      const { m } = await lockedInstall(d => {
        symlinkSync(outside, join(d, 'k', 'link'))
        chmodSync(join(d, 'k'), 0)
      })
      expect(await call(m.r, 'plugins.uninstall', { commandId: 'u', id: 'x' })).toEqual({ ok: true })
      expect(statSync(outside).mode & 0o777).toBe(0o555)
      expect(readdirSync(outside)).toEqual(['keep'])
      chmodSync(outside, 0o755)
    })

    it('removal failing: not a plain ok; confirm for that id is refused until it is gone; a restart clears it', async () => {
      const { m, src } = await lockedInstall(() => {})
      const dataRoot = join(m.r.dataDir, 'plugin-data')
      chmodSync(dataRoot, 0o555)
      try {
        expect(await refused(call(m.r, 'plugins.uninstall', { commandId: 'u', id: 'x' }))).toBe('uninstall_incomplete')
        expect(existsSync(join(dataRoot, 'x'))).toBe(true)
        expect(eventsOf(m.r, 'plugins.uninstalled').length).toBe(1)
        const st = await prepare(m.r, { kind: 'path', path: src })
        expect(st.state).toBe('ready')
        expect(await refused(confirm(m.r, st))).toBe('plugin_data_exists')
        expect((await call(m.r, 'plugins.list')).plugins).toEqual([])
      } finally {
        chmodSync(dataRoot, 0o755)
      }
      await m.r.restart()
      expect(existsSync(join(dataRoot, 'x'))).toBe(false)
      await m.r.install(src)
      expect((await call(m.r, 'plugins.list')).plugins[0].id).toBe('x')
    })

    it('an upgrade of an installed plugin is not refused: the data dir is its own', async () => {
      const { m, src, data } = await lockedInstall(() => {})
      writeFileSync(join(src, 'added.txt'), 'second')
      await m.r.install(src)
      expect(readFileSync(join(data, 'k', 'f'), 'utf8')).toBe('old state')
    })
  })

  it('upgrade: confirm kills the old version, data stays', async () => {
    const f = fake()
    const m = await rigOnly()
    const src = buildPlugin(dirFor(), { format: 'claude', id: 'x', version: '1.0.0', mcp: { y: f.entry() } })
    await m.r.install(src)
    const sid = await m.r.session({ approvalMode: 'auto' })
    await m.r.turn(sid, 'pin')
    await m.mcp(sid, { action: 'tools', server: 'x/y' })
    const data = join(m.r.dataDir, 'plugin-data', 'x', 'y')
    writeFileSync(join(data, 'kept'), 'k')
    expect(m.live().length).toBe(1)
    writeFileSync(join(src, 'added.txt'), 'new version')
    await m.r.install(src)
    expect(m.live().length).toBe(0)
    expect(readFileSync(join(data, 'kept'), 'utf8')).toBe('k')
  })

  it('plugins.get shows the state of the process', async () => {
    const m = await setup({ y: fake().entry() })
    expect((await call(m.r, 'plugins.get', { id: 'x' })).servers[0]).toMatchObject({ name: 'y', state: 'stopped' })
    await m.mcp(m.sid, { action: 'tools', server: 'x/y' })
    expect((await call(m.r, 'plugins.get', { id: 'x' })).servers[0]).toMatchObject({ name: 'y', state: 'running' })
    m.sandbox!.set({ level: 'none', missing: ['disabled'] })
    await call(m.r, 'plugins.setEnabled', { commandId: 'off', id: 'x', enabled: false })
    await call(m.r, 'plugins.setEnabled', { commandId: 'on', id: 'x', enabled: true })
    expect((await call(m.r, 'plugins.get', { id: 'x' })).servers[0]).toMatchObject({ state: 'needs_sandbox' })
  })

  it('plugins.mcp.status: per session, with the pid; without a session only what is alive or failed', async () => {
    const m = await setup({ y: fake().entry() })
    expect(await statusOf(m.r)).toEqual([])
    expect(await statusOf(m.r, m.sid)).toEqual([{ plugin: 'x', server: 'y', sessionId: m.sid, state: 'stopped' }])
    await m.mcp(m.sid, { action: 'tools', server: 'x/y' })
    expect(await statusOf(m.r)).toEqual([{ plugin: 'x', server: 'y', sessionId: m.sid, state: 'running', pid: m.pids[0] }])
  })
})

describe('shutting down', () => {
  it('kernel.close leaves no pid, through the existing killLive, stubborn or not, within the budget', async () => {
    const m = await setup({ a: fake({ stubborn: true }, 'a').entry(), b: fake({}, 'b').entry() })
    await m.mcp(m.sid, { action: 'tools', server: 'x/a' })
    await m.mcp(m.sid, { action: 'tools', server: 'x/b' })
    expect(m.live().length).toBe(2)
    const t0 = Date.now()
    await m.r.kernel.close()
    await until(() => m.live().length === 0, 2000)
    expect(Date.now() - t0).toBeLessThan(5000)
  }, 20_000)

  it('deactivate is synchronous in effect: killAllNow takes a stubborn server by itself, and nothing starts after', async () => {
    const m = await setup({ y: fake({ stubborn: true }).entry() })
    await m.mcp(m.sid, { action: 'tools', server: 'x/y' })
    const [pid] = m.pids
    m.host().killAllNow()
    await until(() => !alive(pid), 1500)
    await expect(m.host().client(m.sid, 'x', 'y')).rejects.toMatchObject({ code: 'server_stopped' })
    expect(m.pids.length).toBe(1)
  })

  it('a killed worker: the group is in the registry file, reapOrphans takes it, wipeSessionTmp takes <sid>/mcp', async () => {
    const m = await setup({ y: fake({ stubborn: true }).entry() })
    await m.mcp(m.sid, { action: 'tools', server: 'x/y' })
    const pid = m.pids[0]
    const pgidsFile = pgidFile(m.r.dataDir)
    expect(existsSync(pgidsFile)).toBe(true)
    expect(readFileSync(pgidsFile, 'utf8')).toContain(String(pid))
    const copy = join(tmp, 'pgids-after-crash')
    writeFileSync(copy, readFileSync(pgidsFile), { mode: 0o600 })
    const res = reapOrphans(copy, { platform: process.platform })
    expect(res.killed).toContain(pid)
    await until(() => !alive(pid), 3000)
    const tmpDir = planOf(m).x.tmpDir!
    expect(existsSync(tmpDir)).toBe(true)
    wipeSessionTmp(m.r.dataDir)
    expect(existsSync(join(m.r.dataDir, 'sessions', m.sid, 'mcp'))).toBe(false)
  }, 20_000)

  it('I2: a child in its own session does not outlive kernel.close, and nothing is left on record', async () => {
    const f = fake()
    const m = await setup({ y: f.entry() })
    const { spawned } = jsonOf((await m.mcp(m.sid, { action: 'call', server: 'x/y', tool: 'probe_children', arguments: { spawn: true } })).text)
    stray.push(spawned)
    expect(alive(spawned)).toBe(true)
    const t0 = Date.now()
    await m.r.kernel.close()
    await until(() => !alive(spawned), 1000)
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(existsSync(pgidFile(m.r.dataDir)) ? readFileSync(pgidFile(m.r.dataDir), 'utf8') : '').not.toContain(String(m.pids[0]))
  }, 20_000)

  it('a child that started its own session is walked and taken when the server is stopped', async () => {
    const f = fake()
    const m = await setup({ y: f.entry() })
    const { spawned } = jsonOf((await m.mcp(m.sid, { action: 'call', server: 'x/y', tool: 'probe_children', arguments: { spawn: true } })).text)
    stray.push(spawned)
    expect(alive(spawned)).toBe(true)
    await call(m.r, 'plugins.setEnabled', { commandId: 'off', id: 'x', enabled: false })
    await until(() => !alive(spawned), 6000)
  }, 20_000)

  it('a group member the leader left behind is taken when the leader crashes', async () => {
    const dir = dirFor()
    mkdirSync(dir)
    const pidFile = join(dir, 'pid')
    const s = join(dir, 'leaver.mjs')
    writeFileSync(s, `import { spawn } from 'node:child_process'\nimport { writeFileSync } from 'node:fs'\nprocess.stdin.on('data', d => { for (const l of String(d).split('\\n').filter(Boolean)) { const q = JSON.parse(l); if (q.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: { protocolVersion: '2025-06-18' } }) + '\\n'); if (q.method === 'tools/call') { const c = spawn('/bin/sleep', ['300'], { stdio: 'ignore' }); c.unref(); writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); process.exit(3) } } })\n`)
    const m = await setup({ y: { command: process.execPath, args: [s] } })
    expect((await m.mcp(m.sid, { action: 'call', server: 'x/y', tool: 'any', arguments: {} })).text).toBe('server_exited')
    const child = Number(readFileSync(pidFile, 'utf8'))
    stray.push(child)
    await until(() => !alive(child), 6000)
  }, 20_000)

  it('a leader that exits while its child holds stdout: exit is what counts, the call fails, the child goes too', async () => {
    const dir = dirFor()
    mkdirSync(dir)
    const pidFile = join(dir, 'pid')
    const s = join(dir, 'holder.mjs')
    writeFileSync(s, `import { spawn } from 'node:child_process'\nimport { writeFileSync } from 'node:fs'\nprocess.stdin.on('data', d => { for (const l of String(d).split('\\n').filter(Boolean)) { const q = JSON.parse(l); if (q.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: { protocolVersion: '2025-06-18' } }) + '\\n'); if (q.method === 'tools/call') { const c = spawn('/bin/sleep', ['300'], { stdio: 'inherit' }); c.unref(); writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); process.exit(3) } } })\n`)
    const m = await setup({ y: { command: process.execPath, args: [s] } })
    const t0 = Date.now()
    expect((await m.mcp(m.sid, { action: 'call', server: 'x/y', tool: 'any', arguments: {} })).text).toBe('server_exited')
    expect(Date.now() - t0).toBeLessThan(3000)
    const child = Number(readFileSync(pidFile, 'utf8'))
    stray.push(child)
    await until(() => !alive(child), 6000)
    await until(() => m.host().status(m.sid)[0].state === 'stopped', 6000)
  }, 20_000)
})

describe('secret values never leak through the plan', () => {
  it('a secret in env is not on the plan argv', async () => {
    const f = fake()
    const m = await rigOnly()
    await m.r.install(buildPlugin(dirFor(), { format: 'claude', id: 'x', mcp: { y: f.entry({ env: { A: '${user_config.tok}' } }) }, manifest: { userConfig: { tok: { title: 't', sensitive: true, required: true } } } }))
    await call(m.r, 'plugins.settings.set', { commandId: 'c', id: 'x', key: 'tok', value: 'argv-check-value' })
    const sid = await m.r.session({ approvalMode: 'auto' })
    await m.r.turn(sid, 'pin')
    await m.mcp(sid, { action: 'tools', server: 'x/y' })
    expect(JSON.stringify(planOf(m).args)).not.toContain('argv-check-value')
    expect(planOf(m).env.A).toBe('argv-check-value')
  })
})
