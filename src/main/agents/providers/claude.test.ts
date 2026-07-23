import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeClaudeProvider, cliModel } from './claude'
import type { LogLine } from '../types'

let dir: string, cli: string
const FAKE = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'assistant', text: '分析代码库' })
out({ type: 'permission_request', tool: 'Write', path: 'theme.ts' })
out({ type: 'result', subtype: 'success', text: '已完成' })
process.exit(0)
`
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-'))
  cli = join(dir, 'claude.js'); writeFileSync(cli, FAKE); chmodSync(cli, 0o755)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('cliModel', () => {
  it('maps friendly display ids to valid CLI aliases', () => {
    expect(cliModel('opus-4.8')).toBe('opus')
    expect(cliModel('sonnet-4.6')).toBe('sonnet')
    expect(cliModel('haiku-4.5')).toBe('haiku')
  })
  it('passes through values the CLI already accepts (alias or full name)', () => {
    expect(cliModel('opus')).toBe('opus')
    expect(cliModel('claude-opus-4-8')).toBe('claude-opus-4-8')
  })
})

describe('claude provider', () => {
  it('maps text to logs and a permission_request to onConfirm', async () => {
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [cli], defaultModels: [] })
    const logs: LogLine[] = []
    let confirmAsked: string | undefined
    const session = provider.run(
      { stageKey: 'design', agentId: 'a1', name: 'Designer', prompt: 'x', cwd: dir, model: 'opus-4.8' },
      {
        onLog: l => logs.push(l), onState: () => {},
        onConfirm: async (req) => { confirmAsked = req.where; return 'allow' },
        onInput: async () => '', onDone: () => {}, onError: () => {}
      },
      process.env
    )
    const res = await session.done
    expect(res.ok).toBe(true)
    expect(logs.map(l => l.text)).toContain('分析代码库')
    expect(logs.map(l => l.text)).toContain('已完成') // the result event line
    expect(confirmAsked).toBe('theme.ts')
  })
  it('flushes a final JSON line that has no trailing newline', async () => {
    const noNl = join(dir, 'nonl.js')
    writeFileSync(noNl, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', text: '收尾完成' }))
process.exit(0)
`)
    chmodSync(noNl, 0o755)
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [noNl], defaultModels: [] })
    const logs: LogLine[] = []
    const session = provider.run(
      { stageKey: 'design', agentId: 'a1', name: 'D', prompt: 'x', cwd: dir, model: 'opus-4.8' },
      { onLog: l => logs.push(l), onState: () => {}, onConfirm: async () => 'allow', onInput: async () => '', onDone: () => {}, onError: () => {} },
      process.env
    )
    await session.done
    expect(logs.map(l => l.text)).toContain('收尾完成')
  })
  it('denies and surfaces an error if onConfirm throws, instead of hanging', async () => {
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [cli], defaultModels: [] })
    let errored: Error | undefined
    const session = provider.run(
      { stageKey: 'design', agentId: 'a1', name: 'D', prompt: 'x', cwd: dir, model: 'opus-4.8' },
      { onLog: () => {}, onState: () => {},
        onConfirm: async () => { throw new Error('ui torn down') },
        onInput: async () => '', onDone: () => {}, onError: (e) => { errored = e } },
      process.env
    )
    const res = await session.done // must settle, not hang
    expect(res.ok).toBe(true)
    expect(errored?.message).toBe('ui torn down')
  })
  it('chat(): assembles assistant text + thinking from the real nested stream-json shape', async () => {
    const chatCli = join(dir, 'claudechat.js')
    writeFileSync(chatCli, `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'init', session_id: 'sess-1' })
out({ type: 'assistant', session_id: 'sess-1', message: { role: 'assistant', content: [ { type: 'thinking', thinking: '分解任务' } ] } })
out({ type: 'assistant', session_id: 'sess-1', message: { role: 'assistant', content: [ { type: 'text', text: '你好，我来处理' } ] } })
out({ type: 'result', subtype: 'success', result: '你好，我来处理', session_id: 'sess-1' })
process.exit(0)
`)
    chmodSync(chatCli, 0o755)
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [chatCli], defaultModels: [] })
    let text = '', think = '', session = '', done = false
    const s = provider.chat!(
      { id: 'a1', prompt: '你好', model: 'opus-4.8', cwd: dir },
      {
        onSession: (id) => { session = id },
        onAssistantDelta: (t) => { text += t },
        onThinkDelta: (t) => { think += t },
        onDone: () => { done = true },
        onError: () => {},
      },
      process.env
    )
    await s.done
    expect(text).toBe('你好，我来处理')
    expect(think).toBe('分解任务')
    expect(session).toBe('sess-1')
    expect(done).toBe(true)
  })

  it('chat(): forwards CLI stderr lines to onStatus (live startup/log visibility)', async () => {
    const noisyCli = join(dir, 'claudenoisy.js')
    writeFileSync(noisyCli, `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
process.stderr.write('connecting to MCP server forge\\n')
process.stderr.write('mcp: forge ready\\n')
out({ type: 'assistant', session_id: 's', message: { role: 'assistant', content: [ { type: 'text', text: 'hi' } ] } })
out({ type: 'result', subtype: 'success', result: 'hi', session_id: 's' })
process.exit(0)
`)
    chmodSync(noisyCli, 0o755)
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [noisyCli], defaultModels: [] })
    const status: string[] = []
    let text = ''
    const s = provider.chat!(
      { id: 'a1', prompt: 'x', model: 'opus-4.8', cwd: dir },
      {
        onSession: () => {}, onAssistantDelta: (t) => { text += t }, onThinkDelta: () => {},
        onStatus: (t) => status.push(t),
        onDone: () => {}, onError: () => {},
      },
      process.env
    )
    await s.done
    expect(text).toBe('hi')
    expect(status).toContain('connecting to MCP server forge')
    expect(status).toContain('mcp: forge ready')
  })

  it('chat(): a turn with zero assistant text surfaces an error diagnostic instead of a silent blank', async () => {
    const emptyCli = join(dir, 'claudeempty.js')
    writeFileSync(emptyCli, `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'init', session_id: 'sess-1' })
out({ type: 'result', subtype: 'success', session_id: 'sess-1' })
process.exit(0)
`)
    chmodSync(emptyCli, 0o755)
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [emptyCli], defaultModels: [] })
    let err: Error | null = null, done = false
    const s = provider.chat!(
      { id: 'a1', prompt: 'hi', model: 'opus-4.8', cwd: dir },
      { onSession: () => {}, onAssistantDelta: () => {}, onThinkDelta: () => {}, onDone: () => { done = true }, onError: (e) => { err = e } },
      process.env,
    )
    await s.done
    expect(err).toBeInstanceOf(Error)
    expect(done).toBe(false)          // NOT a silent onDone with empty text
  })

  it('chat(): a tool-only turn (e.g. forge_propose_plan) is NOT treated as an empty reply', async () => {
    const toolCli = join(dir, 'claudetool.js')
    writeFileSync(toolCli, `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'init', session_id: 'sess-1' })
out({ type: 'assistant', session_id: 'sess-1', message: { role: 'assistant', content: [ { type: 'tool_use', name: 'forge_propose_plan', input: { approach: 'x' } } ] } })
out({ type: 'result', subtype: 'success', session_id: 'sess-1' })
process.exit(0)
`)
    chmodSync(toolCli, 0o755)
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [toolCli], defaultModels: [] })
    let err: Error | null = null, done = false
    const s = provider.chat!(
      { id: 'a1', prompt: '开启工作流', model: 'opus-4.8', cwd: dir },
      { onSession: () => {}, onAssistantDelta: () => {}, onThinkDelta: () => {}, onDone: () => { done = true }, onError: (e) => { err = e } },
      process.env,
    )
    await s.done
    expect(err).toBeNull()
    expect(done).toBe(true)
  })

  it('chat(): reports running-max per-turn context usage, ignoring output + the cumulative result event', async () => {
    const chatCli = join(dir, 'claudeusage.js')
    writeFileSync(chatCli, `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'init', session_id: 'sess-u' })
out({ type: 'assistant', session_id: 'sess-u', message: { role: 'assistant', usage: { input_tokens: 1000, cache_read_input_tokens: 200, output_tokens: 999 }, content: [ { type: 'text', text: 'hi' } ] } })
out({ type: 'assistant', session_id: 'sess-u', message: { role: 'assistant', usage: { input_tokens: 1500, cache_read_input_tokens: 4800, output_tokens: 999 }, content: [ { type: 'text', text: 'more' } ] } })
out({ type: 'result', subtype: 'success', result: 'more', session_id: 'sess-u', usage: { input_tokens: 50000, cache_read_input_tokens: 900000, output_tokens: 3000 } })
process.exit(0)
`)
    chmodSync(chatCli, 0o755)
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [chatCli], defaultModels: [] })
    const usages: { used: number; window: number }[] = []
    const s = provider.chat!(
      { id: 'a1', prompt: 'hi', model: 'opus-4.8', cwd: dir },
      {
        onSession: () => {}, onAssistantDelta: () => {}, onThinkDelta: () => {},
        onUsage: (u) => { usages.push(u) },
        onDone: () => {}, onError: () => {},
      },
      process.env
    )
    await s.done
    // Turn 1 occupancy = 1000+200 = 1200 (output excluded); turn 2 = 1500+4800 = 6300.
    // The result event's cumulative 950K usage must NOT appear — that was the saturation bug.
    expect(usages.length).toBe(2)
    expect(usages[0]).toEqual({ used: 1200, window: 200000 })
    expect(usages[usages.length - 1]).toEqual({ used: 6300, window: 200000 })
  })

  it('surfaces a non-Task tool call to onToolActivity: title on the tool_use, output on its tool_result', async () => {
    const chatCli = join(dir, 'chat-tool.js')
    writeFileSync(chatCli, `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'init', session_id: 'sess-t' })
out({ type: 'assistant', session_id: 'sess-t', message: { role: 'assistant', content: [ { type: 'tool_use', id: 'tu_bash', name: 'Bash', input: { command: 'npm test' } } ] } })
out({ type: 'user', session_id: 'sess-t', message: { content: [ { type: 'tool_result', tool_use_id: 'tu_bash', content: 'PASS 12 tests', is_error: false } ] } })
out({ type: 'assistant', session_id: 'sess-t', message: { role: 'assistant', content: [ { type: 'text', text: '测试通过' } ] } })
out({ type: 'result', subtype: 'success', result: '测试通过', session_id: 'sess-t' })
process.exit(0)
`)
    chmodSync(chatCli, 0o755)
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [chatCli], defaultModels: [] })
    const acts: { id: string; phase: string; title?: string; output?: string; isError?: boolean }[] = []
    let thinkText = ''
    const s = provider.chat!(
      { id: 'a1', prompt: 'run tests', model: 'opus-4.8', cwd: dir },
      {
        onSession: () => {}, onAssistantDelta: () => {}, onThinkDelta: (t) => { thinkText += t },
        onToolActivity: (ev) => acts.push(ev), onDone: () => {}, onError: () => {},
      },
      process.env
    )
    await s.done
    // The Bash call surfaces as a 执行 activity (title on start, output on its result), NOT a think step.
    const start = acts.find(a => a.phase === 'start')
    const done = acts.find(a => a.phase === 'done')
    expect(start).toMatchObject({ id: 'tu_bash', title: '调用 Bash: npm test' })
    expect(done).toMatchObject({ id: 'tu_bash', output: 'PASS 12 tests', isError: false })
    expect(thinkText).not.toContain('调用 Bash')
  })

  it('coalesces word-granular thinking_delta into whole lines (no one-word-per-line)', async () => {
    const chatCli = join(dir, 'chat-think.js')
    // Real claude with --include-partial-messages streams reasoning as word-level thinking_delta.
    // Emit two reasoning lines split across many tiny deltas; the second line has no trailing newline
    // (flushed at stream end). Each delta must NOT become its own onThinkDelta call.
    writeFileSync(chatCli, `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const think = (t) => out({ type: 'stream_event', session_id: 'sess-tk', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: t } } })
out({ type: 'system', subtype: 'init', session_id: 'sess-tk' })
;['先', '读', '一下', '配置', '。', '\\n', '再', '看', 'provider'].forEach(think)
out({ type: 'assistant', session_id: 'sess-tk', message: { role: 'assistant', content: [ { type: 'text', text: '好的' } ] } })
out({ type: 'result', subtype: 'success', result: '好的', session_id: 'sess-tk' })
process.exit(0)
`)
    chmodSync(chatCli, 0o755)
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [chatCli], defaultModels: [] })
    const thinkLines: string[] = []
    const s = provider.chat!(
      { id: 'a1', prompt: '看看项目', model: 'opus-4.8', cwd: dir },
      { onSession: () => {}, onAssistantDelta: () => {}, onThinkDelta: (t) => thinkLines.push(t), onDone: () => {}, onError: () => {} },
      process.env
    )
    await s.done
    // Whole lines, not one word per call: the pre-newline words join into one line, the trailing tail
    // flushes as another — 9 word-deltas collapse to 2 think emissions.
    expect(thinkLines).toEqual(['先读一下配置。', '再看provider'])
  })

  it('attributes a sub-agent\'s own tool call (parent_tool_use_id) to the sub-agent as a step, not the main 执行 block', async () => {
    const chatCli = join(dir, 'chat-sa.js')
    writeFileSync(chatCli, `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'init', session_id: 'sess-sa' })
out({ type: 'assistant', session_id: 'sess-sa', message: { content: [ { type: 'tool_use', id: 'toolu_task', name: 'Task', input: { subagent_type: 'Explore', description: '探查鉴权' } } ] } })
out({ type: 'assistant', parent_tool_use_id: 'toolu_task', session_id: 'sess-sa', message: { content: [ { type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: 'auth.ts' } } ] } })
out({ type: 'assistant', session_id: 'sess-sa', message: { content: [ { type: 'text', text: '完成' } ] } })
out({ type: 'result', subtype: 'success', result: '完成', session_id: 'sess-sa' })
process.exit(0)
`)
    chmodSync(chatCli, 0o755)
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [chatCli], defaultModels: [] })
    const subEvents: { id: string; phase: string; step?: string }[] = []
    const toolActs: { id: string; title?: string }[] = []
    const s = provider.chat!(
      { id: 'a1', prompt: '查一下鉴权', model: 'opus-4.8', cwd: dir },
      {
        onSession: () => {}, onAssistantDelta: () => {}, onThinkDelta: () => {},
        onSubagent: (ev) => subEvents.push(ev), onToolActivity: (ev) => toolActs.push(ev),
        onDone: () => {}, onError: () => {},
      },
      process.env
    )
    await s.done
    // The sub-agent's Read appears as a STEP on the Task sub-agent, attributed by parent_tool_use_id.
    const step = subEvents.find(e => e.step)
    expect(step).toMatchObject({ id: 'toolu_task', step: '调用 Read auth.ts' })
    // And it must NOT leak into the main turn's 执行 block.
    expect(toolActs.find(a => a.title?.includes('Read'))).toBeUndefined()
  })

  it('advertises permissionHook capability', () => {
    const provider = makeClaudeProvider({ defaultModels: [] })
    expect(provider.capabilities.permissionHook).toBe(true)
  })

  it('advertises liveModels and exposes listModelsLive (recovered from the bundle)', async () => {
    const provider = makeClaudeProvider({ defaultModels: [] })
    expect(provider.capabilities.liveModels).toBe(true)
    expect(typeof provider.listModelsLive).toBe('function')
  })

  it('listModelsLive resolves to an array without throwing (fail-open semantics in claudeModels.test)', async () => {
    // Whether claude is installed on this machine or not, the call must never throw and must
    // return an array. The []-on-unresolvable contract is unit-tested in claudeModels.test.ts
    // with injected deps; here we only verify the provider wiring is sound.
    const provider = makeClaudeProvider({ bin: 'definitely-not-claude-xyz', defaultModels: [] })
    const env = { ...process.env, PATH: '/nonexistent' }
    const out = await provider.listModelsLive!(env)
    expect(Array.isArray(out)).toBe(true)
  })

  it('does NOT write mcp config when preArgs is set even if FORGE_* env vars are present', async () => {
    // preArgs = test harness path, so injection is suppressed (test infra stays clean)
    const { existsSync, readdirSync } = await import('node:fs')
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [cli], defaultModels: [] })
    const envWithForge = {
      ...process.env,
      FORGE_SOCKET: join(dir, 'forge.sock'),
      FORGE_AGENT_ID: 'test-agent',
      FORGE_MCP_ENTRY: join(dir, 'forgeMcp.js'),
    }
    const session = provider.run(
      { stageKey: 'design', agentId: 'a1', name: 'D', prompt: 'x', cwd: dir, model: 'opus-4.8' },
      { onLog: () => {}, onState: () => {}, onConfirm: async () => 'allow', onInput: async () => '', onDone: () => {}, onError: () => {} },
      envWithForge
    )
    await session.done
    // No mcp.*.json file should exist in dir
    const mcpFiles = readdirSync(dir).filter(f => f.startsWith('mcp.') && f.endsWith('.json'))
    expect(mcpFiles).toHaveLength(0)
  })
})

describe('claude chat() forge MCP injection', () => {
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
    const provider = makeClaudeProvider({ bin: dumpCli, defaultModels: [] })
    const s = provider.chat!(
      { id: 'a1', prompt: '你好', model: 'sonnet-4.6', cwd: dir },
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

  it('injects --mcp-config into chat() args when FORGE_* env present', async () => {
    const args = await chatAndCapture(forgeEnv())
    expect(args).toContain('--mcp-config')
  })

  it('does NOT inject --mcp-config into chat() args when FORGE_* env absent', async () => {
    const args = await chatAndCapture({})
    expect(args).not.toContain('--mcp-config')
  })
})

describe('claude run() permission mode (autonomous file writes after plan approval)', () => {
  const ARGV_DUMP = `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(2)))
process.exit(0)
`
  let dumpCli: string, argvOut: string
  beforeEach(() => {
    dumpCli = join(dir, 'argvdump.js'); writeFileSync(dumpCli, ARGV_DUMP); chmodSync(dumpCli, 0o755)
    argvOut = join(dir, 'argv.json')
  })
  const RUN_CB = {
    onLog: () => {}, onState: () => {}, onConfirm: async () => 'allow' as const,
    onInput: async () => '', onDone: () => {}, onError: () => {}
  }
  const runAndCapture = async () => {
    const provider = makeClaudeProvider({ bin: dumpCli, defaultModels: [] })
    const s = provider.run(
      { stageKey: 'design', agentId: 'a1', name: 'D', prompt: 'x', cwd: dir, model: 'opus-4.8' },
      RUN_CB,
      { ...process.env, ARGV_OUT: argvOut }
    )
    await s.done
    return JSON.parse(readFileSync(argvOut, 'utf8')) as string[]
  }

  it('passes --permission-mode acceptEdits so stage agents auto-accept edits within cwd', async () => {
    const args = await runAndCapture()
    expect(args).toContain('--permission-mode')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits')
  })

  const chatArgs = async (permissionMode?: 'readonly' | 'auto' | 'full') => {
    const provider = makeClaudeProvider({ bin: dumpCli, defaultModels: [] })
    const s = provider.chat!(
      { id: 'c1', prompt: 'hi', model: 'sonnet-4.6', cwd: dir, permissionMode },
      { onSession: () => {}, onAssistantDelta: () => {}, onThinkDelta: () => {}, onDone: () => {}, onError: () => {} },
      { ...process.env, ARGV_OUT: argvOut }
    )
    await s.done
    return JSON.parse(readFileSync(argvOut, 'utf8')) as string[]
  }

  it('chat() maps the permission mode to --permission-mode (default auto → acceptEdits)', async () => {
    const def = await chatArgs()
    expect(def[def.indexOf('--permission-mode') + 1]).toBe('acceptEdits')
    const ro = await chatArgs('readonly')
    expect(ro[ro.indexOf('--permission-mode') + 1]).toBe('plan')
    const full = await chatArgs('full')
    expect(full[full.indexOf('--permission-mode') + 1]).toBe('bypassPermissions')
  })
})

describe('claude run() cancel', () => {
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
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [hangScript], defaultModels: [] })
    const logs: LogLine[] = []
    const states: string[] = []
    const session = provider.run(
      { stageKey: 'design', agentId: 'a1', name: 'D', prompt: 'x', cwd: dir, model: 'opus-4.8' },
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
