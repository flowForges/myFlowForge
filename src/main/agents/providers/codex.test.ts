import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeCodexProvider, parseCodexEvent, codexToolActivity, codexErrorMessage, forgeChatDirective, isCodexInternalLog } from './codex'
import { forgeCodexConfigArgs } from '../mcpConfig'
import { getAppLog, clearAppLog } from '../../log/appLog'
import type { LogLine, ChatTask } from '../types'

let dir: string, cli: string
const FAKE = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ msg: { type: 'agent_message', message: '思考中' } })
process.stdout.write('not-json\\n')
out({ type: 'task_complete', message: 'done it' })
process.exit(0)
`
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-'))
  cli = join(dir, 'codex.js'); writeFileSync(cli, FAKE); chmodSync(cli, 0o755)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('parseCodexEvent (current thread/item format)', () => {
  it('maps thread.started→session, assistant_message→final, reasoning→think, command→shell', () => {
    expect(parseCodexEvent({ type: 'thread.started', thread_id: 't1' })).toEqual([{ kind: 'session', id: 't1' }])
    expect(parseCodexEvent({ type: 'item.completed', item: { type: 'assistant_message', text: '你好' } })).toEqual([{ kind: 'assistant-final', text: '你好' }])
    expect(parseCodexEvent({ type: 'item.completed', item: { type: 'reasoning', text: '想一下' } })).toEqual([{ kind: 'think', text: '想一下' }])
    expect(parseCodexEvent({ type: 'item.completed', item: { type: 'command_execution', command: ['date'] } })).toEqual([{ kind: 'think', text: '调用 shell: date' }])
  })
  it('ignores lifecycle noise (turn.started, item.updated)', () => {
    expect(parseCodexEvent({ type: 'turn.started' })).toEqual([])
    expect(parseCodexEvent({ type: 'item.updated', item: { type: 'assistant_message', text: 'partial' } })).toEqual([])
  })
  it('surfaces file edits and plans as think steps', () => {
    expect(parseCodexEvent({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'a.ts' }, { path: 'b.ts' }] } }))
      .toEqual([{ kind: 'think', text: '编辑文件: a.ts, b.ts' }])
    expect(parseCodexEvent({ type: 'item.completed', item: { type: 'apply_patch', files: ['x.css'] } }))
      .toEqual([{ kind: 'think', text: '编辑文件: x.css' }])
    expect(parseCodexEvent({ type: 'item.completed', item: { type: 'todo_list', text: '1. 改样式 2. 跑测试' } }))
      .toEqual([{ kind: 'think', text: '计划: 1. 改样式 2. 跑测试' }])
  })
  it('does not over-clip a long command (200 char budget)', () => {
    const long = 'echo ' + 'x'.repeat(300)
    const r = parseCodexEvent({ type: 'item.completed', item: { type: 'command_execution', command: [long] } })
    expect((r[0] as any).text.length).toBeGreaterThan(150)   // not truncated at 60 anymore
  })
  it('detects failure events', () => {
    expect(codexErrorMessage({ type: 'turn.failed', error: { message: 'rate limited' } })).toBe('rate limited')
    expect(codexErrorMessage({ type: 'thread.started', thread_id: 't' })).toBeNull()
  })
  it('surfaces the nested message from a real API 400 error (not a generic string)', () => {
    // Captured verbatim: a model-not-supported 400 arrives with the real reason under error.message,
    // NOT at the top level — the old code read obj.message and lost it to a generic 'codex error'.
    const real = {
      type: 'error',
      status: 400,
      error: { type: 'invalid_request_error', message: "The 'haiku-4.5' model is not supported when using Codex with a ChatGPT account." },
    }
    expect(codexErrorMessage(real)).toBe("The 'haiku-4.5' model is not supported when using Codex with a ChatGPT account.")
  })
  it('parses the EXACT real-world agent_message item shape', () => {
    // Captured from a live `codex exec --json` run:
    expect(parseCodexEvent({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'OK' } }))
      .toEqual([{ kind: 'assistant-final', text: 'OK' }])
  })
})

describe('isCodexInternalLog (stderr noise filter)', () => {
  it('filters bare codex Rust module lines', () => {
    expect(isCodexInternalLog('codex_models_manager::manager::failed to refresh available models: timeout')).toBe(true)
  })
  it('filters the newer timestamped tracing format (missing supports_reasoning_summaries)', () => {
    expect(isCodexInternalLog('2026-07-23T06:42:02.601837Z ERROR codex_models_manager::manager: failed to renew cache TTL: missing field `supports_reasoning_summaries` at line 88 column 5')).toBe(true)
    expect(isCodexInternalLog('2026-07-23T06:42:02Z WARN codex_core::client: retrying')).toBe(true)
  })
  it('does NOT filter the agent\'s real output that merely mentions codex', () => {
    expect(isCodexInternalLog('我用 codex_models_manager 这个模块做了修改')).toBe(false)
    expect(isCodexInternalLog('这是正常的思考内容')).toBe(false)
  })
})

describe('codexToolActivity (chat 执行 block)', () => {
  it('surfaces a command_execution with its output + exit code, keyed by item id', () => {
    expect(codexToolActivity({ type: 'item.completed', item: { id: 'it_1', type: 'command_execution', command: ['npm', 'test'], aggregated_output: 'PASS 12 tests', exit_code: 0 } }))
      .toEqual({ id: 'it_1', phase: 'done', title: '调用 shell: npm test', output: 'PASS 12 tests', isError: false })
  })
  it('marks a non-zero exit code as an error', () => {
    const a = codexToolActivity({ type: 'item.completed', item: { id: 'it_2', type: 'command_execution', command: ['false'], output: 'boom', exit_code: 1 } })
    expect(a?.isError).toBe(true)
    expect(a?.output).toBe('boom')
  })
  it('surfaces a file_change as a title-only step', () => {
    expect(codexToolActivity({ type: 'item.completed', item: { id: 'it_3', type: 'file_change', changes: [{ path: 'a.ts' }, { path: 'b.ts' }] } }))
      .toEqual({ id: 'it_3', phase: 'done', title: '编辑文件: a.ts, b.ts' })
  })
  it('returns null for non-tool items (reasoning/assistant/etc.)', () => {
    expect(codexToolActivity({ type: 'item.completed', item: { type: 'reasoning', text: 'thinking' } })).toBeNull()
    expect(codexToolActivity({ type: 'turn.started' })).toBeNull()
  })
})

describe('parseCodexEvent (legacy format)', () => {
  it('maps reasoning to think, message delta to assistant, full message to assistant-final, session, shell', () => {
    expect(parseCodexEvent({ msg: { type: 'session_configured', session_id: 's1' } })).toEqual([{ kind: 'session', id: 's1' }])
    expect(parseCodexEvent({ msg: { type: 'agent_reasoning', text: '先看时间' } })).toEqual([{ kind: 'think', text: '先看时间' }])
    expect(parseCodexEvent({ msg: { type: 'agent_message_delta', delta: '现在' } })).toEqual([{ kind: 'assistant', text: '现在' }])
    expect(parseCodexEvent({ msg: { type: 'agent_message', message: '现在是 3 点' } })).toEqual([{ kind: 'assistant-final', text: '现在是 3 点' }])
    expect(parseCodexEvent({ msg: { type: 'exec_command_begin', command: ['date'] } })).toEqual([{ kind: 'think', text: '调用 shell: date' }])
  })
})

describe('codex chat', () => {
  it('streams reasoning to think + message to body, ignores the duplicate final when deltas streamed', async () => {
    const chatCli = join(dir, 'codexchat.js')
    writeFileSync(chatCli, `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ msg: { type: 'session_configured', session_id: 'sess-1' } })
out({ msg: { type: 'agent_reasoning', text: '查一下系统时间' } })
out({ msg: { type: 'agent_message_delta', delta: '现在是' } })
out({ msg: { type: 'agent_message_delta', delta: ' 3 点' } })
out({ msg: { type: 'agent_message', message: '现在是 3 点' } })
process.exit(0)
`)
    chmodSync(chatCli, 0o755)
    const provider = makeCodexProvider({ bin: 'node', preArgs: [chatCli], defaultModels: [] })
    let text = '', think = '', session = '', done = false
    const s = provider.chat!(
      { id: 'a1', prompt: '现在几点', model: 'gpt-5-codex', cwd: dir },
      { onSession: id => { session = id }, onAssistantDelta: t => { text += t }, onThinkDelta: t => { think += t }, onDone: () => { done = true }, onError: () => {} },
      process.env
    )
    await s.done
    expect(text).toBe('现在是 3 点')   // from deltas; the duplicate final message is suppressed
    expect(think).toBe('查一下系统时间')
    expect(session).toBe('sess-1')
    expect(done).toBe(true)
  })
})

describe('codex provider', () => {
  it('maps JSONL events to correct log levels and resolves ok', async () => {
    const provider = makeCodexProvider({ bin: 'node', preArgs: [cli], defaultModels: [] })
    const logs: LogLine[] = []
    const states: string[] = []
    const session = provider.run(
      { stageKey: 'test', agentId: 'a1', name: 'Tester', prompt: 'x', cwd: dir, model: 'gpt-5-codex' },
      {
        onLog: l => logs.push(l),
        onState: s => states.push(s),
        onConfirm: async () => 'allow',
        onInput: async () => '',
        onDone: () => {},
        onError: () => {}
      },
      process.env
    )
    const res = await session.done
    expect(res.ok).toBe(true)
    // 思考中 from agent_message → accent
    const thinkLog = logs.find(l => l.text === '思考中')
    expect(thinkLog).toBeDefined()
    expect(thinkLog?.level).toBe('accent')
    // not-json → info verbatim
    const garbageLog = logs.find(l => l.text === 'not-json')
    expect(garbageLog).toBeDefined()
    expect(garbageLog?.level).toBe('info')
    // done it from task_complete → ok
    const doneLog = logs.find(l => l.text === 'done it')
    expect(doneLog).toBeDefined()
    expect(doneLog?.level).toBe('ok')
    // onState sequence ends with 'ok'
    expect(states[0]).toBe('run')
    expect(states[states.length - 1]).toBe('ok')
  })

  it('reports err state and exit code on nonzero exit', async () => {
    const failScript = join(dir, 'fail.js')
    writeFileSync(failScript, `#!/usr/bin/env node\nprocess.exit(2)\n`)
    chmodSync(failScript, 0o755)
    const provider = makeCodexProvider({ bin: 'node', preArgs: [failScript], defaultModels: [] })
    const states: string[] = []
    let done_result: any
    const session = provider.run(
      { stageKey: 'test', agentId: 'a2', name: 'T', prompt: 'x', cwd: dir, model: 'gpt-5-codex' },
      {
        onLog: () => {},
        onState: s => states.push(s),
        onConfirm: async () => 'allow',
        onInput: async () => '',
        onDone: r => { done_result = r },
        onError: () => {}
      },
      process.env
    )
    await session.done
    expect(states[states.length - 1]).toBe('err')
    expect(done_result.ok).toBe(false)
    expect(done_result.summary).toContain('退出码')
  })

  it('records a codex error in the app debug log on nonzero exit', async () => {
    clearAppLog()
    const failScript = join(dir, 'fail2.js')
    writeFileSync(failScript, `#!/usr/bin/env node\nprocess.stderr.write('boom from codex\\n')\nprocess.exit(2)\n`)
    chmodSync(failScript, 0o755)
    const provider = makeCodexProvider({ bin: 'node', preArgs: [failScript], defaultModels: [] })
    const session = provider.run(
      { stageKey: 'test', agentId: 'a3', name: 'T', prompt: 'x', cwd: dir, model: 'gpt-5-codex' },
      { onLog: () => {}, onState: () => {}, onConfirm: async () => 'allow', onInput: async () => '', onDone: () => {}, onError: () => {} },
      process.env
    )
    await session.done
    const codexErrors = getAppLog().filter(e => e.scope === 'codex' && e.level === 'error')
    expect(codexErrors.length).toBeGreaterThan(0)
    expect(codexErrors[codexErrors.length - 1].msg).toContain('退出码')
    expect(codexErrors[codexErrors.length - 1].detail).toContain('boom from codex')
  })

  it('detect() returns false for a nonexistent binary', async () => {
    const provider = makeCodexProvider({ bin: '/nonexistent/codex-xyz-fake', defaultModels: [] })
    expect(await provider.detect()).toBe(false)
  })

  it('flushes a final JSON line that has no trailing newline', async () => {
    const noNl = join(dir, 'nonl.js')
    writeFileSync(noNl, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ type: 'task_complete', message: '收尾完成' }))\nprocess.exit(0)\n`)
    chmodSync(noNl, 0o755)
    const provider = makeCodexProvider({ bin: 'node', preArgs: [noNl], defaultModels: [] })
    const logs: LogLine[] = []
    const session = provider.run(
      { stageKey: 'test', agentId: 'a3', name: 'T', prompt: 'x', cwd: dir, model: 'gpt-5-codex' },
      { onLog: l => logs.push(l), onState: () => {}, onConfirm: async () => 'allow', onInput: async () => '', onDone: () => {}, onError: () => {} },
      process.env
    )
    await session.done
    expect(logs.map(l => l.text)).toContain('收尾完成')
  })

  it('fence: JSONL agent_message with embedded forge:handoff fence → onHandoff called, prose logged, fence lines absent', async () => {
    const fenceScript = join(dir, 'fence.js')
    // Build the message text in the script using JSON.stringify to avoid escaping issues
    // The agent_message text contains: prose + fence + prose, joined by \n
    const script = `#!/usr/bin/env node
const lines = [
  'Here is the result.',
  '\`\`\`forge:handoff',
  JSON.stringify({ summary: 'stage one complete', artifacts: [{ path: 'plan.md', kind: 'md' }] }),
  '\`\`\`',
  'End of output.'
]
const msg = { msg: { type: 'agent_message', message: lines.join('\\n') } }
process.stdout.write(JSON.stringify(msg) + '\\n')
process.exit(0)
`
    writeFileSync(fenceScript, script)
    chmodSync(fenceScript, 0o755)
    const provider = makeCodexProvider({ bin: 'node', preArgs: [fenceScript], defaultModels: [] })
    const logs: LogLine[] = []
    const handoffs: any[] = []
    const session = provider.run(
      { stageKey: 'test', agentId: 'a4', name: 'T', prompt: 'x', cwd: dir, model: 'gpt-5-codex' },
      {
        onLog: l => logs.push(l),
        onState: () => {},
        onConfirm: async () => 'allow',
        onInput: async () => '',
        onDone: () => {},
        onError: () => {},
        onHandoff: p => handoffs.push(p)
      },
      process.env
    )
    await session.done
    // onHandoff called once with correct payload
    expect(handoffs).toHaveLength(1)
    expect(handoffs[0].summary).toBe('stage one complete')
    expect(handoffs[0].artifacts).toEqual([{ path: 'plan.md', kind: 'md' }])
    // The logged text contains the prose lines but NOT the fence lines
    const allText = logs.map(l => l.text).join('\n')
    expect(allText).toContain('Here is the result.')
    expect(allText).toContain('End of output.')
    expect(allText).not.toContain('forge:handoff')
    expect(allText).not.toContain('stage one complete')
    // The log level for agent_message text should be accent
    expect(logs.some(l => l.level === 'accent')).toBe(true)
  })

  it('fence: RAW (non-JSONL) stream where the body line is valid JSON → onHandoff still fires, body not dropped', async () => {
    // A raw codex stream (not JSONL) emits the fence body as its own stdout line. That body
    // is always valid JSON, so it must NOT be mistaken for a codex event and dropped — it
    // must fail-open through the fence scanner so the handoff is detected.
    const fenceScript = join(dir, 'fence-raw.js')
    const script = `#!/usr/bin/env node
process.stdout.write('before raw\\n')
process.stdout.write('\`\`\`forge:handoff\\n')
process.stdout.write(JSON.stringify({ summary: 'raw stream handoff', artifacts: [{ path: 'r.md', kind: 'md' }] }) + '\\n')
process.stdout.write('\`\`\`\\n')
process.stdout.write('after raw\\n')
process.exit(0)
`
    writeFileSync(fenceScript, script)
    chmodSync(fenceScript, 0o755)
    const provider = makeCodexProvider({ bin: 'node', preArgs: [fenceScript], defaultModels: [] })
    const logs: LogLine[] = []
    const handoffs: any[] = []
    const session = provider.run(
      { stageKey: 'test', agentId: 'a6', name: 'T', prompt: 'x', cwd: dir, model: 'gpt-5-codex' },
      {
        onLog: l => logs.push(l),
        onState: () => {},
        onConfirm: async () => 'allow',
        onInput: async () => '',
        onDone: () => {},
        onError: () => {},
        onHandoff: p => handoffs.push(p)
      },
      process.env
    )
    await session.done
    expect(handoffs).toHaveLength(1)
    expect(handoffs[0].summary).toBe('raw stream handoff')
    expect(handoffs[0].artifacts).toEqual([{ path: 'r.md', kind: 'md' }])
    const allText = logs.map(l => l.text).join('\n')
    expect(allText).toContain('before raw')
    expect(allText).toContain('after raw')
    expect(allText).not.toContain('forge:handoff')
    expect(allText).not.toContain('raw stream handoff')
  })

  it('fence: cb without onHandoff (undefined) → no crash, fence still swallowed', async () => {
    const fenceScript = join(dir, 'fence-no-cb.js')
    // Use a JSONL agent_message with embedded fence — avoids body line being parsed as JSON separately
    const script = `#!/usr/bin/env node
const lines = [
  'before prose',
  '\`\`\`forge:handoff',
  JSON.stringify({ summary: 'silent payload' }),
  '\`\`\`',
  'after prose'
]
const msg = { msg: { type: 'agent_message', message: lines.join('\\n') } }
process.stdout.write(JSON.stringify(msg) + '\\n')
process.exit(0)
`
    writeFileSync(fenceScript, script)
    chmodSync(fenceScript, 0o755)
    const provider = makeCodexProvider({ bin: 'node', preArgs: [fenceScript], defaultModels: [] })
    const logs: LogLine[] = []
    // Callbacks without onHandoff
    const session = provider.run(
      { stageKey: 'test', agentId: 'a5', name: 'T', prompt: 'x', cwd: dir, model: 'gpt-5-codex' },
      {
        onLog: l => logs.push(l),
        onState: () => {},
        onConfirm: async () => 'allow',
        onInput: async () => '',
        onDone: () => {},
        onError: () => {}
        // onHandoff intentionally omitted
      },
      process.env
    )
    // Must not throw
    await expect(session.done).resolves.toBeTruthy()
    const texts = logs.map(l => l.text)
    // Normal lines pass through
    expect(texts.some(t => t.includes('before prose') || t.includes('after prose'))).toBe(true)
    // Fence lines swallowed
    expect(texts.some(t => t.includes('forge:handoff') || t.includes('silent payload'))).toBe(false)
  })
})

describe('codex run() forge MCP injection', () => {
  const ARGV_DUMP = `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(2)))
process.exit(0)
`
  let dumpCli: string, argvOut: string
  beforeEach(() => {
    dumpCli = join(dir, 'argvdump.js'); writeFileSync(dumpCli, ARGV_DUMP); chmodSync(dumpCli, 0o755)
    argvOut = join(dir, 'argv.json')
  })

  const NOOP_CB = { onLog: () => {}, onState: () => {}, onConfirm: async () => 'allow' as const, onInput: async () => '', onDone: () => {}, onError: () => {} }
  const runAndCapture = async (env: Record<string, string>, preArgs?: string[]) => {
    const provider = makeCodexProvider(preArgs ? { bin: 'node', preArgs, defaultModels: [] } : { bin: dumpCli, defaultModels: [] })
    const s = provider.run(
      { stageKey: 'test', agentId: 'a1', name: 'T', prompt: 'THE_PROMPT', cwd: dir, model: 'default' },
      NOOP_CB,
      { ...process.env, ARGV_OUT: argvOut, ...env }
    )
    await s.done
    return JSON.parse(readFileSync(argvOut, 'utf8')) as string[]
  }

  // Built lazily (per-test): `dir` is only assigned in beforeEach, undefined at collection time.
  const forgeEnv = () => ({ FORGE_SOCKET: join(dir, 'f.sock'), FORGE_AGENT_ID: 'develop:projA', FORGE_MCP_ENTRY: '/x/forgeMcp.js' })

  it('capabilities.mcpTools is true', () => {
    expect(makeCodexProvider({ defaultModels: [] }).capabilities.mcpTools).toBe(true)
  })

  it('capabilities.liveModels is true (reads ~/.codex/models_cache.json)', () => {
    expect(makeCodexProvider({ defaultModels: [] }).capabilities.liveModels).toBe(true)
  })

  it('listModels falls back to defaults when no local cache exists', async () => {
    // No models_cache.json on the test machine path → fall back to the supplied defaults.
    const defaults = [{ id: 'default', label: '账号默认' }]
    const models = await makeCodexProvider({ defaultModels: defaults }).listModels(process.env)
    expect(models.length).toBeGreaterThanOrEqual(1)
  })

  it('injects -c mcp_servers.forge.* and places them before task.prompt when FORGE_* env present', async () => {
    const FORGE_ENV = forgeEnv()
    const args = await runAndCapture(FORGE_ENV)
    const inj = forgeCodexConfigArgs({ ...process.env, ARGV_OUT: argvOut, ...FORGE_ENV })
    // The 6 injected tokens (-c/value pairs) must appear CONTIGUOUSLY and in ORDER, not merely as members.
    const start = args.findIndex(a => a.startsWith('mcp_servers.forge.command=')) - 1 // the '-c' before it
    expect(start).toBeGreaterThanOrEqual(0)
    expect(args.slice(start, start + inj.length)).toEqual(inj)
    // And the whole injected block precedes the positional prompt.
    expect(start).toBeLessThan(args.indexOf('THE_PROMPT'))
  })

  it('does NOT inject when FORGE_* env absent', async () => {
    const args = await runAndCapture({})
    expect(args.filter(a => a.startsWith('mcp_servers.forge.'))).toHaveLength(0)
    expect(args).toContain('THE_PROMPT')
  })

  it('preArgs branch is unaffected by injection', async () => {
    const args = await runAndCapture(forgeEnv(), [dumpCli])
    expect(args.filter(a => a.startsWith('mcp_servers.forge.'))).toHaveLength(0)
  })
})

describe('codex chat() forge MCP injection', () => {
  const ARGV_DUMP = `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(2)))
process.exit(0)
`
  let dumpCli: string, argvOut: string
  beforeEach(() => {
    dumpCli = join(dir, 'argvdump.js'); writeFileSync(dumpCli, ARGV_DUMP); chmodSync(dumpCli, 0o755)
    argvOut = join(dir, 'argv.json')
  })

  const NOOP_CB = {
    onSession: () => {}, onAssistantDelta: () => {}, onThinkDelta: () => {},
    onDone: () => {}, onError: () => {}
  }
  const chatAndCapture = async (env: Record<string, string>) => {
    const provider = makeCodexProvider({ bin: dumpCli, defaultModels: [] })
    const s = provider.chat!(
      { id: 'a1', prompt: '你好', model: 'default', cwd: dir },
      NOOP_CB,
      { ...process.env, ARGV_OUT: argvOut, ...env }
    )
    await s.done
    return JSON.parse(readFileSync(argvOut, 'utf8')) as string[]
  }

  const forgeEnv = () => ({
    FORGE_SOCKET: join(dir, 'f.sock'),
    FORGE_AGENT_ID: 'develop:projA',
    FORGE_MCP_ENTRY: '/x/forgeMcp.js',
  })

  it('injects -c mcp_servers.forge.* into chat() args when FORGE_* env present', async () => {
    const args = await chatAndCapture(forgeEnv())
    expect(args.some(a => a.startsWith('mcp_servers.forge.'))).toBe(true)
    const inj = forgeCodexConfigArgs({ ...process.env, ARGV_OUT: argvOut, ...forgeEnv() })
    const start = args.findIndex(a => a.startsWith('mcp_servers.forge.command=')) - 1
    expect(start).toBeGreaterThanOrEqual(0)
    expect(args.slice(start, start + inj.length)).toEqual(inj)
  })

  it('does NOT inject mcp_servers.forge.* into chat() args when FORGE_* env absent', async () => {
    const args = await chatAndCapture({})
    expect(args.filter(a => a.startsWith('mcp_servers.forge.'))).toHaveLength(0)
  })
})

describe('codex chat() native resume', () => {
  const ARGV_DUMP = `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(2)))
process.exit(0)
`
  let dumpCli: string, argvOut: string
  beforeEach(() => {
    dumpCli = join(dir, 'argvdump2.js'); writeFileSync(dumpCli, ARGV_DUMP); chmodSync(dumpCli, 0o755)
    argvOut = join(dir, 'argv2.json')
  })
  const NOOP_CB = { onSession: () => {}, onAssistantDelta: () => {}, onThinkDelta: () => {}, onDone: () => {}, onError: () => {} }
  const chatArgs = async (task: Partial<ChatTask>, env: Record<string, string> = {}) => {
    const provider = makeCodexProvider({ bin: dumpCli, defaultModels: [] })
    const s = provider.chat!(
      { id: 'a1', prompt: 'PROMPT_BODY', model: 'default', cwd: dir, ...task },
      NOOP_CB,
      { ...process.env, ARGV_OUT: argvOut, ...env }
    )
    await s.done
    return JSON.parse(readFileSync(argvOut, 'utf8')) as string[]
  }

  it('passes `exec resume <sessionId>` as the leading args when a sessionId is present', async () => {
    const args = await chatArgs({ sessionId: 'thread-123' })
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'thread-123'])
  })

  it('uses plain `exec` (no resume) when there is no sessionId (first turn)', async () => {
    const args = await chatArgs({})
    expect(args[0]).toBe('exec')
    expect(args).not.toContain('resume')
  })

  it('resume still carries the standard chat flags and keeps the prompt last', async () => {
    const args = await chatArgs({ sessionId: 's1' })
    expect(args).toContain('--json')
    expect(args).toContain('--skip-git-repo-check')
    expect(args).toContain('--ignore-user-config')
    expect(args[args.length - 1]).toContain('PROMPT_BODY')
  })

  it('does NOT pass -s/--sandbox on resume (codex exec resume rejects it); uses -c sandbox_mode instead', async () => {
    const args = await chatArgs({ sessionId: 's1' })
    expect(args).not.toContain('-s')
    expect(args).not.toContain('--sandbox')
    expect(args).toContain('sandbox_mode="workspace-write"')
    expect(args).toContain('approval_policy="never"')
  })

  it('first turn (plain exec) also expresses sandbox via -c, not -s', async () => {
    const args = await chatArgs({})
    expect(args).not.toContain('-s')
    expect(args).toContain('sandbox_mode="workspace-write"')
  })
})

describe('codex chat() forge workflow directive', () => {
  const ARGV_DUMP = `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(2)))
process.exit(0)
`
  let dumpCli: string, argvOut: string
  beforeEach(() => {
    dumpCli = join(dir, 'argvdump3.js'); writeFileSync(dumpCli, ARGV_DUMP); chmodSync(dumpCli, 0o755)
    argvOut = join(dir, 'argv3.json')
  })
  const NOOP_CB = { onSession: () => {}, onAssistantDelta: () => {}, onThinkDelta: () => {}, onDone: () => {}, onError: () => {} }
  const promptArg = async (env: Record<string, string> = {}) => {
    const provider = makeCodexProvider({ bin: dumpCli, defaultModels: [] })
    const s = provider.chat!(
      { id: 'a1', prompt: 'PROMPT_BODY', model: 'default', cwd: dir },
      NOOP_CB,
      { ...process.env, ARGV_OUT: argvOut, ...env }
    )
    await s.done
    const args = JSON.parse(readFileSync(argvOut, 'utf8')) as string[]
    return args[args.length - 1]
  }

  it('prepends the forge_propose_plan directive when FORGE_TOOLS exposes it', async () => {
    const prompt = await promptArg({ FORGE_TOOLS: 'forge_propose_plan' })
    expect(prompt).toContain('forge_propose_plan')
    expect(prompt).toContain('PROMPT_BODY')   // user text preserved at the end
  })

  it('does NOT inject the directive when FORGE_TOOLS is absent', async () => {
    expect(await promptArg({})).toBe('PROMPT_BODY')
  })

  it('does NOT inject the directive when FORGE_TOOLS lacks forge_propose_plan', async () => {
    expect(await promptArg({ FORGE_TOOLS: 'forge_read_context' })).toBe('PROMPT_BODY')
  })
})

describe('forgeChatDirective', () => {
  it('returns guidance mentioning forge_propose_plan when the tool is exposed', () => {
    expect(forgeChatDirective({ FORGE_TOOLS: 'forge_propose_plan' } as NodeJS.ProcessEnv)).toContain('forge_propose_plan')
  })
  it('returns empty string when the tool is not exposed', () => {
    expect(forgeChatDirective({} as NodeJS.ProcessEnv)).toBe('')
    expect(forgeChatDirective({ FORGE_TOOLS: 'other' } as NodeJS.ProcessEnv)).toBe('')
  })
  it('tells the chat agent to ask inline (never point the user at a nonexistent forge UI)', () => {
    const d = forgeChatDirective({ FORGE_TOOLS: 'forge_propose_plan' } as NodeJS.ProcessEnv)
    expect(d).toContain('不存在这样的界面')
    expect(d).toMatch(/直接在你这条回复的正文里/)
  })
})

describe('codex run() cancel', () => {
  it('kills the child with SIGTERM', async () => {
    const hangScript = join(dir, 'hang.js')
    const sigtermOut = join(dir, 'sigterm.txt')
    writeFileSync(hangScript, `#!/usr/bin/env node
process.on('SIGTERM', () => {
  require('node:fs').writeFileSync(process.env.SIGTERM_OUT, 'SIGTERM')
  process.exit(143)
})
process.stdout.write('READY\\n')
setInterval(() => {}, 60000)
`)
    chmodSync(hangScript, 0o755)
    const provider = makeCodexProvider({ bin: 'node', preArgs: [hangScript], defaultModels: [] })
    const logs: LogLine[] = []
    const states: string[] = []
    const session = provider.run(
      { stageKey: 'test', agentId: 'a1', name: 'T', prompt: 'x', cwd: dir, model: 'gpt-5-codex' },
      { onLog: l => logs.push(l), onState: s => states.push(s), onConfirm: async () => 'allow', onInput: async () => '', onDone: () => {}, onError: () => {} },
      { ...process.env, SIGTERM_OUT: sigtermOut }
    )
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 1000
      const poll = () => {
        if (logs.some(l => l.text === 'READY')) { resolve(); return }
        if (Date.now() > deadline) { reject(new Error('child did not become ready')); return }
        setTimeout(poll, 10)
      }
      poll()
    })
    session.cancel()
    await session.done
    expect(readFileSync(sigtermOut, 'utf8')).toBe('SIGTERM')
    expect(logs.some(l => l.text.includes('超时'))).toBe(false)
    expect(states[states.length - 1]).toBe('err')
  }, 5000)
})
