// cursor.chat.test.ts — fakeBin integration tests for cursor provider chat().
// ⚠️ Stream fixture shapes are ASSUMED (cursor not logged in). Match parseCursorEvent shapes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeCursorProvider } from './cursor'

let dir: string

// Canned stream-json sequence using cursor-assumed shapes:
// - assistant text block → onAssistantDelta
// - tool_use block (non-file tool) → onThinkDelta
// - result → no direct callback (end-of-stream)
const CHAT_STREAM = [
  // assistant text → onAssistantDelta
  { type: 'assistant', message: { content: [{ type: 'text', text: '你好，我来帮你。' }] } },
  // tool call (non-file) → onThinkDelta
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo hi' } }] } },
  // file-kind tool call (Edit) → also onThinkDelta
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/x.ts' } }] } },
  // final result
  { type: 'result', result: '完成' },
]

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cursor-chat-')) })
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

describe('cursor chat()', () => {
  it('fires onAssistantDelta for text, onThinkDelta for tool/file, onActivity, onDone', async () => {
    const cli = fakeBin(CHAT_STREAM)
    const provider = makeCursorProvider({ bin: 'node', preArgs: [cli], defaultModels: [] })

    const assistantChunks: string[] = []
    const thinkChunks: string[] = []
    let activityCount = 0
    let doneResult: { elapsed: number } | null = null

    const session = provider.chat!(
      { id: 'c1', prompt: 'hello', model: 'sonnet-4', cwd: dir },
      {
        onSession: () => {},
        onAssistantDelta: t => assistantChunks.push(t),
        onThinkDelta: t => thinkChunks.push(t),
        onActivity: () => { activityCount++ },
        onDone: r => { doneResult = r },
        onError: (e) => { throw e },
      },
      process.env
    )

    const res = await session.done
    expect(res.ok).toBe(true)

    // onAssistantDelta fired with assistant text
    expect(assistantChunks.join('')).toContain('你好')

    // onThinkDelta fired for tool_use (both Bash and Edit route through think/file)
    expect(thinkChunks.length).toBeGreaterThanOrEqual(1)
    const thinkText = thinkChunks.join(' ')
    expect(thinkText).toContain('调用')

    // liveness callback fired
    expect(activityCount).toBeGreaterThan(0)

    // onDone called with elapsed number
    expect(doneResult).not.toBeNull()
    expect(typeof doneResult!.elapsed).toBe('number')
  })

  it('falls back to onAssistantDelta for non-JSON lines', async () => {
    const cli = join(dir, 'plain.js')
    writeFileSync(cli, `#!/usr/bin/env node\nprocess.stdout.write('plain text line\\n')\nprocess.exit(0)\n`)
    chmodSync(cli, 0o755)

    const provider = makeCursorProvider({ bin: 'node', preArgs: [cli], defaultModels: [] })
    const chunks: string[] = []
    const session = provider.chat!(
      { id: 'c2', prompt: 'hi', model: '', cwd: dir },
      {
        onSession: () => {},
        onAssistantDelta: t => chunks.push(t),
        onThinkDelta: () => {},
        onDone: () => {},
        onError: (e) => { throw e },
      },
      process.env
    )
    await session.done
    expect(chunks.join('')).toContain('plain text line')
  })

  it('onDone reports elapsed >= 0', async () => {
    const cli = fakeBin([{ type: 'text', text: 'hi' }])
    const provider = makeCursorProvider({ bin: 'node', preArgs: [cli], defaultModels: [] })
    let elapsed = -1
    const session = provider.chat!(
      { id: 'c3', prompt: 'hi', model: '', cwd: dir },
      {
        onSession: () => {},
        onAssistantDelta: () => {},
        onThinkDelta: () => {},
        onDone: r => { elapsed = r.elapsed },
        onError: (e) => { throw e },
      },
      process.env
    )
    await session.done
    expect(elapsed).toBeGreaterThanOrEqual(0)
  })

  it('returns ok:false on non-zero exit', async () => {
    const cli = fakeBin([], 1)
    const provider = makeCursorProvider({ bin: 'node', preArgs: [cli], defaultModels: [] })
    const session = provider.chat!(
      { id: 'c4', prompt: 'hi', model: '', cwd: dir },
      {
        onSession: () => {},
        onAssistantDelta: () => {},
        onThinkDelta: () => {},
        onDone: () => {},
        onError: () => {},
      },
      process.env
    )
    const res = await session.done
    expect(res.ok).toBe(false)
  })

  it('cancel() sends SIGTERM without throwing', async () => {
    // A bin that sleeps forever so we can cancel it
    const cli = join(dir, 'sleep.js')
    writeFileSync(cli, `#!/usr/bin/env node\nsetTimeout(() => {}, 60000)\n`)
    chmodSync(cli, 0o755)

    const provider = makeCursorProvider({ bin: 'node', preArgs: [cli], defaultModels: [] })
    const session = provider.chat!(
      { id: 'c5', prompt: 'hi', model: '', cwd: dir },
      {
        onSession: () => {},
        onAssistantDelta: () => {},
        onThinkDelta: () => {},
        onDone: () => {},
        onError: () => {},
      },
      process.env
    )
    // Cancel immediately
    session.cancel()
    const res = await session.done
    // After SIGTERM the process exits non-zero (signal kill)
    expect(res).toBeDefined()
  })
})
