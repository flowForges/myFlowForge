/**
 * codex.run.kind.test.ts
 *
 * Verifies that run() emits onLog lines with the correct `kind` field for each
 * event type produced by parseCodexEvent.  Uses the existing fake-bin/preArgs
 * idiom: we write a Node script that emits canned `item.completed` JSONL to
 * stdout, then capture the onLog calls.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeCodexProvider } from './codex'
import type { LogLine } from '../types'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'codex-kind-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Run the provider with a given fake script and return all captured onLog lines. */
async function captureKinds(scriptBody: string): Promise<LogLine[]> {
  const scriptPath = join(dir, 'fake.js')
  writeFileSync(scriptPath, scriptBody)
  chmodSync(scriptPath, 0o755)

  const provider = makeCodexProvider({ bin: 'node', preArgs: [scriptPath], defaultModels: [] })
  const logs: LogLine[] = []
  const session = provider.run(
    { stageKey: 'test', agentId: 'a1', name: 'T', prompt: 'x', cwd: dir, model: 'default' },
    {
      onLog: l => logs.push(l),
      onState: () => {},
      onConfirm: async () => 'allow',
      onInput: async () => '',
      onDone: () => {},
      onError: () => {}
    },
    process.env
  )
  await session.done
  return logs
}

describe('codex run() — kind-tagged log lines (parity with claude.run())', () => {
  it('reasoning item → kind:think, level:info', async () => {
    const script = `#!/usr/bin/env node
const out = o => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'item.completed', item: { type: 'reasoning', text: '先分析一下' } })
process.exit(0)
`
    const logs = await captureKinds(script)
    const log = logs.find(l => l.text === '先分析一下')
    expect(log).toBeDefined()
    expect(log?.kind).toBe('think')
    expect(log?.level).toBe('info')
  })

  it('command_execution item → kind:tool, level:accent, text starts with 调用 shell', async () => {
    const script = `#!/usr/bin/env node
const out = o => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'item.completed', item: { type: 'command_execution', command: ['ls', '-la'] } })
process.exit(0)
`
    const logs = await captureKinds(script)
    const log = logs.find(l => l.text.startsWith('调用 shell'))
    expect(log).toBeDefined()
    expect(log?.kind).toBe('tool')
    expect(log?.level).toBe('accent')
    expect(log?.text).toBe('调用 shell: ls -la')
  })

  it('file_change item → kind:file, level:accent, text starts with 编辑文件', async () => {
    const script = `#!/usr/bin/env node
const out = o => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'src/foo.ts' }] } })
process.exit(0)
`
    const logs = await captureKinds(script)
    const log = logs.find(l => l.text.startsWith('编辑文件'))
    expect(log).toBeDefined()
    expect(log?.kind).toBe('file')
    expect(log?.level).toBe('accent')
    expect(log?.text).toBe('编辑文件: src/foo.ts')
  })

  it('apply_patch item → kind:file, level:accent', async () => {
    const script = `#!/usr/bin/env node
const out = o => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'item.completed', item: { type: 'apply_patch', files: ['README.md'] } })
process.exit(0)
`
    const logs = await captureKinds(script)
    const log = logs.find(l => l.text.startsWith('编辑文件'))
    expect(log).toBeDefined()
    expect(log?.kind).toBe('file')
    expect(log?.level).toBe('accent')
    expect(log?.text).toBe('编辑文件: README.md')
  })

  it('agent_message item (assistant-final) → kind:output, level:accent', async () => {
    const script = `#!/usr/bin/env node
const out = o => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'item.completed', item: { type: 'agent_message', text: '任务完成，已修改文件。' } })
process.exit(0)
`
    const logs = await captureKinds(script)
    const log = logs.find(l => l.text === '任务完成，已修改文件。')
    expect(log).toBeDefined()
    expect(log?.kind).toBe('output')
    expect(log?.level).toBe('accent')
  })

  it('legacy agent_reasoning think item → kind:think, level:info', async () => {
    // Verify the legacy format also gets kind-tagged correctly
    const script = `#!/usr/bin/env node
const out = o => process.stdout.write(JSON.stringify(o) + '\\n')
out({ msg: { type: 'agent_reasoning', text: '正在思考...' } })
process.exit(0)
`
    const logs = await captureKinds(script)
    const log = logs.find(l => l.text === '正在思考...')
    expect(log).toBeDefined()
    expect(log?.kind).toBe('think')
    expect(log?.level).toBe('info')
  })

  it('legacy exec_command_begin shell action → kind:tool, level:accent', async () => {
    const script = `#!/usr/bin/env node
const out = o => process.stdout.write(JSON.stringify(o) + '\\n')
out({ msg: { type: 'exec_command_begin', command: ['npm', 'test'] } })
process.exit(0)
`
    const logs = await captureKinds(script)
    const log = logs.find(l => l.text.startsWith('调用 shell'))
    expect(log).toBeDefined()
    expect(log?.kind).toBe('tool')
    expect(log?.level).toBe('accent')
    expect(log?.text).toBe('调用 shell: npm test')
  })

  it('session events do NOT produce a log line', async () => {
    const script = `#!/usr/bin/env node
const out = o => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'thread.started', thread_id: 'sess-xyz' })
process.exit(0)
`
    const logs = await captureKinds(script)
    // No log line for session events (no text to show)
    expect(logs.filter(l => l.text.includes('sess-xyz'))).toHaveLength(0)
  })
})
