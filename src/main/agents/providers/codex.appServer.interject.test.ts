import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatCallbacks } from '../types'

/**
 * codex 走 app-server 时,排队的那条可以插进**正在跑的这一轮**(turn/steer);app-server 起不来时这一轮
 * 自动退回 exec 照常跑完、不提供插话。假 codex 靠 PATH 塞进去,说的是 app-server 的真协议
 * (codex-cli 0.154 `app-server generate-json-schema`:TurnSteerParams = {threadId, expectedTurnId, input})。
 */
const settings = vi.hoisted(() => ({ codexTransport: 'app-server' as 'exec' | 'app-server', codexTransportChosen: false }))
vi.mock('../../config/store', () => ({ readSettings: () => ({ ...settings }) }))
const logs = vi.hoisted(() => [] as string[])
vi.mock('../../log/appLog', async (orig) => ({ ...(await orig<typeof import('../../log/appLog')>()), logError: (_s: string, m: string) => { logs.push(m) } }))

// MODE=steer:握手 → turn/start 回 turn.id=turn-1 → 先说一句 → 等 turn/steer → 回 {turnId} → 再说一句 → 收尾。
// MODE=broken:`app-server` 子命令直接失败退出(老版本 codex);`exec` 照常给一条回复。
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs')
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const argv = process.argv.slice(2)
const log = (o) => fs.appendFileSync(process.env.TRACE, JSON.stringify(o) + '\\n')
log({ argv, cwd: process.cwd(), agent: process.env.FORGE_AGENT_ID || null })
if (argv[argv.length - 1] === 'app-server' || argv.includes('app-server')) {
  if (process.env.MODE === 'broken') { process.stderr.write("error: unrecognized subcommand 'app-server'\\n"); process.exit(2) }
  let buf = ''
  process.stdin.on('data', (b) => {
    buf += b.toString()
    let nl
    while ((nl = buf.indexOf('\\n')) !== -1) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
      if (!line) continue
      const m = JSON.parse(line)
      log({ rpc: m })
      if (m.method === 'initialize') out({ jsonrpc: '2.0', id: m.id, result: {} })
      else if (m.method === 'thread/start' || m.method === 'thread/resume') out({ jsonrpc: '2.0', id: m.id, result: { thread: { id: 'th1' } } })
      else if (m.method === 'turn/start' && process.env.MODE === 'empty') {
        out({ jsonrpc: '2.0', id: m.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } })
        out({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'th1', turn: { id: 'turn-1', status: 'completed', items: [] } } })
      }
      else if (m.method === 'turn/start' && process.env.MODE === 'crash') {
        out({ jsonrpc: '2.0', id: m.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } })
        process.stderr.write('fatal: sandbox died\\n'); setTimeout(() => process.exit(3), 20)
      }
      else if (m.method === 'turn/start') {
        out({ jsonrpc: '2.0', id: m.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } })
        out({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'th1', turn: { id: 'turn-1', status: 'inProgress', items: [] } } })
        out({ jsonrpc: '2.0', method: 'item/completed', params: { item: { id: 'm1', type: 'agentMessage', text: 'first' } } })
      }
      else if (m.method === 'turn/steer') {
        if (m.params.expectedTurnId !== 'turn-1') { out({ jsonrpc: '2.0', id: m.id, error: { code: -32600, message: 'mismatch' } }); continue }
        out({ jsonrpc: '2.0', id: m.id, result: { turnId: 'turn-1' } })
        out({ jsonrpc: '2.0', method: 'item/completed', params: { item: { id: 'm2', type: 'agentMessage', text: 'second' } } })
        out({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'th1', turn: { id: 'turn-1', status: 'completed', items: [] } } })
      }
    }
  })
} else {
  out({ type: 'thread.started', thread_id: 'th-exec' })
  out({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'from exec' } })
  out({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })
  process.exit(0)
}
`

let dir: string, trace: string, oldPath: string | undefined
beforeEach(() => {
  logs.length = 0
  settings.codexTransport = 'app-server'; settings.codexTransportChosen = false
  dir = mkdtempSync(join(tmpdir(), 'codex-steer-'))
  writeFileSync(join(dir, 'codex'), FAKE); chmodSync(join(dir, 'codex'), 0o755)
  trace = join(dir, 'trace.jsonl')
  oldPath = process.env.PATH
  process.env.PATH = `${dir}:${oldPath ?? ''}`
})
afterEach(() => {
  process.env.PATH = oldPath
  rmSync(dir, { recursive: true, force: true })
})

const traced = () => existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []

async function chat(mode: 'steer' | 'broken' | 'empty' | 'crash', extraEnv: NodeJS.ProcessEnv = {}, bin?: string) {
  const { makeCodexProvider } = await import('./codex')
  let text = ''
  const errors: string[] = []
  const statuses: string[] = []
  const ready: boolean[] = []
  let firstSeen!: () => void
  const first = new Promise<void>(r => { firstSeen = r })
  const cb: ChatCallbacks = {
    onSession: () => {}, onThinkDelta: () => {}, onDone: () => {},
    onAssistantDelta: (t) => { text += t; if (text.includes('first') || text.includes('from exec')) firstSeen() },
    onError: (e) => { errors.push(e.message) },
    onStatus: (t) => { statuses.push(t) },
  }
  const provider = makeCodexProvider({ bin, defaultModels: [], modelHasFastTier: () => false })
  const session = provider.chat!({ id: 'c1', prompt: 'hello', model: 'default', cwd: dir }, cb, { ...process.env, TRACE: trace, MODE: mode, ...extraEnv })
  session.watchInterjectable?.((r) => ready.push(r))
  return { session, first, done: session.done, text: () => text, errors, statuses, ready }
}

describe('codex chat · app-server 插话', () => {
  it('拿到 turnId 后可插话:turn/steer 带对 expectedTurnId,插进同一轮,后面的输出还在同一条回复里', async () => {
    const c = await chat('steer')
    expect(typeof c.session.interject).toBe('function')
    await c.first
    expect(c.ready).toEqual([true])
    await expect(c.session.interject!('also b.txt', [{ path: '/tmp/b.png', name: 'b.png' } as never])).resolves.toBe(true)
    await c.done
    expect(c.text()).toBe('first\n\nsecond')
    expect(c.errors).toEqual([])
    const steer = traced().find(t => t.rpc?.method === 'turn/steer').rpc
    expect(steer.params.threadId).toBe('th1')
    expect(steer.params.expectedTurnId).toBe('turn-1')
    // 与正常发送同一个构造(buildChatPrompt):附件路径跟在正文后面
    expect(steer.params.input).toEqual([{ type: 'text', text: 'also b.txt\n\n附件:\n- /tmp/b.png' }])
    expect(c.ready.at(-1)).toBe(false)
    await expect(c.session.interject!('late')).resolves.toBe(false)
  })

  it('app-server 进程拿得到这一轮的 cwd 和 env(电脑操作的 FORGE_AGENT_ID 靠它)', async () => {
    const c = await chat('steer', { FORGE_AGENT_ID: 'agent-xyz' })
    await c.first
    await c.session.interject!('x')
    await c.done
    const boot = traced()[0]
    expect(boot.argv.at(-1)).toBe('app-server')
    expect(boot.agent).toBe('agent-xyz')
    expect(boot.cwd.endsWith(dir.split('/').pop()!)).toBe(true)
  })

  it('★app-server 起不来(老版本 codex):这一轮自动退回 exec 照常完成,不报错、不提供插话,只记一次日志', async () => {
    const c = await chat('broken')
    await c.done
    expect(c.text()).toBe('from exec')
    expect(c.errors).toEqual([])
    expect(c.ready).not.toContain(true)
    await expect(c.session.interject!('x')).resolves.toBe(false)
    const runs = traced().filter(t => t.argv)
    expect(runs.map(r => r.argv[0] === 'exec' ? 'exec' : 'app-server')).toEqual(['app-server', 'exec'])
    expect(logs.filter(m => m.includes('回落到 exec'))).toHaveLength(1)
  })
  it('工作流 run() 同样回落(两个调用方都要接)', async () => {
    settings.codexTransportChosen = true
    const { makeCodexProvider } = await import('./codex')
    const provider = makeCodexProvider({ defaultModels: [], modelHasFastTier: () => false })
    const lines: string[] = []
    const states: string[] = []
    const errors: unknown[] = []
    const s = provider.run(
      { stageKey: 't', agentId: 'a1', name: 'T', prompt: 'x', cwd: dir, model: 'default' },
      { onLog: (l) => lines.push(l.text), onState: (st) => states.push(st), onConfirm: async () => 'allow', onInput: async () => '', onDone: () => {}, onError: (e) => errors.push(e) },
      { ...process.env, TRACE: trace, MODE: 'broken' },
    )
    expect((await s.done).ok).toBe(true)
    expect(lines.join('\n')).toContain('from exec')
    expect(states.at(-1)).toBe('ok')
    expect(errors).toEqual([])
    expect(traced().filter(t => t.argv).map(r => r.argv[0] === 'exec' ? 'exec' : 'app-server')).toEqual(['app-server', 'exec'])
  })
  it('回落提示每次 app 运行、每个 codex 路径只说一次;日志每轮照记', async () => {
    const bin = join(dir, 'codex')
    const a = await chat('broken', {}, bin); await a.done
    const b = await chat('broken', {}, bin); await b.done
    expect(b.text()).toBe('from exec')
    const fb = (xs: string[]) => xs.filter(t => t.includes('回落到 exec'))
    expect(fb(a.statuses)).toHaveLength(1)
    expect(fb(b.statuses)).toHaveLength(0)
    expect(logs.filter(m => m.includes('回落到 exec'))).toHaveLength(2)
  })
})

describe('codex chat · app-server 没有回复时要报错(同 exec)', () => {
  it('这一轮完成了却一个字都没有 → onError 给出诊断,不是一条空白回复', async () => {
    const c = await chat('empty')
    await c.done
    expect(c.text()).toBe('')
    expect(c.errors).toHaveLength(1)
    expect(c.errors[0]).toContain('codex 无输出')
  })
  it('进程中途崩了 → 只报一条「意外退出」(带 stderr),不再叠一条无输出', async () => {
    const c = await chat('crash')
    await c.done
    expect(c.errors).toHaveLength(1)
    expect(c.errors[0]).toContain('意外退出')
    expect(c.errors[0]).toContain('sandbox died')
  })
})

// 插话是聊天的功能:默认值只把**聊天**切到 app-server。无人值守的工作流阶段不能因为默认值变了就开始停在审批门上。
describe('codex 传输:聊天 vs 工作流', () => {
  const firstSpawn = () => { const r = traced().find(t => t.argv); return r.argv[0] === 'exec' ? 'exec' : 'app-server' }
  const runOnce = async () => {
    const { makeCodexProvider } = await import('./codex')
    const provider = makeCodexProvider({ defaultModels: [], modelHasFastTier: () => false })
    const s = provider.run(
      { stageKey: 't', agentId: 'a1', name: 'T', prompt: 'x', cwd: dir, model: 'default' },
      { onLog: () => {}, onState: () => {}, onConfirm: async () => 'allow', onInput: async () => '', onDone: () => {}, onError: () => {} },
      { ...process.env, TRACE: trace, MODE: 'broken' },
    )
    await s.done
    const k = firstSpawn(); rmSync(trace, { force: true }); return k
  }
  const chatOnce = async () => { const c = await chat('broken'); await c.done; const k = firstSpawn(); rmSync(trace, { force: true }); return k }

  it('默认(没亲手选过):聊天 app-server,工作流 exec', async () => {
    expect(await chatOnce()).toBe('app-server')
    expect(await runOnce()).toBe('exec')
  })
  it('亲手选了 app-server:两边都 app-server', async () => {
    settings.codexTransportChosen = true
    expect(await chatOnce()).toBe('app-server')
    expect(await runOnce()).toBe('app-server')
  })
  it('亲手选了 exec:两边都 exec', async () => {
    settings.codexTransport = 'exec'; settings.codexTransportChosen = true
    expect(await chatOnce()).toBe('exec')
    expect(await runOnce()).toBe('exec')
  })
})
