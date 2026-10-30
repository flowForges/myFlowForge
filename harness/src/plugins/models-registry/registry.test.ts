import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, type Kernel } from '../../kernel/kernel'
import type { Plugin } from '../../kernel/pluginHost'
import type { RpcError } from '../../kernel/rpcError'
import type { AccountView, CatalogView } from '../../protocol/models'
import type { Account, ModelAdapter, ModelEvent, ModelRequest, ModelsService } from '../../lib/models/types'
import { createModelsRegistry, type RegistryOpts } from './index'

let dir: string
let kernels: Kernel[] = []
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mffai-models-')) })
afterEach(async () => {
  for (const k of kernels) await k.close().catch(() => {})
  kernels = []
  rmSync(dir, { recursive: true, force: true })
})

type Call = { url: string; headers: Record<string, string> }
type Responder = (url: string, init?: RequestInit) => Response | Promise<Response>
function spyFetch(respond: Responder = () => new Response('{}')) {
  const calls: Call[] = []
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()) })
    return respond(String(url), init)
  }) as typeof fetch
  return { fn, calls }
}

/** 手动驱动的计时器:回调只在测试调用 fire() 时执行 */
function manualTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>()
  let n = 0
  return {
    timers: {
      setTimeout: (fn: () => void, ms: number) => { pending.set(++n, { fn, ms }); return n },
      clearTimeout: (h: unknown) => { pending.delete(h as number) },
    },
    pending,
    fire() {
      const all = [...pending.entries()]
      pending.clear()
      for (const [, t] of all) t.fn()
    },
  }
}

/** 假适配器:每次 stream 先调注入的 fetch(模拟网络),再按脚本吐事件 */
function fakeAdapter(fetchFn: typeof fetch, script: (a: Account, r: ModelRequest) => ModelEvent[]) {
  const seen: { account: Account; req: ModelRequest }[] = []
  const adapter: ModelAdapter = {
    async *stream(account, req) {
      seen.push({ account, req })
      await fetchFn(`${account.baseUrl}/x`)
      for (const e of script(account, req)) yield e
    },
    async test(account) {
      seen.push({ account, req: undefined as unknown as ModelRequest })
      await fetchFn(`${account.baseUrl}/test`)
    },
  }
  return { adapter, seen }
}

async function boot(opts: RegistryOpts = {}, extra: Plugin[] = []) {
  let svc: ModelsService | undefined
  const capture: Plugin = {
    manifest: { id: 'capture', version: '1', kernel: '*', inject: ['models'] },
    activate(ctx) { svc = ctx.services.get<ModelsService>('models') },
  }
  const t = manualTimers()
  const k = await createKernel({
    dataDir: dir,
    plugins: [createModelsRegistry({ timers: t.timers, ...opts }), ...extra, capture],
    secrets: { osBackend: false },
  })
  kernels.push(k)
  return { k, svc: svc!, timers: t }
}
const errOf = async (p: Promise<unknown>) => {
  try { await p } catch (e) { return e as RpcError }
  throw new Error('expected rejection')
}
const collect = async (it: AsyncIterable<ModelEvent>) => {
  const out: ModelEvent[] = []
  for await (const e of it) out.push(e)
  return out
}
const req = (interactive: boolean) => ({ interactive, messages: [{ role: 'user' as const, parts: [{ type: 'text' as const, text: 'hi' }] }], signal: new AbortController().signal })
const accountEvents = (k: Kernel) => k.events.after(0).filter(e => e.type === 'account.updated').map(e => (e.payload as { account: AccountView }).account)
const allEventsText = (k: Kernel) => JSON.stringify(k.events.after(0))
const files = (d: string): string[] =>
  readdirSync(d).flatMap(n => (statSync(join(d, n)).isDirectory() ? files(join(d, n)) : [join(d, n)]))
const OK: ModelEvent[] = [{ type: 'text', delta: 'yo' }, { type: 'done', reason: 'stop' }]

describe('models.addAccount', () => {
  it('coding-tools-only 预设缺 restrictionAck → -32602', async () => {
    const { k } = await boot()
    const e = await errOf(k.handle('models.addAccount', { commandId: 'c1', presetId: 'zhipu-cn', apiKey: 'zk-secret-1' }))
    expect(e.code).toBe(-32602)
    expect(e.message).toBe('restriction acknowledgement required')
    expect((await k.handle('models.accounts', undefined)) as { accounts: unknown[] }).toMatchObject({ accounts: [] })
  })

  it('带 ack:账号落配置,密钥不在 config.json / 事件 / RPC 结果 / 任何明文配置', async () => {
    const { k } = await boot()
    const view = (await k.handle('models.addAccount', { commandId: 'c1', presetId: 'zhipu-cn', apiKey: 'zk-secret-1', restrictionAck: true })) as AccountView
    expect(view).toMatchObject({ presetId: 'zhipu-cn', label: '智谱 Coding Plan', state: 'ok' })
    expect(JSON.stringify(view)).not.toContain('zk-secret-1')
    const cfg = readFileSync(join(dir, 'config.json'), 'utf8')
    expect(cfg).not.toContain('zk-secret-1')
    const acc = JSON.parse(cfg).models.accounts[0]
    expect(acc).toMatchObject({ id: view.id, presetId: 'zhipu-cn' })
    expect(typeof acc.restrictionAckAt).toBe('number')
    expect(allEventsText(k)).not.toContain('zk-secret-1')
    expect(accountEvents(k).map(a => a.id)).toEqual([view.id])
    const list = (await k.handle('models.accounts', undefined)) as { accounts: AccountView[]; secretsBackend: string }
    expect(list.secretsBackend).toBe('plaintext-file')
    expect(list.accounts.map(a => a.id)).toEqual([view.id])
    expect(JSON.stringify(list)).not.toContain('zk-secret-1')
    // 只有凭据文件里有密钥
    const holders = files(dir).filter(f => !f.endsWith('.sqlite') && !f.includes('.sqlite-') && readFileSync(f, 'utf8').includes('zk-secret-1'))
    expect(holders).toEqual([join(dir, 'credentials.json')])
  })

  it('未知预设 / api-key 预设缺 key / ChatGPT 预设 → -32602', async () => {
    const { k } = await boot()
    expect((await errOf(k.handle('models.addAccount', { commandId: 'a', presetId: 'nope', apiKey: 'k' }))).code).toBe(-32602)
    expect((await errOf(k.handle('models.addAccount', { commandId: 'b', presetId: 'openai', apiKey: '  ' }))).code).toBe(-32602)
    expect((await errOf(k.handle('models.addAccount', { commandId: 'c', presetId: 'chatgpt' }))).code).toBe(-32602)
    expect((await errOf(k.handle('models.addAccount', { commandId: 'd', presetId: 'custom-openai', apiKey: 'k' }))).code).toBe(-32602)
  })
})

describe('models.stream', () => {
  it('interactive:false + coding-tools-only → done{restricted},注入的 fetch 一次也没调', async () => {
    const f = spyFetch()
    const { adapter, seen } = fakeAdapter(f.fn, () => OK)
    const { svc } = await boot({ fetch: f.fn })
    svc.registerAdapter('anthropic', adapter)
    const a = await svc.addAccount({ presetId: 'zhipu-cn', apiKey: 'zk', restrictionAck: true })
    const evs = await collect(svc.stream({ accountId: a.id, modelId: 'glm-5.3' }, req(false)))
    expect(evs).toEqual([{ type: 'done', reason: 'error', error: expect.objectContaining({ kind: 'restricted', retryable: false }) }])
    expect(f.calls).toEqual([])
    expect(seen).toEqual([])
  })

  it('interactive:true 透传到适配器:协议 / baseUrl / apiKey / quirks / model', async () => {
    const f = spyFetch()
    const { adapter, seen } = fakeAdapter(f.fn, () => OK)
    const { svc } = await boot({ fetch: f.fn })
    svc.registerAdapter('anthropic', adapter)
    const a = await svc.addAccount({ presetId: 'zhipu-cn', apiKey: 'zk', restrictionAck: true })
    const evs = await collect(svc.stream({ accountId: a.id, modelId: 'glm-5.3' }, req(true)))
    expect(evs).toEqual(OK)
    expect(seen).toHaveLength(1)
    expect(seen[0].account).toMatchObject({ id: a.id, protocol: 'anthropic', baseUrl: 'https://open.bigmodel.cn/api/anthropic', apiKey: 'zk' })
    expect(seen[0].account.quirks).toMatchObject({ chat: { thinking: 'zai' } })
    expect(seen[0].req).toMatchObject({ model: 'glm-5.3', interactive: true })
    expect(f.calls.map(c => c.url)).toEqual(['https://open.bigmodel.cn/api/anthropic/x'])
  })

  it('非受限预设 interactive:false 照常;账号协议覆盖 + baseUrl 覆盖生效', async () => {
    const f = spyFetch()
    const { adapter, seen } = fakeAdapter(f.fn, () => OK)
    const { svc } = await boot({ fetch: f.fn })
    svc.registerAdapter('openai-chat', adapter)
    const a = await svc.addAccount({ presetId: 'kimi-cn', apiKey: 'kk', protocol: 'openai-chat', baseUrl: 'https://proxy.example/v1' })
    expect(await collect(svc.stream({ accountId: a.id, modelId: 'k3' }, req(false)))).toEqual(OK)
    expect(seen[0].account).toMatchObject({ protocol: 'openai-chat', baseUrl: 'https://proxy.example/v1' })
  })

  it('没有该协议的适配器 → done{unavailable}', async () => {
    const { svc } = await boot()
    const a = await svc.addAccount({ presetId: 'openai', apiKey: 'sk' })
    const evs = await collect(svc.stream({ accountId: a.id, modelId: 'gpt-5' }, req(true)))
    expect(evs).toEqual([{ type: 'done', reason: 'error', error: expect.objectContaining({ kind: 'unavailable', message: 'no adapter for openai-responses' }) }])
  })

  it('setDefault + stream("default");没有默认 → done{error}', async () => {
    const f = spyFetch()
    const { adapter, seen } = fakeAdapter(f.fn, () => OK)
    const { k, svc } = await boot({ fetch: f.fn })
    svc.registerAdapter('openai-chat', adapter)
    expect((await collect(svc.stream('default', req(true))))[0]).toMatchObject({ type: 'done', reason: 'error' })
    const a = await svc.addAccount({ presetId: 'deepseek', apiKey: 'dk' })
    expect(await k.handle('models.setDefault', { accountId: a.id, modelId: 'deepseek-chat' })).toEqual({ ok: true })
    expect(((await k.handle('models.catalog', undefined)) as CatalogView).default).toEqual({ accountId: a.id, modelId: 'deepseek-chat' })
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).models.default).toEqual({ accountId: a.id, modelId: 'deepseek-chat' })
    expect(await collect(svc.stream('default', req(true)))).toEqual(OK)
    expect(seen[0].req.model).toBe('deepseek-chat')
    expect((await errOf(k.handle('models.setDefault', { accountId: 'nope', modelId: 'x' }))).code).toBe(-32602)
  })

  it('auth 错误:api-key 账号 → error 状态 + account.updated;消息里的 key 被打码', async () => {
    const f = spyFetch()
    const { adapter } = fakeAdapter(f.fn, a => [
      { type: 'text', delta: 'part' },
      { type: 'done', reason: 'error', error: { kind: 'auth', message: `invalid key ${a.apiKey} rejected`, retryable: false } },
    ])
    const { k, svc } = await boot({ fetch: f.fn })
    svc.registerAdapter('openai-chat', adapter)
    const a = await svc.addAccount({ presetId: 'deepseek', apiKey: 'dk-leaky-123' })
    const evs = await collect(svc.stream({ accountId: a.id, modelId: 'deepseek-chat' }, req(true)))
    expect(evs[0]).toEqual({ type: 'text', delta: 'part' })
    expect(evs[1]).toMatchObject({ type: 'done', error: { kind: 'auth', message: 'invalid key *** rejected' } })
    expect(svc.accounts()[0].state).toBe('error')
    expect(accountEvents(k).at(-1)).toMatchObject({ id: a.id, state: 'error' })
    expect(allEventsText(k)).not.toContain('dk-leaky-123')
  })

  it('quota 错误 → quota_exhausted;之后成功 → ok', async () => {
    const f = spyFetch()
    let fail = true
    const { adapter } = fakeAdapter(f.fn, () =>
      fail ? [{ type: 'done', reason: 'error', error: { kind: 'quota', message: 'used up', retryable: false } }] : OK)
    const { k, svc } = await boot({ fetch: f.fn })
    svc.registerAdapter('openai-chat', adapter)
    const a = await svc.addAccount({ presetId: 'deepseek', apiKey: 'dk' })
    await collect(svc.stream({ accountId: a.id, modelId: 'm' }, req(true)))
    expect(svc.accounts()[0].state).toBe('quota_exhausted')
    fail = false
    await collect(svc.stream({ accountId: a.id, modelId: 'm' }, req(true)))
    expect(svc.accounts()[0].state).toBe('ok')
    expect(accountEvents(k).map(x => x.state)).toEqual(['ok', 'quota_exhausted', 'ok'])
  })

  it('适配器没给 done 就结束 / 直接抛错 → done{network}', async () => {
    const { svc } = await boot()
    svc.registerAdapter('openai-chat', { async *stream() { yield { type: 'text', delta: 'a' } }, async test() {} })
    const a = await svc.addAccount({ presetId: 'deepseek', apiKey: 'dk' })
    const evs = await collect(svc.stream({ accountId: a.id, modelId: 'm' }, req(true)))
    expect(evs.at(-1)).toMatchObject({ type: 'done', reason: 'error', error: { kind: 'network' } })
  })
})

describe('models.removeAccount / testAccount', () => {
  it('删除密钥、清掉指向它的默认、调用协议的删除钩子', async () => {
    const { k, svc } = await boot()
    const hooked: string[] = []
    svc.registerRemoveHook('openai-chat', acc => { hooked.push(acc.id) })
    const a = await svc.addAccount({ presetId: 'deepseek', apiKey: 'dk-rm-1' })
    svc.setDefault({ accountId: a.id, modelId: 'deepseek-chat' })
    expect(readFileSync(join(dir, 'credentials.json'), 'utf8')).toContain('dk-rm-1')
    expect(await k.handle('models.removeAccount', { commandId: 'r1', accountId: a.id })).toEqual({ ok: true })
    expect(readFileSync(join(dir, 'credentials.json'), 'utf8')).not.toContain('dk-rm-1')
    expect(hooked).toEqual([a.id])
    expect(svc.accounts()).toEqual([])
    const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    expect(cfg.models).toEqual({ accounts: [] })
    expect((await errOf(k.handle('models.removeAccount', { accountId: a.id }))).code).toBe(-32602)
  })

  it('testAccount:成功 → ok;适配器抛 ModelFailure → {ok:false, error{kind,message}} 且打码', async () => {
    const { k, svc } = await boot()
    let failWith: unknown
    svc.registerAdapter('openai-chat', {
      async *stream() { yield { type: 'done', reason: 'stop' } },
      async test(acc) { if (failWith) throw Object.assign(new Error('x'), { error: { kind: 'auth', message: `bad ${acc.apiKey}`, retryable: false } }) },
    })
    const a = await svc.addAccount({ presetId: 'deepseek', apiKey: 'dk-t' })
    expect(await k.handle('models.testAccount', { accountId: a.id })).toEqual({ ok: true })
    failWith = true
    expect(await k.handle('models.testAccount', { accountId: a.id })).toEqual({ ok: false, error: { kind: 'auth', message: 'bad ***' } })
    expect(svc.accounts()[0].state).toBe('error')
  })
})

describe('启动与目录', () => {
  it('重启后账号还在;密钥缺失的 api-key 账号 → error', async () => {
    const first = await boot()
    const a = await first.svc.addAccount({ presetId: 'deepseek', apiKey: 'dk' })
    const b = await first.svc.addAccount({ presetId: 'openai', apiKey: 'sk' })
    await first.k.close()
    kernels = []
    const creds = JSON.parse(readFileSync(join(dir, 'credentials.json'), 'utf8'))
    delete creds[`models-registry/account/${b.id}/apiKey`]
    writeFileSync(join(dir, 'credentials.json'), JSON.stringify(creds))
    const { svc } = await boot()
    expect(svc.accounts().map(x => [x.id, x.state])).toEqual([[a.id, 'ok'], [b.id, 'error']])
  })

  it('catalog = 预设 + 快照;24h 刷新带 ETag 写缓存;304 / 失败保留', async () => {
    const api = {
      deepseek: { id: 'deepseek', models: { 'deepseek-chat': { id: 'deepseek-chat', name: 'DS Fresh', limit: { context: 777, output: 77 }, modalities: { input: ['text'], output: ['text'] } } } },
      zhipuai_other: { id: 'unrelated', models: { z: { id: 'z', name: 'Z', modalities: { output: ['text'] } } } },
    }
    let mode: 'ok' | '304' | 'fail' = 'ok'
    const f = spyFetch(() => {
      if (mode === 'fail') throw new Error('offline')
      if (mode === '304') return new Response(null, { status: 304 })
      return new Response(JSON.stringify(api), { status: 200, headers: { etag: '"v1"' } })
    })
    // kimi-cn 用内置清单:k3 的元数据来自快照
    const { svc, timers } = await boot({ fetch: f.fn })
    const before = svc.catalog()
    expect(before.presets.length).toBeGreaterThan(10)
    expect(before.models['kimi-cn'].map(m => m.id)).toContain('k3')
    expect(f.calls).toEqual([]) // 首次刷新等计时器
    timers.fire()
    await expect.poll(() => existsSync(join(dir, 'plugins', 'models-registry', 'cache', 'models.json'))).toBe(true)
    expect(f.calls[0].url).toBe('https://models.dev/api.json')
    const cache = JSON.parse(readFileSync(join(dir, 'plugins', 'models-registry', 'cache', 'models.json'), 'utf8'))
    expect(cache.etag).toBe('"v1"')
    expect(Object.keys(cache.snapshot.models)).toEqual(['deepseek/deepseek-chat'])
    expect(timers.pending.size).toBe(1)
    expect([...timers.pending.values()][0].ms).toBe(24 * 3600_000)
    mode = '304'
    timers.fire()
    await expect.poll(() => f.calls.length).toBe(2)
    expect(f.calls[1].headers['if-none-match']).toBe('"v1"')
    mode = 'fail'
    timers.fire()
    await expect.poll(() => f.calls.length).toBe(3)
    await expect.poll(() => timers.pending.size).toBe(1)
    expect(svc.catalog().presets.length).toBe(before.presets.length)
    expect(JSON.parse(readFileSync(join(dir, 'plugins', 'models-registry', 'cache', 'models.json'), 'utf8')).etag).toBe('"v1"')
  })

  it('自定义预设:手填模型清单出现在 accounts[].models', async () => {
    const { svc } = await boot()
    const models = [{ id: 'my-model', name: 'Mine', context: 1000, output: 100, image: false, reasoning: 'none' as const, toolCall: true }]
    const a = await svc.addAccount({ presetId: 'custom-openai', apiKey: 'ck', baseUrl: 'https://llm.local/v1', models })
    expect(svc.accounts()[0]).toMatchObject({ id: a.id, baseUrl: 'https://llm.local/v1', models })
  })
})

describe('models.quota', () => {
  const zhipuBody = { data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 30 }] } }

  it('zhipu 走裸 key;5 分钟内命中缓存', async () => {
    let now = 1_000_000
    const f = spyFetch(() => new Response(JSON.stringify(zhipuBody)))
    const { k, svc } = await boot({ fetch: f.fn, now: () => now })
    const a = await svc.addAccount({ presetId: 'zhipu-cn', apiKey: 'zk-q', restrictionAck: true })
    const q = { windows: [{ label: '5h', usedPercent: 30 }] }
    expect(await k.handle('models.quota', { accountId: a.id })).toEqual(q)
    expect(f.calls[0]).toMatchObject({ url: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit', headers: { authorization: 'zk-q' } })
    now += 4 * 60_000
    expect(await k.handle('models.quota', { accountId: a.id })).toEqual(q)
    expect(f.calls).toHaveLength(1)
    now += 2 * 60_000
    await k.handle('models.quota', { accountId: a.id })
    expect(f.calls).toHaveLength(2)
  })

  it('MiniMax base_resp 报错(HTTP 200)→ null + 账号 error + account.updated', async () => {
    const f = spyFetch(() => new Response(JSON.stringify({ base_resp: { status_code: 1004, status_msg: 'invalid api key' } })))
    const { k, svc } = await boot({ fetch: f.fn })
    const a = await svc.addAccount({ presetId: 'minimax-cn', apiKey: 'mk' })
    expect(await k.handle('models.quota', { accountId: a.id })).toBeNull()
    expect(f.calls[0]).toMatchObject({ url: 'https://api.minimaxi.com/v1/token_plan/remains', headers: { authorization: 'Bearer mk' } })
    expect(svc.accounts()[0].state).toBe('error')
    expect(accountEvents(k).at(-1)).toMatchObject({ id: a.id, state: 'error' })
  })

  it('kimi 用 coding base;ChatGPT 预设 → 跳转链接;无用量接口 → null 且不发请求', async () => {
    const f = spyFetch(() => new Response(JSON.stringify({ usage: { limit: 10, used: 5 } })))
    const { k, svc } = await boot({ fetch: f.fn })
    const kimi = await svc.addAccount({ presetId: 'kimi-global', apiKey: 'kk' })
    expect(await k.handle('models.quota', { accountId: kimi.id })).toEqual({ windows: [{ label: 'total', usedPercent: 50 }] })
    expect(f.calls[0].url).toBe('https://api.kimi.ai/coding/v1/usages')
    const gpt = await svc.addAccount({ presetId: 'chatgpt' })
    expect(await k.handle('models.quota', { accountId: gpt.id })).toEqual({ link: 'https://chatgpt.com/settings/usage' })
    const ds = await svc.addAccount({ presetId: 'deepseek', apiKey: 'dk' })
    expect(await k.handle('models.quota', { accountId: ds.id })).toBeNull()
    expect(f.calls).toHaveLength(1)
  })
})

describe('updateConfig 收紧', () => {
  it('其他插件不能写 models 段', async () => {
    let err: unknown
    const other: Plugin = { manifest: { id: 'other', version: '1', kernel: '*' }, activate(ctx) { try { ctx.updateConfig('models', { accounts: [] }) } catch (e) { err = e } } }
    await boot({}, [other])
    expect(String(err)).toMatch(/not writable/)
  })
  it('写入非法值 → 抛错,config.json 不变;合法值原子落盘', async () => {
    const errs: unknown[] = []
    const fake: Plugin = {
      manifest: { id: 'models-registry', version: '1', kernel: '*' },
      activate(ctx) {
        expect(ctx.config).toEqual({ models: { accounts: [] } })
        expect(ctx.secretsBackend).toBe('plaintext-file')
        try { ctx.updateConfig('models', { accounts: [{ id: 1 }] }) } catch (e) { errs.push(e) }
        try { ctx.updateConfig('plugins', { disabled: [] }) } catch (e) { errs.push(e) }
        expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).models).toEqual({ accounts: [] })
        ctx.updateConfig('models', { accounts: [{ id: 'a', presetId: 'p', label: 'l' }] })
      },
    }
    kernels.push(await createKernel({ dataDir: dir, plugins: [fake], secrets: { osBackend: false } }))
    expect(errs).toHaveLength(2)
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).models.accounts).toEqual([{ id: 'a', presetId: 'p', label: 'l' }])
  })
})
