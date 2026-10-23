import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeQoderProvider } from './qoder'
import type { PermissionMode } from '@shared/permissions'

let dir: string
let bin: string
let argvOut: string

const ARGV_DUMP = `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(2)))
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\\n')
process.exit(0)
`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qoder-ro-'))
  bin = join(dir, 'argvdump.js'); writeFileSync(bin, ARGV_DUMP); chmodSync(bin, 0o755)
  argvOut = join(dir, 'argv.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const RUN_CB = { onLog: () => {}, onState: () => {}, onConfirm: async () => 'allow' as const, onInput: async () => '', onDone: () => {}, onError: () => {} }
const CHAT_CB = { onSession: () => {}, onAssistantDelta: () => {}, onThinkDelta: () => {}, onDone: () => {}, onError: () => {} }

const READONLY = ['--permission-mode', 'dont_ask', '--tools', 'Read', 'Grep', 'Glob',
  '--disallowed-tools', 'Edit', '--disallowed-tools', 'Write', '--disallowed-tools', 'Bash']

const forgeEnv = (): NodeJS.ProcessEnv => ({ FORGE_SOCKET: join(dir, 'f.sock'), FORGE_AGENT_ID: 'agent-1', FORGE_MCP_ENTRY: join(dir, 'mcp.js'), FORGE_MCP_DIR: dir, FORGE_TOOLS: 'forge_handoff,forge_heartbeat' })
async function runArgs(mode: PermissionMode | undefined, extra: NodeJS.ProcessEnv = {}): Promise<string[]> {
  const p = makeQoderProvider({ bin, defaultModels: [] })
  await p.run({ stageKey: 's', agentId: 'a', name: 'n', prompt: 'hello', cwd: dir, model: 'default', permissionMode: mode }, RUN_CB, { ...process.env, ARGV_OUT: argvOut, ...extra }).done
  return JSON.parse(readFileSync(argvOut, 'utf8'))
}
async function chatArgs(mode: PermissionMode | undefined): Promise<string[]> {
  const p = makeQoderProvider({ bin, defaultModels: [] })
  await p.chat!({ id: 'c', prompt: 'hello', model: 'default', cwd: dir, permissionMode: mode }, CHAT_CB, { ...process.env, ARGV_OUT: argvOut }).done
  return JSON.parse(readFileSync(argvOut, 'utf8'))
}
const hasSeq = (args: string[], seq: string[]) => args.some((_, i) => seq.every((s, j) => args[i + j] === s))

describe('qoder readonly', () => {
  it('run(): dont_ask + Read/Grep/Glob allowlist + Edit/Write/Bash denied, never --dangerously-skip-permissions', async () => {
    const args = await runArgs('readonly')
    expect(hasSeq(args, READONLY)).toBe(true)
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args).not.toContain('bypass_permissions')
    // prompt sits right after -p, before the variadic --tools, so it can't be swallowed as a tool name
    expect(args.slice(0, 2)).toEqual(['-p', 'hello'])
    // the variadic --tools list is closed by another option, never by the end of argv
    expect(args[args.indexOf('Glob') + 1]).toMatch(/^--/)
  })
  it('chat(): same readonly flags, no --dangerously-skip-permissions', async () => {
    const args = await chatArgs('readonly')
    expect(hasSeq(args, READONLY)).toBe(true)
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args.slice(0, 2)).toEqual(['-p', 'hello'])
  })
  it('auto / full keep today\'s flags', async () => {
    const auto = await runArgs('auto')
    expect(hasSeq(auto, ['--permission-mode', 'accept_edits', '--dangerously-skip-permissions'])).toBe(true)
    expect(auto).not.toContain('--tools')
    const full = await runArgs('full')
    expect(hasSeq(full, ['--permission-mode', 'bypass_permissions', '--dangerously-skip-permissions', '--dangerously-skip-permissions'])).toBe(true)
    const unset = await runArgs(undefined)
    expect(hasSeq(unset, ['--permission-mode', 'accept_edits', '--dangerously-skip-permissions'])).toBe(true)
    const chatAuto = await chatArgs('auto')
    expect(hasSeq(chatAuto, ['--permission-mode', 'accept_edits'])).toBe(true)
    expect(chatAuto).not.toContain('--tools')
  })
  it('run(): readonly workflow/delegate agents keep their forge MCP tools (dont_ask would deny unlisted MCP)', async () => {
    const args = await runArgs('readonly', forgeEnv())
    expect(hasSeq(args, ['--allowed-tools', 'mcp__forge__forge_handoff'])).toBe(true)
    expect(hasSeq(args, ['--allowed-tools', 'mcp__forge__forge_heartbeat'])).toBe(true)
    expect(args).toContain('--mcp-config')
  })
  it('run(): council seats (no FORGE_*) get no forge allow / MCP config', async () => {
    const args = await runArgs('readonly')
    expect(args.some(a => a.startsWith('mcp__forge__'))).toBe(false)
    expect(args).not.toContain('--mcp-config')
  })
  it('run(): auto with forge env is unchanged (no extra forge --allowed-tools)', async () => {
    const args = await runArgs('auto', forgeEnv())
    expect(args.some(a => a.startsWith('mcp__forge__'))).toBe(false)
  })
})
