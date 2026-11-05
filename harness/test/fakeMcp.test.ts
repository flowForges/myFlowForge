// 假 MCP 服务(09)和插件夹具本身的测试。跑真进程,不进沙箱:只验剧本。沙箱的行在 mcp.darwin.test.ts(Task 9)
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { calling, say } from './memoryRig'
import { buildPlugin, buildRepo, installFakeMcp, pluginKernel, type PluginRig } from './pluginRig'

let root = ''
const live: ChildProcess[] = []
const rigs: PluginRig[] = []

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-fakemcp-')))
})
afterEach(async () => {
  for (const c of live.splice(0)) c.kill('SIGKILL')
  for (const r of rigs.splice(0)) await r.close()
  rmSync(root, { recursive: true, force: true })
})

interface Server {
  child: ChildProcess
  dir: string
  send(m: object): void
  request(method: string, params?: object): Promise<any>
  lines: string[]
  /** 等到收到满足条件的一行 */
  until(pred: (line: string) => boolean): Promise<string>
  exited: Promise<number | null>
  stderr(): string
  calls(): any[]
}

function start(scenario: object, args: string[] = [], env: NodeJS.ProcessEnv = {}): Server {
  const dir = installFakeMcp(root, scenario, `s${live.length}`)
  const child = spawn(process.execPath, [join(dir, 'fake-mcp.mjs'), ...args], { cwd: root, env: { PATH: '/usr/bin:/bin', ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  live.push(child)
  const lines: string[] = []
  const waiters: (() => void)[] = []
  let buf = ''
  let err = ''
  child.stdout!.on('data', d => {
    buf += d.toString()
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      lines.push(buf.slice(0, i))
      buf = buf.slice(i + 1)
    }
    for (const w of waiters.splice(0)) w()
  })
  child.stderr!.on('data', d => { err += d })
  let nextId = 0
  const until = async (pred: (line: string) => boolean) => {
    for (;;) {
      const hit = lines.find(pred)
      if (hit !== undefined) return hit
      await new Promise<void>(r => waiters.push(r))
    }
  }
  const exited = new Promise<number | null>(r => child.on('close', code => r(code)))
  const parsed = (l: string) => { try { return JSON.parse(l) } catch { return undefined } }
  return {
    child, dir, lines, until, exited,
    stderr: () => err,
    send: m => void child.stdin!.write(`${JSON.stringify(m)}\n`),
    async request(method, params) {
      const id = ++nextId
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params && { params }) })}\n`)
      return parsed(await until(l => parsed(l)?.id === id))
    },
    calls: () => (existsSync(join(dir, 'calls.jsonl')) ? readFileSync(join(dir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []),
  }
}

const init = (s: Server) => s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } })
const call = async (s: Server, name: string, args: object = {}) => {
  const r = await s.request('tools/call', { name, arguments: args })
  return JSON.parse(r.result.content[0].text)
}
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('fake-mcp', () => {
  it('initialize, ping, tools/list, echo, an unknown method; every call recorded with argv, env names and cwd', async () => {
    const s = start({}, ['--flag', 'v'], { SOME_NAME: 'hidden-value' })
    const r = await init(s)
    expect(r.result.protocolVersion).toBe('2025-06-18')
    expect(r.result.serverInfo.name).toBe('fake-mcp')
    expect(r.result.instructions).toBeUndefined()
    expect((await s.request('ping')).result).toEqual({})
    const names = (await s.request('tools/list')).result.tools.map((t: { name: string }) => t.name)
    expect(names).toEqual(['echo', 'probe_children', 'probe_env', 'probe_fetch', 'probe_read', 'probe_write'])
    expect(await call(s, 'echo', { a: 1 })).toEqual({ a: 1 })
    expect((await s.request('no/such')).error.code).toBe(-32601)
    expect((await s.request('tools/call', { name: 'nope' })).error.code).toBe(-32602)
    const calls = s.calls()
    expect(calls.map(c => c.method)).toEqual(['initialize', 'ping', 'tools/list', 'tools/call', 'no/such', 'tools/call'])
    expect(calls[0].argv).toEqual(['--flag', 'v'])
    expect(calls[0].envNames).toContain('SOME_NAME')
    expect(JSON.stringify(calls)).not.toContain('hidden-value')
    expect(calls[0].cwd).toBe(root)
    expect(calls[3].params.arguments).toEqual({ a: 1 })
  })

  it('probes say what really happened', async () => {
    const s = start({}, [], { MY_VAR: 'visible' })
    await init(s)
    const file = join(s.dir, 'scenario.json')
    expect((await call(s, 'probe_read', { path: file })).ok).toBe(true)
    expect(await call(s, 'probe_read', { path: join(root, 'missing') })).toMatchObject({ ok: false, code: 'ENOENT' })
    expect(await call(s, 'probe_write', { path: join(root, 'w.txt'), text: 'hi' })).toMatchObject({ ok: true })
    expect(readFileSync(join(root, 'w.txt'), 'utf8')).toBe('hi')
    expect(await call(s, 'probe_write', { path: join(root, 'no', 'w.txt'), text: 'hi' })).toMatchObject({ ok: false, code: 'ENOENT' })
    expect((await call(s, 'probe_env')).env.MY_VAR).toBe('visible')
    const kids = await call(s, 'probe_children', { spawn: true })
    expect(kids.self.argv.join(' ')).toContain('fake-mcp.mjs')
    expect(kids.spawned).toBeGreaterThan(0)
    process.kill(kids.spawned, 'SIGKILL')
    // 连不上就说连不上:没有在听的端口
    const closed = await call(s, 'probe_fetch', { host: '127.0.0.1', port: 9, direct: true })
    expect(closed.ok).toBe(false)
  })

  it('toolCount and a page size: tools/list pages through nextCursor', async () => {
    const s = start({ toolCount: 7, pageSize: 5 })
    await init(s)
    const a = (await s.request('tools/list')).result
    expect(a.tools).toHaveLength(5)
    const b = (await s.request('tools/list', { cursor: a.nextCursor })).result
    const c = (await s.request('tools/list', { cursor: b.nextCursor })).result
    expect(c.nextCursor).toBeUndefined()
    expect([...a.tools, ...b.tools, ...c.tools].map((t: { name: string }) => t.name).filter((n: string) => n.startsWith('tool_'))).toHaveLength(7)
  })

  it('badNames: listed as they are', async () => {
    const s = start({ badNames: ['a;rm -rf', '../x'] })
    await init(s)
    const names = (await s.request('tools/list')).result.tools.map((t: { name: string }) => t.name)
    expect(names).toEqual(expect.arrayContaining(['a;rm -rf', '../x']))
  })

  it('instructions: only when the scenario has them', async () => {
    expect((await init(start({ instructions: 'OBEY' }))).result.instructions).toBe('OBEY')
  })

  it('neverInit: reads initialize and doesn\'t answer, still alive', async () => {
    const s = start({ neverInit: true })
    s.send({ jsonrpc: '2.0', id: 100, method: 'initialize', params: {} })
    for (let i = 0; i < 400 && s.calls().length === 0; i++) await pause(5)
    expect(s.calls().map(c => c.method)).toEqual(['initialize'])
    // 答 ping 说明循环在走,initialize 是真没答
    expect((await s.request('ping')).result).toEqual({})
    expect(s.lines.some(l => JSON.parse(l).id === 100)).toBe(false)
    expect(s.child.exitCode).toBeNull()
  })

  it('crashOnCall: exits mid-call with the given code', async () => {
    const s = start({ crashOnCall: 7 })
    await init(s)
    s.send({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'echo', arguments: {} } })
    expect(await s.exited).toBe(7)
  })

  it('garbage: a line that is not JSON before each answer', async () => {
    const s = start({ garbage: 'not json at all' })
    const r = await init(s)
    expect(r.result).toBeDefined()
    expect(s.lines[0]).toBe('not json at all')
  })

  it('unknownId: an answer to a request nobody made', async () => {
    const s = start({ unknownId: true })
    await init(s)
    await s.until(l => JSON.parse(l).id === 987654)
  })

  it('hugeLine: one line of that many bytes in place of the list', async () => {
    const s = start({ hugeLine: 5 * 1024 * 1024 })
    await init(s)
    s.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const big = await s.until(l => l.length > 1000)
    expect(big.length).toBe(5 * 1024 * 1024)
  })

  it('serverRequests: sent after initialized; the answers are recorded', async () => {
    const s = start({ serverRequests: ['sampling/createMessage', { method: 'roots/list', params: { x: 1 } }] })
    await init(s)
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const line = await s.until(l => l.includes('roots/list'))
    const sampling = JSON.parse(s.lines.find(l => l.includes('sampling/createMessage'))!)
    const roots = JSON.parse(line)
    expect(roots.params).toEqual({ x: 1 })
    s.send({ jsonrpc: '2.0', id: sampling.id, error: { code: -32601, message: 'no' } })
    await s.request('ping')
    expect(s.calls().find(c => c.method === 'response')?.params).toMatchObject({ id: sampling.id, error: { code: -32601 } })
  })

  it('stderr: printed at start, a list too', async () => {
    const s = start({ stderr: ['line one', 'line two'] })
    await init(s)
    expect(s.stderr()).toBe('line one\nline two\n')
  })

  it('delayMs: answers late; cancelled calls get no answer and the process stays', async () => {
    const s = start({ delayMs: 80 })
    const t0 = Date.now()
    await init(s)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(70)
    s.send({ jsonrpc: '2.0', id: 50, method: 'tools/call', params: { name: 'echo', arguments: {} } })
    s.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 50 } })
    await pause(150)
    expect(s.lines.some(l => JSON.parse(l).id === 50)).toBe(false)
    expect((await s.request('ping')).result).toEqual({})
    expect(s.calls().some(c => c.method === 'notifications/cancelled')).toBe(true)
  })

  it('listChangedAfter: after that many calls a notification goes out and the descriptions move', async () => {
    const s = start({ listChangedAfter: 2 })
    await init(s)
    const before = (await s.request('tools/list')).result.tools[0].description
    await call(s, 'echo')
    expect(s.lines.some(l => l.includes('list_changed'))).toBe(false)
    await call(s, 'echo')
    await s.until(l => l.includes('notifications/tools/list_changed'))
    expect((await s.request('tools/list')).result.tools[0].description).not.toBe(before)
  })

  it('stdin closing ends it; SIGTERM ends it; nothing else does', async () => {
    const a = start({})
    await init(a)
    await pause(30)
    expect(a.child.exitCode).toBeNull()
    a.child.stdin!.end()
    expect(await a.exited).toBe(0)
    const b = start({})
    await init(b)
    b.child.kill('SIGTERM')
    await b.exited
    expect(b.child.signalCode === 'SIGTERM' || b.child.exitCode === 0).toBe(true)
  })

  it('stubborn: ignores stdin closing and SIGTERM; only SIGKILL ends it', async () => {
    const s = start({ stubborn: true })
    await init(s)
    s.child.stdin!.end()
    s.child.kill('SIGTERM')
    await pause(100)
    expect(s.child.exitCode).toBeNull()
    expect(s.child.signalCode).toBeNull()
    s.child.kill('SIGKILL')
    await s.exited
  })
})

describe('pluginRig: fixtures', () => {
  it('buildPlugin writes each format; extra files keep their mode', () => {
    const skills = { a: { description: 'does a', body: 'Body A' } }
    const claude = buildPlugin(root, { format: 'claude', id: 'cl', skills, commands: { go: 'Run it' }, mcp: { s: { command: 'node', args: ['x.js'] } }, hooks: { SessionStart: [] }, extra: { 'bin/x': { mode: 0o755, text: '#!/bin/sh\n' }, 'README.md': 'hi' } })
    expect(JSON.parse(readFileSync(join(claude, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('cl')
    expect(readFileSync(join(claude, 'skills', 'a', 'SKILL.md'), 'utf8')).toContain('description: does a')
    expect(readFileSync(join(claude, 'commands', 'go.md'), 'utf8')).toBe('Run it')
    expect(JSON.parse(readFileSync(join(claude, '.mcp.json'), 'utf8')).mcpServers.s.command).toBe('node')
    expect(JSON.parse(readFileSync(join(claude, 'hooks', 'hooks.json'), 'utf8')).hooks).toEqual({ SessionStart: [] })
    expect(statSync(join(claude, 'bin', 'x')).mode & 0o111).toBe(0o111)
    const native = buildPlugin(root, { format: 'native', id: 'na', mcp: { s: { command: 'node' } } })
    const m = JSON.parse(readFileSync(join(native, 'mff-plugin.json'), 'utf8'))
    expect(m).toMatchObject({ id: 'na', kernel: '^0.1.0', mcpServers: { s: { command: 'node' } } })
    const bare = buildPlugin(root, { format: 'bare', id: 'ba', skills })
    expect(existsSync(join(bare, '.claude-plugin'))).toBe(false)
    expect(existsSync(join(bare, 'mff-plugin.json'))).toBe(false)
    expect(existsSync(join(bare, 'skills', 'a', 'SKILL.md'))).toBe(true)
  })

  it('buildRepo commits a copy: the plugin dir stays a plain tree, the url is file://', () => {
    const plugin = buildPlugin(root, { format: 'bare', id: 'r', skills: { a: 'Body' } })
    const repo = buildRepo(join(root, 'repos'), plugin)
    expect(repo.url.startsWith('file://')).toBe(true)
    expect(repo.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(existsSync(join(plugin, '.git'))).toBe(false)
    expect(existsSync(join(repo.url.slice('file://'.length), '.git'))).toBe(true)
  })
})

describe('pluginRig: pluginKernel', () => {
  it('runs a turn with a scripted model on a temp home, restarts, and greps raw bytes', async () => {
    const rig = await pluginKernel({ models: { script: () => say('hello from model') } })
    rigs.push(rig)
    expect(rig.dataDir.startsWith(rig.home)).toBe(false)
    const sid = await rig.session()
    const turnId = await rig.turn(sid, 'NEEDLE-USER-TEXT')
    expect(turnId).toBeTruthy()
    expect(rig.requests).toHaveLength(1)
    expect(JSON.stringify(rig.requests[0].messages)).toContain('NEEDLE-USER-TEXT')
    expect(rig.rawBytes().includes('NEEDLE-USER-TEXT')).toBe(true)
    expect(rig.rawBytes().includes('NOT-WRITTEN-ANYWHERE')).toBe(false)
    const before = rig.kernel
    await rig.restart({ kill: true })
    expect(rig.kernel).not.toBe(before)
    expect(rig.kernel.events.bySession(sid).some(e => e.type === 'message.user')).toBe(true)
    await rig.restart({ kill: false })
    await rig.turn(sid, 'again')
    expect(rig.requests).toHaveLength(2)
  })

  it('tools a script calls go through the real registry and gate', async () => {
    const rig = await pluginKernel({ models: { script: n => (n === 1 ? calling('c1', 'nope', {}) : say('done')) } })
    rigs.push(rig)
    const sid = await rig.session()
    await rig.turn(sid, 'go')
    expect(rig.requests).toHaveLength(2)
    expect(rig.kernel.events.bySession(sid).some(e => e.type === 'tool.ended')).toBe(true)
  })

  it('install before a plugin manager is in the list: the -32601 of the method', async () => {
    const rig = await pluginKernel()
    rigs.push(rig)
    await expect(rig.install('/nowhere')).rejects.toMatchObject({ code: -32601 })
  })
})
