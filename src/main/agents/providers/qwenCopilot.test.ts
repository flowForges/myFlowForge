import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeQwenProvider } from './qwen'
import { makeCopilotProvider } from './copilot'
import type { LogLine } from '../types'

// A fake CLI that echoes its argv (so we can lock the invocation) then prints two output lines.
const FAKE = `#!/usr/bin/env node
process.stdout.write('ARGS ' + JSON.stringify(process.argv.slice(2)) + '\\n')
process.stdout.write('第一行输出\\n')
process.stdout.write('第二行输出\\n')
process.exit(0)
`
let dir: string, cli: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qc-'))
  cli = join(dir, 'fake.js'); writeFileSync(cli, FAKE); chmodSync(cli, 0o755)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const cbs = (logs: LogLine[], states: string[]) => ({
  onLog: (l: LogLine) => logs.push(l), onState: (s: string) => states.push(s),
  onConfirm: async () => 'allow' as const, onInput: async () => '', onDone: () => {}, onError: () => {},
})

describe('qwen provider', () => {
  it('invokes `-m <model> -p <prompt>` and surfaces output as accent logs (chat downgrade)', async () => {
    const provider = makeQwenProvider({ bin: cli, defaultModels: [] })
    const logs: LogLine[] = [], states: string[] = []
    const session = provider.run({ stageKey: 't', agentId: 'q1', name: 'T', prompt: 'hi', cwd: dir, model: 'qwen3-coder-plus' }, cbs(logs, states) as never, process.env)
    const res = await session.done
    expect(res.ok).toBe(true)
    expect(logs.some(l => l.text === 'ARGS ["-m","qwen3-coder-plus","-p","hi"]')).toBe(true)
    expect(logs.map(l => l.text)).toContain('第一行输出')
    expect(logs.every(l => l.level === 'accent')).toBe(true)
    expect(states.at(-1)).toBe('ok')
  })
  it('reports the id and displayName', () => {
    const p = makeQwenProvider({ bin: 'qwen', defaultModels: [] })
    expect(p.id).toBe('qwen'); expect(p.displayName).toBe('Qwen Code')
  })
})

describe('copilot provider', () => {
  it('invokes `-p <prompt> --allow-all-tools`, adding --model only for a non-default model', async () => {
    const withModel = makeCopilotProvider({ bin: cli, defaultModels: [] })
    let logs: LogLine[] = [], states: string[] = []
    await withModel.run({ stageKey: 't', agentId: 'c1', name: 'T', prompt: 'hi', cwd: dir, model: 'gpt-5' }, cbs(logs, states) as never, process.env).done
    expect(logs.some(l => l.text === 'ARGS ["-p","hi","--allow-all-tools","--model","gpt-5"]')).toBe(true)

    logs = []; states = []
    await makeCopilotProvider({ bin: cli, defaultModels: [] }).run({ stageKey: 't', agentId: 'c2', name: 'T', prompt: 'hi', cwd: dir, model: 'default' }, cbs(logs, states) as never, process.env).done
    expect(logs.some(l => l.text === 'ARGS ["-p","hi","--allow-all-tools"]')).toBe(true)   // no --model for 账号默认
  })
  it('reports the id and displayName', () => {
    const p = makeCopilotProvider({ bin: 'copilot', defaultModels: [] })
    expect(p.id).toBe('copilot'); expect(p.displayName).toBe('GitHub Copilot CLI')
  })
})
