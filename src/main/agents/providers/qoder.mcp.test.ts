import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeQoderProvider } from './qoder'

let dir: string

const ARGV_DUMP = `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(2)))
process.exit(0)
`

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'qoder-mcp-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const RUN_CB = {
  onLog: () => {},
  onState: () => {},
  onConfirm: async () => 'allow' as const,
  onInput: async () => '',
  onDone: () => {},
  onError: () => {},
}

describe('Test A — qoder run() injects --mcp-config when FORGE_* env present', () => {
  it('includes --mcp-config in args when FORGE_SOCKET/FORGE_AGENT_ID/FORGE_MCP_ENTRY set', async () => {
    const dumpBin = join(dir, 'argvdump.js')
    writeFileSync(dumpBin, ARGV_DUMP); chmodSync(dumpBin, 0o755)
    const argvOut = join(dir, 'argv.json')

    const provider = makeQoderProvider({ bin: dumpBin, defaultModels: [] })
    const s = provider.run(
      { stageKey: 'design', agentId: 'a1', name: 'D', prompt: 'x', cwd: dir, model: 'default' },
      RUN_CB,
      {
        ...process.env,
        ARGV_OUT: argvOut,
        FORGE_SOCKET: join(dir, 'f.sock'),
        FORGE_AGENT_ID: 'test-agent',
        FORGE_MCP_ENTRY: join(dir, 'forgeMcp.js'),
      }
    )
    await s.done
    const args = JSON.parse(readFileSync(argvOut, 'utf8')) as string[]
    expect(args).toContain('--mcp-config')
    // qodercli streams with --include-partial-messages but REJECTS claude's --verbose (it prints
    // usage and exits with no stdout), so the adapter must NOT pass --verbose.
    expect(args).not.toContain('--verbose')
    expect(args).toContain('--include-partial-messages')
  })
})

describe('Test C — qoder run() injects --allowed-tools per tool', () => {
  it('injects one --allowed-tools flag per tool in allowedTools', async () => {
    const dumpBin = join(dir, 'argvdump.js')
    writeFileSync(dumpBin, ARGV_DUMP); chmodSync(dumpBin, 0o755)
    const argvOut = join(dir, 'argv.json')

    const provider = makeQoderProvider({ bin: dumpBin, defaultModels: [] })
    const s = provider.run(
      { stageKey: 'design', agentId: 'a1', name: 'D', prompt: 'x', cwd: dir, model: 'default', allowedTools: ['Read', 'Bash'] },
      RUN_CB,
      { ...process.env, ARGV_OUT: argvOut }
    )
    await s.done
    const args = JSON.parse(readFileSync(argvOut, 'utf8')) as string[]

    // Find first --allowed-tools occurrence
    const idx1 = args.indexOf('--allowed-tools')
    expect(idx1).toBeGreaterThanOrEqual(0)
    expect(args[idx1 + 1]).toBe('Read')

    // Find the second --allowed-tools occurrence (after the first)
    const idx2 = args.indexOf('--allowed-tools', idx1 + 1)
    expect(idx2).toBeGreaterThanOrEqual(0)
    expect(args[idx2 + 1]).toBe('Bash')
  })
})

describe('Test B — qoder chat() fires callbacks from canned stream-json', () => {
  it('fires onSession, onAssistantDelta, onThinkDelta, and onDone', async () => {
    const chatCli = join(dir, 'qoderchat.js')
    writeFileSync(chatCli, `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'init', session_id: 'sess-q1' })
out({ type: 'assistant', session_id: 'sess-q1', message: { role: 'assistant', content: [ { type: 'thinking', thinking: '计划中' } ] } })
out({ type: 'assistant', session_id: 'sess-q1', message: { role: 'assistant', content: [ { type: 'text', text: '已完成任务' } ] } })
out({ type: 'result', subtype: 'success', result: '已完成任务', session_id: 'sess-q1' })
process.exit(0)
`)
    chmodSync(chatCli, 0o755)

    const provider = makeQoderProvider({ bin: 'node', preArgs: [chatCli], defaultModels: [] })
    let text = '', think = '', session = '', done = false

    const s = provider.chat!(
      { id: 'a1', prompt: '你好', model: 'default', cwd: dir },
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
    expect(session).toBe('sess-q1')
    expect(text).toBe('已完成任务')
    expect(think).toBe('计划中')
    expect(done).toBe(true)
  })
})

describe('qoder capabilities', () => {
  it('advertises mcpTools: true', () => {
    const provider = makeQoderProvider({ defaultModels: [] })
    expect(provider.capabilities.mcpTools).toBe(true)
  })
})
