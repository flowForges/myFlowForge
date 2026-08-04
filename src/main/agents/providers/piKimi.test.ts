import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makePiProvider } from './pi'
import { makeKimiProvider } from './kimi'
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
  dir = mkdtempSync(join(tmpdir(), 'pk-'))
  cli = join(dir, 'fake.js'); writeFileSync(cli, FAKE); chmodSync(cli, 0o755)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const cbs = (logs: LogLine[], states: string[]) => ({
  onLog: (l: LogLine) => logs.push(l), onState: (s: string) => states.push(s),
  onConfirm: async () => 'allow' as const, onInput: async () => '', onDone: () => {}, onError: () => {},
})

describe('pi provider', () => {
  it('invokes `-p <prompt>` and surfaces output as accent logs (chat downgrade)', async () => {
    const provider = makePiProvider({ bin: cli, defaultModels: [] })
    const logs: LogLine[] = [], states: string[] = []
    const session = provider.run({ stageKey: 't', agentId: 'p1', name: 'T', prompt: 'hi', cwd: dir, model: 'default' }, cbs(logs, states) as never, process.env)
    const res = await session.done
    expect(res.ok).toBe(true)
    expect(logs.some(l => l.text === 'ARGS ["-p","hi"]')).toBe(true)   // no --model for 账号默认
    expect(logs.map(l => l.text)).toContain('第一行输出')
    expect(logs.every(l => l.level === 'accent')).toBe(true)
    expect(states.at(-1)).toBe('ok')
  })
  it('adds --model only for a non-default model', async () => {
    const logs: LogLine[] = [], states: string[] = []
    await makePiProvider({ bin: cli, defaultModels: [] }).run({ stageKey: 't', agentId: 'p2', name: 'T', prompt: 'hi', cwd: dir, model: 'anthropic/claude-sonnet-4.5' }, cbs(logs, states) as never, process.env).done
    expect(logs.some(l => l.text === 'ARGS ["-p","hi","--model","anthropic/claude-sonnet-4.5"]')).toBe(true)
  })
  it('reports id, displayName and mcpTools:false', () => {
    const p = makePiProvider({ bin: 'pi', defaultModels: [] })
    expect(p.id).toBe('pi'); expect(p.displayName).toBe('Pi')
    expect(p.capabilities.mcpTools).toBe(false)
  })
})

describe('kimi provider', () => {
  it('invokes `-p <prompt> --output-format text` and surfaces output as accent logs', async () => {
    const provider = makeKimiProvider({ bin: cli, defaultModels: [] })
    const logs: LogLine[] = [], states: string[] = []
    const res = await provider.run({ stageKey: 't', agentId: 'k1', name: 'T', prompt: 'hi', cwd: dir, model: 'default' }, cbs(logs, states) as never, process.env).done
    expect(res.ok).toBe(true)
    expect(logs.some(l => l.text === 'ARGS ["-p","hi","--output-format","text"]')).toBe(true)  // no --model for 账号默认
    expect(logs.map(l => l.text)).toContain('第一行输出')
    expect(logs.every(l => l.level === 'accent')).toBe(true)
  })
  it('adds --model only for a non-default model', async () => {
    const logs: LogLine[] = [], states: string[] = []
    await makeKimiProvider({ bin: cli, defaultModels: [] }).run({ stageKey: 't', agentId: 'k2', name: 'T', prompt: 'hi', cwd: dir, model: 'kimi-k2.5' }, cbs(logs, states) as never, process.env).done
    expect(logs.some(l => l.text === 'ARGS ["-p","hi","--output-format","text","--model","kimi-k2.5"]')).toBe(true)
  })
  it('reports id and displayName', () => {
    const p = makeKimiProvider({ bin: 'kimi', defaultModels: [] })
    expect(p.id).toBe('kimi'); expect(p.displayName).toBe('Kimi Code')
  })
})
