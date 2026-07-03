import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeCodexProvider } from './codex'
import type { LogLine } from '../types'

// Same blind spot as claude: codex emits item.started / item.updated lifecycle events while a long
// item (e.g. a big apply_patch) is being generated. The current parser only logs on item.completed,
// so those in-flight events produce no log line and the heartbeat would see silence. run() must
// signal onActivity on raw stream traffic so a healthy long-running agent is not killed.
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'codex-act-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function run(scriptBody: string): Promise<{ logs: LogLine[]; activity: number }> {
  const scriptPath = join(dir, 'fake.js')
  writeFileSync(scriptPath, scriptBody); chmodSync(scriptPath, 0o755)
  const provider = makeCodexProvider({ bin: 'node', preArgs: [scriptPath], defaultModels: [] })
  const logs: LogLine[] = []
  let activity = 0
  const session = provider.run(
    { stageKey: 'test', agentId: 'a1', name: 'T', prompt: 'x', cwd: dir, model: 'default' },
    { onLog: l => logs.push(l), onState: () => {}, onConfirm: async () => 'allow', onInput: async () => '', onDone: () => {}, onError: () => {}, onActivity: () => { activity++ } },
    process.env
  )
  await session.done
  return { logs, activity }
}

describe('codex run() — liveness on in-flight item streaming', () => {
  it('signals onActivity for item.started/updated traffic that produces no log line', async () => {
    const script = `#!/usr/bin/env node
const out = o => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'item.started', item: { type: 'file_change' } })
out({ type: 'item.updated', item: { type: 'file_change' } })
out({ type: 'item.updated', item: { type: 'file_change' } })
process.exit(0)
`
    const { logs, activity } = await run(script)
    // In-flight lifecycle events are not logged (only item.completed is) — the silent window.
    expect(logs).toHaveLength(0)
    // But the stream traffic keeps liveness alive.
    expect(activity).toBeGreaterThan(0)
  })
})
