import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeClaudeProvider } from './claude'
import type { LogLine } from '../types'

// Regression: a subagent writing a large document streams the whole file content as a long run of
// `input_json_delta` events (the tool-input of a single Write). Those deltas map to NO log line, so
// the orchestrator heartbeat — which only beats on onLog — saw total silence for >150s and the
// watchdog killed a perfectly healthy agent mid-Write. run() must signal onActivity on raw stream
// traffic so liveness is decoupled from whether an event produces a user-facing log line.
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'claude-act-')) })
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

describe('claude run() — liveness on tool-input streaming', () => {
  it('signals onActivity for input_json_delta traffic that produces no log line', async () => {
    // Pure tool-input deltas: this is the silent window that streamed a 34KB Write content.
    const stream = [
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"content":"# Design' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '\\n\\nlots of text...' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '...more...\\"}' } } },
    ]
    const cli = fakeBin(stream)
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [cli], defaultModels: [] })
    const logs: LogLine[] = []
    let activity = 0
    const session = provider.run(
      { stageKey: 'design', agentId: 'a1', name: 'D', prompt: 'x', cwd: dir, model: 'opus-4.8' },
      { onLog: l => logs.push(l), onState: () => {}, onConfirm: async () => 'allow', onInput: async () => '', onDone: () => {}, onError: () => {}, onActivity: () => { activity++ } },
      process.env
    )
    await session.done
    // The blind spot: these deltas carry no user-facing text, so they produce no log line at all.
    expect(logs).toHaveLength(0)
    // The fix: the raw stream traffic must still register as activity so the heartbeat stays alive.
    expect(activity).toBeGreaterThan(0)
  })
})
