import { describe, it, expect } from 'vitest'
import {
  CLAUDE_CONTROL_FLAGS, controlInitLine, userMessageLine,
  parseCanUseTool, toolTarget, controlAllowLine, controlDenyLine,
} from './claudeControl'

describe('claudeControl', () => {
  it('exposes the two control flags in one array', () => {
    expect(CLAUDE_CONTROL_FLAGS).toEqual(['--input-format', 'stream-json', '--permission-prompt-tool', 'stdio'])
  })

  it('frames an initialize control_request', () => {
    expect(JSON.parse(controlInitLine())).toMatchObject({ type: 'control_request', request: { subtype: 'initialize' } })
  })

  it('frames the prompt as a user message', () => {
    const o = JSON.parse(userMessageLine('do the thing'))
    expect(o).toMatchObject({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }] }, parent_tool_use_id: null })
  })

  it('parses a can_use_tool request (main agent → no agentId)', () => {
    const req = parseCanUseTool({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_1' } })
    expect(req).toEqual({ requestId: 'r1', toolName: 'Bash', input: { command: 'ls' }, toolUseId: 'toolu_1', agentId: undefined })
  })

  it('parses a sub-agent can_use_tool request (agentId set)', () => {
    const req = parseCanUseTool({ type: 'control_request', request_id: 'r2', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: '/x' }, tool_use_id: 'toolu_2', agent_id: 'a99' } })
    expect(req?.agentId).toBe('a99')
  })

  it('returns null for non-can_use_tool objects', () => {
    expect(parseCanUseTool({ type: 'assistant' })).toBeNull()
    expect(parseCanUseTool({ type: 'control_request', request: { subtype: 'initialize' } })).toBeNull()
    expect(parseCanUseTool(null)).toBeNull()
  })

  it('extracts a human target from tool input', () => {
    expect(toolTarget({ file_path: '/a/b' })).toBe('/a/b')
    expect(toolTarget({ command: 'rm -rf x' })).toBe('rm -rf x')
    expect(toolTarget({ path: '/p' })).toBe('/p')
    expect(toolTarget({})).toBeUndefined()
  })

  it('frames an allow response echoing input + request_id', () => {
    const req = { requestId: 'r1', toolName: 'Bash', input: { command: 'ls' }, toolUseId: 'toolu_1' }
    const o = JSON.parse(controlAllowLine(req))
    expect(o).toMatchObject({ type: 'control_response', response: { subtype: 'success', request_id: 'r1', response: { behavior: 'allow', updatedInput: { command: 'ls' }, toolUseID: 'toolu_1' } } })
  })

  it('frames a deny response with a message', () => {
    const req = { requestId: 'r1', toolName: 'Bash', input: {}, toolUseId: 'toolu_1' }
    const o = JSON.parse(controlDenyLine(req, '不行'))
    expect(o).toMatchObject({ type: 'control_response', response: { subtype: 'success', request_id: 'r1', response: { behavior: 'deny', message: '不行', toolUseID: 'toolu_1' } } })
  })
})
