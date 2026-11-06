import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createKernel, type Kernel } from '../kernel/kernel'
import type { Plugin, PluginContext } from '../kernel/pluginHost'
import { readDevIndex, removeDevPlugin, trustDevPlugin } from '../lib/plugins/devStore'
import { NO_SANDBOX } from '../../test/sandboxStub'
import { cleanStop, loadDevPlugins } from './devPlugins'

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
const crashed = () => join(runDir, 'dev-crashed')
const DATA_URL = 'data:text/javascript;base64,'
const textOf = (url: string) => (url.startsWith(DATA_URL) ? Buffer.from(url.slice(DATA_URL.length), 'base64').toString('utf8') : '')
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
/** 按 data: URL 里的字节给假模块(按里面写的 id);记下导入过什么 */
function importerOf(mods: Record<string, () => unknown>) {
  const urls: string[] = []
  const importer = vi.fn(async (url: string) => {
    urls.push(url)
    for (const [id, make] of Object.entries(mods)) if (textOf(url).includes(JSON.stringify(id))) return make()
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
    cleanStop(runDir, log)
    expect(readdirSync(dataDir)).toEqual([])
  })

  it('imports the hashed bytes of the approved copy as a data: URL, never a file path', async () => {
    const t = trusted()
    const { importer, urls } = importerOf({ 'dev-x': () => goodPlugin('dev-x') })
    const dev = await load(importer)
    expect(urls).toHaveLength(1)
    expect(urls[0].startsWith(DATA_URL)).toBe(true)
    expect(textOf(urls[0])).toBe(readFileSync(t.file, 'utf8'))
    expect(urls[0]).not.toContain(pathToFileURL(t.file).href)
    expect(dev.plugins.map(p => p.manifest.id)).toEqual(['dev-x'])
  })

  it('after trust, editing the source changes nothing on the next start; only a new trust does', async () => {
    const t = trusted()
    writeFileSync(join(t.dir, 'p.mjs'), 'export default "edited"')
    const first = importerOf({ 'dev-x': () => goodPlugin('dev-x') })
    await load(first.importer)
    expect(first.urls.map(textOf)).toEqual([moduleText('dev-x')])
    expect(readFileSync(t.file, 'utf8')).toBe(moduleText('dev-x'))
    cleanStop(runDir, log)

    const edited = moduleText('dev-x', '// edited')
    writeFileSync(join(t.dir, 'p.mjs'), edited)
    const again = trustDevPlugin({ dataDir, path: t.dir, reservedIds: new Set() })
    expect(again).toMatchObject({ ok: true, hash: sha(edited) })
    const second = importerOf({ 'dev-x': () => goodPlugin('dev-x') })
    await load(second.importer)
    expect(second.urls.map(textOf)).toEqual([edited])
    expect(t.file).not.toBe(readDevIndex(dataDir).find(e => e.id === 'dev-x')!.file)
  })

  it('a copy changed on disk is not imported; it shows as failed', async () => {
    const t = trusted()
    writeFileSync(t.file, 'export default "tampered"')
    const { importer } = importerOf({ 'dev-x': () => goodPlugin('dev-x') })
    const dev = await load(importer)
    expect(importer).not.toHaveBeenCalled()
    expect(logged.some(l => l.level === 'warn' && JSON.stringify(l.d).includes('dev_hash_mismatch'))).toBe(true)
    expect(dev.plugins.map(p => p.manifest.id)).toEqual(['dev-x'])
    await expect(dev.plugins[0].activate({} as PluginContext)).rejects.toThrow(/^dev_hash_mismatch$/)
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
    await expect(dev.plugins[0].activate({} as PluginContext)).rejects.toThrow(/^dev_hash_mismatch$/)
  })

  it.each([
    ['another id', () => goodPlugin('dev-other'), 'dev_manifest_mismatch'],
    ['a built-in id', () => goodPlugin('memory-default'), 'dev_manifest_mismatch'],
    ['no default', () => ({}), 'dev_manifest_mismatch'],
    ['a default that is not an object', () => ({ default: 'x' }), 'dev_manifest_mismatch'],
    ['no manifest', () => ({ default: { activate() {} } }), 'dev_manifest_mismatch'],
    ['no activate', () => ({ default: { manifest: { id: 'dev-x', version: '1.0.0', kernel: '^0.1.0' } } }), 'dev_no_activate'],
    ['activate that is not a function', () => ({ default: { manifest: { id: 'dev-x', version: '1.0.0', kernel: '^0.1.0' }, activate: 1 } }), 'dev_no_activate'],
    ['a default getter that throws', () => ({ get default() { throw new Error('boom') } }), 'dev_import_failed'],
  ] as [string, () => unknown, string][])('a module with %s becomes a failing plugin under its own id, with a stable code', async (_, make, code) => {
    trusted()
    const dev = await load(importerOf({ 'dev-x': make }).importer)
    expect(dev.plugins.map(p => p.manifest.id)).toEqual(['dev-x'])
    // ctx 是能用的:失败只能来自那个替身,不是来自缺了 append
    const appended: unknown[] = []
    const ctx = { append: (e: unknown) => (appended.push(e), {}), log } as unknown as PluginContext
    await expect(Promise.resolve().then(() => dev.plugins[0].activate(ctx))).rejects.toThrow(new RegExp(`^${code}$`))
    expect(appended).toEqual([])
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
    // 稳定代码,没有导入器的原话(那里面有路径)
    expect(err).toBe('dev_import_failed')
    expect(JSON.stringify(logged)).not.toContain(secret)
    expect(JSON.stringify(logged)).not.toContain('failed with')
    await expect(Promise.resolve().then(() => dev.plugins[1].activate({} as PluginContext))).rejects.toThrow(/^dev_import_failed$/)
  })
})

describe('loadDevPlugins: the crash marker', () => {
  it('is on disk before the import starts, stays after it, goes only at a clean stop', async () => {
    trusted()
    let during = false
    await load(async () => {
      during = existsSync(marker())
      return goodPlugin('dev-x')
    })
    expect(during).toBe(true)
    expect(existsSync(marker())).toBe(true)
    cleanStop(runDir, log)
    expect(existsSync(marker())).toBe(false)
    cleanStop(runDir, log) // 第二次没事
  })

  it('crash, skip, and the skip is sticky across clean stops until a new trust', async () => {
    const t = trusted()
    await load(importerOf({ 'dev-x': () => goodPlugin('dev-x') }).importer) // 这个进程崩了:没人删标记
    expect(existsSync(marker())).toBe(true)

    for (let i = 0; i < 3; i++) {
      const skip = importerOf({ 'dev-x': () => goodPlugin('dev-x') })
      const skipped = await load(skip.importer)
      expect(skipped.skipped).toBe('dev_crashed')
      expect(skipped.plugins).toEqual([])
      expect(skip.importer).not.toHaveBeenCalled()
      cleanStop(runDir, log) // 跳过的这次正常停了:还是跳过,不来回
    }
    expect(existsSync(crashed())).toBe(true)

    trustDevPlugin({ dataDir, path: t.dir, reservedIds: new Set() })
    expect(existsSync(crashed())).toBe(false)
    const next = importerOf({ 'dev-x': () => goodPlugin('dev-x') })
    const loaded = await load(next.importer)
    expect(loaded.skipped).toBeUndefined()
    expect(next.importer).toHaveBeenCalledTimes(1)
  })

  it('plugins.dev.remove also lifts the skip, for the plugins left', async () => {
    trusted('dev-a')
    trusted('dev-b')
    await load(importerOf({ 'dev-a': () => goodPlugin('dev-a'), 'dev-b': () => goodPlugin('dev-b') }).importer)
    expect((await load(importerOf({}).importer)).skipped).toBe('dev_crashed')
    removeDevPlugin({ dataDir, id: 'dev-a' })
    const left = importerOf({ 'dev-b': () => goodPlugin('dev-b') })
    const dev = await load(left.importer)
    expect(dev.skipped).toBeUndefined()
    expect(dev.plugins.map(p => p.manifest.id)).toEqual(['dev-b'])
  })

  it('a crash long after loading still counts: no timer removes the marker', async () => {
    trusted()
    const armed: unknown[] = []
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => (armed.push(ms), 0)) as never)
    try {
      const dev = await load(importerOf({ 'dev-x': () => goodPlugin('dev-x') }).importer)
      expect(Object.keys(dev).sort()).toEqual(['plugins'])
    } finally {
      spy.mockRestore()
    }
    expect(armed).toEqual([])
    expect(existsSync(marker())).toBe(true)
    expect((await load(importerOf({}).importer)).skipped).toBe('dev_crashed')
  })

  it('a clean stop, which needs nothing from the load, means the next start loads', async () => {
    trusted()
    await load(importerOf({ 'dev-x': () => goodPlugin('dev-x') }).importer)
    cleanStop(runDir, log)
    const next = await load(importerOf({ 'dev-x': () => goodPlugin('dev-x') }).importer)
    expect(next.skipped).toBeUndefined()
    expect(next.plugins).toHaveLength(1)
  })

  it('a stale marker or skip with nothing trusted is no crash: nothing to skip, and both are cleared', async () => {
    mkdirSync(runDir)
    writeFileSync(marker(), '')
    writeFileSync(crashed(), '')
    const dev = await load(importerOf({}).importer)
    expect(dev.skipped).toBeUndefined()
    expect(existsSync(marker())).toBe(false)
    expect(existsSync(crashed())).toBe(false)
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
    await expect(dev.plugins[0].activate({} as PluginContext)).rejects.toThrow(/^dev_guard_unavailable$/)
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
    for (const p of dev.plugins) await expect(Promise.resolve().then(() => p.activate({} as PluginContext))).rejects.toThrow(/^dev_import_failed$/)
  })

  it('I-2: a bare import of a package planted in a node_modules above the copy does not load', async () => {
    // 文件 URL 的裸导入往上逐级找 node_modules:cwd = ~ 的会话写得到 ~/node_modules
    const planted = join(tmp, 'node_modules', 'planted')
    mkdirSync(planted, { recursive: true })
    const ran = join(tmp, 'planted-ran')
    writeFileSync(join(planted, 'package.json'), JSON.stringify({ name: 'planted', type: 'module', main: 'index.js' }))
    writeFileSync(join(planted, 'index.js'), `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(ran)}, 'ran')\nexport default 1\n`)
    trusted('dev-p', `import x from 'planted'\nexport default { manifest: { id: 'dev-p', version: '1.0.0', kernel: '^0.1.0' }, activate() { return x } }\n`)
    const dev = await loadDevPlugins({ dataDir, runDir, log })
    await expect(Promise.resolve().then(() => dev.plugins[0].activate({} as PluginContext))).rejects.toThrow(/^dev_import_failed$/)
    expect(existsSync(ran)).toBe(false)
  })

  it('I-2: the copy edited between the hash check and the import: the checked bytes load', async () => {
    const t = trusted('dev-e', `export default { manifest: { id: 'dev-e', version: '1.0.0', kernel: '^0.1.0', which: 'approved' }, activate() {} }\n`)
    const dev = await loadDevPlugins({
      dataDir, runDir, log,
      importer: u => {
        writeFileSync(t.file, `export default { manifest: { id: 'dev-e', version: '1.0.0', kernel: '^0.1.0', which: 'swapped' }, activate() {} }\n`)
        return import(/* @vite-ignore */ u)
      },
    })
    expect((dev.plugins[0].manifest as unknown as { which: string }).which).toBe('approved')
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
    // 稳定代码:导入器和 activate 的原话里有路径
    expect(by['dev-a']).toMatchObject({ state: 'failed', trust: 'dev', error: 'dev_import_failed' })
    expect(by['dev-b']).toMatchObject({ state: 'failed', trust: 'dev', error: 'dev_activate_failed' })
    expect(by['dev-c']).toMatchObject({ state: 'active', trust: 'dev' })
    expect(by.builtin).toEqual({ id: 'builtin', state: 'active' })
    expect(by.after).toEqual({ id: 'after', state: 'active' })
    expect(eventsOf(k, 'plugin.failed').map(e => e.payload)).toEqual([{ id: 'dev-a', error: 'dev_import_failed' }, { id: 'dev-b', error: 'dev_activate_failed' }])
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
