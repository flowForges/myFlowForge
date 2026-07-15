import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeClaudeProvider } from './claude'
import { makeCodexProvider } from './codex'
import { makeQoderProvider } from './qoder'
import type { ChatTask, ChatCallbacks } from '../types'

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

async function capture(provider: ReturnType<typeof makeClaudeProvider>, env: NodeJS.ProcessEnv): Promise<string[]> {
  const session = provider.chat(task, noop, env)
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
})
