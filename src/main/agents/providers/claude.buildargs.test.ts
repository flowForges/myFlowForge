import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { buildClaudeArgs, cliModel } from './claude'

describe('buildClaudeArgs', () => {
  const baseTask = {
    stageKey: 'h',
    agentId: 'a',
    name: 'H',
    prompt: 'hi',
    cwd: '/tmp',
    model: 'opus-4.8',
  } as any

  it('without allowedTools: contains standard flags and NOT --allowedTools', () => {
    const args = buildClaudeArgs(baseTask, process.env)
    expect(args).toContain('-p')
    expect(args).toContain('hi')
    expect(args).toContain('--output-format')
    expect(args).toContain('stream-json')
    expect(args).toContain('--permission-mode')
    expect(args).toContain('acceptEdits')
    expect(args).toContain('--model')
    expect(args).toContain(cliModel('opus-4.8'))
    expect(args).not.toContain('--allowedTools')
  })

  it('with task.allowedTools = [Read, Bash]: args contain --allowedTools followed by Read and Bash', () => {
    const task = { ...baseTask, allowedTools: ['Read', 'Bash'] }
    const args = buildClaudeArgs(task, process.env)
    const idx = args.indexOf('--allowedTools')
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toBe('Read')
    expect(args[idx + 2]).toBe('Bash')
  })

  it('--allowedTools is inserted after acceptEdits and before --model', () => {
    const task = { ...baseTask, allowedTools: ['Read'] }
    const args = buildClaudeArgs(task, process.env)
    const acceptEditsIdx = args.indexOf('acceptEdits')
    const allowedToolsIdx = args.indexOf('--allowedTools')
    const modelIdx = args.indexOf('--model')
    expect(allowedToolsIdx).toBeGreaterThan(acceptEditsIdx)
    expect(allowedToolsIdx).toBeLessThan(modelIdx)
  })

  it('with empty allowedTools array: does NOT inject --allowedTools', () => {
    const task = { ...baseTask, allowedTools: [] }
    const args = buildClaudeArgs(task, process.env)
    expect(args).not.toContain('--allowedTools')
  })

  // Regression: a delegated (run-path) claude sub-agent gets the forge MCP server registered
  // (--mcp-config) but headless claude BLOCKS the forge_handoff call unless its name is pre-granted
  // via --allowedTools. Without the pre-grant the sub-agent can't hand off and degrades to a text
  // "请授权 forge_handoff" reply. The chat path already pre-grants these; run path must too.
  const forgeEnv = {
    FORGE_SOCKET: `${tmpdir()}/forge-test.sock`,
    FORGE_AGENT_ID: 'agent-1',
    FORGE_MCP_ENTRY: '/tmp/forge-mcp-entry.js',
    FORGE_TOOLS: 'forge_handoff,forge_ask',
  } as NodeJS.ProcessEnv

  it('with forge env injected: pre-grants the forge MCP tool names via --allowedTools', () => {
    const args = buildClaudeArgs(baseTask, forgeEnv)
    const idx = args.indexOf('--allowedTools')
    expect(idx).toBeGreaterThan(-1)
    const granted = args.slice(idx + 1)
    expect(granted).toContain('mcp__forge__forge_handoff')
    expect(granted).toContain('mcp__forge__forge_ask')
    expect(args).toContain('--mcp-config')
  })

  it('with forge env AND task.allowedTools: grants both the task tools and the forge tools', () => {
    const task = { ...baseTask, allowedTools: ['Read'] }
    const args = buildClaudeArgs(task, forgeEnv)
    const idx = args.indexOf('--allowedTools')
    expect(idx).toBeGreaterThan(-1)
    const granted = args.slice(idx + 1)
    expect(granted).toContain('Read')
    expect(granted).toContain('mcp__forge__forge_handoff')
  })

  // A read-only delegation must NOT get claude's 'plan' mode: plan blocks the pre-granted
  // forge_handoff so the sub-agent can never hand off (it degraded to a "请授权 forge_handoff" reply).
  // Read-only omits --permission-mode (default ask mode); the delegate denies mutations via onConfirm.
  it('permissionMode readonly: OMITS --permission-mode (no plan) so pre-granted forge tools can run', () => {
    const task = { ...baseTask, permissionMode: 'readonly' }
    const args = buildClaudeArgs(task, forgeEnv)
    expect(args).not.toContain('--permission-mode')
    expect(args).not.toContain('plan')
    // forge tools are still pre-granted so the handoff actually goes through
    const granted = args.slice(args.indexOf('--allowedTools') + 1)
    expect(granted).toContain('mcp__forge__forge_handoff')
  })

  it('permissionMode auto/full still emit their --permission-mode flag', () => {
    expect(buildClaudeArgs({ ...baseTask, permissionMode: 'auto' } as any, process.env)).toContain('acceptEdits')
    expect(buildClaudeArgs({ ...baseTask, permissionMode: 'full' } as any, process.env)).toContain('bypassPermissions')
  })
})
