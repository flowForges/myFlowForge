// plugins.dev.*(09 spec §12、Review Focus 6)。真内核,假模型。真 Seatbelt 的那条在 mcp.darwin.test.ts
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { call, eventsOf, prepare, refused, scriptQueue, stubPlugin, withManager } from '../../../test/managerRig'
import { calling, say } from '../../../test/memoryRig'
import { pluginKernel, type PluginKernelOpts, type PluginRig } from '../../../test/pluginRig'
import toolsRegistry from '../tools-registry'
import type { SessionCommands, ToolsService } from '../../lib/tools/types'
import { readDevIndex } from '../../lib/plugins/devStore'
import { createToolsCoding } from '../tools-coding'

const ACK = 'runs_with_full_access'
const SRC = 'export default { manifest: { id: "dev-x", version: "1.0.0", kernel: "^0.1.0" }, activate() {} }\n'
const sha = (b: string) => createHash('sha256').update(b).digest('hex')

const rigs: PluginRig[] = []
async function rig(o: PluginKernelOpts = {}): Promise<PluginRig> {
  const r = await pluginKernel({ ...withManager(), ...o })
  rigs.push(r)
  return r
}
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close()
})

function source(r: PluginRig, manifest: Record<string, unknown> = {}, at = join(r.root, 'proj')): string {
  mkdirSync(join(at, 'dist'), { recursive: true })
  writeFileSync(join(at, 'mff-plugin.json'), JSON.stringify({ id: 'dev-x', version: '1.0.0', main: 'dist/plugin.mjs', ...manifest }))
  writeFileSync(join(at, 'dist', 'plugin.mjs'), SRC)
  return at
}
const nothingLanded = (r: PluginRig) => {
  expect(existsSync(join(r.dataDir, 'dev-plugins', 'dev-x'))).toBe(false)
  expect(eventsOf(r, 'plugins.dev.trusted')).toEqual([])
}

describe('plugins.dev.trust', () => {
  it.each([
    ['missing', {}],
    ['a plain yes', { acknowledge: 'yes' }],
    ['true', { acknowledge: true }],
    ['almost the literal', { acknowledge: 'runs_with_full_access ' }],
  ])('acknowledge %s: -32602 and nothing lands', async (_, ack) => {
    const r = await rig()
    await expect(call(r, 'plugins.dev.trust', { path: source(r), ...ack })).rejects.toMatchObject({ code: -32602 })
    nothingLanded(r)
  })

  it('the result says what was approved, and plugins.dev.trusted is the audit trail', async () => {
    const r = await rig()
    const res = await call(r, 'plugins.dev.trust', { path: source(r), acknowledge: ACK })
    expect(res).toEqual({ ok: true, id: 'dev-x', hash: sha(SRC), bytes: Buffer.byteLength(SRC), main: 'dist/plugin.mjs', restartRequired: true })
    expect(eventsOf(r, 'plugins.dev.trusted').map(e => e.payload)).toEqual([{ id: 'dev-x', hash: sha(SRC) }])
    expect(readFileSync(readDevIndex(r.dataDir)[0].file, 'utf8')).toBe(SRC)
  })

  it('plugins.list.dev comes from the record; the hash and time, no path', async () => {
    const r = await rig()
    expect((await call(r, 'plugins.list')).dev).toEqual([])
    const res = await call(r, 'plugins.dev.trust', { path: source(r), acknowledge: ACK })
    const { dev } = await call(r, 'plugins.list')
    expect(dev).toEqual([{ id: 'dev-x', hash: res.hash, trustedAt: expect.any(Number) }])
    await r.restart()
    expect((await call(r, 'plugins.list')).dev).toEqual(dev)
  })

  it('a path under a credential root is refused, and so is the data dir and a relative path', async () => {
    const r = await rig()
    const ssh = source(r, {}, join(r.home, '.ssh', 'proj'))
    expect(await refused(call(r, 'plugins.dev.trust', { path: ssh, acknowledge: ACK }))).toBe('path_refused')
    const data = source(r, {}, join(r.dataDir, 'proj'))
    expect(await refused(call(r, 'plugins.dev.trust', { path: data, acknowledge: ACK }))).toBe('path_refused')
    expect(await refused(call(r, 'plugins.dev.trust', { path: 'proj', acknowledge: ACK }))).toBe('path_refused')
    nothingLanded(r)
  })

  it('home is a fine root, but main under a credential root in it is refused all the same', async () => {
    const r = await rig()
    mkdirSync(join(r.home, '.ssh'), { recursive: true })
    writeFileSync(join(r.home, '.ssh', 'plugin.mjs'), SRC)
    writeFileSync(join(r.home, 'mff-plugin.json'), JSON.stringify({ id: 'dev-x', version: '1.0.0', main: '.ssh/plugin.mjs' }))
    expect(await refused(call(r, 'plugins.dev.trust', { path: r.home, acknowledge: ACK }))).toBe('main_invalid')
    nothingLanded(r)
  })

  it('the path is resolved before the manifest is read: a link to the source works, a link to a refused root does not', async () => {
    const r = await rig()
    const real = source(r)
    symlinkSync(real, join(r.root, 'proj-link'))
    expect(await call(r, 'plugins.dev.trust', { path: join(r.root, 'proj-link'), acknowledge: ACK })).toMatchObject({ ok: true, id: 'dev-x' })
    mkdirSync(join(r.home, '.ssh', 'p'), { recursive: true })
    symlinkSync(join(r.home, '.ssh', 'p'), join(r.root, 'ssh-link'))
    expect(await refused(call(r, 'plugins.dev.trust', { path: join(r.root, 'ssh-link'), acknowledge: ACK }))).toBe('path_refused')
  })

  it.each([
    ['a planted id without dev-', { id: 'memory-default' }, 'id_not_dev'],
    ['a main outside the directory', { main: '../out.mjs' }, 'main_invalid'],
    ['an unknown manifest key', { nope: 1 }, 'bad_manifest'],
  ])('%s is refused with a stable code', async (_, manifest, code) => {
    const r = await rig()
    writeFileSync(join(r.root, 'out.mjs'), SRC)
    expect(await refused(call(r, 'plugins.dev.trust', { path: source(r, manifest), acknowledge: ACK }))).toBe(code)
    nothingLanded(r)
  })

  it('a symlinked main is refused with -32602', async () => {
    const r = await rig()
    const dir = source(r)
    rmSync(join(dir, 'dist', 'plugin.mjs'))
    writeFileSync(join(r.root, 'out.mjs'), SRC)
    symlinkSync(join(r.root, 'out.mjs'), join(dir, 'dist', 'plugin.mjs'))
    await expect(call(r, 'plugins.dev.trust', { path: dir, acknowledge: ACK })).rejects.toMatchObject({ code: -32602, message: 'symlink' })
    nothingLanded(r)
  })

  it('a main name holding bidi characters comes back escaped; the event holds no path or name', async () => {
    const r = await rig()
    const name = 'dist/a‮b.mjs'
    const dir = source(r, { main: name })
    writeFileSync(join(dir, name), SRC)
    const res = await call(r, 'plugins.dev.trust', { path: dir, acknowledge: ACK })
    expect(res.main).not.toContain('‮')
    expect(res.main).toContain('\\u202e')
    expect(JSON.stringify(eventsOf(r, 'plugins.dev.trusted'))).not.toContain(dir)
  })

  it('an installed plugin cannot take a dev- id (the other side of the same wall)', async () => {
    const r = await rig()
    const dir = join(r.root, 'normal')
    mkdirSync(dir)
    writeFileSync(join(dir, 'mff-plugin.json'), JSON.stringify({ id: 'dev-x', version: '1.0.0', kernel: '^0.1.0' }))
    expect(await prepare(r, { kind: 'path', path: dir })).toMatchObject({ state: 'failed', error: 'id_reserved' })
  })
})

describe('plugins.dev.remove', () => {
  it('takes it off the list and off the disk, says restart, and another start finds nothing', async () => {
    const r = await rig()
    const { hash } = await call(r, 'plugins.dev.trust', { path: source(r), acknowledge: ACK })
    expect(readdirSync(join(r.dataDir, 'dev-plugins', 'dev-x'))).toEqual([`entry-${hash.slice(0, 12)}.mjs`])
    expect(await call(r, 'plugins.dev.remove', { id: 'dev-x' })).toEqual({ ok: true, restartRequired: true })
    expect((await call(r, 'plugins.list')).dev).toEqual([])
    expect(existsSync(join(r.dataDir, 'dev-plugins', 'dev-x'))).toBe(false)
  })

  it('an id that was never trusted: plugin_not_installed. A shape that climbs: -32602 at the schema', async () => {
    const r = await rig()
    expect(await refused(call(r, 'plugins.dev.remove', { id: 'dev-nope' }))).toBe('plugin_not_installed')
    await expect(call(r, 'plugins.dev.remove', { id: '../x' })).rejects.toMatchObject({ code: -32602 })
  })

  it('uninstall and dev.remove are separate lists: neither reaches the other', async () => {
    const r = await rig()
    await call(r, 'plugins.dev.trust', { path: source(r), acknowledge: ACK })
    expect(await refused(call(r, 'plugins.uninstall', { commandId: 'u1', id: 'dev-x' }))).toBe('plugin_not_installed')
    expect(readDevIndex(r.dataDir)).toHaveLength(1)
  })
})

describe('no path to plugins.dev.* but the RPC', () => {
  /** 拿到插件能拿到的那些服务 */
  async function withServices() {
    let commands: SessionCommands | undefined
    let tools: ToolsService | undefined
    const queue = scriptQueue()
    const r = await rig({
      models: { script: queue.script },
      before: () => [toolsRegistry, createToolsCoding({ loginPath: async () => '' }), stubPlugin([], ctx => {
        commands = ctx.services.get<SessionCommands>('sessionCommands')
        tools = ctx.services.get<ToolsService>('tools')
      })],
    })
    return { r, queue, commands: commands!, tools: tools! }
  }

  it.each(['plugins.dev.trust', 'plugins.dev.remove', 'plugins.list', 'plugins.install.confirm'])('sessionCommands.call refuses %s', async method => {
    const { r, commands } = await withServices()
    await expect(commands.call(method as never, { path: source(r), acknowledge: ACK } as never)).rejects.toThrow('not a session command')
    nothingLanded(r)
  })

  it('no tool is named for it, and a model forging one gets an unknown tool', async () => {
    const { r, queue, tools } = await withServices()
    expect(tools.list().map(t => t.name).filter(n => /dev|trust/i.test(n))).toEqual([])
    const path = source(r)
    queue.push(calling('c1', 'plugins.dev.trust', { path, acknowledge: ACK }), say('done'))
    const sid = await r.session({ approvalMode: 'auto' })
    await r.turn(sid, 'trust it')
    nothingLanded(r)
    expect(JSON.stringify(r.events(sid).filter(e => e.type === 'tool.ended'))).toContain('未知工具')
  })

  it('telegram commands are a closed list: its source names no plugins method', () => {
    const dir = join(__dirname, '..', 'channel-telegram')
    for (const f of readdirSync(dir).filter(n => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
      expect(readFileSync(join(dir, f), 'utf8')).not.toContain('plugins.')
    }
  })
})
