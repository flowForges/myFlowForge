import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createKernel, type Kernel } from '../kernel/kernel'
import type { Plugin, PluginContext } from '../kernel/pluginHost'
import { readDevIndex, trustDevPlugin } from '../lib/plugins/devStore'
import { NO_SANDBOX } from '../../test/sandboxStub'
import { DEV_LOADED_AFTER_MS, loadDevPlugins } from './devPlugins'

let tmp = ''
let dataDir = ''
let runDir = ''
let kernels: Kernel[] = []
const logged: { level: string; m: string; d?: unknown }[] = []
const log = {
  info: (m: string, d?: unknown) => void logged.push({ level: 'info', m, d }),
  warn: (m: string, d?: unknown) => void logged.push({ level: 'warn', m, d }),
  error: (m: string, d?: unknown) => void logged.push({ level: 'error', m, d }),
}
const marker = () => join(runDir, 'dev-loading')
const sha = (b: string) => createHash('sha256').update(b).digest('hex')

const moduleText = (id: string, body = '') => `${body}\nexport default { manifest: { id: ${JSON.stringify(id)}, version: '1.0.0', kernel: '^0.1.0' }, activate(ctx) { ctx.log.info('active') } }\n`

let n = 0
function trusted(id = 'dev-x', text = moduleText(id)) {
  const dir = join(tmp, `src-${++n}`)
  mkdirSync(dir)
  writeFileSync(join(dir, 'mff-plugin.json'), JSON.stringify({ id, version: '1.0.0', main: 'p.mjs' }))
  writeFileSync(join(dir, 'p.mjs'), text)
  const r = trustDevPlugin({ dataDir, path: dir, reservedIds: new Set() })
  if (!r.ok) throw new Error(r.error)
  return { dir, ...r, file: readDevIndex(dataDir).find(e => e.id === id)!.file }
}
const goodPlugin = (id: string, activate: Plugin['activate'] = () => {}) => ({ default: { manifest: { id, version: '1.0.0', kernel: '^0.1.0' }, activate } })
/** 按 URL 给假模块;记下导入过什么 */
function importerOf(mods: Record<string, () => unknown>) {
  const urls: string[] = []
  const importer = vi.fn(async (url: string) => {
    urls.push(url)
    for (const [id, make] of Object.entries(mods)) if (url.includes(`/${id}/`)) return make()
    throw new Error(`no module for ${url}`)
  })
  return { importer, urls }
}
const load = (importer: (url: string) => Promise<unknown>, over: Partial<Parameters<typeof loadDevPlugins>[0]> = {}) => loadDevPlugins({ dataDir, runDir, log, importer, ...over })

async function kernelWith(plugins: Plugin[], devPlugins?: { ids: string[]; skipped?: 'dev_crashed' }): Promise<Kernel> {
  const k = await createKernel({ dataDir, home: join(tmp, 'home'), plugins, secrets: { osBackend: false }, sandbox: NO_SANDBOX, ...(devPlugins && { devPlugins }) })
  kernels.push(k)
  return k
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-devload-')))
  dataDir = join(tmp, 'data')
  runDir = join(dataDir, 'run')
  mkdirSync(dataDir)
  mkdirSync(join(tmp, 'home'))
  logged.length = 0
  kernels = []
})
afterEach(async () => {
  for (const k of kernels) await k.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('loadDevPlugins: what gets imported', () => {
  it('nothing trusted: no import, no marker, not one file or directory created', async () => {
    const { importer } = importerOf({})
    const dev = await load(importer)
    expect(dev.plugins).toEqual([])
    expect(dev.skipped).toBeUndefined()
    expect(importer).not.toHaveBeenCalled()
    expect(readdirSync(dataDir)).toEqual([])
    dev.markLoaded()
    expect(readdirSync(dataDir)).toEqual([])
  })

  it('imports the approved copy by file URL, never the source', async () => {
    const t = trusted()
    const { importer, urls } = importerOf({ 'dev-x': () => goodPlugin('dev-x') })
    const dev = await load(importer)
    expect(urls).toEqual([pathToFileURL(t.file).href])
    expect(urls[0]).not.toContain(t.dir)
    expect(dev.plugins.map(p => p.manifest.id)).toEqual(['dev-x'])
  })

  it('after trust, editing the source changes nothing on the next start; only a new trust does', async () => {
    const t = trusted()
    writeFileSync(join(t.dir, 'p.mjs'), 'export default "edited"')
    const first = importerOf({ 'dev-x': () => goodPlugin('dev-x') })
    const dev = await load(first.importer)
    expect(first.urls).toEqual([pathToFileURL(t.file).href])
    expect(readFileSync(t.file, 'utf8')).toBe(moduleText('dev-x'))
    dev.markLoaded()

    const edited = moduleText('dev-x', '// edited')
    writeFileSync(join(t.dir, 'p.mjs'), edited)
    const again = trustDevPlugin({ dataDir, path: t.dir, reservedIds: new Set() })
    expect(again).toMatchObject({ ok: true, hash: sha(edited) })
    const second = importerOf({ 'dev-x': () => goodPlugin('dev-x') })
    await load(second.importer)
    expect(second.urls[0]).toContain(`entry-${sha(edited).slice(0, 12)}.mjs`)
  })

  it('a copy changed on disk is not imported; it shows as failed', async () => {
    const t = trusted()
    writeFileSync(t.file, 'export default "tampered"')
    const { importer } = importerOf({ 'dev-x': () => goodPlugin('dev-x') })
    const dev = await load(importer)
    expect(importer).not.toHaveBeenCalled()
    expect(logged.some(l => l.level === 'warn' && JSON.stringify(l.d).includes('hash_mismatch'))).toBe(true)
    expect(dev.plugins.map(p => p.manifest.id)).toEqual(['dev-x'])
    await expect(dev.plugins[0].activate({} as PluginContext)).rejects.toThrow('hash_mismatch')
  })

  it.each([
    ['removed', (f: string) => rmSync(f)],
    ['swapped for a link to identical bytes', (f: string) => { const other = join(tmp, 'same.mjs'); writeFileSync(other, readFileSync(f)); rmSync(f); symlinkSync(other, f) }],
  ])('a copy %s is not imported', async (_, change) => {
    const t = trusted()
    change(t.file)
    const { importer } = importerOf({ 'dev-x': () => goodPlugin('dev-x') })
    const dev = await load(importer)
    expect(importer).not.toHaveBeenCalled()
    await expect(dev.plugins[0].activate({} as PluginContext)).rejects.toThrow('hash_mismatch')
  })

  it.each([
    ['another id', () => goodPlugin('dev-other')],
    ['a built-in id', () => goodPlugin('memory-default')],
    ['no default', () => ({})],
    ['a default that is not an object', () => ({ default: 'x' })],
    ['no manifest', () => ({ default: { activate() {} } })],
    ['no activate', () => ({ default: { manifest: { id: 'dev-x', version: '1.0.0', kernel: '^0.1.0' } } })],
    ['activate that is not a function', () => ({ default: { manifest: { id: 'dev-x', version: '1.0.0', kernel: '^0.1.0' }, activate: 1 } })],
    ['a default getter that throws', () => ({ get default() { throw new Error('boom') } })],
  ] as [string, () => unknown][])('a module with %s becomes a failing plugin under its own id', async (_, make) => {
    trusted()
    const dev = await load(importerOf({ 'dev-x': make }).importer)
    expect(dev.plugins.map(p => p.manifest.id)).toEqual(['dev-x'])
    await expect(Promise.resolve().then(() => dev.plugins[0].activate({} as PluginContext))).rejects.toThrow()
  })

  it('an import that throws, even something odd, is a failing plugin, with no secret in the message', async () => {
    trusted('dev-a')
    trusted('dev-b')
    trusted('dev-c')
    const secret = `sk-${'x'.repeat(24)}`
    const dev = await load(importerOf({
      'dev-a': () => { throw new Error(`failed with ${secret}`) },
      'dev-b': () => { throw null },
      'dev-c': () => goodPlugin('dev-c'),
    }).importer)
    expect(dev.plugins.map(p => p.manifest.id)).toEqual(['dev-a', 'dev-b', 'dev-c'])
    const err = await Promise.resolve().then(() => dev.plugins[0].activate({} as PluginContext)).catch(e => (e as Error).message)
    expect(err).toContain('failed with')
    expect(err).not.toContain(secret)
    expect(JSON.stringify(logged)).not.toContain(secret)
    await expect(Promise.resolve().then(() => dev.plugins[1].activate({} as PluginContext))).rejects.toThrow()
  })
})

describe('loadDevPlugins: the marker', () => {
  it('is on disk before the import starts, stays after it, goes at markLoaded', async () => {
    trusted()
    let during = false
    const dev = await load(async () => {
      during = existsSync(marker())
      return goodPlugin('dev-x')
    })
    expect(during).toBe(true)
    expect(existsSync(marker())).toBe(true)
    dev.markLoaded()
    expect(existsSync(marker())).toBe(false)
    dev.markLoaded() // 第二次没事
  })

  it('crash, skip, stop, load: the whole flow', async () => {
    trusted()
    const crash = importerOf({ 'dev-x': () => goodPlugin('dev-x') })
    await load(crash.importer) // 这个进程在 30 s 内崩了:没人删标记
    expect(existsSync(marker())).toBe(true)

    const skip = importerOf({ 'dev-x': () => goodPlugin('dev-x') })
    const skipped = await load(skip.importer)
    expect(skipped.skipped).toBe('dev_crashed')
    expect(skipped.plugins).toEqual([])
    expect(skip.importer).not.toHaveBeenCalled()
    expect(existsSync(marker())).toBe(true) // 这次还没活过 30 s,再崩还跳过

    skipped.markLoaded() // 活够了,或者正常停了
    const next = importerOf({ 'dev-x': () => goodPlugin('dev-x') })
    const loaded = await load(next.importer)
    expect(loaded.skipped).toBeUndefined()
    expect(next.importer).toHaveBeenCalledTimes(1)
    expect(loaded.plugins.map(p => p.manifest.id)).toEqual(['dev-x'])
  })

  it('a clean stop inside the 30 s, which calls markLoaded, means the next start loads', async () => {
    trusted()
    ;(await load(importerOf({ 'dev-x': () => goodPlugin('dev-x') }).importer)).markLoaded()
    const next = await load(importerOf({ 'dev-x': () => goodPlugin('dev-x') }).importer)
    expect(next.skipped).toBeUndefined()
    expect(next.plugins).toHaveLength(1)
  })

  it('a stale marker with nothing trusted is no crash: nothing to skip, and it is cleared', async () => {
    mkdirSync(runDir)
    writeFileSync(marker(), '')
    const dev = await load(importerOf({}).importer)
    expect(dev.skipped).toBeUndefined()
    expect(existsSync(marker())).toBe(false)
  })

  it('a dangling link as the marker still counts as there', async () => {
    trusted()
    mkdirSync(runDir)
    symlinkSync(join(tmp, 'nothing'), marker())
    const { importer } = importerOf({ 'dev-x': () => goodPlugin('dev-x') })
    expect((await load(importer)).skipped).toBe('dev_crashed')
    expect(importer).not.toHaveBeenCalled()
  })

  it("if the marker can't be written nothing is imported: no guard, no load", async () => {
    trusted()
    writeFileSync(runDir, 'a file where the directory goes')
    const { importer } = importerOf({ 'dev-x': () => goodPlugin('dev-x') })
    const dev = await load(importer)
    expect(importer).not.toHaveBeenCalled()
    expect(dev.plugins.map(p => p.manifest.id)).toEqual(['dev-x'])
    await expect(dev.plugins[0].activate({} as PluginContext)).rejects.toThrow('dev_guard_unavailable')
  })

  it('armMarkLoaded removes it 30 s later on the injected timer, and markLoaded cancels the wait', async () => {
    expect(DEV_LOADED_AFTER_MS).toBe(30_000)
    trusted()
    const fired: { fn: () => void; ms: number }[] = []
    const cleared: unknown[] = []
    const timers = { setTimeout: (fn: () => void, ms: number) => { fired.push({ fn, ms }); return fired.length }, clearTimeout: (h: unknown) => void cleared.push(h) }
    const dev = await load(importerOf({ 'dev-x': () => goodPlugin('dev-x') }).importer, { timers })
    expect(fired).toEqual([]) // 激活之后才开始算,不是加载时
    dev.armMarkLoaded()
    expect(fired.map(f => f.ms)).toEqual([30_000])
    expect(existsSync(marker())).toBe(true)
    fired[0].fn()
    expect(existsSync(marker())).toBe(false)

    const second = await load(importerOf({ 'dev-x': () => goodPlugin('dev-x') }).importer, { timers })
    second.armMarkLoaded()
    second.markLoaded()
    expect(cleared).toEqual([2])
  })

  it('a skipped start arms the same way, so one good run later the plugins come back', async () => {
    trusted()
    mkdirSync(runDir)
    writeFileSync(marker(), '')
    const fired: (() => void)[] = []
    const dev = await load(importerOf({}).importer, { timers: { setTimeout: (fn: () => void) => (fired.push(fn), 1), clearTimeout: () => {} } })
    expect(dev.skipped).toBe('dev_crashed')
    dev.armMarkLoaded()
    fired[0]()
    expect(existsSync(marker())).toBe(false)
  })
})

describe('the real importer', () => {
  // vite-node 放行:这里跑的是真 import,不是假的。打包后 import( 还在不在,Task 11 的回合证明
  it('loads a temp .mjs from its copy; node: built-ins work', async () => {
    trusted('dev-real', `import { sep } from 'node:path'\nexport default { manifest: { id: 'dev-real', version: '1.0.0', kernel: '^0.1.0', sep }, activate() {} }\n`)
    const dev = await loadDevPlugins({ dataDir, runDir, log })
    expect(dev.plugins.map(p => p.manifest.id)).toEqual(['dev-real'])
    expect((dev.plugins[0].manifest as unknown as { sep: string }).sep).toBe('/')
    await expect(Promise.resolve(dev.plugins[0].activate({ append: () => ({}) } as unknown as PluginContext))).resolves.toBeUndefined()
  })

  it('a bundle with a relative or a bare import fails: only the one file came over', async () => {
    const dir = trusted('dev-rel', `import { a } from './helper.mjs'\nexport default { manifest: { id: 'dev-rel', version: '1.0.0', kernel: '^0.1.0' }, activate() { return a } }\n`)
    writeFileSync(join(dir.dir, 'helper.mjs'), 'export const a = 1')
    trusted('dev-bare', `import x from 'no-such-package-anywhere'\nexport default { manifest: { id: 'dev-bare', version: '1.0.0', kernel: '^0.1.0' }, activate() { return x } }\n`)
    const dev = await loadDevPlugins({ dataDir, runDir, log })
    expect(dev.plugins.map(p => p.manifest.id)).toEqual(['dev-bare', 'dev-rel'])
    for (const p of dev.plugins) await expect(Promise.resolve().then(() => p.activate({} as PluginContext))).rejects.toThrow()
  })
})

describe('through a kernel', () => {
  const builtin: Plugin = { manifest: { id: 'builtin', version: '1.0.0', kernel: '^0.1.0' }, activate() {} }
  const eventsOf = (k: Kernel, type: string) => k.events.after(0, 1000).filter(e => e.type === type)

  it("status says trust:'dev' for dev ids only, plugins.dev.loaded carries the hash, no problems on a good start", async () => {
    const t = trusted()
    let ctxSeen: PluginContext | undefined
    const dev = await load(importerOf({ 'dev-x': () => goodPlugin('dev-x', c => { ctxSeen = c }) }).importer)
    const k = await kernelWith([builtin, ...dev.plugins], { ids: dev.plugins.map(p => p.manifest.id), ...(dev.skipped && { skipped: dev.skipped }) })
    expect(ctxSeen).toBeDefined()
    const st = k.status()
    expect(st.plugins).toEqual([{ id: 'builtin', state: 'active' }, { id: 'dev-x', state: 'active', trust: 'dev' }])
    expect(st).not.toHaveProperty('problems')
    expect(eventsOf(k, 'plugins.dev.loaded').map(e => e.payload)).toEqual([{ id: 'dev-x', hash: t.hash }])
    expect(await k.handle('status', {})).toMatchObject({ plugins: [{ id: 'builtin' }, { id: 'dev-x', trust: 'dev' }] })
  })

  it('a dev plugin that fails, at import or at activate, is plugin.failed; the others stay active; no loaded event', async () => {
    trusted('dev-a')
    trusted('dev-b')
    trusted('dev-c')
    const dev = await load(importerOf({
      'dev-a': () => { throw new Error("Cannot find module './helper.mjs'") },
      'dev-b': () => goodPlugin('dev-b', () => { throw new Error('activate exploded') }),
      'dev-c': () => goodPlugin('dev-c'),
    }).importer)
    const after: Plugin = { manifest: { id: 'after', version: '1.0.0', kernel: '^0.1.0' }, activate() {} }
    const k = await kernelWith([builtin, ...dev.plugins, after], { ids: dev.plugins.map(p => p.manifest.id) })
    const by = Object.fromEntries(k.status().plugins.map(p => [p.id, p]))
    expect(by['dev-a']).toMatchObject({ state: 'failed', trust: 'dev', error: expect.stringContaining('helper.mjs') })
    expect(by['dev-b']).toMatchObject({ state: 'failed', trust: 'dev', error: 'activate exploded' })
    expect(by['dev-c']).toMatchObject({ state: 'active', trust: 'dev' })
    expect(by.builtin).toEqual({ id: 'builtin', state: 'active' })
    expect(by.after).toEqual({ id: 'after', state: 'active' })
    expect(eventsOf(k, 'plugin.failed').map(e => (e.payload as { id: string }).id)).toEqual(['dev-a', 'dev-b'])
    expect(eventsOf(k, 'plugins.dev.loaded').map(e => (e.payload as { id: string }).id)).toEqual(['dev-c'])
  })

  it('a skipped start: status says dev_crashed, the plugin is not listed, RPC is up', async () => {
    trusted()
    mkdirSync(runDir)
    writeFileSync(marker(), '')
    const dev = await load(importerOf({ 'dev-x': () => goodPlugin('dev-x') }).importer)
    const k = await kernelWith([builtin, ...dev.plugins], { ids: [], skipped: dev.skipped })
    expect(k.status().problems).toEqual(['dev_crashed'])
    expect(k.status().plugins).toEqual([{ id: 'builtin', state: 'active' }])
    expect(await k.handle('status', {})).toMatchObject({ problems: ['dev_crashed'] })
    expect(eventsOf(k, 'plugins.dev.loaded')).toEqual([])
  })

  it('without devPlugins nothing is dev, and a kernel without it is unchanged', async () => {
    const k = await kernelWith([builtin])
    expect(k.status().plugins).toEqual([{ id: 'builtin', state: 'active' }])
    expect(k.status()).not.toHaveProperty('problems')
  })

  it('a dev plugin has no privileges by name: no config section, no redact, no new RPC method', async () => {
    trusted()
    const tried: Record<string, string> = {}
    const attempt = async (name: string, fn: () => unknown) => {
      try {
        await fn()
        tried[name] = 'no error'
      } catch (e) {
        tried[name] = (e as Error).message
      }
    }
    const dev = await load(importerOf({
      'dev-x': () => goodPlugin('dev-x', async c => {
        await attempt('config', () => c.updateConfig('models', {}))
        await attempt('redact', () => c.events.redact([]))
        await attempt('rpc', () => c.rpc.register('dev.anything' as never, async () => 1))
      }),
    }).importer)
    const k = await kernelWith(dev.plugins, { ids: ['dev-x'] })
    expect(k.status().plugins[0]).toMatchObject({ state: 'active' })
    expect(tried.config).toContain('not writable')
    expect(tried.redact).toContain('may not redact')
    expect(tried.rpc).toContain('unknown rpc method')
    await expect(k.handle('dev.anything', {})).rejects.toMatchObject({ code: -32601 })
  })

  it('a plugin whose manifest id is changed after the check still runs under the approved id', async () => {
    trusted()
    let reads = 0
    const dev = await load(importerOf({
      'dev-x': () => ({ default: { get manifest() { reads++; return { id: reads === 1 ? 'dev-x' : 'memory-default', version: '1.0.0', kernel: '^0.1.0' } }, activate() {} } }),
    }).importer)
    expect(dev.plugins[0].manifest.id).toBe('dev-x')
    expect(dev.plugins[0].manifest.id).toBe('dev-x')
    expect(lstatSync(marker()).isFile()).toBe(true)
  })
})
