import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeQoderProvider } from './qoder'
import type { LogLine, AgentState } from '../types'

let dir: string

// Canned stream-json sequence (claude-compatible shapes that parseChatStreamActions handles)
const STREAM = [
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '分析中' } } },
  { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Edit', input: { file_path: 'a.ts' } } } },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '完成' } } },
  { type: 'result', subtype: 'success', result: '全部完成' },
]

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'qoder-kind-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function fakeBin(lines: object[], exitCode = 0): string {
  const cli = join(dir, 'stream.js')
  const body = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const lines = ${JSON.stringify(lines)}
for (const l of lines) out(l)
process.exit(${exitCode})
`
  writeFileSync(cli, body); chmodSync(cli, 0o755)
  return cli
}

describe('qoder run() rich kinded logging', () => {
  it('maps stream-json events to kind-tagged log lines and ends ok', async () => {
    const cli = fakeBin(STREAM)
    const provider = makeQoderProvider({ bin: 'node', preArgs: [cli], defaultModels: [] })
    const logs: LogLine[] = []
    const states: AgentState[] = []
    let activityCount = 0

    const session = provider.run(
      { stageKey: 'design', agentId: 'a1', name: 'D', prompt: 'x', cwd: dir, model: 'default' },
      {
        onLog: l => logs.push(l),
        onState: s => states.push(s),
        onActivity: () => { activityCount++ },
        onConfirm: async () => 'allow',
        onInput: async () => '',
        onDone: () => {},
        onError: () => {},
      },
      process.env
    )
    const res = await session.done
    expect(res.ok).toBe(true)
    expect(states[states.length - 1]).toBe('ok')
    expect(activityCount).toBeGreaterThan(0)

    const find = (pred: (l: LogLine) => boolean) => logs.find(pred)

    const think = find(l => l.text.includes('分析中'))
    expect(think).toBeDefined()
    expect(think!.kind).toBe('think')
    expect(think!.level).toBe('info')

    const file = find(l => l.text.includes('Edit') && l.text.includes('a.ts'))
    expect(file).toBeDefined()
    expect(file!.kind).toBe('file')
    expect(file!.level).toBe('accent')

    const output = find(l => l.text.includes('完成') && l.kind === 'output')
    expect(output).toBeDefined()
    expect(output!.kind).toBe('output')
    expect(output!.level).toBe('accent')

    const result = find(l => l.text.includes('全部完成'))
    expect(result).toBeDefined()
    expect(result!.kind).toBe('output')
    expect(result!.level).toBe('ok')
  })

  it('fires onHandoff when a forge:handoff fence appears in stream text', async () => {
    // A handoff fence emitted inside a text_delta line (non-JSON fallback path through scanner)
    // The fence must span multiple lines. We emit it as non-JSON plain text lines so the
    // fallback scanner path is exercised.
    const fenceLines = [
      '```forge:handoff',
      JSON.stringify({ summary: 'design ok', artifacts: [{ path: 'src/x.ts', kind: 'source' }] }),
      '```',
    ]
    // We emit these as non-JSON raw lines to exercise the parse-fail → scanner.feedLine path
    const cli = join(dir, 'fence.js')
    const body = `#!/usr/bin/env node
const lines = ${JSON.stringify(fenceLines)}
for (const l of lines) process.stdout.write(l + '\\n')
process.exit(0)
`
    writeFileSync(cli, body); chmodSync(cli, 0o755)

    const provider = makeQoderProvider({ bin: 'node', preArgs: [cli], defaultModels: [] })
    let handoffPayload: any = null
    const session = provider.run(
      { stageKey: 'design', agentId: 'a2', name: 'D', prompt: 'x', cwd: dir, model: 'default' },
      {
        onLog: () => {},
        onState: () => {},
        onHandoff: p => { handoffPayload = p },
        onConfirm: async () => 'allow',
        onInput: async () => '',
        onDone: () => {},
        onError: () => {},
      },
      process.env
    )
    await session.done
    expect(handoffPayload).not.toBeNull()
    expect(handoffPayload.summary).toBe('design ok')
    expect(handoffPayload.artifacts).toHaveLength(1)
    expect(handoffPayload.artifacts[0].path).toBe('src/x.ts')
  })

  it('ends with state err and non-zero summary on non-zero exit', async () => {
    const cli = fakeBin([], 1)
    const provider = makeQoderProvider({ bin: 'node', preArgs: [cli], defaultModels: [] })
    const states: AgentState[] = []
    let doneResult: any = null

    const session = provider.run(
      { stageKey: 'design', agentId: 'a3', name: 'D', prompt: 'x', cwd: dir, model: 'default' },
      {
        onLog: () => {},
        onState: s => states.push(s),
        onConfirm: async () => 'allow',
        onInput: async () => '',
        onDone: r => { doneResult = r },
        onError: () => {},
      },
      process.env
    )
    await session.done
    expect(states[states.length - 1]).toBe('err')
    expect(doneResult.ok).toBe(false)
    expect(doneResult.summary).toContain('退出码')
  })
})
