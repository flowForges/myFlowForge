import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Plugin, PluginContext } from '../../kernel/pluginHost'
import type { MemoryService } from '../../lib/memory/types'
import type { ToolContext, ToolResult, ToolsService } from '../../lib/tools/types'
import { createGit } from '../../lib/git/snapshot'
import { fakeClock, fakeModels, memoryKernel, say, type MemoryRig } from '../../../test/memoryRig'
import { BUILTIN_PLUGINS } from '../index'
import loopDefault from '../loop-default'
import { createToolsCoding } from '../tools-coding'
import toolsRegistry from '../tools-registry'
import { parseEntries } from './files'
import { createMemoryDefault } from './index'
import { manifest } from './manifest'

let rig: MemoryRig | undefined
afterEach(async () => {
  await rig?.close()
  rig = undefined
})

function probePlugin() {
  const holder: { ctx?: PluginContext } = {}
  const plugin: Plugin = { manifest: { id: 'probe', version: '0', kernel: '^0.1.0' }, activate: c => { holder.ctx = c } }
  return { plugin, holder }
}

const pluginDir = (r: MemoryRig) => join(r.dataDir, 'plugins', 'memory-default')
const filesDir = (r: MemoryRig) => join(pluginDir(r), 'files')
const statesOf = (r: MemoryRig) => r.k.status().plugins
const stateOf = (r: MemoryRig, id = 'memory-default') => statesOf(r).find(p => p.id === id)
const health = (r: MemoryRig) => r.k.handle('memory.health', {}) as Promise<{ problems: string[]; rawRows: number; noteRows: number; pendingProposals: number }>

function diary(r: MemoryRig): string {
  const dir = join(filesDir(r), 'diary')
  return existsSync(dir) ? readdirSync(dir).map(f => readFileSync(join(dir, f), 'utf8')).join('') : ''
}

function caller(r: MemoryRig, ctx: () => PluginContext) {
  let n = 0
  return (name: string, args: unknown, sessionId: string, turnId = 't1') =>
    ctx().services.get<ToolsService>('tools')!.call(name, JSON.stringify(args), { sessionId, turnId, callId: `c${++n}`, cwd: r.cwd, spillDir: join(r.root, 'spill'), signal: new AbortController().signal })
}

describe('manifest and registration', () => {
  it('manifest', () => {
    expect(manifest).toEqual({ id: 'memory-default', version: '0.1.0', kernel: '^0.1.0', provides: ['memory'], inject: ['sessions'] })
  })

  it('BUILTIN_PLUGINS has memory-default after the tools that it uses and before loop-default', () => {
    const ids = BUILTIN_PLUGINS.map(p => p.manifest.id)
    expect(ids.indexOf('memory-default')).toBeGreaterThan(ids.indexOf('tools-registry'))
    expect(ids.indexOf('memory-default')).toBeLessThan(ids.indexOf('loop-default'))
  })

  it('without the tools service it still activates and provides memory, and memory.health says so', async () => {
    const { plugin, holder } = probePlugin()
    rig = await memoryKernel({ plugins: [createMemoryDefault({ nightly: false }), plugin] })
    expect(stateOf(rig)).toEqual({ id: 'memory-default', state: 'active' })
    const memory = holder.ctx!.services.get<MemoryService>('memory')!
    expect(memory.contextFor({ sessionId: 's', turnId: 't', text: 'hi', events: [], contextTokens: 1000 })).toEqual([])
    expect(() => memory.noteContext({ sessionId: 's', ref: { accountId: 'a', modelId: 'm' }, tokens: 1, context: 2 })).not.toThrow()
    expect((await health(rig)).problems).toEqual([])
  })

  it('with loop-default, a turn sends the three tools after the toolset and nothing else changes', async () => {
    const models = fakeModels({ script: () => say('ok') })
    rig = await memoryKernel({ models, plugins: [toolsRegistry, createMemoryDefault({ nightly: false }), loopDefault] })
    const { sessionId } = (await rig.k.handle('session.create', { commandId: 'c1', cwd: rig.cwd, model: { accountId: 'acc', modelId: 'gpt-5' } })) as { sessionId: string }
    await rig.k.handle('session.prompt', { commandId: 'c2', sessionId, text: 'hello' })
    const r = rig
    for (let i = 0; i < 200 && !r.k.events.after(0).some(e => e.type === 'turn.ended' || e.type === 'turn.failed'); i++) await new Promise(res => setTimeout(res, 5))
    const names = (models.foreground()[0].req.tools ?? []).map(t => t.name)
    expect(names.slice(-3)).toEqual(['memory_get', 'memory_search', 'memory_write'])
  })

  it('closing the kernel removes the tools, stops ingest and closes the database', async () => {
    const { plugin, holder } = probePlugin()
    rig = await memoryKernel({ plugins: [toolsRegistry, createMemoryDefault({ nightly: false }), plugin] })
    const tools = holder.ctx!.services.get<ToolsService>('tools')!
    expect(tools.list(t => t.ambient === true).map(t => t.name).sort()).toEqual(['memory_get', 'memory_search', 'memory_write'])
    await rig.k.close()
    expect(tools.list(t => t.ambient === true)).toEqual([])
    expect(existsSync(join(pluginDir(rig), 'memory.sqlite'))).toBe(true)
    expect(existsSync(join(pluginDir(rig), 'memory.sqlite-wal'))).toBe(false)
  })

  it('flushNow pulls the log into the raw layer without the batch timer', async () => {
    const clock = fakeClock()
    const { plugin, holder } = probePlugin()
    const memory = createMemoryDefault({ now: clock.now, timers: clock.timers, flushMs: 60_000, nightly: false })
    rig = await memoryKernel({ plugins: [memory, plugin] })
    const { sessionId } = (await rig.k.handle('session.create', { commandId: 'c1' })) as { sessionId: string }
    holder.ctx!.append({ type: 'message.user', sessionId, payload: { turnId: 't', text: 'words here' } })
    memory.flushNow()
    expect((await health(rig)).rawRows).toBe(1)
  })
})

describe('rollback', () => {
  async function bootWith() {
    const { plugin, holder } = probePlugin()
    const control = { wipe: false }
    rig = await memoryKernel({
      // restart 关完旧内核才来这里:这时删库,等于新内核遇到一个重建的库
      plugins: () => {
        if (control.wipe) for (const f of readdirSync(pluginDir(rig!))) if (f.startsWith('memory.sqlite')) rmSync(join(pluginDir(rig!), f))
        return [toolsRegistry, createMemoryDefault({ nightly: false }), plugin]
      },
    })
    return { holder, control, call: caller(rig, () => holder.ctx!), r: rig }
  }

  it("removes that turn's diary line, session note and pending proposal, and no other turn's", async () => {
    const { holder, call, r } = await bootWith()
    const owner = (await r.k.handle('session.create', { commandId: 'c1' })) as { sessionId: string }
    const group = (await r.k.handle('session.create', { commandId: 'c2', origin: 'im' })) as { sessionId: string }
    await call('memory_write', { text: 'keep this draft', durable: true }, owner.sessionId, 'keep')
    await call('memory_write', { text: 'undo this draft', durable: true }, owner.sessionId, 'undo')
    const kept = await call('memory_write', { text: 'keep group note' }, group.sessionId, 'keep-g')
    const undone = await call('memory_write', { text: 'undo group note' }, group.sessionId, 'undo-g')
    holder.ctx!.append({ type: 'turn.rolledBack', sessionId: owner.sessionId, payload: { turnId: 'undo', files: 0 } })
    holder.ctx!.append({ type: 'turn.rolledBack', sessionId: group.sessionId, payload: { turnId: 'undo-g', files: 0 } })
    await call('memory_search', { query: 'draft' }, owner.sessionId)
    expect(diary(r)).toContain('keep this draft')
    expect(diary(r)).not.toContain('undo this draft')
    expect((await health(r)).pendingProposals).toBe(1)
    expect((await call('memory_get', { id: undone.meta!.id }, group.sessionId)).content).toBe('未找到')
    expect((await call('memory_get', { id: kept.meta!.id }, group.sessionId)).content).toContain('keep group note')
  })

  it('a rebuilt database replays the rollback: same files, nothing fails, nothing else goes, no event storm', async () => {
    const { holder, control, call, r } = await bootWith()
    const { sessionId } = (await r.k.handle('session.create', { commandId: 'c1' })) as { sessionId: string }
    await call('memory_write', { text: 'undo this draft' }, sessionId, 'undo')
    await call('memory_write', { text: 'keep this draft' }, sessionId, 'keep')
    holder.ctx!.append({ type: 'turn.rolledBack', sessionId, payload: { turnId: 'undo', files: 0 } })
    await call('memory_search', { query: 'draft' }, sessionId)
    const before = diary(r)
    expect(before).not.toContain('undo this draft')
    const updates = r.k.events.after(0, 100_000).filter(e => e.type === 'memory.updated').length
    control.wipe = true
    await r.restart()
    await call('memory_search', { query: 'draft' }, sessionId)
    expect(diary(r)).toBe(before)
    expect((await health(r)).problems).toEqual([])
    expect(r.k.events.after(0, 100_000).filter(e => e.type === 'memory.updated').length).toBe(updates)
    expect((await call('memory_search', { query: 'keep this draft' }, sessionId)).content).toContain('keep this draft')
  })

  it('reconcile comes before ingest: a line left behind by an old rollback goes on the rebuild', async () => {
    const { plugin, holder } = probePlugin()
    let withMemory = false
    rig = await memoryKernel({ plugins: () => (withMemory ? [toolsRegistry, createMemoryDefault({ nightly: false }), plugin] : [plugin]) })
    const r = rig
    const { sessionId } = (await r.k.handle('session.create', { commandId: 'c1' })) as { sessionId: string }
    holder.ctx!.append({ type: 'turn.rolledBack', sessionId, payload: { turnId: 'gone', files: 0 } })
    // 崩在回滚生效之前:行还在文件里,库已经没了
    mkdirSync(join(filesDir(r), 'diary'), { recursive: true })
    const line = '- left behind <!-- mff id=n_left src=model ts=1793000000000 turn=gone -->\n- still here <!-- mff id=n_kept src=model ts=1793000000000 turn=other -->\n'
    writeFileSync(join(filesDir(r), 'diary', '2026-11-03.md'), line)
    withMemory = true
    await r.restart()
    const call = caller(r, () => holder.ctx!)
    await call('memory_search', { query: 'still' }, sessionId)
    const left = parseEntries(diary(r)).map(e => e.id)
    expect(left).toEqual(['n_kept'])
  })
})

describe('memory failing does not stop the kernel', () => {
  async function bootBroken(breakIt: (dir: string) => void) {
    const { plugin, holder } = probePlugin()
    let broken = false
    const models = fakeModels({ script: () => say('ok') })
    rig = await memoryKernel({
      models,
      plugins: () => {
        return broken ? [toolsRegistry, createMemoryDefault({ nightly: false }), loopDefault, plugin] : [plugin]
      },
    })
    const r = rig
    const dir = pluginDir(r)
    rmSync(dir, { recursive: true, force: true })
    broken = true
    breakIt(dir)
    await r.restart()
    return { r, holder, models, call: caller(r, () => holder.ctx!) }
  }

  it('memory.sqlite is a directory (openSync fails): active, reported in health, tools say unavailable, a turn runs', async () => {
    const { r, holder, call, models } = await bootBroken(dir => mkdirSync(join(dir, 'memory.sqlite'), { recursive: true }))
    expect(stateOf(r)).toEqual({ id: 'memory-default', state: 'active' })
    const h = await health(r)
    expect(h.problems).toEqual(['store_unavailable:EISDIR'])
    expect(h.rawRows).toBe(0)
    const { sessionId } = (await r.k.handle('session.create', { commandId: 'c1', cwd: r.cwd, model: { accountId: 'acc', modelId: 'gpt-5' } })) as { sessionId: string }
    for (const [name, args] of [['memory_search', { query: 'abc' }], ['memory_get', { id: 'r_1' }], ['memory_write', { text: 'abc' }]] as const) {
      const res = await call(name, args, sessionId)
      expect(res.isError, name).toBe(true)
      expect(res.content, name).toContain('unavailable')
    }
    const memory = holder.ctx!.services.get<MemoryService>('memory')!
    expect(memory.contextFor({ sessionId, turnId: 't', text: 'hi', events: [], contextTokens: 1000 })).toEqual([])
    await r.k.handle('session.prompt', { commandId: 'c2', sessionId, text: 'hello' })
    for (let i = 0; i < 200 && models.foreground().length === 0; i++) await new Promise(res => setTimeout(res, 5))
    expect(models.foreground()).toHaveLength(1)
    expect((models.foreground()[0].req.tools ?? []).map(t => t.name)).toContain('memory_search')
  })

  it('a fault after the store opened: the store is closed again and health has the code, not the message', async () => {
    const { plugin, holder } = probePlugin()
    // 对账给不存在的 USER.md 取时间时抛:文件系统的错误这里造不出来(目录和文件都会先被收紧权限)
    const now = () => {
      throw Object.assign(new Error('/secret/path/in/a/message'), { code: 'EACCES' })
    }
    rig = await memoryKernel({ plugins: [toolsRegistry, createMemoryDefault({ now, nightly: false }), plugin] })
    expect(stateOf(rig)?.state).toBe('active')
    expect((await health(rig)).problems).toEqual(['store_unavailable:EACCES'])
    expect(existsSync(join(pluginDir(rig), 'memory.sqlite-wal'))).toBe(false)
    const { sessionId } = (await rig.k.handle('session.create', { commandId: 'c1' })) as { sessionId: string }
    expect((await caller(rig, () => holder.ctx!)('memory_write', { text: 'abc' }, sessionId)).content).toContain('unavailable')
  })

  it('files/ is a plain file (mkdirSync cannot make the tree): the store is closed again and health says so', async () => {
    const { r, call } = await bootBroken(dir => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'files'), 'in the way')
    })
    expect(stateOf(r)?.state).toBe('active')
    expect((await health(r)).problems).toEqual(['store_unavailable:ENOTDIR'])
    expect(existsSync(join(pluginDir(r), 'memory.sqlite-wal'))).toBe(false)
    const { sessionId } = (await r.k.handle('session.create', { commandId: 'c1' })) as { sessionId: string }
    expect((await call('memory_search', { query: 'abc' }, sessionId)).content).toContain('unavailable')
  })

  it('the plugin directory itself cannot be made: plugin.failed, the kernel still runs', async () => {
    const { r } = await bootBroken(dir => writeFileSync(dir, 'in the way'))
    expect(stateOf(r)?.state).toBe('failed')
    expect(stateOf(r, 'probe')?.state).toBe('active')
    expect(r.k.events.after(0, 100_000).some(e => e.type === 'plugin.failed')).toBe(true)
    const { sessionId } = (await r.k.handle('session.create', { commandId: 'c1' })) as { sessionId: string }
    expect(sessionId).toBeTruthy()
  })

  it('a garbage database is set aside and rebuilt, and health says so', async () => {
    const { r } = await bootBroken(dir => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'memory.sqlite'), 'this is not a database, not even close to one')
    })
    expect(stateOf(r)?.state).toBe('active')
    expect((await health(r)).problems.join()).toContain('moved to memory.sqlite.bad-')
  })
})

describe('what shell and read can see', () => {
  function sandboxExecUsable(): boolean {
    if (process.platform !== 'darwin') return false
    return spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: 'ignore' }).status === 0
  }
  const usable = sandboxExecUsable()

  async function bootCoding(real: boolean) {
    const { plugin, holder } = probePlugin()
    const env = { PATH: '/usr/bin:/bin' }
    rig = await memoryKernel({
      plugins: [toolsRegistry, createToolsCoding({ shellEnv: env, loginPath: async () => '', minTimeoutMs: 100 }), createMemoryDefault({ nightly: false }), plugin],
      ...(real && { kernel: { sandbox: { upstream: null, git: createGit({ base: { ...env, GIT_CONFIG_NOSYSTEM: '1' } }) } } }),
    })
    const r = rig
    const { sessionId } = (await r.k.handle('session.create', { commandId: 'c1', cwd: r.cwd, approvalMode: 'auto' })) as { sessionId: string }
    const user = join(filesDir(r), 'USER.md')
    writeFileSync(user, '- PRIVATE-MEMORY-MARKER\n')
    const ctx: ToolContext = { sessionId, turnId: 't', callId: 'c', cwd: r.cwd, spillDir: join(r.root, 'spill'), signal: new AbortController().signal }
    const call = (name: string, args: unknown): Promise<ToolResult> => holder.ctx!.services.get<ToolsService>('tools')!.call(name, JSON.stringify(args), ctx)
    return { call, user, r }
  }

  it('read on the memory files and the database is denied', async () => {
    const { call, user, r } = await bootCoding(false)
    for (const path of [user, join(pluginDir(r), 'memory.sqlite')]) {
      const res = await call('read', { path })
      expect(res.isError, path).toBe(true)
      expect(res.content).toContain('拒绝')
      expect(res.content).not.toContain('PRIVATE-MEMORY-MARKER')
    }
  })

  it.skipIf(!usable)('shell cat of USER.md under real Seatbelt prints nothing', async () => {
    const { call, user, r } = await bootCoding(true)
    expect(r.k.status().sandbox?.level).toBe('full')
    const res = await call('shell', { command: `cat '${user}'` })
    expect(res.content).not.toContain('PRIVATE-MEMORY-MARKER')
    expect(/^exit (\d+)/.exec(res.content)?.[1]).not.toBe('0')
  })
})
