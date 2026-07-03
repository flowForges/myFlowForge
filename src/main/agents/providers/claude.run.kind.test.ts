import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeClaudeProvider } from './claude'
import type { LogLine, AgentState } from '../types'

// Drive run() with a canned stream-json sequence (the real `--include-partial-messages` shapes
// that parseChatStreamActions understands) and assert each line is logged with the right kind+level.
let dir: string

// One JSON object per stdout line — matches the line-delimited stream-json the run() reader expects.
const STREAM = [
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '先看一下文件' } } },
  { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Edit', input: { file_path: 'src/app.ts' } } } },
  { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } } } },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '修改完成。' } } },
  { type: 'result', subtype: 'success', result: '全部完成' },
]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-kind-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function fakeBin(lines: object[]): string {
  const cli = join(dir, 'stream.js')
  const body = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const lines = ${JSON.stringify(lines)}
for (const l of lines) out(l)
process.exit(0)
`
  writeFileSync(cli, body); chmodSync(cli, 0o755)
  return cli
}

describe('claude run() rich kinded logging', () => {
  it('maps stream-json events to kind-tagged log lines and ends ok', async () => {
    const cli = fakeBin(STREAM)
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [cli], defaultModels: [] })
    const logs: LogLine[] = []
    const states: AgentState[] = []
    const session = provider.run(
      { stageKey: 'design', agentId: 'a1', name: 'D', prompt: 'x', cwd: dir, model: 'opus-4.8' },
      { onLog: l => logs.push(l), onState: s => states.push(s), onConfirm: async () => 'allow', onInput: async () => '', onDone: () => {}, onError: () => {} },
      process.env
    )
    const res = await session.done
    expect(res.ok).toBe(true)
    expect(states[states.length - 1]).toBe('ok')

    const find = (pred: (l: LogLine) => boolean) => logs.find(pred)

    const think = find(l => l.text.includes('先看一下文件'))
    expect(think).toBeDefined()
    expect(think!.kind).toBe('think')
    expect(think!.level).toBe('info')

    const file = find(l => l.text.includes('Edit') && l.text.includes('src/app.ts'))
    expect(file).toBeDefined()
    expect(file!.kind).toBe('file')
    expect(file!.level).toBe('accent')

    const tool = find(l => l.text.includes('Bash') && l.text.includes('npm test'))
    expect(tool).toBeDefined()
    expect(tool!.kind).toBe('tool')
    expect(tool!.level).toBe('accent')

    const output = find(l => l.text.includes('修改完成'))
    expect(output).toBeDefined()
    expect(output!.kind).toBe('output')
    expect(output!.level).toBe('accent')

    const result = find(l => l.text.includes('全部完成'))
    expect(result).toBeDefined()
    expect(result!.kind).toBe('output')
    expect(result!.level).toBe('ok')
  })
})
