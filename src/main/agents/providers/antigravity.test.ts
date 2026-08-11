import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeAntigravityProvider, stripModelsProgress } from './antigravity'
import { permissionArgs } from '../permissionArgs'
import type { ChatCallbacks, LogLine } from '../types'

let dir: string, cli: string, argsSink: string

// 假 agy:把收到的 argv 落盘(好断言命令行),然后按【真机确认过的信封】吐事件。
const fakeCli = (sink: string) => `#!/usr/bin/env node
const fs = require('fs')
fs.writeFileSync(${JSON.stringify(sink)}, JSON.stringify(process.argv.slice(2)))
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ event: 'init', init: { cwd: process.cwd(), tools: ['read_file'], permission_mode: 'accept-edits' } })
out({ event: 'step_update', step_update: { conversation_id: 'conv-77', step_index: 0, state: 'ACTIVE', step_type: 'TOOL', tool_name: 'read_file', tool_info: { name: 'read_file', parameters: { file_path: '/a/b.ts' } } } })
out({ event: 'step_update', step_update: { conversation_id: 'conv-77', step_index: 0, state: 'DONE', tool_name: 'read_file', tool_info: { name: 'read_file', output: '文件内容' } } })
out({ event: 'step_update', step_update: { conversation_id: 'conv-77', step_index: 1, state: 'ACTIVE', text_delta: '这段代码' } })
out({ event: 'step_update', step_update: { conversation_id: 'conv-77', step_index: 1, state: 'ACTIVE', text_delta: '做了三件事。' } })
out({ event: 'result', result: { conversation_id: 'conv-77', status: 'SUCCESS', response: '这段代码做了三件事。', duration_seconds: 2, num_turns: 1, usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 5, cache_read_tokens: 0, total_tokens: 125 } } })
process.exit(0)
`

// 未登录时的真实收尾(原样抄自真机输出)。
const FAKE_UNAUTH = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ event: 'result', result: { conversation_id: '', status: 'ERROR', response: '', error: 'authentication failed or timed out', duration_seconds: 0, num_turns: 0, usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 } } }) + '\\n')
process.exit(0)
`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agy-'))
  argsSink = join(dir, 'argv.json')
  cli = join(dir, 'agy.js'); writeFileSync(cli, fakeCli(argsSink)); chmodSync(cli, 0o755)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const argv = (): string[] => JSON.parse(readFileSync(argsSink, 'utf8'))

function mkChatCb() {
  const st = { text: '', think: [] as string[], sessions: [] as string[], tools: [] as any[], errored: '', turnTokens: null as any, usage: null as any, status: [] as string[] }
  const cb: ChatCallbacks = {
    onSession: (id) => st.sessions.push(id),
    onAssistantDelta: (t) => { st.text += t },
    onThinkDelta: (t) => st.think.push(t),
    onToolActivity: (t) => st.tools.push(t),
    onTurnTokens: (t) => { st.turnTokens = t },
    onUsage: (u) => { st.usage = u },
    onStatus: (s) => st.status.push(s),
    onDone: () => {},
    onError: (e) => { st.errored = e.message },
  }
  return { cb, st }
}

describe('antigravity provider', () => {
  it('身份与能力:没有逐操作审批协议,也注入不了 forge MCP —— 都如实标 false', () => {
    const p = makeAntigravityProvider({ bin: 'agy', defaultModels: [] })
    expect(p.id).toBe('antigravity')
    expect(p.displayName).toBe('Antigravity')
    expect(p.capabilities.permissionHook).toBe(false)
    expect(p.capabilities.mcpTools).toBe(false)
    expect(p.capabilities.liveModels).toBe(true)
  })

  it('chat:正文只来自 text_delta,工具步配成对,conversation_id 上报为会话 id', async () => {
    const p = makeAntigravityProvider({ bin: 'node', preArgs: [cli], defaultModels: [] })
    const { cb, st } = mkChatCb()
    await p.chat!({ id: 't1', cwd: dir, model: 'default', prompt: '看看这个文件', attachments: [] } as never, cb, process.env).done

    // ★正文恰好一份:result.response 是整轮全文,若也当增量发就会变成「…三件事。这段代码做了三件事。」
    expect(st.text).toBe('这段代码做了三件事。')
    expect(st.sessions).toContain('conv-77')
    expect(st.tools.map(t => [t.phase, t.title ?? t.output])).toEqual([['start', 'read_file · /a/b.ts'], ['done', '文件内容']])
    expect(st.turnTokens).toEqual({ input: 100, output: 25 })   // thinking 计进输出
    expect(st.usage?.used).toBe(125)
    expect(st.errored).toBe('')
  })

  it('chat:未登录时把 result.error 当作失败原因,而不是丢一句「无输出」', async () => {
    const unauth = join(dir, 'unauth.js'); writeFileSync(unauth, FAKE_UNAUTH); chmodSync(unauth, 0o755)
    const p = makeAntigravityProvider({ bin: 'node', preArgs: [unauth], defaultModels: [] })
    const { cb, st } = mkChatCb()
    await p.chat!({ id: 't2', cwd: dir, model: 'default', prompt: 'hi', attachments: [] } as never, cb, process.env).done
    expect(st.errored).toBe('authentication failed or timed out')
  })

  it('chat:非 JSON 行(比如登录 URL)走状态行,绝不混进回答正文', async () => {
    const noisy = join(dir, 'noisy.js'); writeFileSync(noisy, `#!/usr/bin/env node
process.stdout.write('Authentication required. Please visit the URL to log in:\\n')
process.stdout.write(JSON.stringify({ event: 'step_update', step_update: { text_delta: '正文' } }) + '\\n')
process.stdout.write(JSON.stringify({ event: 'result', result: { status: 'SUCCESS' } }) + '\\n')
process.exit(0)
`)
    chmodSync(noisy, 0o755)
    const p = makeAntigravityProvider({ bin: 'node', preArgs: [noisy], defaultModels: [] })
    const { cb, st } = mkChatCb()
    await p.chat!({ id: 't3', cwd: dir, model: 'default', prompt: 'hi', attachments: [] } as never, cb, process.env).done
    expect(st.text).toBe('正文')
    expect(st.status.join(' ')).toContain('Authentication required')
  })

  it('run:正文进日志,工具步出标题,result 决定成败', async () => {
    const p = makeAntigravityProvider({ bin: 'node', preArgs: [cli], defaultModels: [] })
    const logs: LogLine[] = []
    const res = await p.run(
      { stageKey: 'design', agentId: 'a1', name: 'D', prompt: 'x', cwd: dir, model: 'default' },
      { onLog: l => logs.push(l), onState: () => {}, onConfirm: async () => 'allow', onInput: async () => '', onDone: () => {}, onError: () => {} },
      process.env,
    ).done
    expect(res.ok).toBe(true)
    expect(logs.map(l => l.text)).toContain('read_file · /a/b.ts')
    expect(logs.filter(l => l.kind === 'output').map(l => l.text).join('')).toContain('三件事')
  })

  it('命令行:stream-json + 权限档;续聊才带 --conversation', async () => {
    const p = makeAntigravityProvider({ bin: 'node', defaultModels: [] })
    // preArgs 是测试后门,会顶掉真实 argv —— 这里要验真实 argv,所以不能用它,改把假 CLI 当 bin。
    chmodSync(cli, 0o755)
    const direct = makeAntigravityProvider({ bin: cli, defaultModels: [] })
    const { cb } = mkChatCb()
    await direct.chat!({ id: 't4', cwd: dir, model: 'gemini-3-pro', permissionMode: 'readonly', prompt: 'hi', attachments: [] } as never, cb, process.env).done
    const a = argv()
    expect(a.slice(0, 2)).toEqual(['-p', expect.stringContaining('hi') as unknown as string])
    expect(a).toContain('--output-format'); expect(a).toContain('stream-json')
    expect(a).toContain('--model'); expect(a).toContain('gemini-3-pro')
    expect(a.join(' ')).toContain('--mode plan')          // readonly
    expect(a).not.toContain('--conversation')             // 首轮不带
    expect(p.bin).toBe('node')

    const { cb: cb2 } = mkChatCb()
    await direct.chat!({ id: 't5', cwd: dir, model: 'default', sessionId: 'conv-9', prompt: 'hi', attachments: [] } as never, cb2, process.env).done
    const b = argv()
    expect(b.join(' ')).toContain('--conversation conv-9')
    expect(b).not.toContain('--model')                    // 'default' 是占位,不该真传给 CLI
  })
})

describe('权限档映射', () => {
  it('三档分别落到 --mode plan / --mode accept-edits / --dangerously-skip-permissions', () => {
    expect(permissionArgs('antigravity', 'readonly')).toEqual(['--mode', 'plan'])
    expect(permissionArgs('antigravity', 'auto')).toEqual(['--mode', 'accept-edits'])
    expect(permissionArgs('antigravity', 'full')).toEqual(['--dangerously-skip-permissions'])
    expect(permissionArgs('antigravity', undefined)).toEqual([])
  })
})

describe('stripModelsProgress', () => {
  it('去掉 agy models 的进度行,否则它会被当成一条假模型', () => {
    expect(stripModelsProgress('Fetching available models...\ngemini-3-pro  强\ngemini-3-flash  快'))
      .toBe('gemini-3-pro  强\ngemini-3-flash  快')
  })
  it('正常输出原样通过', () => {
    expect(stripModelsProgress('a\nb')).toBe('a\nb')
  })
})
