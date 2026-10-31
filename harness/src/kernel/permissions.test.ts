import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_NETWORK_ALLOW } from '../lib/permissions/rules'
import { resolveToolPath } from '../lib/fs/paths'
import { parsePermissions, PermissionsStore, SANDBOX_STUB, validatePermissions, InvalidPermissions } from './permissions'
import { createKernel, type Kernel } from './kernel'
import type { PermissionGate } from './permissionGate'
import type { Plugin, PluginContext } from './pluginHost'
import type { RpcError } from './rpcError'
import type { KernelConfig } from './config'

const ctx = { home: '/h', platform: 'linux' as const }

describe('parsePermissions (load mode)', () => {
  it('missing section → defaults; network.allow is the default list only when the key is absent', () => {
    const r = parsePermissions(undefined, ctx)
    expect(r.errors).toEqual([])
    expect(r.rules).toEqual([])
    expect(r.config).toEqual({
      rules: [], network: { allow: [...DEFAULT_NETWORK_ALLOW] }, sandbox: { enabled: true, allowLoopback: false }, allowUnsandboxedAuto: false,
    })
    expect(parsePermissions({ network: {} }, ctx).config.network.allow).toEqual([...DEFAULT_NETWORK_ALLOW])
    expect(parsePermissions({ network: { allow: [] } }, ctx).config.network.allow).toEqual([])
    expect(parsePermissions({ sandbox: { allowLoopback: true } }, ctx).config.sandbox).toEqual({ enabled: true, allowLoopback: true })
  })

  it('keeps every deny that parses (even with a failing test); drops bad and test-failing ask / allow', () => {
    const r = parsePermissions({
      rules: [
        { effect: 'deny', rule: 'shell(git push*)', match: ['git status'] }, // 0 用例失败,仍保留
        { effect: 'allow', rule: 'read(/x/**)', match: ['/y/a'] }, // 1 用例失败,丢
        { effect: 'ask', rule: 'edit(x)' }, // 2 主语错,丢
        { effect: 'deny', rule: 'write(' }, // 3 写法错,解析不了只能丢
        { effect: 'allow', rule: 'read(/ok/**)', match: ['/ok/a'] }, // 4 好的
        42, // 5 不是对象
      ],
    }, ctx)
    expect(r.rules.map(x => x.spec.rule)).toEqual(['shell(git push*)', 'read(/ok/**)'])
    expect(r.errors.map(e => [e.index, e.reason])).toEqual([[0, 'test_failed'], [1, 'test_failed'], [2, 'subject'], [3, 'syntax'], [5, 'syntax']])
    expect(r.config.rules.map(x => x.rule)).toEqual(['shell(git push*)', 'read(/ok/**)'])
    expect(r.config.rules[1]).toEqual({ effect: 'allow', rule: 'read(/ok/**)', match: ['/ok/a'] })
  })

  it('invalid network entries are dropped and reported with reason network', () => {
    const r = parsePermissions({ network: { allow: ['pypi.org', '', 7, '  '] } }, ctx)
    expect(r.config.network.allow).toEqual(['pypi.org'])
    expect(r.errors).toEqual([
      { index: 1, rule: '', reason: 'network' },
      { index: 2, rule: '7', reason: 'network' },
      { index: 3, rule: '  ', reason: 'network' },
    ])
  })

  it('wrong shapes fall back to the tight default and are reported', () => {
    const r = parsePermissions({ rules: 'x', network: { allow: 'all' }, sandbox: { enabled: 'no', allowLoopback: 1 }, allowUnsandboxedAuto: 'yes' }, ctx)
    expect(r.config).toEqual({ rules: [], network: { allow: [] }, sandbox: { enabled: true, allowLoopback: false }, allowUnsandboxedAuto: false })
    expect(r.errors.map(e => [e.index, e.rule, e.reason])).toEqual([
      [-1, 'rules', 'syntax'], [-1, 'network.allow', 'syntax'], [-1, 'sandbox.enabled', 'syntax'], [-1, 'sandbox.allowLoopback', 'syntax'],
      [-1, 'allowUnsandboxedAuto', 'syntax'],
    ])
    expect(parsePermissions('nope', ctx).errors).toEqual([{ index: -1, rule: 'permissions', reason: 'syntax' }])
    expect(parsePermissions(null, ctx).errors).toEqual([{ index: -1, rule: 'permissions', reason: 'syntax' }])
  })

  it('a rule with a non-string text is reported with an empty rule', () => {
    expect(parsePermissions({ rules: [{ effect: 'deny', rule: 3 }] }, ctx).errors).toEqual([{ index: 0, rule: '', reason: 'syntax' }])
  })
})

describe('validatePermissions (strict, for set)', () => {
  it('any error rejects the whole config, including a test-failing deny', () => {
    const v = validatePermissions({ rules: [{ effect: 'deny', rule: 'shell(rm*)', match: ['ls'] }] }, ctx)
    expect(v).toEqual({ ok: false, errors: [{ index: 0, rule: 'shell(rm*)', reason: 'test_failed', case: 'ls' }] })
    expect(validatePermissions({ network: { allow: [''] } }, ctx).ok).toBe(false)
    expect(validatePermissions(undefined, ctx)).toEqual({ ok: false, errors: [{ index: -1, rule: 'permissions', reason: 'syntax' }] })
  })
  it('a good config passes with its rules; missing parts get defaults', () => {
    const v = validatePermissions({ rules: [{ effect: 'ask', rule: 'write(package.json)' }] }, ctx)
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.rules).toHaveLength(1)
    expect(v.config.network.allow).toEqual([...DEFAULT_NETWORK_ALLOW])
  })
})

describe('PermissionsStore', () => {
  const access = (initial: unknown) => {
    let cfg = { version: 1, plugins: { disabled: [] }, models: { accounts: [] }, permissions: initial } as KernelConfig
    const writes: unknown[] = []
    let fail = false
    return {
      writes,
      failNext: () => { fail = true },
      get: () => cfg,
      update: (section: keyof KernelConfig, value: unknown) => {
        if (fail) { fail = false; throw new Error('disk full') }
        writes.push([section, value])
        cfg = { ...cfg, [section]: value }
      },
    }
  }

  it('set saves through update first, then swaps memory', () => {
    const a = access(undefined)
    const store = new PermissionsStore({ config: a, ctx })
    store.set({ rules: [{ effect: 'deny', rule: 'read(/x)' }] })
    expect(a.writes).toEqual([['permissions', store.get().config]])
    expect(store.get().rules).toHaveLength(1)
    expect(store.get().errors).toEqual([])
  })

  it('a failed save leaves memory unchanged; an invalid config never reaches update', () => {
    const a = access({ rules: [{ effect: 'deny', rule: 'read(/x)' }] })
    const store = new PermissionsStore({ config: a, ctx })
    a.failNext()
    expect(() => store.set({ rules: [] })).toThrow('disk full')
    expect(store.get().rules).toHaveLength(1)
    expect(() => store.set({ rules: [{ effect: 'allow', rule: 'shell(*)' }] })).toThrow(InvalidPermissions)
    expect(a.writes).toEqual([])
    expect(store.get().rules).toHaveLength(1)
  })
})

// ── 内核里的 permissions 段与 RPC ──────────────────────────────────────

let home: string
let dataDir: string
let work: string
let kernels: Kernel[] = []
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mffai-perm-home-'))
  dataDir = mkdtempSync(join(tmpdir(), 'mffai-perm-data-'))
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mffai-perm-work-')))
})
afterEach(async () => {
  for (const k of kernels) await k.close().catch(() => {})
  kernels = []
  for (const d of [home, dataDir, work]) rmSync(d, { recursive: true, force: true })
})

let gate: PermissionGate | undefined
let modelsCtx: PluginContext | undefined
const probe: Plugin = { manifest: { id: 'probe', version: '0', kernel: '^0.1.0' }, activate: c => { gate = c.services.get<PermissionGate>('permissionGate') } }
// 冒充 models-registry:它是唯一能写 models 段的插件
const modelsWriter: Plugin = { manifest: { id: 'models-registry', version: '0', kernel: '^0.1.0' }, activate: c => { modelsCtx = c } }

async function boot(plugins: Plugin[] = [probe]) {
  const k = await createKernel({ dataDir, plugins, home, env: {}, secrets: { osBackend: false } })
  kernels.push(k)
  return k
}
const configFile = () => join(dataDir, 'config.json')
const rpcError = async (p: Promise<unknown>) => {
  try { await p } catch (e) { return e as RpcError }
  throw new Error('expected rejection')
}
const account = { id: 'a1', presetId: 'zhipu-cn', label: 'Mine' }

describe('kernel permissions section', () => {
  it('a models save keeps a hand-written permissions section byte-for-byte', async () => {
    const permissions = { rules: [{ effect: 'allow', rule: 'shell(*)', note: 'bad on purpose' }], network: { allow: [] }, extra: { z: 1, a: [2] } }
    writeFileSync(configFile(), JSON.stringify({ version: 1, models: { accounts: [account] }, permissions }))
    await boot([probe, modelsWriter])
    modelsCtx!.updateConfig('models', { accounts: [account, { ...account, id: 'a2' }] })
    const saved = JSON.parse(readFileSync(configFile(), 'utf8'))
    expect(JSON.stringify(saved.permissions)).toBe(JSON.stringify(permissions))
    expect(saved.models.accounts).toHaveLength(2)
  })

  it('no permissions key is written when the section was never set', async () => {
    await boot()
    expect(JSON.parse(readFileSync(configFile(), 'utf8'))).not.toHaveProperty('permissions')
  })

  it('a plugin cannot write the permissions section', async () => {
    await boot([probe, modelsWriter])
    expect(() => modelsCtx!.updateConfig('permissions', {})).toThrow(/not writable/)
  })

  it('Review Focus 3: a hand-edited config with one bad allow and one bad deny still starts; deny enforced, allow dropped', async () => {
    mkdirSync(join(work, 'out'))
    const out = join(work, 'out')
    writeFileSync(configFile(), JSON.stringify({
      version: 1,
      models: { accounts: [account] },
      permissions: {
        rules: [
          { effect: 'allow', rule: `read(${out}/**)`, match: ['/nowhere/x'] },
          { effect: 'deny', rule: 'read(secret.txt)', match: ['other.txt'] },
        ],
      },
    }))
    const before = readFileSync(configFile())
    const k = await boot()
    expect(k.status().state).toBe('running')
    expect(readdirSync(dataDir).filter(f => f.includes('.bad'))).toEqual([])
    expect(readFileSync(configFile())).toEqual(before)
    expect(JSON.parse(readFileSync(configFile(), 'utf8')).models.accounts).toEqual([account])
    const got = await k.handle('permissions.get', {}) as { errors: unknown[]; config: { rules: unknown[] } }
    expect(got.errors).toHaveLength(2)
    expect(got.config.rules).toHaveLength(1)
    const cwd = join(work, 'repo')
    mkdirSync(cwd)
    const { sessionId } = await k.handle('session.create', { commandId: 'c1', cwd }) as { sessionId: string }
    const check = (rel: string) => gate!.check({ actor: 'tools', action: 'read', resource: resolveToolPath(cwd, rel), sessionId })
    expect(check('secret.txt')).toBe('deny')
    expect(check('a.txt')).toBe('allow')
    expect(gate!.check({ actor: 'tools', action: 'read', resource: join(out, 'x'), sessionId })).toBe('deny') // allow 被丢了
  })

  it('Review Focus 3: permissions.set with a failing match → -32602 test_failed and config.json is byte-identical', async () => {
    const k = await boot()
    const before = readFileSync(configFile())
    const e = await rpcError(k.handle('permissions.set', { commandId: 'p1', config: { rules: [{ effect: 'deny', rule: 'shell(git push*)', match: ['git status'] }] } }))
    expect(e.code).toBe(-32602)
    expect(e.message).toBe('invalid rules')
    expect((e.data as { reason: string }[])[0].reason).toBe('test_failed')
    expect(readFileSync(configFile())).toEqual(before)
    expect(k.events.after(0).map(x => x.type)).not.toContain('permissions.updated')
    // 失败不留回执:同一 commandId 改好后能成功
    expect(await k.handle('permissions.set', { commandId: 'p1', config: { rules: [] } })).toEqual({ ok: true })
  })

  it('permissions.set without a config is rejected', async () => {
    const k = await boot()
    expect((await rpcError(k.handle('permissions.set', { commandId: 'p1' }))).code).toBe(-32602)
  })

  it('permissions.set saves, appends permissions.updated without rule text, and replays by commandId', async () => {
    const k = await boot()
    const config = { rules: [{ effect: 'deny', rule: 'shell(git push*)', match: ['git push origin main'] }], network: { allow: ['pypi.org', 'crates.io'] } }
    expect(await k.handle('permissions.set', { commandId: 'p1', config })).toEqual({ ok: true })
    const saved = JSON.parse(readFileSync(configFile(), 'utf8')).permissions
    expect(saved.rules).toEqual(config.rules)
    expect(saved.network.allow).toEqual(['pypi.org', 'crates.io'])
    const updated = k.events.after(0).filter(e => e.type === 'permissions.updated')
    expect(updated).toHaveLength(1)
    expect(updated[0].payload).toEqual({ rules: 1, network: 2 })
    expect(updated[0].sessionId).toBeUndefined()
    expect(JSON.stringify(updated[0])).not.toContain('git push')
    // 重放:同一 commandId 换了内容也不再生效
    expect(await k.handle('permissions.set', { commandId: 'p1', config: { rules: [] } })).toEqual({ ok: true })
    expect(JSON.parse(readFileSync(configFile(), 'utf8')).permissions.rules).toEqual(config.rules)
    expect(k.events.after(0).filter(e => e.type === 'permissions.updated')).toHaveLength(1)
    // commandId 不能借给别的方法
    expect((await rpcError(k.handle('session.create', { commandId: 'p1' }))).code).toBe(-32602)
  })

  it('a live change applies to an existing session: a deny added mid-session blocks the next read', async () => {
    const k = await boot()
    const { sessionId } = await k.handle('session.create', { commandId: 'c1', cwd: work }) as { sessionId: string }
    const read = () => gate!.check({ actor: 'tools', action: 'read', resource: join(work, 'notes.md'), sessionId })
    expect(read()).toBe('allow')
    await k.handle('permissions.set', { commandId: 'p1', config: { rules: [{ effect: 'deny', rule: 'read(*.md)' }] } })
    expect(read()).toBe('deny')
    expect(gate!.checkMany([{ actor: 'tools', action: 'read', resource: join(work, 'a.ts'), sessionId }])).toEqual(['allow'])
  })

  it('permissions.get: defaults expand for an ask session and keep placeholders without one; sandbox is the stub', async () => {
    const k = await boot()
    const { sessionId } = await k.handle('session.create', { commandId: 'c1', cwd: work }) as { sessionId: string }
    const got = await k.handle('permissions.get', { sessionId }) as { defaults: string[]; sandbox: unknown; errors: unknown[]; config: unknown }
    expect(got.defaults).toEqual([`allow read(${work}/**)`, `allow write(${work}/**)`, 'ask shell(*)'])
    expect(got.sandbox).toEqual(SANDBOX_STUB)
    expect(got.errors).toEqual([])
    expect(got.config).toEqual(parsePermissions(undefined, { home, platform: process.platform }).config)
    const auto = await k.handle('session.create', { commandId: 'c2', cwd: work, approvalMode: 'auto' }) as { sessionId: string }
    expect((await k.handle('permissions.get', { sessionId: auto.sessionId }) as { defaults: string[] }).defaults[2]).toBe('allow shell(*)')
    expect((await k.handle('permissions.get', {}) as { defaults: string[] }).defaults).toEqual(['allow read(<cwd>/**)', 'allow write(<cwd>/**)', '<mode> shell(*)'])
  })

  it('a plugin cannot register permissions.get (reserved)', async () => {
    const bad: Plugin = { manifest: { id: 'p', version: '0', kernel: '^0.1.0' }, activate: c => { c.rpc.register('permissions.get', async () => ({})) } }
    const k = await boot([bad])
    expect(k.status().plugins).toEqual([expect.objectContaining({ id: 'p', state: 'failed', error: expect.stringMatching(/reserved/) })])
  })
})

describe('config file safety', () => {
  it('a permissions section of the wrong type never renames config.json', async () => {
    writeFileSync(configFile(), JSON.stringify({ version: 1, models: { accounts: [account] }, permissions: 'garbage' }))
    const k = await boot()
    expect(existsSync(configFile())).toBe(true)
    expect(readdirSync(dataDir).filter(f => f.includes('.bad'))).toEqual([])
    const got = await k.handle('permissions.get', {}) as { errors: unknown[] }
    expect(got.errors).toEqual([{ index: -1, rule: 'permissions', reason: 'syntax' }])
  })
})
