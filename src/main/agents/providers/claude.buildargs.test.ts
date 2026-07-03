import { describe, it, expect } from 'vitest'
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
})
