import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeClaudeProvider } from './claude'
import { makeCodexProvider } from './codex'
import { makeQoderProvider } from './qoder'
import { makeCopilotProvider } from './copilot'
import { makeCursorProvider } from './cursor'
import { makeGeminiProvider } from './gemini'
import { makeQwenProvider } from './qwen'
import { makeOpencodeProvider } from './opencode'
import type { ChatTask, ChatCallbacks, AgentTask, AgentCallbacks, AgentProvider } from '../types'

// Regression for the chat-delegation bug: forge_delegate / forge_propose_plan silently failed
// because the non-interactive CLI blocked the MCP tool call. Each provider's chat() must now
// authorize the forge MCP tools (claude/qoder via --allowedTools/--allowed-tools; codex by using
// the only sandbox that lets it run MCP tools — danger-full-access). We spawn a fake bin that
// records its argv, then assert the authorization landed in the real chat() arg list.
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'forge-perm-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

// A bin that dumps its argv to ARGV_OUT then exits — chat() gets no stream (treated as no-reply),
// which is fine: we only care about the args built before spawn.
function argvBin(): string {
  const cli = join(dir, 'dump.js')
  writeFileSync(cli, `#!/usr/bin/env node
require('fs').writeFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(2)))
process.exit(0)
`)
  chmodSync(cli, 0o755)
  return cli
}

function forgeEnv(): NodeJS.ProcessEnv {
  return {
    ARGV_OUT: join(dir, 'argv.json'),
    FORGE_SOCKET: join(dir, 'forge.sock'),
    FORGE_AGENT_ID: 'chat',
    FORGE_MCP_ENTRY: '/app/out/main/forgeMcp.js',
    FORGE_TOOLS: 'forge_propose_plan,forge_delegate',
  }
}

const task: ChatTask = { id: 't1', prompt: 'hi', cwd: '/tmp', model: 'default', permissionMode: 'readonly' }
const noop: ChatCallbacks = {
  onSession: () => {}, onAssistantDelta: () => {}, onThinkDelta: () => {},
  onDone: () => {}, onError: () => {},
}

async function capture(provider: ReturnType<typeof makeClaudeProvider>, env: NodeJS.ProcessEnv, cwd?: string): Promise<string[]> {
  if (!provider.chat) throw new Error('provider has no chat()')
  const session = provider.chat({ ...task, cwd: cwd ?? task.cwd }, noop, env)
  await session.done
  const out = env.ARGV_OUT as string
  return existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : []
}

// copilot (and other chat()-less providers) get their chat turn driven through run() instead — see
// chatService.ts's run-downgrade. Mirror that shape here: build an AgentTask (stageKey:'chat') and
// drive provider.run(), then dump the recorded argv the same way capture() does.
const runTask: AgentTask = { stageKey: 'chat', agentId: 'chat', name: 'chat', prompt: 'hi', cwd: '/tmp', model: 'default', permissionMode: 'readonly' }
const runNoop: AgentCallbacks = {
  onLog: () => {}, onState: () => {}, onConfirm: async () => 'deny', onInput: async () => '',
  onDone: () => {}, onError: () => {},
}
async function captureRun(provider: { run: AgentProvider['run'] }, env: NodeJS.ProcessEnv, cwd?: string): Promise<string[]> {
  const session = provider.run({ ...runTask, cwd: cwd ?? runTask.cwd }, runNoop, env)
  await session.done
  const out = env.ARGV_OUT as string
  return existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : []
}

describe('forge MCP tool authorization in chat()', () => {
  it('claude pre-grants the forge tools via --allowedTools', async () => {
    const args = await capture(makeClaudeProvider({ bin: argvBin(), defaultModels: [] }), forgeEnv())
    const i = args.indexOf('--allowedTools')
    expect(i).toBeGreaterThan(-1)
    expect(args).toContain('mcp__forge__forge_delegate')
    expect(args).toContain('mcp__forge__forge_propose_plan')
  })

  it('qoder pre-grants the forge tools via --allowed-tools', async () => {
    const args = await capture(makeQoderProvider({ bin: argvBin(), defaultModels: [] }), forgeEnv())
    expect(args.filter(a => a === '--allowed-tools').length).toBe(2)
    expect(args).toContain('mcp__forge__forge_delegate')
    expect(args).toContain('mcp__forge__forge_propose_plan')
  })

  it('codex forces danger-full-access sandbox so MCP tool calls are not cancelled', async () => {
    const args = await capture(makeCodexProvider({ bin: argvBin(), defaultModels: [] }), forgeEnv())
    expect(args).toContain('sandbox_mode="danger-full-access"')
    // still non-interactive
    expect(args).toContain('approval_policy="never"')
    // forge server actually registered
    expect(args.some(a => a.startsWith('mcp_servers.forge.command='))).toBe(true)
  })

  it('codex keeps the permission-shield sandbox when forge is NOT injected', async () => {
    const env = { ARGV_OUT: join(dir, 'argv.json') } // no FORGE_* → no forge tools
    const args = await capture(makeCodexProvider({ bin: argvBin(), defaultModels: [] }), env)
    expect(args).toContain('sandbox_mode="read-only"') // from permissionMode: 'readonly'
    expect(args).not.toContain('sandbox_mode="danger-full-access"')
  })

  it('claude adds no --allowedTools when forge is NOT injected', async () => {
    const env = { ARGV_OUT: join(dir, 'argv.json') }
    const args = await capture(makeClaudeProvider({ bin: argvBin(), defaultModels: [] }), env)
    expect(args).not.toContain('--allowedTools')
  })

  it('copilot 注入 --additional-mcp-config + --allow-all-tools', async () => {
    const args = await captureRun(makeCopilotProvider({ bin: argvBin(), defaultModels: [] }), forgeEnv())
    expect(args).toContain('--additional-mcp-config')
    expect(args).toContain('--allow-all-tools')
    const idx = args.indexOf('--additional-mcp-config')
    expect(JSON.parse(args[idx + 1]).mcpServers.forge).toBeTruthy()
    // no duplicate --allow-all-tools even though provisionForgeMcp already includes it
    expect(args.filter(a => a === '--allow-all-tools').length).toBe(1)
    // chat directive prepended to the prompt so a copilot-driven chat turn learns to delegate
    const promptIdx = args.indexOf('-p')
    expect(args[promptIdx + 1]).toContain('Forge 双路径规则')
    expect(args[promptIdx + 1]).toContain('hi')
  })

  it('copilot keeps a single --allow-all-tools and no forge directive when forge is NOT injected', async () => {
    const env = { ARGV_OUT: join(dir, 'argv.json') }
    const args = await captureRun(makeCopilotProvider({ bin: argvBin(), defaultModels: [] }), env)
    expect(args).not.toContain('--additional-mcp-config')
    expect(args.filter(a => a === '--allow-all-tools').length).toBe(1)
    const promptIdx = args.indexOf('-p')
    expect(args[promptIdx + 1]).toBe('hi')
  })

  it('gemini 注入 yolo + allowed-mcp-server-names 且写 .gemini/settings.json', async () => {
    const args = await captureRun(makeGeminiProvider({ bin: argvBin(), defaultModels: [] }), forgeEnv(), dir)
    expect(args).toEqual(expect.arrayContaining(['--approval-mode', 'yolo', '--allowed-mcp-server-names', 'forge']))
    const cfgPath = join(dir, '.gemini', 'settings.json')
    expect(existsSync(cfgPath)).toBe(true)
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(cfg.mcpServers.forge.trust).toBe(true)
    // chat directive prepended to the prompt so a gemini-driven chat turn learns to delegate
    const promptIdx = args.indexOf('-p')
    expect(args[promptIdx + 1]).toContain('Forge 双路径规则')
    expect(args[promptIdx + 1]).toContain('hi')
  })

  it('gemini adds no extra args or directive when forge is NOT injected', async () => {
    const env = { ARGV_OUT: join(dir, 'argv.json') }
    const args = await captureRun(makeGeminiProvider({ bin: argvBin(), defaultModels: [] }), env, dir)
    expect(args).not.toContain('--approval-mode')
    expect(existsSync(join(dir, '.gemini', 'settings.json'))).toBe(false)
    const promptIdx = args.indexOf('-p')
    expect(args[promptIdx + 1]).toBe('hi')
  })

  it('qwen 写 .qwen/settings.json（trust=true）且不注入 --approval-mode（0.19 fork 无此参数）', async () => {
    const args = await captureRun(makeQwenProvider({ bin: argvBin(), defaultModels: [] }), forgeEnv(), dir)
    expect(args).not.toContain('--approval-mode')
    const cfgPath = join(dir, '.qwen', 'settings.json')
    expect(existsSync(cfgPath)).toBe(true)
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(cfg.mcpServers.forge.trust).toBe(true)
    // chat directive prepended to the prompt so a qwen-driven chat turn learns to delegate
    const promptIdx = args.indexOf('-p')
    expect(args[promptIdx + 1]).toContain('Forge 双路径规则')
    expect(args[promptIdx + 1]).toContain('hi')
  })

  it('cursor 注入 --approve-mcps 且写 .cursor/mcp.json', async () => {
    const args = await capture(makeCursorProvider({ bin: argvBin(), defaultModels: [] }), forgeEnv(), dir)
    expect(args).toContain('--approve-mcps')
    const cfgPath = join(dir, '.cursor', 'mcp.json')
    expect(existsSync(cfgPath)).toBe(true)
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(cfg.mcpServers.forge).toBeTruthy()
  })

  it('opencode 写 opencode.json mcp.forge（enabled=true 足够，无需 permission 键 —— 实测确认）', async () => {
    const args = await capture(makeOpencodeProvider({ bin: argvBin(), defaultModels: [] }), forgeEnv(), dir)
    const cfgPath = join(dir, 'opencode.json')
    expect(existsSync(cfgPath)).toBe(true)
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(cfg.mcp.forge.enabled).toBe(true)
    expect(cfg.mcp.forge.type).toBe('local')
    // chat directive prepended to the prompt (already inlined by opencode chat()); prompt is the
    // last positional arg since opencode has no -p/--prompt flag for `run`.
    expect(args[args.length - 1]).toContain('Forge 双路径规则')
    expect(args[args.length - 1]).toContain('hi')
  })
})
