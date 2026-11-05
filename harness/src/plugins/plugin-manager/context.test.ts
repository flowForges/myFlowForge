// injectFirst 的判定;钉住之后的字节在 prefix.test.ts
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lastResult, scriptQueue, withManager } from '../../../test/managerRig'
import { calling, say } from '../../../test/memoryRig'
import { buildPlugin, pluginKernel, type PluginKernelOpts, type PluginRig, type PluginSpec } from '../../../test/pluginRig'
import type { KernelEvent } from '../../protocol/index'
import loopDirect from '../loop-direct'
import { createLoopDefault } from '../loop-default'
import { createGit } from '../../lib/git/snapshot'
import { createPluginsService, INDEX_MAX, SkillCatalog } from './context'
import { PluginStore } from './store'

let tmp: string
const rigs: PluginRig[] = []
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-ctx-')))
})
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close()
  rmSync(tmp, { recursive: true, force: true })
})

let n = 0
const plugin = (spec: Partial<PluginSpec> = {}) => buildPlugin(join(tmp, `p${++n}`), { format: 'claude', id: 'demo', skills: { s: 'body' }, ...spec })
async function setup(o: PluginKernelOpts = {}) {
  const q = scriptQueue()
  const r = await pluginKernel({ ...withManager(), ...o, models: { script: q.script } })
  rigs.push(r)
  return { r, q, reqs: () => r.models.foreground().map(c => c.req) }
}
const indexOf = (r: PluginRig, sid: string) => (r.events(sid).find(e => e.type === 'plugins.injected')?.payload as { text: string; skill: boolean; mcp: boolean } | undefined)

describe('the index text', () => {
  it('leaves out disable-model-invocation skills and keeps user-invocable:false ones', async () => {
    const { r } = await setup()
    await r.install(plugin({ skills: { open: 'x', hidden: { body: 'x', frontmatter: 'disable-model-invocation: true\n' }, quiet: { body: 'x', frontmatter: 'user-invocable: false\n' } } }))
    const sid = await r.session()
    await r.turn(sid, 'hi')
    const { text } = indexOf(r, sid)!
    expect(text).toContain('demo:open')
    expect(text).toContain('demo:quiet')
    expect(text).not.toContain('demo:hidden')
  })

  it('only model-hidden skills: nothing is written', async () => {
    const { r } = await setup()
    await r.install(plugin({ skills: { hidden: { body: 'x', frontmatter: 'disable-model-invocation: true\n' } } }))
    const sid = await r.session()
    await r.turn(sid, 'hi')
    expect(indexOf(r, sid)).toBeUndefined()
  })

  it('a disabled plugin is not listed', async () => {
    const { r } = await setup()
    await r.install(plugin({ id: 'on' }))
    const off = plugin({ id: 'off' })
    const { stagingId, consentHash } = await prepareOff(r, off)
    await r.kernel.handle('plugins.install.confirm' as never, { commandId: 'off', stagingId, consentHash, grants: { servers: {} }, enable: false } as never)
    const sid = await r.session()
    await r.turn(sid, 'hi')
    const { text } = indexOf(r, sid)!
    expect(text).toContain('on:s')
    expect(text).not.toContain('off:s')
  })

  it('6000-char cap, the more line, 200-char descriptions, and list still reaches the rest', async () => {
    const skills = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`s${String(i).padStart(2, '0')}`, { description: 'q'.repeat(500), body: 'x' }]))
    const { r, q, reqs } = await setup()
    await r.install(plugin({ skills }))
    const sid = await r.session()
    q.push(calling('c', 'skill', { action: 'list' }), say('ok'))
    await r.turn(sid, 'hi')
    const { text } = indexOf(r, sid)!
    expect(INDEX_MAX).toBe(6000)
    expect(text.length).toBeLessThanOrEqual(6000)
    const lines = text.split('\n')
    const kept = lines.filter(l => l.startsWith('demo:'))
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(80)
    expect(kept[0]).toBe(`demo:s00 — ${'q'.repeat(200)}`)
    expect(text).toContain(`[${80 - kept.length} more: use skill with action list]`)
    const listed = lastResult(reqs().at(-1)!)
    expect(listed.split('\n').filter(l => l.startsWith('demo:'))).toHaveLength(80)
    expect(listed).not.toContain('more: use skill')
  })

  it('does no variable substitution', async () => {
    const { r } = await setup()
    await r.install(plugin({ skills: { s: { description: 'at ${CLAUDE_PLUGIN_ROOT} and ${user_config.k}', body: 'x' } }, manifest: { userConfig: { k: { title: 'K' } } } }))
    await r.kernel.handle('plugins.settings.set' as never, { commandId: 'k', id: 'demo', key: 'k', value: 'SETTING' } as never)
    const sid = await r.session()
    await r.turn(sid, 'hi')
    const { text } = indexOf(r, sid)!
    expect(text).toContain('${CLAUDE_PLUGIN_ROOT}')
    expect(text).toContain('${user_config.k}')
    expect(text).not.toContain('SETTING')
    expect(text).not.toContain(r.root)
  })

  it('an IM session gets the fixed line and no third-party text reaches its first request (M22)', async () => {
    const { r, reqs } = await setup({ level: 'full' })
    await r.install(plugin({ id: 'zqplug', skills: { zqskill: { description: 'ZQDESCRIPTION', body: 'ZQBODY' } }, mcp: { zqsrv: { command: 'node' } } }))
    const sid = await r.session({ origin: 'im', approvalMode: 'auto' })
    await r.turn(sid, 'hi')
    expect(indexOf(r, sid)).toEqual({ turnId: expect.any(String), text: '<plugin-index>\n[1 plugin skills installed: use skill with action list]\n</plugin-index>', skill: true, mcp: false })
    const bytes = JSON.stringify(reqs()[0])
    for (const leak of ['zqplug', 'zqskill', 'ZQDESCRIPTION', 'ZQBODY', 'zqsrv']) expect(bytes).not.toContain(leak)
  })

  it('a loop-direct session with plugins enabled: no event, no change', async () => {
    const { r, reqs } = await setup({ after: e => [createLoopDefault({ git: createGit({ base: e.env }) }), loopDirect] })
    await r.install(plugin())
    const { sessionId } = (await r.kernel.handle('session.create', { commandId: 'chat', model: { accountId: 'acc', modelId: 'gpt-5' } })) as { sessionId: string }
    await r.turn(sessionId, 'hi')
    await r.turn(sessionId, 'again')
    expect(indexOf(r, sessionId)).toBeUndefined()
    const req = reqs().at(-1)!
    expect(req.tools ?? []).toEqual([])
    expect(JSON.stringify(req.messages)).not.toContain('plugin-index')
  })
})

async function prepareOff(r: PluginRig, path: string) {
  const { stagingId } = (await r.kernel.handle('plugins.install.prepare', { source: { kind: 'path', path } })) as { stagingId: string }
  for (;;) {
    const st = (await r.kernel.handle('plugins.install.status', { stagingId })) as { state: string; consentHash?: string }
    if (st.state === 'ready') return { stagingId, consentHash: st.consentHash! }
    if (st.state === 'failed') throw new Error('install failed')
    await new Promise(res => setTimeout(res, 5))
  }
}

describe('injectFirst, on its own', () => {
  const started = (turnId: string): KernelEvent => ({ seq: 1, ts: 1, type: 'turn.started', sessionId: 's', payload: { turnId } })
  const makeStore = () => {
    const dataDir = join(tmp, 'data')
    return PluginStore.open({ dataDir }, { info() {}, warn() {}, error() {} })
  }
  const logger = () => {
    const warn = vi.fn()
    return { info() {}, warn, error() {} }
  }
  const service = (over: Partial<Parameters<typeof createPluginsService>[0]> = {}) => {
    const log = logger()
    const append = vi.fn()
    const store = makeStore()
    const s = createPluginsService({
      store,
      catalog: new SkillCatalog(store, { home: join(tmp, 'home') }, log),
      sessions: { get: () => ({ origin: 'app' }) as never },
      sandbox: { status: () => ({ level: 'full', missing: [], autoDegraded: false }) },
      append,
      log,
      ...over,
    })
    return { s, append, log }
  }

  it('no plugins: no event, false flags', () => {
    const { s, append } = service()
    expect(s.injectFirst({ sessionId: 's', turnId: 't', events: [] })).toEqual({ skill: false, mcp: false })
    expect(append).not.toHaveBeenCalled()
  })

  it('never writes twice: an event in the log is returned as it is', () => {
    const { s, append } = service()
    const events: KernelEvent[] = [{ seq: 1, ts: 1, type: 'plugins.injected', sessionId: 's', payload: { turnId: 'old', text: 'x', skill: true, mcp: true } }]
    expect(s.injectFirst({ sessionId: 's', turnId: 't', events })).toEqual({ skill: true, mcp: true })
    expect(append).not.toHaveBeenCalled()
  })

  it('its own turn.started does not make it a later turn, another one does', async () => {
    const { r } = await setup()
    await r.install(plugin())
    const sid = await r.session()
    await r.turn(sid, 'one')
    expect(indexOf(r, sid)).toBeDefined()
    const { s, append } = service()
    expect(s.injectFirst({ sessionId: 's', turnId: 't', events: [started('other')] })).toEqual({ skill: false, mcp: false })
    expect(append).not.toHaveBeenCalled()
  })

  it('failures only log, by error class: no event, false flags, no text in the log', () => {
    const boom = () => {
      throw new TypeError('SECRET-IN-MESSAGE')
    }
    const { s, log } = service({ sessions: { get: boom } as never })
    expect(s.injectFirst({ sessionId: 's', turnId: 't', events: [] })).toEqual({ skill: false, mcp: false })
    expect(JSON.stringify(log.warn.mock.calls)).toContain('TypeError')
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('SECRET-IN-MESSAGE')
  })

  it('an unreadable plugin is skipped with a log line, its name not in it', async () => {
    const { r } = await setup()
    await r.install(plugin({ id: 'first' }))
    await r.install(plugin({ id: 'second' }))
    const dir = join(r.dataDir + '-plugins', 'second')
    const { readdirSync } = await import('node:fs')
    // 清单坏了:read 回 bad_manifest
    writeFileSync(join(dir, readdirSync(dir)[0], '.claude-plugin', 'plugin.json'), 'not json')
    const sid = await r.session()
    await r.turn(sid, 'hi')
    const { text } = indexOf(r, sid)!
    expect(text).toContain('first:s')
    expect(text).not.toContain('second:s')
  })
})
