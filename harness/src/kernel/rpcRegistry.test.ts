import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, type Kernel } from './kernel'
import { EventBus } from './events'
import { nullLogger } from './log'
import { PluginHost, type Plugin, type PluginContext } from './pluginHost'
import { ServiceRegistry } from './services'
import { RpcError } from './rpcError'
import { RpcRegistry } from './rpcRegistry'
import type { WorkerMethodName } from '../protocol/index'

let dir: string
let kernels: Kernel[] = []
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mffai-rpcreg-')) })
afterEach(async () => {
  for (const k of kernels) await k.close().catch(() => {})
  kernels = []
  rmSync(dir, { recursive: true, force: true })
})

const plugin = (id: string, activate: (ctx: PluginContext) => void | Promise<void>): Plugin => ({
  manifest: { id, version: '1', kernel: '*' },
  activate,
})
async function boot(plugins: Plugin[]) {
  const k = await createKernel({ dataDir: dir, plugins })
  kernels.push(k)
  return k
}
const codeOf = async (p: Promise<unknown>) => {
  try { await p } catch (e) { return (e as RpcError).code }
  throw new Error('expected rejection')
}

describe('RpcRegistry', () => {
  it('register / get / dispose', () => {
    const r = new RpcRegistry()
    const h = async () => 1
    const off = r.register('a', 'models.catalog', h)
    expect(r.get('models.catalog')).toBe(h)
    off()
    expect(r.get('models.catalog')).toBeUndefined()
  })
  it('reserved core methods throw', () => {
    const r = new RpcRegistry()
    for (const m of ['auth', 'hello', 'status', 'snapshot', 'events.tail', 'events.subscribe', 'session.create', 'session.prompt', 'session.cancel'])
      expect(() => r.register('a', m as WorkerMethodName, async () => 1)).toThrow(/reserved/)
  })
  it('unknown method throws', () => {
    expect(() => new RpcRegistry().register('a', 'nope.x' as WorkerMethodName, async () => 1)).toThrow(/unknown/)
  })
  it('duplicate registration throws; stale disposer does not remove the new owner', () => {
    const r = new RpcRegistry()
    const off = r.register('a', 'models.quota', async () => 1)
    expect(() => r.register('b', 'models.quota', async () => 2)).toThrow(/already registered by a/)
    off()
    const h = async () => 3
    r.register('b', 'models.quota', h)
    off()
    expect(r.get('models.quota')).toBe(h)
  })
})

describe('plugin RPC via kernel.handle', () => {
  it('registered method is callable with validated params; unregistered → -32601', async () => {
    const seen: unknown[] = []
    const k = await boot([plugin('p', ctx => {
      ctx.rpc.register('models.catalog', async () => ({ presets: [], models: {} }))
      ctx.rpc.register('models.setDefault', async p => { seen.push(p); return { ok: true } })
    })])
    expect(await k.handle('models.catalog', undefined)).toEqual({ presets: [], models: {} })
    expect(await k.handle('models.setDefault', { accountId: 'a', modelId: 'm' })).toEqual({ ok: true })
    // 参数先由内核校验,处理者不会看到坏参数
    expect(await codeOf(k.handle('models.setDefault', { accountId: 'a' }))).toBe(-32602)
    expect(seen).toEqual([{ accountId: 'a', modelId: 'm' }])
    expect(await codeOf(k.handle('models.quota', { accountId: 'a' }))).toBe(-32601)
  })

  it('handler RpcError passes through; other errors → -32603', async () => {
    const k = await boot([plugin('p', ctx => {
      ctx.rpc.register('models.quota', async () => { throw new RpcError(-32602, 'bad account') })
      ctx.rpc.register('models.testAccount', async () => { throw new Error('boom') })
    })])
    await expect(k.handle('models.quota', { accountId: 'a' })).rejects.toMatchObject({ code: -32602, message: 'bad account' })
    expect(await codeOf(k.handle('models.testAccount', { accountId: 'a' }))).toBe(-32603)
  })

  it('registering a reserved method makes the plugin fail', async () => {
    const k = await boot([plugin('p', ctx => { ctx.rpc.register('session.create', async () => ({})) })])
    expect(k.status().plugins).toEqual([expect.objectContaining({ id: 'p', state: 'failed', error: expect.stringMatching(/reserved/) })])
  })

  it('two plugins registering the same method: second one fails, first keeps it', async () => {
    const k = await boot([
      plugin('a', ctx => { ctx.rpc.register('models.accounts', async () => ({ accounts: [], secretsBackend: 'keychain' })) }),
      plugin('b', ctx => { ctx.rpc.register('models.accounts', async () => ({ accounts: [], secretsBackend: 'dpapi' })) }),
    ])
    expect(k.status().plugins.map(p => p.state)).toEqual(['active', 'failed'])
    expect(await k.handle('models.accounts', {})).toEqual({ accounts: [], secretsBackend: 'keychain' })
  })

  it('deactivating the plugin removes its methods', async () => {
    // 激活中途失败 → 作用域释放 → 已注册的方法随之注销
    const k = await boot([plugin('p', ctx => {
      ctx.rpc.register('models.catalog', async () => ({ presets: [], models: {} }))
      throw new Error('later failure')
    })])
    expect(await codeOf(k.handle('models.catalog', {}))).toBe(-32601)
  })

  it('PluginHost.deactivateAll unregisters plugin methods', async () => {
    const rpc = new RpcRegistry()
    const host = new PluginHost({
      services: new ServiceRegistry(), events: new EventBus(), rpc, log: nullLogger, dataDir: dir,
      append: e => ({ ...e, seq: 1, ts: 0 }),
    })
    await host.activateAll([plugin('p', ctx => { ctx.rpc.register('models.catalog', async () => ({})) })], [])
    expect(rpc.get('models.catalog')).toBeDefined()
    await host.deactivateAll()
    expect(rpc.get('models.catalog')).toBeUndefined()
  })
})
