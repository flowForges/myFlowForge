// RPC、启用、禁用、卸载、配置与凭据:Review Focus 6 的卸载快照(还没有服务,Task 9 再加)
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { call, confirm, eventsOf, installedFile, prepare, refused, snapshot, storeOf, withManager } from '../../../test/managerRig'
import { buildPlugin, pluginKernel, type PluginRig, type PluginSpec } from '../../../test/pluginRig'
import { NO_SANDBOX } from '../../../test/sandboxStub'
import { createKernel } from '../../kernel/kernel'
import type { Plugin, PluginContext } from '../../kernel/pluginHost'
import { BUILTIN_PLUGINS } from '../index'
import { createPluginManager, type PluginManagerOpts } from './index'
import { manifestFor } from './manifest'

let tmp: string
const rigs: PluginRig[] = []
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-pm-')))
})
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close()
  rmSync(tmp, { recursive: true, force: true })
})

const rig = async (o: PluginManagerOpts = {}) => {
  const r = await pluginKernel(withManager(o))
  rigs.push(r)
  return r
}
let n = 0
const plugin = (spec: Partial<PluginSpec> = {}) => buildPlugin(join(tmp, `p${++n}`), { format: 'claude', id: 'demo', skills: { s: 'body' }, ...spec })
const install = async (r: PluginRig, path: string, over: Record<string, unknown> = {}) => confirm(r, await prepare(r, { kind: 'path', path }), over)
const configured = () =>
  plugin({
    mcp: { srv: { command: 'node', env: { TOKEN: '${user_config.token}', REGION: '${user_config.region}', RAW: '${RAW_KEY}' } } },
    manifest: { userConfig: { token: { title: 'Token', sensitive: true, required: true }, region: { title: 'Region', required: false } } },
  })
const secretsFile = (r: PluginRig) => join(r.dataDir, 'credentials.json')
const secretKeys = (r: PluginRig) => (existsSync(secretsFile(r)) ? Object.keys(JSON.parse(readFileSync(secretsFile(r), 'utf8'))).sort() : [])

describe('manifest', () => {
  it('declares what spec §4 asks; pgids only on posix (win32 would wait forever)', () => {
    expect(manifestFor('darwin')).toMatchObject({ id: 'plugin-manager', provides: ['plugins'], inject: ['tools', 'sandbox', 'sessions', 'sessionCommands', 'pgids'] })
    expect(manifestFor('win32').inject).toEqual(['tools', 'sandbox', 'sessions', 'sessionCommands'])
  })
})

describe('with no plugins', () => {
  it('activation creates nothing under <data>-plugins or plugin-data, and no installed.json', async () => {
    const r = await rig()
    expect(r.kernel.status().plugins.find(p => p.id === 'plugin-manager')?.state).toBe('active')
    expect(existsSync(storeOf(r))).toBe(false)
    expect(existsSync(join(r.dataDir, 'plugin-data'))).toBe(false)
    expect(readdirSync(join(r.dataDir, 'plugins', 'plugin-manager'))).toEqual([])
    expect(await call(r, 'plugins.list')).toEqual({ plugins: [], dev: [], problems: [] })
    expect(existsSync(storeOf(r))).toBe(false)
  })

  it('BUILTIN_PLUGINS keeps the spec order and starts with an idle round, on its own, leaving no store', async () => {
    const ids = BUILTIN_PLUGINS.map(p => p.manifest.id)
    expect(ids.indexOf('plugin-manager')).toBe(ids.indexOf('memory-default') + 1)
    expect(ids.indexOf('plugin-manager')).toBe(ids.indexOf('loop-default') - 1)
    const dataDir = join(tmp, 'data')
    const home = join(tmp, 'home')
    mkdirSync(home)
    writeFileSync(join(tmp, 'ok'), '')
    mkdirSync(dataDir)
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ version: 1, executors: { disabled: ['codex', 'qoder'] } }))
    const k = await createKernel({ dataDir, home, env: { PATH: '/usr/bin:/bin', HOME: home, USERPROFILE: home }, sandbox: NO_SANDBOX, plugins: BUILTIN_PLUGINS, secrets: { osBackend: false } })
    try {
      expect(k.status().plugins.find(p => p.id === 'plugin-manager')?.state).toBe('active')
      expect(existsSync(`${dataDir}-plugins`)).toBe(false)
      // m5:家目录是内核的那个,不是 os.homedir()
      expect(await k.handle('plugins.install.prepare', { source: { kind: 'path', path: home } }).then(() => 'ok', e => (e as Error).message)).toBe('path_refused')
      // reservedIds 是真的内置列表:懒求值,不是空集合
      const dir = buildPluginFor('telegram-like', 'channel-telegram')
      const { stagingId } = (await k.handle('plugins.install.prepare', { source: { kind: 'path', path: dir } })) as { stagingId: string }
      for (let i = 0; i < 1000; i++) {
        const st = (await k.handle('plugins.install.status', { stagingId })) as { state: string; error?: string }
        if (st.state !== 'fetching') {
          expect(st).toMatchObject({ state: 'failed', error: 'id_reserved' })
          break
        }
        await new Promise(res => setTimeout(res, 5))
      }
    } finally {
      await k.close()
    }
  })
})
const buildPluginFor = (sub: string, id: string) => buildPlugin(join(tmp, sub), { format: 'claude', id, skills: { s: 'x' } })

describe('plugins.list and plugins.get', () => {
  it('list carries the display fields; get answers consent, grants, settings and servers', async () => {
    const r = await rig({ now: () => 1234 })
    const path = configured()
    await install(r, path)
    const { plugins } = await call(r, 'plugins.list')
    expect(plugins).toHaveLength(1)
    expect(plugins[0]).toMatchObject({ id: 'demo', version: '1.0.0', format: 'claude', enabled: true, state: 'ok', problems: [], source: { kind: 'path' }, installedAt: 1234 })
    expect(plugins[0].integrity).toMatch(/^sha256:[0-9a-f]{64}$/)
    const got = await call(r, 'plugins.get', { id: 'demo' })
    expect(got.consent.id).toBe('demo')
    expect(got.grants).toEqual({ servers: { srv: { network: [], cwd: 'read' } } })
    expect(got.settings).toEqual([
      { key: 'RAW_KEY', set: false, sensitive: true },
      { key: 'region', set: false, sensitive: false },
      { key: 'token', set: false, sensitive: true },
    ])
    // state 已经说了,reason 不重复(plugins.get 和 status 是同一个函数)
    expect(got.servers).toEqual([{ name: 'srv', state: 'needs_config' }])
    expect(await refused(call(r, 'plugins.get', { id: 'nope' }))).toBe('plugin_not_installed')
  })

  it('server state follows problems, required config and enabled', async () => {
    const r = await rig()
    await install(r, plugin({ mcp: { dock: { command: 'docker' }, fine: { command: 'node' } } }))
    expect((await call(r, 'plugins.get', { id: 'demo' })).servers).toEqual([
      { name: 'dock', state: 'problem', reason: 'runtime_unsupported' },
      // 这个夹具的沙箱级别是 none:起不来就要这么说(§10.3)
      { name: 'fine', state: 'needs_sandbox' },
    ])
    await call(r, 'plugins.setEnabled', { commandId: 'x', id: 'demo', enabled: false })
    expect((await call(r, 'plugins.get', { id: 'demo' })).servers.map((s: { state: string }) => s.state)).toEqual(['problem', 'disabled'])
  })

  it('a record survives a restart with its consent', async () => {
    const r = await rig()
    await install(r, configured())
    const before = await call(r, 'plugins.get', { id: 'demo' })
    await r.restart()
    expect(await call(r, 'plugins.get', { id: 'demo' })).toEqual(before)
  })

  it('corrupt installed.json: no plugin enabled, store_recovered, and RPC still answers', async () => {
    const r = await rig()
    await install(r, plugin())
    writeFileSync(installedFile(r), '{oops')
    await r.restart()
    expect(await call(r, 'plugins.list')).toEqual({ plugins: [], dev: [], problems: ['store_recovered'] })
    expect(readdirSync(join(r.dataDir, 'plugins', 'plugin-manager')).some(f => f.startsWith('installed.json.bad-'))).toBe(true)
    expect(eventsOf(r, 'plugin.failed').filter(e => (e.payload as { id: string }).id === 'plugin-manager')).toEqual([])
  })
})

describe('setEnabled', () => {
  it('disable: kills, records, leaves settings, secrets, grants and data; enable brings it back', async () => {
    const kills: string[] = []
    const r = await rig({ killPluginProcesses: async id => void kills.push(id) })
    await install(r, configured())
    await call(r, 'plugins.settings.set', { id: 'demo', key: 'token', value: 'v-secret' })
    await call(r, 'plugins.settings.set', { id: 'demo', key: 'region', value: 'eu' })
    await call(r, 'plugins.grants.set', { commandId: 'g', id: 'demo', grants: { servers: { srv: { network: ['api.example.com'], cwd: 'read' } } } })
    const data = join(r.dataDir, 'plugin-data', 'demo', 'srv')
    mkdirSync(data, { recursive: true })
    writeFileSync(join(data, 'x'), 'kept')
    const keys = secretKeys(r)
    kills.length = 0
    await call(r, 'plugins.setEnabled', { commandId: 'd', id: 'demo', enabled: false })
    expect(kills).toEqual(['demo'])
    expect(eventsOf(r, 'plugins.disabled').map(e => e.payload)).toEqual([{ id: 'demo' }])
    const got = await call(r, 'plugins.get', { id: 'demo' })
    expect(got.grants.servers.srv.network).toEqual(['api.example.com'])
    expect(got.settings.filter((s: { set: boolean }) => s.set).map((s: { key: string }) => s.key)).toEqual(['region', 'token'])
    expect(readFileSync(join(data, 'x'), 'utf8')).toBe('kept')
    expect(secretKeys(r)).toEqual(keys)
    await r.restart()
    expect((await call(r, 'plugins.list')).plugins[0].enabled).toBe(false)
    await call(r, 'plugins.setEnabled', { commandId: 'e', id: 'demo', enabled: true })
    expect((await call(r, 'plugins.list')).plugins[0].enabled).toBe(true)
  })

  it('the record says disabled before processes are killed: nothing can start in between', async () => {
    let seen: unknown
    const holder: { r?: PluginRig } = {}
    const r = await rig({
      killPluginProcesses: async () => {
        seen = JSON.parse(readFileSync(installedFile(holder.r!), 'utf8')).plugins[0].enabled
      },
    })
    holder.r = r
    await install(r, plugin())
    await call(r, 'plugins.setEnabled', { commandId: 'd', id: 'demo', enabled: false })
    expect(seen).toBe(false)
  })

  it('replayed by commandId and repeated by value: one event; not installed is refused', async () => {
    const r = await rig()
    await install(r, plugin())
    await call(r, 'plugins.setEnabled', { commandId: 'd', id: 'demo', enabled: false })
    await call(r, 'plugins.setEnabled', { commandId: 'd', id: 'demo', enabled: false })
    await call(r, 'plugins.setEnabled', { commandId: 'd2', id: 'demo', enabled: false })
    expect(eventsOf(r, 'plugins.disabled')).toHaveLength(1)
    expect(await refused(call(r, 'plugins.setEnabled', { commandId: 'd3', id: 'nope', enabled: true }))).toBe('plugin_not_installed')
  })

  it('two lifecycle calls at once run one after the other', async () => {
    let inside = 0
    let most = 0
    const r = await rig({
      killPluginProcesses: async () => {
        most = Math.max(most, ++inside)
        await new Promise(res => setTimeout(res, 10))
        inside--
      },
    })
    await install(r, plugin())
    await Promise.all([
      call(r, 'plugins.grants.set', { commandId: 'a', id: 'demo', grants: { servers: {} } }),
      call(r, 'plugins.setEnabled', { commandId: 'b', id: 'demo', enabled: false }),
      call(r, 'plugins.uninstall', { commandId: 'c', id: 'demo' }),
    ])
    expect(most).toBe(1)
    expect((await call(r, 'plugins.list')).plugins).toEqual([])
  })
})

describe('plugins.grants.set', () => {
  const native = () => plugin({ format: 'native', id: 'nat', mcp: { srv: { command: 'node', permissions: { network: ['a.example.com', 'b.example.com'], cwd: 'write' } } } })
  it('any change kills the processes and writes the event; a host dropped is dropped; replay is one', async () => {
    const kills: string[] = []
    const r = await rig({ killPluginProcesses: async id => void kills.push(id) })
    await install(r, native(), { grants: { servers: { srv: { network: ['a.example.com', 'b.example.com'], cwd: 'read' } } } })
    kills.length = 0
    const narrow = { commandId: 'g1', id: 'nat', grants: { servers: { srv: { network: ['a.example.com'], cwd: 'read' } } } }
    await call(r, 'plugins.grants.set', narrow)
    await call(r, 'plugins.grants.set', narrow)
    expect(kills).toEqual(['nat'])
    expect(eventsOf(r, 'plugins.grants.updated').map(e => e.payload)).toEqual([{ id: 'nat' }])
    await call(r, 'plugins.grants.set', { commandId: 'g2', id: 'nat', grants: { servers: { srv: { network: ['a.example.com', 'b.example.com'], cwd: 'write' } } } })
    expect(kills).toEqual(['nat', 'nat'])
  })
  it('unchanged grants kill nothing', async () => {
    const kills: string[] = []
    const r = await rig({ killPluginProcesses: async id => void kills.push(id) })
    await install(r, native())
    kills.length = 0
    await call(r, 'plugins.grants.set', { commandId: 'g1', id: 'nat', grants: { servers: { srv: { network: [], cwd: 'read' } } } })
    expect(kills).toEqual([])
  })
  it('refusals leave the record alone', async () => {
    const r = await rig()
    await install(r, native())
    const before = readFileSync(installedFile(r))
    expect(await refused(call(r, 'plugins.grants.set', { commandId: 'g', id: 'nat', grants: { servers: { srv: { network: ['c.example.com'], cwd: 'read' } } } }))).toBe('grants_exceed_declared')
    expect(await refused(call(r, 'plugins.grants.set', { commandId: 'g2', id: 'nat', grants: { servers: { srv: { network: ['*'], cwd: 'read' } } } }))).toBe('bad_host')
    expect(await refused(call(r, 'plugins.grants.set', { commandId: 'g3', id: 'nope', grants: { servers: {} } }))).toBe('plugin_not_installed')
    expect(readFileSync(installedFile(r))).toEqual(before)
    expect(eventsOf(r, 'plugins.grants.updated')).toEqual([])
  })
})

describe('plugins.settings', () => {
  const secret = () => `sk-${'x'.repeat(24)}`

  it('a sensitive value lands in secrets under <id>/<KEY>, and in no record, event, log or RPC result', async () => {
    const value = `plain-${'q'.repeat(20)}`
    const r = await rig()
    await install(r, configured())
    expect(await call(r, 'plugins.settings.set', { id: 'demo', key: 'token', value })).toEqual({ ok: true })
    expect(await call(r, 'plugins.settings.set', { id: 'demo', key: 'RAW_KEY', value })).toEqual({ ok: true })
    expect(secretKeys(r)).toEqual(['plugin-manager/demo/RAW_KEY', 'plugin-manager/demo/token'])
    const got = await call(r, 'plugins.get', { id: 'demo' })
    expect(JSON.stringify(got)).not.toContain(value)
    expect(JSON.stringify(await call(r, 'plugins.list'))).not.toContain(value)
    expect(got.settings.find((s: { key: string }) => s.key === 'token')).toEqual({ key: 'token', set: true, sensitive: true })
    expect(r.rawBytes().includes(value)).toBe(false)
    expect(JSON.parse(readFileSync(installedFile(r), 'utf8')).plugins[0].secretKeys).toEqual(['RAW_KEY', 'token'])
  })

  it('a plain value is kept in the record and read back', async () => {
    const r = await rig()
    await install(r, configured())
    await call(r, 'plugins.settings.set', { id: 'demo', key: 'region', value: 'eu' })
    expect(secretKeys(r)).toEqual([])
    expect((await call(r, 'plugins.get', { id: 'demo' })).settings.find((s: { key: string }) => s.key === 'region')).toEqual({ key: 'region', set: true, sensitive: false, value: 'eu' })
  })

  it('a secret-shaped value under a key the plugin called plain goes to secrets, and a later plain value moves it back', async () => {
    const r = await rig()
    await install(r, configured())
    const v = secret()
    await call(r, 'plugins.settings.set', { id: 'demo', key: 'region', value: v })
    expect(secretKeys(r)).toEqual(['plugin-manager/demo/region'])
    expect(r.rawBytes().includes(v)).toBe(false)
    expect(JSON.stringify(await call(r, 'plugins.get', { id: 'demo' }))).not.toContain(v)
    expect((await call(r, 'plugins.get', { id: 'demo' })).settings.find((s: { key: string }) => s.key === 'region')).toEqual({ key: 'region', set: true, sensitive: true })
    await call(r, 'plugins.settings.set', { id: 'demo', key: 'region', value: 'eu' })
    expect(secretKeys(r)).toEqual([])
    expect((await call(r, 'plugins.get', { id: 'demo' })).settings.find((s: { key: string }) => s.key === 'region')).toEqual({ key: 'region', set: true, sensitive: false, value: 'eu' })
  })

  it('required config set: the server stops needing config', async () => {
    const r = await rig()
    await install(r, configured())
    await call(r, 'plugins.settings.set', { id: 'demo', key: 'token', value: 'v' })
    expect((await call(r, 'plugins.get', { id: 'demo' })).servers[0].state).toBe('needs_config')
    await call(r, 'plugins.settings.set', { id: 'demo', key: 'RAW_KEY', value: 'v' })
    expect((await call(r, 'plugins.get', { id: 'demo' })).servers[0]).toEqual({ name: 'srv', state: 'needs_sandbox' })
    await call(r, 'plugins.settings.clear', { id: 'demo', key: 'RAW_KEY' })
    expect((await call(r, 'plugins.get', { id: 'demo' })).servers[0].state).toBe('needs_config')
  })

  it('refused: an undeclared key, a key of another plugin, a shape holding a slash, a prototype name, a NUL value, an unknown plugin', async () => {
    const r = await rig()
    await install(r, configured())
    await install(r, plugin({ id: 'other', mcp: { srv: { command: 'node', env: { O: '${OTHER_KEY}' } } } }))
    const before = secretKeys(r)
    expect(await refused(call(r, 'plugins.settings.set', { id: 'demo', key: 'UNDECLARED', value: 'v' }))).toBe('unknown_setting')
    expect(await refused(call(r, 'plugins.settings.set', { id: 'demo', key: 'OTHER_KEY', value: 'v' }))).toBe('unknown_setting')
    expect(await refused(call(r, 'plugins.settings.set', { id: 'demo', key: 'constructor', value: 'v' }))).toBe('unknown_setting')
    expect(await refused(call(r, 'plugins.settings.set', { id: 'demo', key: '__proto__', value: 'v' }))).toBe('unknown_setting')
    await expect(call(r, 'plugins.settings.set', { id: 'demo', key: 'other/KEY', value: 'v' })).rejects.toMatchObject({ code: -32602 })
    expect(await refused(call(r, 'plugins.settings.set', { id: 'demo', key: 'region', value: 'a\0b' }))).toBe('bad_value')
    expect(await refused(call(r, 'plugins.settings.set', { id: 'nope', key: 'token', value: 'v' }))).toBe('plugin_not_installed')
    expect(secretKeys(r)).toEqual(before)
  })

  const lockedManager = (o: PluginManagerOpts, locked: { value: boolean }): ((e: { env: NodeJS.ProcessEnv; home: string }) => Plugin) => e => {
    const inner = createPluginManager({ allowFileProtocol: true, env: e.env, ...o })
    return {
      manifest: inner.manifest,
      activate(ctx: PluginContext) {
        const fail = async () => {
          throw new Error(`secrets locked at ${e.home}`)
        }
        const wrapped = Object.create(ctx) as PluginContext
        Object.defineProperty(wrapped, 'secrets', {
          value: {
            get: (k: string) => (locked.value ? Promise.resolve(undefined) : ctx.secrets.get(k)),
            set: (k: string, v: string) => (locked.value ? fail() : ctx.secrets.set(k, v)),
            delete: (k: string) => (locked.value ? fail() : ctx.secrets.delete(k)),
          },
        })
        Object.defineProperty(wrapped, 'secretsBackend', { get: () => (locked.value ? 'unavailable' : ctx.secretsBackend) })
        return inner.activate(wrapped)
      },
    }
  }

  it('secrets unavailable: secrets_unavailable, not an internal error, and no record of a key that was never stored', async () => {
    const locked = { value: false }
    const r = await pluginKernel({ manager: lockedManager({}, locked) })
    rigs.push(r)
    await install(r, configured())
    locked.value = true
    const before = readFileSync(installedFile(r))
    expect(await refused(call(r, 'plugins.settings.set', { id: 'demo', key: 'token', value: 'v' }))).toBe('secrets_unavailable')
    expect(readFileSync(installedFile(r))).toEqual(before)
    expect(r.logs.join('\n')).not.toContain('rpc plugins.settings.set failed')
    // 普通值不受影响
    expect(await call(r, 'plugins.settings.set', { id: 'demo', key: 'region', value: 'eu' })).toEqual({ ok: true })
  })

  it('uninstall with secrets locked refuses, so no key is orphaned; once unlocked it finishes', async () => {
    const locked = { value: false }
    const killCount = { value: 0 }
    const r = await pluginKernel({ manager: lockedManager({ killPluginProcesses: async () => void killCount.value++ }, locked) })
    rigs.push(r)
    await install(r, configured())
    await call(r, 'plugins.settings.set', { id: 'demo', key: 'token', value: 'v' })
    locked.value = true
    const kills = killCount.value
    expect(await refused(call(r, 'plugins.uninstall', { commandId: 'u', id: 'demo' }))).toBe('secrets_unavailable')
    // 拒绝的时候还没有动手:照常启用,进程也没杀
    expect((await call(r, 'plugins.list')).plugins[0]).toMatchObject({ id: 'demo', enabled: true })
    expect(killCount.value).toBe(kills)
    expect(secretKeys(r)).toEqual(['plugin-manager/demo/token'])
    locked.value = false
    await call(r, 'plugins.uninstall', { commandId: 'u', id: 'demo' })
    expect(secretKeys(r)).toEqual([])
  })

  it('a backend that fails only when writing still answers secrets_unavailable, and forgets the key', async () => {
    const r = await pluginKernel({
      manager: e => {
        const inner = createPluginManager({ allowFileProtocol: true, env: e.env })
        return {
          manifest: inner.manifest,
          activate(ctx) {
            const wrapped = Object.create(ctx) as PluginContext
            Object.defineProperty(wrapped, 'secrets', { value: { get: ctx.secrets.get, delete: ctx.secrets.delete, set: async () => Promise.reject(new Error(`no space at ${e.home}`)) } })
            return inner.activate(wrapped)
          },
        }
      },
    })
    rigs.push(r)
    await install(r, configured())
    const before = readFileSync(installedFile(r))
    expect(await refused(call(r, 'plugins.settings.set', { id: 'demo', key: 'token', value: 'v' }))).toBe('secrets_unavailable')
    expect(readFileSync(installedFile(r))).toEqual(before)
    expect(r.logs.join('\n')).not.toContain(r.home)
  })

  it('a crash between recording the key and storing the value still leaves the key known to uninstall', async () => {
    const stored: string[] = []
    const r = await pluginKernel({
      manager: e => {
        const inner = createPluginManager({ allowFileProtocol: true, env: e.env })
        return {
          manifest: inner.manifest,
          activate(ctx) {
            const wrapped = Object.create(ctx) as PluginContext
            Object.defineProperty(wrapped, 'secrets', {
              value: {
                get: ctx.secrets.get,
                delete: ctx.secrets.delete,
                set: (k: string, v: string) => {
                  stored.push(JSON.parse(readFileSync(join(e.dataDir, 'plugins', 'plugin-manager', 'installed.json'), 'utf8')).plugins[0].secretKeys.join())
                  return ctx.secrets.set(k, v)
                },
              },
            })
            return inner.activate(wrapped)
          },
        }
      },
    })
    rigs.push(r)
    await install(r, configured())
    await call(r, 'plugins.settings.set', { id: 'demo', key: 'token', value: 'v' })
    expect(stored).toEqual(['token'])
  })
})

describe('plugins.uninstall leaves nothing', () => {
  it('byte-identical snapshot: code, data, record, config and secret keys', async () => {
    const r = await rig()
    writeFileSync(join(r.dataDir, 'config.json'), JSON.stringify({ version: 1 }))
    const take = () => ({
      code: snapshot(storeOf(r)),
      data: snapshot(join(r.dataDir, 'plugin-data')),
      record: existsSync(installedFile(r)) ? readFileSync(installedFile(r)).toString('hex') : null,
      config: readFileSync(join(r.dataDir, 'config.json')).toString('hex'),
      secrets: secretKeys(r),
      manager: readdirSync(join(r.dataDir, 'plugins', 'plugin-manager')),
    })
    const before = take()
    await install(r, configured(), { grants: { servers: { srv: { network: ['api.example.com'], cwd: 'write' } } } })
    await call(r, 'plugins.settings.set', { id: 'demo', key: 'token', value: `sec-${'t'.repeat(20)}` })
    await call(r, 'plugins.settings.set', { id: 'demo', key: 'RAW_KEY', value: `sec-${'u'.repeat(20)}` })
    await call(r, 'plugins.settings.set', { id: 'demo', key: 'region', value: 'eu' })
    // 还没有服务(Task 9):数据目录由测试写,等于服务写过
    const data = join(r.dataDir, 'plugin-data', 'demo', 'srv')
    mkdirSync(data, { recursive: true })
    writeFileSync(join(data, 'cache'), 'written by the server')
    expect(take()).not.toEqual(before)
    expect(await call(r, 'plugins.uninstall', { commandId: 'u', id: 'demo' })).toEqual({ ok: true })
    expect(take()).toEqual(before)
    expect(eventsOf(r, 'plugins.uninstalled').map(e => e.payload)).toEqual([{ id: 'demo' }])
    await r.restart()
    expect(take()).toEqual(before)
  })

  it('removing one of two leaves the other whole', async () => {
    const r = await rig()
    await install(r, plugin({ id: 'keep' }))
    await install(r, plugin({ id: 'gone' }))
    await call(r, 'plugins.uninstall', { commandId: 'u', id: 'gone' })
    expect(readdirSync(storeOf(r))).toEqual(['keep'])
    expect((await call(r, 'plugins.list')).plugins.map((p: { id: string }) => p.id)).toEqual(['keep'])
    await r.restart()
    expect((await call(r, 'plugins.list')).plugins[0]).toMatchObject({ id: 'keep', enabled: true, state: 'ok' })
  })

  it('I3: the store root swapped for a link while running: uninstall removes the link, not what it points at', async () => {
    const r = await rig()
    await install(r, plugin())
    const victim = join(tmp, 'victim')
    mkdirSync(join(victim, 'demo'), { recursive: true })
    writeFileSync(join(victim, 'demo', 'canary'), 'alive')
    renameSync(storeOf(r), join(tmp, 'moved'))
    symlinkSync(victim, storeOf(r))
    await call(r, 'plugins.uninstall', { commandId: 'u', id: 'demo' })
    expect(readFileSync(join(victim, 'demo', 'canary'), 'utf8')).toBe('alive')
    expect((await call(r, 'plugins.list')).plugins).toEqual([])
  })

  it('a second install of the same id sees no old setting, secret, grant or data', async () => {
    const r = await rig()
    const path = configured()
    await install(r, path, { grants: { servers: { srv: { network: ['api.example.com'], cwd: 'write' } } } })
    await call(r, 'plugins.settings.set', { id: 'demo', key: 'token', value: 'v' })
    await call(r, 'plugins.settings.set', { id: 'demo', key: 'region', value: 'eu' })
    await call(r, 'plugins.uninstall', { commandId: 'u', id: 'demo' })
    await install(r, path)
    const got = await call(r, 'plugins.get', { id: 'demo' })
    expect(got.settings.every((s: { set: boolean }) => !s.set)).toBe(true)
    expect(got.grants).toEqual({ servers: { srv: { network: [], cwd: 'read' } } })
    expect(got.consent.diff).toBeUndefined()
  })

  it('kills first; the record is gone before the code is; replay is one event; not installed is refused', async () => {
    const seen: boolean[] = []
    const holder: { r?: PluginRig } = {}
    const r = await rig({ killPluginProcesses: async () => void seen.push(existsSync(join(storeOf(holder.r!), 'demo'))) })
    holder.r = r
    await install(r, plugin())
    seen.length = 0
    await call(r, 'plugins.uninstall', { commandId: 'u', id: 'demo' })
    await call(r, 'plugins.uninstall', { commandId: 'u', id: 'demo' })
    expect(seen).toEqual([true])
    expect(eventsOf(r, 'plugins.uninstalled')).toHaveLength(1)
    expect(await refused(call(r, 'plugins.uninstall', { commandId: 'u2', id: 'demo' }))).toBe('plugin_not_installed')
  })

  it('a kill that fails does not stop the uninstall, and logs no details', async () => {
    const r = await rig({
      killPluginProcesses: async () => {
        throw new Error('details')
      },
    })
    await install(r, plugin())
    await call(r, 'plugins.uninstall', { commandId: 'u', id: 'demo' })
    expect((await call(r, 'plugins.list')).plugins).toEqual([])
    expect(r.logs.join('\n')).not.toContain('details')
  })

  it('a crash after the record is gone: the empty record file says the store is ours, and the restart removes the files', async () => {
    const r = await rig()
    await install(r, plugin())
    const data = join(r.dataDir, 'plugin-data', 'demo', 'srv')
    mkdirSync(data, { recursive: true })
    writeFileSync(installedFile(r), JSON.stringify({ version: 1, plugins: [] }))
    await r.restart({ kill: true })
    expect((await call(r, 'plugins.list')).problems).toEqual([])
    expect(existsSync(installedFile(r))).toBe(false)
    expect(existsSync(storeOf(r))).toBe(false)
    expect(existsSync(join(r.dataDir, 'plugin-data'))).toBe(false)
  })
})

describe('I1, I2: a lost record costs nothing silently', () => {
  const lose = async (r: PluginRig) => {
    const rec = JSON.parse(readFileSync(installedFile(r), 'utf8'))
    writeFileSync(installedFile(r), JSON.stringify({ ...rec, version: 99 })) // 坏了,但还读得出密钥键
    await r.restart()
  }

  it('I2: orphaned secrets do not reach a later plugin with the same id', async () => {
    const r = await rig()
    const path = configured()
    await install(r, path)
    await install(r, plugin({ id: 'other', mcp: { srv: { command: 'node', env: { K: '${OTHER_KEY}' } } } }))
    await call(r, 'plugins.settings.set', { id: 'demo', key: 'token', value: 'old-owner' })
    await call(r, 'plugins.settings.set', { id: 'other', key: 'OTHER_KEY', value: 'theirs' })
    await lose(r)
    expect(secretKeys(r)).toContain('plugin-manager/demo/token')
    await install(r, path)
    expect(secretKeys(r)).toEqual(['plugin-manager/other/OTHER_KEY'])
    expect((await call(r, 'plugins.get', { id: 'demo' })).settings.every((s: { set: boolean }) => !s.set)).toBe(true)
  })

  it('I2: a locked backend refuses the landing, keeps the staging, and it can be confirmed once unlocked', async () => {
    const locked = { value: true }
    const r = await pluginKernel({
      manager: e => {
        const inner = createPluginManager({ allowFileProtocol: true, env: e.env })
        return {
          manifest: inner.manifest,
          activate(ctx) {
            const wrapped = Object.create(ctx) as PluginContext
            Object.defineProperty(wrapped, 'secrets', { value: { ...ctx.secrets, delete: (k: string) => (locked.value ? Promise.reject(new Error(`at ${e.home}`)) : ctx.secrets.delete(k)) } })
            return inner.activate(wrapped)
          },
        }
      },
    })
    rigs.push(r)
    const st = await prepare(r, { kind: 'path', path: configured() })
    expect(await refused(confirm(r, st))).toBe('secrets_unavailable')
    expect((await call(r, 'plugins.list')).plugins).toEqual([])
    locked.value = false
    expect(await confirm(r, st)).toEqual({ ok: true, id: 'demo' })
  })

  it('an upgrade that newly declares a key clears an orphan under it, and keeps the keys it already held', async () => {
    const r = await rig()
    const spec = (keys: string[]) => plugin({ mcp: { srv: { command: 'node', env: Object.fromEntries(keys.map(k => [k, `\${${k}}`])) } } })
    await install(r, spec(['HELD']))
    await call(r, 'plugins.settings.set', { id: 'demo', key: 'HELD', value: 'v' })
    await install(r, spec(['HELD', 'FRESH']))
    expect(secretKeys(r)).toEqual(['plugin-manager/demo/HELD'])
  })

  it('plugins.store.discard: secrets listed in .bad, unknown dirs and .bad go; replay is one; the problem clears', async () => {
    const r = await rig()
    await install(r, configured())
    await call(r, 'plugins.settings.set', { id: 'demo', key: 'token', value: 'v' })
    const data = join(r.dataDir, 'plugin-data', 'demo', 'srv')
    mkdirSync(data, { recursive: true })
    await lose(r)
    await r.restart()
    expect((await call(r, 'plugins.list')).problems).toEqual(['store_recovered'])
    expect(existsSync(data)).toBe(true)
    const params = { commandId: 'disc' }
    expect(await call(r, 'plugins.store.discard', params)).toEqual({ ok: true })
    expect(await call(r, 'plugins.store.discard', params)).toEqual({ ok: true })
    expect(eventsOf(r, 'plugins.store.discarded')).toHaveLength(1)
    expect(secretKeys(r)).toEqual([])
    expect(existsSync(storeOf(r))).toBe(false)
    expect(existsSync(join(r.dataDir, 'plugin-data'))).toBe(false)
    expect(readdirSync(join(r.dataDir, 'plugins', 'plugin-manager'))).toEqual([])
    expect((await call(r, 'plugins.list')).problems).toEqual([])
    await r.restart()
    expect((await call(r, 'plugins.list')).problems).toEqual([])
  })

  it('plugins.store.discard leaves a plugin reinstalled meanwhile: its code, data and secret', async () => {
    const r = await rig()
    const path = configured()
    await install(r, path)
    await call(r, 'plugins.settings.set', { id: 'demo', key: 'token', value: 'old' })
    await lose(r)
    await install(r, path)
    await call(r, 'plugins.settings.set', { id: 'demo', key: 'token', value: 'new' })
    await call(r, 'plugins.store.discard', { commandId: 'disc' })
    expect(secretKeys(r)).toEqual(['plugin-manager/demo/token'])
    expect((await call(r, 'plugins.list')).plugins[0]).toMatchObject({ id: 'demo', state: 'ok' })
    expect(readdirSync(storeOf(r))).toEqual(['demo'])
  })

  it('plugins.store.discard with a file it cannot read: store_unreadable, nothing deleted', async () => {
    const r = await rig()
    await install(r, plugin())
    chmodSync(installedFile(r), 0o000)
    try {
      await r.restart()
      expect((await call(r, 'plugins.list')).problems).toEqual(['store_recovered'])
      expect(await refused(call(r, 'plugins.store.discard', { commandId: 'd' }))).toBe('store_unreadable')
      expect(existsSync(join(storeOf(r), 'demo'))).toBe(true)
      // 也写不进去:装新的不能盖掉读不了的记录
      const st = await prepare(r, { kind: 'path', path: plugin({ id: 'second' }) })
      expect(await refused(confirm(r, st))).toBe('store_error')
    } finally {
      chmodSync(installedFile(r), 0o600)
    }
    await r.restart()
    expect((await call(r, 'plugins.list')).plugins).toMatchObject([{ id: 'demo', enabled: true, state: 'ok' }])
  })

  it('plugins.store.discard with secrets locked: secrets_unavailable, nothing deleted, retry works', async () => {
    const locked = { value: false }
    const r = await pluginKernel({
      manager: e => {
        const inner = createPluginManager({ allowFileProtocol: true, env: e.env })
        return {
          manifest: inner.manifest,
          activate(ctx) {
            const wrapped = Object.create(ctx) as PluginContext
            Object.defineProperty(wrapped, 'secrets', { value: { ...ctx.secrets, delete: (k: string) => (locked.value ? Promise.reject(new Error('locked')) : ctx.secrets.delete(k)) } })
            return inner.activate(wrapped)
          },
        }
      },
    })
    rigs.push(r)
    await install(r, configured())
    await call(r, 'plugins.settings.set', { id: 'demo', key: 'token', value: 'v' })
    await lose(r)
    locked.value = true
    expect(await refused(call(r, 'plugins.store.discard', { commandId: 'd' }))).toBe('secrets_unavailable')
    expect(existsSync(join(storeOf(r), 'demo'))).toBe(true)
    expect((await call(r, 'plugins.list')).problems).toEqual(['store_recovered'])
    locked.value = false
    expect(await call(r, 'plugins.store.discard', { commandId: 'd' })).toEqual({ ok: true })
    expect(secretKeys(r)).toEqual([])
  })

  it('plugins.store.discard with nothing to discard changes nothing', async () => {
    const r = await rig()
    await install(r, plugin())
    expect(await call(r, 'plugins.store.discard', { commandId: 'd' })).toEqual({ ok: true })
    expect((await call(r, 'plugins.list')).plugins).toHaveLength(1)
  })
})

describe('small corrections from review', () => {
  it('m6: a plain value that looks secret when read back is masked in plugins.get', async () => {
    const secret = `sk-${'x'.repeat(24)}`
    const r = await rig()
    await install(r, configured())
    const rec = JSON.parse(readFileSync(installedFile(r), 'utf8'))
    rec.plugins[0].settings.region = secret // 旧记录、或打码规则后来才加的
    writeFileSync(installedFile(r), JSON.stringify(rec))
    await r.restart()
    const row = (await call(r, 'plugins.get', { id: 'demo' })).settings.find((s: { key: string }) => s.key === 'region')
    expect(JSON.stringify(row)).not.toContain(secret)
    expect(row.set).toBe(true)
  })

  it('m8: a refused enable has already killed the processes when it returns', async () => {
    const kills: string[] = []
    let finished = false
    const r = await rig({
      killPluginProcesses: async id => {
        await new Promise(res => setTimeout(res, 20))
        kills.push(id)
        finished = true
      },
    })
    await install(r, plugin())
    kills.length = 0
    finished = false
    const dir = join(storeOf(r), 'demo')
    writeFileSync(join(dir, readdirSync(dir)[0], 'tampered'), '')
    expect(await refused(call(r, 'plugins.setEnabled', { commandId: 'e', id: 'demo', enabled: true }))).toBe('integrity_failed')
    expect(finished).toBe(true)
    expect(kills).toEqual(['demo'])
  })
})

describe('plugins cannot reach each other', () => {
  it('secret keys are prefixed by id: the same key name on two plugins stays two values', async () => {
    const r = await rig()
    const spec = (id: string) => plugin({ id, mcp: { srv: { command: 'node', env: { K: '${SHARED}' } } } })
    await install(r, spec('aa'))
    await install(r, spec('bb'))
    await call(r, 'plugins.settings.set', { id: 'aa', key: 'SHARED', value: 'one' })
    await call(r, 'plugins.settings.set', { id: 'bb', key: 'SHARED', value: 'two' })
    expect(secretKeys(r)).toEqual(['plugin-manager/aa/SHARED', 'plugin-manager/bb/SHARED'])
    await call(r, 'plugins.uninstall', { commandId: 'u', id: 'aa' })
    expect(secretKeys(r)).toEqual(['plugin-manager/bb/SHARED'])
  })
})
