import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeGeminiProvider } from './gemini'
import type { LogLine } from '../types'

let dir: string, cli: string
const FAKE = `#!/usr/bin/env node
process.stdout.write('第一行输出\\n')
process.stdout.write('第二行输出\\n')
process.exit(0)
`
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gemini-'))
  cli = join(dir, 'gemini.js'); writeFileSync(cli, FAKE); chmodSync(cli, 0o755)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('gemini provider', () => {
  it('happy path: logs two text lines as accent (so chat downgrade surfaces them) and resolves ok', async () => {
    const provider = makeGeminiProvider({ bin: 'node', preArgs: [cli], defaultModels: [] })
    const logs: LogLine[] = []
    const states: string[] = []
    const session = provider.run(
      { stageKey: 'test', agentId: 'g1', name: 'Tester', prompt: 'hello', cwd: dir, model: 'gemini-2.5-pro' },
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
    expect(logs.map(l => l.text)).toContain('第一行输出')
    expect(logs.map(l => l.text)).toContain('第二行输出')
    expect(logs.every(l => l.level === 'accent')).toBe(true)
    expect(states[0]).toBe('run')
    expect(states[states.length - 1]).toBe('ok')
  })

  it('empty lines are skipped', async () => {
    const emptyScript = join(dir, 'empty.js')
    writeFileSync(emptyScript, `#!/usr/bin/env node\nprocess.stdout.write('a\\n\\n\\nb\\n')\nprocess.exit(0)\n`)
    chmodSync(emptyScript, 0o755)
    const provider = makeGeminiProvider({ bin: 'node', preArgs: [emptyScript], defaultModels: [] })
    const logs: LogLine[] = []
    const session = provider.run(
      { stageKey: 'test', agentId: 'g2', name: 'T', prompt: 'x', cwd: dir, model: 'gemini-2.5-flash' },
      { onLog: l => logs.push(l), onState: () => {}, onConfirm: async () => 'allow', onInput: async () => '', onDone: () => {}, onError: () => {} },
      process.env
    )
    await session.done
    expect(logs).toHaveLength(2)
    expect(logs[0].text).toBe('a')
    expect(logs[1].text).toBe('b')
  })

  it('nonzero exit → onState err, onDone ok:false with 退出码', async () => {
    const failScript = join(dir, 'fail.js')
    writeFileSync(failScript, `#!/usr/bin/env node\nprocess.exit(3)\n`)
    chmodSync(failScript, 0o755)
    const provider = makeGeminiProvider({ bin: 'node', preArgs: [failScript], defaultModels: [] })
    const states: string[] = []
    let done_result: any
    const session = provider.run(
      { stageKey: 'test', agentId: 'g3', name: 'T', prompt: 'x', cwd: dir, model: 'gemini-2.5-pro' },
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

  it('detect() returns false for a nonexistent binary', async () => {
    const provider = makeGeminiProvider({ bin: '/nonexistent/gemini-xyz-fake', defaultModels: [] })
    expect(await provider.detect()).toBe(false)
  })

  it('flushes a final line that has no trailing newline', async () => {
    const noNl = join(dir, 'nonl.js')
    writeFileSync(noNl, `#!/usr/bin/env node\nprocess.stdout.write('尾行')\nprocess.exit(0)\n`)
    chmodSync(noNl, 0o755)
    const provider = makeGeminiProvider({ bin: 'node', preArgs: [noNl], defaultModels: [] })
    const logs: LogLine[] = []
    const session = provider.run(
      { stageKey: 'test', agentId: 'g4', name: 'T', prompt: 'x', cwd: dir, model: 'gemini-2.5-pro' },
      { onLog: l => logs.push(l), onState: () => {}, onConfirm: async () => 'allow', onInput: async () => '', onDone: () => {}, onError: () => {} },
      process.env
    )
    await session.done
    expect(logs.map(l => l.text)).toContain('尾行')
  })

  it('fence: normal line + complete forge:handoff fence + normal line → onHandoff called, fence lines absent from logs', async () => {
    const fenceScript = join(dir, 'fence.js')
    const script = `#!/usr/bin/env node
process.stdout.write('before line\\n')
process.stdout.write('\`\`\`forge:handoff\\n')
process.stdout.write('{ "summary": "task done", "artifacts": [{ "path": "out.md", "kind": "md" }] }\\n')
process.stdout.write('\`\`\`\\n')
process.stdout.write('after line\\n')
process.exit(0)
`
    writeFileSync(fenceScript, script)
    chmodSync(fenceScript, 0o755)
    const provider = makeGeminiProvider({ bin: 'node', preArgs: [fenceScript], defaultModels: [] })
    const logs: LogLine[] = []
    const handoffs: any[] = []
    const session = provider.run(
      { stageKey: 'test', agentId: 'g5', name: 'T', prompt: 'x', cwd: dir, model: 'gemini-2.5-pro' },
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
    expect(handoffs[0].summary).toBe('task done')
    expect(handoffs[0].artifacts).toEqual([{ path: 'out.md', kind: 'md' }])
    // logs contain the two normal lines
    const texts = logs.map(l => l.text)
    expect(texts).toContain('before line')
    expect(texts).toContain('after line')
    // fence lines must NOT appear in logs
    expect(texts.some(t => t.includes('forge:handoff'))).toBe(false)
    expect(texts.some(t => t.includes('task done'))).toBe(false)
  })

  it('fence: unclosed fence at stream end → no onHandoff, flushed lines appear in logs', async () => {
    const unclosedScript = join(dir, 'unclosed.js')
    const script = `#!/usr/bin/env node
process.stdout.write('preamble\\n')
process.stdout.write('\`\`\`forge:handoff\\n')
process.stdout.write('{ "summary": "partial" }\\n')
process.exit(0)
`
    writeFileSync(unclosedScript, script)
    chmodSync(unclosedScript, 0o755)
    const provider = makeGeminiProvider({ bin: 'node', preArgs: [unclosedScript], defaultModels: [] })
    const logs: LogLine[] = []
    const handoffs: any[] = []
    const session = provider.run(
      { stageKey: 'test', agentId: 'g6', name: 'T', prompt: 'x', cwd: dir, model: 'gemini-2.5-pro' },
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
    // No handoff triggered (fence was never closed)
    expect(handoffs).toHaveLength(0)
    // The buffered lines are flushed back into logs (fail-open)
    const texts = logs.map(l => l.text)
    expect(texts).toContain('preamble')
    // The fence open line and buffered body should appear via flush
    expect(texts.some(t => t.includes('forge:handoff') || t.includes('partial'))).toBe(true)
  })
})
