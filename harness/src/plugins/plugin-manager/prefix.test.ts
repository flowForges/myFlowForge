// Review Focus 2:前缀不动。假模型记下每个请求,用例里没有密钥,也不触发 LoopGuard 提醒:
// 那两样不在"逐字节一致"的范围内(04 spec)。两个内核相比时日期相同,除非正好跨午夜
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { call, confirm, lastResult, scriptQueue, settled, storeOf, stubPlugin, stubTool, until, withManager } from '../../../test/managerRig'
import { calling, say, type Req } from '../../../test/memoryRig'
import { buildPlugin, pluginKernel, type PluginKernelOpts, type PluginRig, type PluginSpec } from '../../../test/pluginRig'
import type { Plugin, PluginContext } from '../../kernel/pluginHost'
import { createGit } from '../../lib/git/snapshot'
import { createLoopDefault } from '../loop-default'
import { createMemoryDefault } from '../memory-default'
import toolsRegistry from '../tools-registry'
import { createPluginManager } from './index'

let tmp: string
const rigs: PluginRig[] = []
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-prefix-')))
})
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close()
  rmSync(tmp, { recursive: true, force: true })
})

let n = 0
const plugin = (spec: Partial<PluginSpec> = {}) => buildPlugin(join(tmp, `p${++n}`), { format: 'claude', id: 'demo', skills: { s: { description: 'first description', body: 'first text' } }, ...spec })

function setup(o: PluginKernelOpts = {}) {
  const q = scriptQueue()
  return pluginKernel({ ...withManager(), ...o, models: { script: q.script } }).then(r => {
    rigs.push(r)
    return { r, q, reqs: () => r.models.foreground().map(c => c.req) }
  })
}

const injected = (r: PluginRig, sid: string) => r.events(sid).filter(e => e.type === 'plugins.injected')
const toolNames = (req: Req) => (req.tools ?? []).map(t => t.name)
const textParts = (req: Req) => req.messages[0].parts.map(p => (p.type === 'text' ? p.text : ''))
const wire = (req: Req) => JSON.stringify({ system: req.system, tools: req.tools, messages: req.messages })

/** next 是 prev 的逐字节延续:system、tools 不变,消息是前缀 */
function continues(prev: Req, next: Req) {
  expect(next.system).toBe(prev.system)
  expect(JSON.stringify(next.tools)).toBe(JSON.stringify(prev.tools))
  expect(JSON.stringify(next.messages.slice(0, prev.messages.length))).toBe(JSON.stringify(prev.messages))
}

/** 钉在第一轮的索引块:第一条用户消息里的那个 part */
const indexPart = (req: Req) => textParts(req).find(t => t.startsWith('<plugin-index>'))

describe('no plugins installed', () => {
  it('request bodies are byte-identical to a run without plugin-manager in the list', async () => {
    const stubs = () => [toolsRegistry, stubPlugin([stubTool('read'), stubTool('memory_search', { ambient: true }), stubTool('delegate_x', { delegate: true })])]
    const run = async (o: PluginKernelOpts) => {
      const { r, q, reqs } = await setup({ before: stubs, ...o })
      const sid = await r.session()
      q.push(calling('c1', 'read', {}), say('one'))
      await r.turn(sid, 'first')
      await r.turn(sid, 'second')
      return reqs().map(q2 => wire(q2).replaceAll(r.root, '<root>'))
    }
    const without = await run({ manager: undefined })
    const withIt = await run({})
    expect(without).toHaveLength(3)
    expect(withIt).toEqual(without)
    expect(JSON.stringify(JSON.parse(without[0]).messages)).not.toContain('plugin-index')
    expect(JSON.parse(without[0]).tools.map((t: { name: string }) => t.name)).toEqual(['read', 'memory_search', 'delegate_x'])
  })
})

describe('a plugin enabled before the first turn', () => {
  it('turns 1–3 and a restart are byte-prefix continuations, tools included', async () => {
    const { r, q, reqs } = await setup()
    await r.install(plugin())
    const sid = await r.session()
    await r.turn(sid, 'one')
    // 中间带一次技能读取:工具结果重建后也要和当时发的一样
    q.push(calling('c1', 'skill', { action: 'read', name: 'demo:s' }), say('read it'))
    await r.turn(sid, 'two')
    await r.turn(sid, 'three')
    await r.restart()
    await r.turn(sid, 'four')
    const all = reqs()
    expect(all).toHaveLength(5)
    for (let i = 1; i < all.length; i++) continues(all[i - 1], all[i])
    expect(toolNames(all[0])).toEqual(['skill'])
    expect(lastResult(all[2])).toContain('first text')
    expect(injected(r, sid)).toHaveLength(1)
  })

  it('a crash restart (kill) keeps the same bytes', async () => {
    const { r, reqs } = await setup()
    await r.install(plugin())
    const sid = await r.session()
    await r.turn(sid, 'one')
    await r.restart({ kill: true })
    await r.turn(sid, 'two')
    continues(reqs()[0], reqs()[1])
  })

  it('the index sits after the environment and memory blocks, before the reminder', async () => {
    const memory = { contextFor: (q: { events: unknown[] }) => ((q.events as { type: string }[]).some(e => e.type === 'memory.injected') ? [] : [{ kind: 'session', text: '<memory>note</memory>' }]), noteContext() {} }
    const provider: Plugin = { manifest: { id: 'stub-memory', version: '0', kernel: '^0.1.0', provides: ['memory'] }, activate: ctx => void ctx.services.provide('memory', memory) }
    const { r, reqs } = await setup({ before: () => [toolsRegistry, provider] })
    await r.install(plugin())
    const sid = await r.session()
    await r.turn(sid, 'hello')
    const parts = textParts(reqs()[0])
    expect(parts).toHaveLength(5)
    expect(parts[0]).toMatch(/^<environment>/)
    expect(parts[1]).toBe('<memory>note</memory>')
    expect(parts[2]).toMatch(/^<plugin-index>\n/)
    expect(parts[2]).toContain('demo:s — first description')
    expect(parts[2]).toMatch(/<\/plugin-index>$/)
    expect(parts[3]).toMatch(/^<reminder>/)
    expect(parts[4]).toBe('hello')
    // 只在第一条
    await r.turn(sid, 'again')
    const later = reqs()[1].messages.filter(m => m.role === 'user').at(-1)!
    expect(JSON.stringify(later)).not.toContain('plugin-index')
  })
})

describe('a session started without plugins', () => {
  it('a plugin enabled later changes nothing: no index, no skill in tools, bytes unchanged, forged call not_available', async () => {
    const { r, q, reqs } = await setup({ level: 'full', before: () => [toolsRegistry, stubPlugin([stubTool('mcp', { ambient: true, pluginScoped: 'mcp' })])] })
    const sid = await r.session()
    await r.turn(sid, 'one')
    await r.install(plugin({ mcp: { srv: { command: 'node' } } }))
    await r.turn(sid, 'two')
    q.push(calling('f1', 'skill', { action: 'list' }), say('tried'))
    await r.turn(sid, 'three')
    q.push(calling('f2', 'skill', { action: 'read', name: 'demo:s' }), say('tried'))
    await r.turn(sid, 'four')
    const all = reqs()
    for (let i = 1; i < all.length; i++) continues(all[i - 1], all[i])
    for (const req of all) {
      expect(toolNames(req)).toEqual([])
      expect(indexPart(req)).toBeUndefined()
    }
    expect(injected(r, sid)).toHaveLength(0)
    const results = all.flatMap(req => req.messages).filter(m => m.role === 'tool').map(m => (m.parts[0].type === 'tool_result' ? m.parts[0].content : ''))
    expect(results.at(-1)).toBe('not_available')
    expect(JSON.stringify(all.at(-1))).not.toContain('first text')
    expect(JSON.stringify(all.at(-1))).not.toContain('first description')
  })

  it('a turn failed before any plugin, then an enable and a retry: still nothing written', async () => {
    const { r, q, reqs } = await setup()
    const sid = await r.session()
    q.push((async function* () {
      yield { type: 'done', reason: 'error', error: { kind: 'unavailable', message: 'down', retryable: false } } as const
    })())
    await r.turn(sid, 'one')
    await r.install(plugin())
    await r.turn(sid, 'two')
    expect(injected(r, sid)).toHaveLength(0)
    expect(toolNames(reqs().at(-1)!)).toEqual([])
  })
})

describe('a session with the index, then the plugin changes', () => {
  it('disabled, upgraded, uninstalled: tools and the first message never move, skill follows the store', async () => {
    const { r, q, reqs } = await setup()
    const root = plugin()
    await r.install(root)
    const sid = await r.session()
    await r.turn(sid, 'one')
    const pinned = reqs()[0]
    const read = async (id: string) => {
      q.push(calling(id, 'skill', { action: 'read', name: 'demo:s' }), say('done'))
      await r.turn(sid, id)
      const last = reqs().at(-1)!
      expect(JSON.stringify(last.tools)).toBe(JSON.stringify(pinned.tools))
      expect(JSON.stringify(last.messages[0])).toBe(JSON.stringify(pinned.messages[0]))
      return lastResult(last)
    }
    await call(r, 'plugins.setEnabled', { commandId: 'off', id: 'demo', enabled: false })
    expect(await read('disabled')).toBe('plugin_disabled')

    writeFileSync(join(root, 'skills', 's', 'SKILL.md'), '---\nname: s\ndescription: second description\n---\nsecond text\n')
    const { stagingId } = await call(r, 'plugins.upgrade.prepare', { id: 'demo' })
    const st = await settled(r, stagingId)
    await confirm(r, { stagingId, consentHash: st.consentHash }, { enable: true })
    const upgraded = await read('upgraded')
    expect(upgraded).toContain('second text')
    expect(upgraded).not.toContain('first text')
    expect(indexPart(reqs().at(-1)!)).toContain('first description')
    expect(indexPart(reqs().at(-1)!)).not.toContain('second description')

    await call(r, 'plugins.uninstall', { commandId: 'rm', id: 'demo' })
    expect(await read('removed')).toBe('plugin_not_installed')
    expect(injected(r, sid)).toHaveLength(1)
  })
})

describe('what cannot move the block', () => {
  const capture = () => {
    const box: { ctx?: PluginContext } = {}
    return { box, before: () => [toolsRegistry, stubPlugin([], ctx => (box.ctx = ctx))] }
  }

  it('a rolled-back first turn keeps it, with no second event', async () => {
    const { box, before } = capture()
    const { r, reqs } = await setup({ before })
    await r.install(plugin())
    const sid = await r.session()
    const first = await r.turn(sid, 'one')
    box.ctx!.append({ type: 'turn.rolledBack', sessionId: sid, payload: { turnId: first } })
    await r.install(plugin({ id: 'later' }))
    await r.turn(sid, 'two')
    const [a, b] = reqs()
    expect(indexPart(b)).toBe(indexPart(a))
    expect(toolNames(b)).toEqual(['skill'])
    expect(b.messages).toHaveLength(1)
    expect(injected(r, sid)).toHaveLength(1)
  })

  it('a context.rebuilt keeps it: the checkpoint branch passes the block too', async () => {
    const { box, before } = capture()
    const { r, reqs } = await setup({ before })
    await r.install(plugin())
    const sid = await r.session()
    await r.turn(sid, 'one')
    const through = r.events(sid).at(-1)!.seq
    await r.turn(sid, 'two')
    const cp = box.ctx!.append({ type: 'memory.checkpoint', sessionId: sid, payload: { throughSeq: through, asOfSeq: through, text: 'SUMMARY' } })
    box.ctx!.append({ type: 'context.rebuilt', sessionId: sid, payload: { checkpointSeq: cp.seq, throughSeq: through, step: 1, before: 2, after: 1 } })
    await r.turn(sid, 'three')
    const rebuilt = reqs().at(-1)!
    expect(JSON.stringify(rebuilt.messages[1])).toContain('SUMMARY')
    expect(JSON.stringify(rebuilt.messages[0])).toBe(JSON.stringify(reqs()[0].messages[0]))
    expect(indexPart(rebuilt)).toBe(indexPart(reqs()[0]))
    expect(JSON.stringify(rebuilt.tools)).toBe(JSON.stringify(reqs()[0].tools))
  })

  it('a failed first turn and its retry write one event, same bytes', async () => {
    const { r, q, reqs } = await setup()
    await r.install(plugin())
    const sid = await r.session()
    q.push((async function* () {
      yield { type: 'done', reason: 'error', error: { kind: 'unavailable', message: 'down', retryable: false } } as const
    })())
    await r.turn(sid, 'one')
    await r.install(plugin({ id: 'later' }))
    await r.turn(sid, 'two')
    expect(injected(r, sid)).toHaveLength(1)
    expect(indexPart(reqs()[1])).toBe(indexPart(reqs()[0]))
    expect(indexPart(reqs()[1])).not.toContain('later')
  })

  it('the second and third turns write nothing', async () => {
    const { r } = await setup()
    await r.install(plugin())
    const sid = await r.session()
    await r.turn(sid, 'one')
    const once = JSON.stringify(injected(r, sid))
    await r.turn(sid, 'two')
    await r.turn(sid, 'three')
    expect(JSON.stringify(injected(r, sid))).toBe(once)
  })

  it('two plugins installed in either order give the same index bytes, sorted', async () => {
    const indexFor = async (order: string[]) => {
      const { r } = await setup()
      for (const id of order) await r.install(plugin({ id, skills: { s: { description: `${id} text`, body: 'b' } } }))
      const sid = await r.session()
      await r.turn(sid, 'one')
      return (injected(r, sid)[0].payload as { text: string }).text
    }
    const ab = await indexFor(['aaa', 'bbb'])
    const ba = await indexFor(['bbb', 'aaa'])
    expect(ba).toBe(ab)
    expect(ab.indexOf('aaa:s')).toBeLessThan(ab.indexOf('bbb:s'))
  })

  it('tools order does not depend on when the manager activated', async () => {
    const stubs = [stubTool('read'), stubTool('memory_zeta', { ambient: true }), stubTool('memory_alpha', { ambient: true }), stubTool('delegate_b', { delegate: true }), stubTool('delegate_a', { delegate: true })]
    const run = async (first: boolean) => {
      let tools: { list(): { name: string }[] } | undefined
      const stub = stubPlugin(stubs, ctx => (tools = ctx.services.get('tools')))
      const manager = (e: { env: NodeJS.ProcessEnv }) => createPluginManager({ env: e.env, reservedIds: () => new Set() })
      const { r, reqs } = await setup(
        first
          ? { before: () => [toolsRegistry], manager, after: e => [stub, createLoopDefault({ git: createGit({ base: e.env }) })] }
          : { before: () => [toolsRegistry, stub], manager },
      )
      await r.install(plugin())
      const sid = await r.session()
      await r.turn(sid, 'one')
      return { sent: toolNames(reqs()[0]), others: tools!.list().map(t => t.name).filter(x => x !== 'skill') }
    }
    const early = await run(true)
    const late = await run(false)
    expect(early.sent).toEqual(late.sent)
    expect(early.sent).toEqual(['read', 'memory_alpha', 'memory_zeta', 'skill', 'delegate_a', 'delegate_b'])
    expect(early.others).toEqual(late.others)
  })
})

describe('the pin survives the manager (M8)', () => {
  it('plugin-manager not active on restart: first message unchanged, flags read from the event', async () => {
    let on = true
    const real = withManager().manager!
    // 代替它的只提供一个同名工具:它在 tools 里说明循环看的是事件,不是服务
    const { r, reqs } = await setup({
      manager: e => (on ? real(e) : stubPlugin([stubTool('skill', { ambient: true, pluginScoped: 'skill' })])),
    })
    await r.install(plugin())
    const sid = await r.session()
    await r.turn(sid, 'one')
    on = false
    await r.restart()
    expect(r.kernel.status().plugins.some(p => p.id === 'plugin-manager')).toBe(false)
    await r.turn(sid, 'two')
    const [a, b] = reqs()
    expect(JSON.stringify(b.messages[0])).toBe(JSON.stringify(a.messages[0]))
    expect(toolNames(b)).toEqual(['skill'])
    expect(injected(r, sid)).toHaveLength(1)
  })

  it('installed.json corrupt on restart: same bytes and tools, skill says not installed, a new session has no index', async () => {
    let corrupt = false
    const real = withManager().manager!
    const { r, q, reqs } = await setup({
      manager: e => {
        if (corrupt) writeFileSync(join(e.dataDir, 'plugins', 'plugin-manager', 'installed.json'), 'not json')
        return real(e)
      },
    })
    await r.install(plugin())
    const sid = await r.session()
    await r.turn(sid, 'one')
    corrupt = true
    await r.restart()
    q.push(calling('c', 'skill', { action: 'read', name: 'demo:s' }), say('done'))
    await r.turn(sid, 'two')
    const [a, b] = reqs()
    continues(a, b)
    expect(lastResult(reqs().at(-1)!)).toBe('plugin_not_installed')
    const fresh = await r.session()
    await r.turn(fresh, 'hi')
    expect(indexPart(reqs().at(-1)!)).toBeUndefined()
    expect(injected(r, fresh)).toHaveLength(0)
  })

  it('memory.delete of a row quoting the same text leaves the event bytes and the block alone', async () => {
    const memory = createMemoryDefault({ nightly: false })
    const { r, reqs } = await setup({ before: () => [toolsRegistry, memory] })
    await r.install(plugin())
    const sid = await r.session()
    await r.turn(sid, 'one')
    const event = () => JSON.stringify(injected(r, sid))
    const before = event()
    const text = (injected(r, sid)[0].payload as { text: string }).text
    const turn = await r.turn(sid, `quoting: ${text}`)
    memory.flushNow()
    const quoted = r.events(sid).find(e => e.type === 'message.user' && (e.payload as { turnId: string }).turnId === turn)!
    await call(r, 'memory.delete', { commandId: 'del', id: `r_${quoted.seq}` })
    // 确实删了那一行,否则这条什么也没证明
    const after = r.events(sid).find(e => e.seq === quoted.seq)!
    expect(JSON.stringify(after.payload)).not.toContain(text)
    expect(event()).toBe(before)
    await r.turn(sid, 'three')
    expect(indexPart(reqs().at(-1)!)).toBe(text)
  })

  it('a tampered plugin is disabled on restart: the old session keeps its block, a new one has none', async () => {
    const { r, reqs } = await setup()
    await r.install(plugin())
    const sid = await r.session()
    await r.turn(sid, 'one')
    const dir = join(storeOf(r), 'demo', readdirSync(join(storeOf(r), 'demo'))[0])
    writeFileSync(join(dir, 'skills', 's', 'SKILL.md'), 'changed')
    await r.restart()
    await r.turn(sid, 'two')
    expect(indexPart(reqs()[1])).toBe(indexPart(reqs()[0]))
    const fresh = await r.session()
    await r.turn(fresh, 'hi')
    expect(injected(r, fresh)).toHaveLength(0)
  })
})

describe('the mcp flag', () => {
  const mcpStub = () => [toolsRegistry, stubPlugin([stubTool('mcp', { ambient: true, pluginScoped: 'mcp' })])]
  const server = { command: 'node' }
  const flags = async (o: { level?: PluginKernelOpts['level']; origin?: 'app' | 'im' | 'acp' | 'schedule'; spec?: Partial<PluginSpec> }) => {
    const { r, reqs } = await setup({ before: mcpStub, ...(o.level && { level: o.level }) })
    await r.install(plugin({ mcp: { srv: server }, ...o.spec }))
    const sid = await r.session(o.origin ? { origin: o.origin } : {})
    await r.turn(sid, 'one')
    return { event: injected(r, sid)[0]?.payload as { skill: boolean; mcp: boolean; text: string } | undefined, tools: toolNames(reqs()[0]) }
  }

  it.each([
    ['full', 'app', true],
    ['full', 'acp', true],
    ['partial', 'app', true],
    ['none', 'app', false],
    ['full', 'im', false],
    ['full', 'schedule', false],
  ] as const)('level %s, origin %s → mcp %s', async (level, origin, mcp) => {
    const { event, tools } = await flags({ level, origin })
    expect(event).toMatchObject({ skill: true, mcp })
    expect(tools.includes('mcp')).toBe(mcp)
    // 用不了的服务不列
    expect(event!.text.includes('demo/srv')).toBe(mcp)
  })

  it('servers only: mcp without skill, and no skill tool', async () => {
    const { event, tools } = await flags({ level: 'full', spec: { skills: {} } })
    expect(event).toMatchObject({ skill: false, mcp: true })
    expect(tools).toEqual(['mcp'])
    expect(event!.text).toContain('demo/srv')
  })

  it('servers only, where they cannot run: nothing is written', async () => {
    expect((await flags({ level: 'none', spec: { skills: {} } })).event).toBeUndefined()
    expect((await flags({ level: 'full', origin: 'im', spec: { skills: {} } })).event).toBeUndefined()
  })

  it('a server with problems does not count; needs_config does', async () => {
    expect((await flags({ level: 'full', spec: { skills: {}, mcp: { bad: { command: 'docker', args: ['run'] } } } })).event).toBeUndefined()
    const needs = await flags({ level: 'full', spec: { skills: {}, mcp: { srv: { command: 'node', env: { T: '${user_config.token}' } } }, manifest: { userConfig: { token: { title: 'T', sensitive: true, required: true } } } } })
    expect(needs.event).toMatchObject({ mcp: true })
  })
})

describe('an IM session', () => {
  it('the one change at narrowApproval is the environment mode line', async () => {
    const { r, q, reqs } = await setup({ level: 'full' })
    await r.install(plugin())
    const sid = await r.session({ origin: 'im', approvalMode: 'auto' })
    q.push(calling('c', 'skill', { action: 'list' }), say('listed'))
    await r.turn(sid, 'one')
    await until(() => r.events(sid).some(e => e.type === 'session.approvalNarrowed'))
    await r.turn(sid, 'two')
    const a = reqs()[0]
    const b = reqs().at(-1)!
    // 已知例外(spec §9.3):环境块的审批模式那一行变一次,07 已有的行为。其余字节都不动
    const [envA, ...restA] = textParts(a)
    const [envB, ...restB] = textParts(b)
    expect(restB).toEqual(restA)
    const linesA = envA.split('\n')
    const linesB = envB.split('\n')
    expect(linesB).toHaveLength(linesA.length)
    const moved = linesA.flatMap((l, i) => (l === linesB[i] ? [] : [[l, linesB[i]]]))
    expect(moved).toHaveLength(1)
    expect(moved[0][0]).toBe('commands: run without asking')
    expect(moved[0][1]).toBe("commands: each command needs the user's approval")
    expect(JSON.stringify(b.tools)).toBe(JSON.stringify(a.tools))
    expect(b.system).toBe(a.system)
    expect(JSON.stringify(b.messages.slice(1, a.messages.length))).toBe(JSON.stringify(a.messages.slice(1)))
  })
})

describe('sessions the service does not reach', () => {
  it('a throwing service only logs: the turn runs, no tools', async () => {
    const provider: Plugin = {
      manifest: { id: 'bad-plugins', version: '0', kernel: '^0.1.0', provides: ['plugins'] },
      activate: ctx =>
        void ctx.services.provide('plugins', {
          injectFirst() {
            throw new Error('secret text')
          },
        }),
    }
    const { r, reqs } = await setup({ manager: undefined, before: () => [toolsRegistry, provider, stubPlugin([stubTool('skill', { ambient: true, pluginScoped: 'skill' })])] })
    const sid = await r.session()
    await r.turn(sid, 'one')
    expect(r.events(sid).at(-1)!.type).toBe('turn.ended')
    expect(toolNames(reqs()[0])).toEqual([])
    expect(r.logs.join('\n')).not.toContain('secret text')
  })
})
