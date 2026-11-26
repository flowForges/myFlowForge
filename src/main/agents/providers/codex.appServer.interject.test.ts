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
vi.mock('../../config/store', () => ({ readSettings: () => ({ codexTransport: 'app-server' }) }))
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

async function chat(mode: 'steer' | 'broken', extraEnv: NodeJS.ProcessEnv = {}) {
  const { makeCodexProvider } = await import('./codex')
  let text = ''
  const errors: string[] = []
  const ready: boolean[] = []
  let firstSeen!: () => void
  const first = new Promise<void>(r => { firstSeen = r })
  const cb: ChatCallbacks = {
    onSession: () => {}, onThinkDelta: () => {}, onDone: () => {},
    onAssistantDelta: (t) => { text += t; if (text.includes('first') || text.includes('from exec')) firstSeen() },
    onError: (e) => { errors.push(e.message) },
  }
  const provider = makeCodexProvider({ defaultModels: [], modelHasFastTier: () => false })
  const session = provider.chat!({ id: 'c1', prompt: 'hello', model: 'default', cwd: dir }, cb, { ...process.env, TRACE: trace, MODE: mode, ...extraEnv })
  session.watchInterjectable?.((r) => ready.push(r))
  return { session, first, done: session.done, text: () => text, errors, ready }
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
})
