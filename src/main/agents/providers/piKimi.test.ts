import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { makePiProvider } from './pi'
import { makeKimiProvider } from './kimi'
import { makeReasonixProvider } from './reasonix'
import { makeTraeProvider } from './trae'
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
  it('readonly: only read/grep/find/ls tools, no extensions, no project-local files', async () => {
    const logs: LogLine[] = [], states: string[] = []
    await makePiProvider({ bin: cli, defaultModels: [] }).run({ stageKey: 't', agentId: 'p3', name: 'T', prompt: 'hi', cwd: dir, model: 'default', permissionMode: 'readonly' }, cbs(logs, states) as never, process.env).done
    expect(logs.some(l => l.text === 'ARGS ["-p","hi","--tools","read,grep,find,ls","--no-extensions","--no-approve"]')).toBe(true)
  })
  it('auto / full keep the plain invocation', async () => {
    for (const permissionMode of ['auto', 'full'] as const) {
      const logs: LogLine[] = [], states: string[] = []
      await makePiProvider({ bin: cli, defaultModels: [] }).run({ stageKey: 't', agentId: 'p4', name: 'T', prompt: 'hi', cwd: dir, model: 'default', permissionMode }, cbs(logs, states) as never, process.env).done
      expect(logs.some(l => l.text === 'ARGS ["-p","hi"]')).toBe(true)
    }
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
  it('readonly run(): app-owned agent file (read/search tools only) outside the workspace', async () => {
    const logs: LogLine[] = [], states: string[] = []
    await makeKimiProvider({ bin: cli, defaultModels: [] }).run({ stageKey: 't', agentId: 'k3', name: 'T', prompt: 'hi', cwd: dir, model: 'kimi-k2.5', permissionMode: 'readonly' }, cbs(logs, states) as never, process.env).done
    const argv = JSON.parse(logs.find(l => l.text.startsWith('ARGS '))!.text.slice(5)) as string[]
    const file = argv[argv.indexOf('--agent-file') + 1]
    expect(argv).toEqual(['-p', 'hi', '--output-format', 'text', '--agent-file', file, '--model', 'kimi-k2.5'])
    expect(file.startsWith(dir)).toBe(false)
    expect(isAbsolute(file)).toBe(true)
    const md = readFileSync(file, 'utf8')
    const fm = md.split('---')[1]
    expect(fm).toMatch(/^name: forge-readonly$/m)
    expect(fm).toMatch(/^description: \S/m)
    expect(fm).toMatch(/^tools: \[Read, Glob, Grep, ReadMediaFile\]$/m)
    expect(fm).toMatch(/^disallowedTools: \[Write, Edit, Bash, Agent, AgentSwarm, Skill, TaskStop, CronCreate, CronDelete, EnterPlanMode, ExitPlanMode, CreateGoal\]$/m)
    expect(fm).not.toMatch(/WebSearch|FetchURL/)
    expect(md.split('---').slice(2).join('---')).toContain('${base_prompt}')
  })
  it('readonly chat(): never ACP — even on the account-default model it runs the gated -p path', async () => {
    let text = ''
    await new Promise<void>((resolve) => {
      makeKimiProvider({ bin: cli, defaultModels: [] }).chat!({ id: 'kc', prompt: 'hi', model: 'default', cwd: dir, permissionMode: 'readonly' },
        { onSession() {}, onAssistantDelta: (t) => { text += t }, onThinkDelta() {}, onDone: () => resolve(), onError: () => resolve() }, process.env)
    })
    const argv = JSON.parse(text.split('\n')[0].slice(5)) as string[]
    expect(argv.slice(0, 5)).toEqual(['-p', 'hi', '--output-format', 'text', '--agent-file'])
    expect(argv).not.toContain('acp')
  })
  it('auto / full run() keep the plain invocation', async () => {
    for (const permissionMode of ['auto', 'full'] as const) {
      const logs: LogLine[] = [], states: string[] = []
      await makeKimiProvider({ bin: cli, defaultModels: [] }).run({ stageKey: 't', agentId: 'k4', name: 'T', prompt: 'hi', cwd: dir, model: 'default', permissionMode }, cbs(logs, states) as never, process.env).done
      expect(logs.some(l => l.text === 'ARGS ["-p","hi","--output-format","text"]')).toBe(true)
    }
  })
  it('reports id and displayName', () => {
    const p = makeKimiProvider({ bin: 'kimi', defaultModels: [] })
    expect(p.id).toBe('kimi'); expect(p.displayName).toBe('Kimi Code')
  })
})

describe('reasonix provider', () => {
  it('invokes `run -y <prompt>` and surfaces output as accent logs (chat downgrade)', async () => {
    const provider = makeReasonixProvider({ bin: cli, defaultModels: [] })
    const logs: LogLine[] = [], states: string[] = []
    const res = await provider.run({ stageKey: 't', agentId: 'r1', name: 'T', prompt: 'hi', cwd: dir, model: 'default' }, cbs(logs, states) as never, process.env).done
    expect(res.ok).toBe(true)
    expect(logs.some(l => l.text === 'ARGS ["run","-y","hi"]')).toBe(true)   // no --model for 账号默认
    expect(logs.map(l => l.text)).toContain('第一行输出')
    expect(logs.every(l => l.level === 'accent')).toBe(true)
    expect(states.at(-1)).toBe('ok')
  })
  it('adds --model (before the prompt) only for a non-default model', async () => {
    const logs: LogLine[] = [], states: string[] = []
    await makeReasonixProvider({ bin: cli, defaultModels: [] }).run({ stageKey: 't', agentId: 'r2', name: 'T', prompt: 'hi', cwd: dir, model: 'deepseek-reasoner' }, cbs(logs, states) as never, process.env).done
    expect(logs.some(l => l.text === 'ARGS ["run","-y","--model","deepseek-reasoner","hi"]')).toBe(true)
  })
  it('reports id, displayName and mcpTools:false', () => {
    const p = makeReasonixProvider({ bin: 'reasonix', defaultModels: [] })
    expect(p.id).toBe('reasonix'); expect(p.displayName).toBe('Reasonix')
    expect(p.capabilities.mcpTools).toBe(false)
  })
})

describe('trae provider', () => {
  it('invokes `-p <prompt>` and surfaces output as accent logs (chat downgrade)', async () => {
    const provider = makeTraeProvider({ bin: cli, defaultModels: [] })
    const logs: LogLine[] = [], states: string[] = []
    const res = await provider.run({ stageKey: 't', agentId: 'tr1', name: 'T', prompt: 'hi', cwd: dir, model: 'default' }, cbs(logs, states) as never, process.env).done
    expect(res.ok).toBe(true)
    expect(logs.some(l => l.text === 'ARGS ["-p","hi"]')).toBe(true)
    expect(logs.map(l => l.text)).toContain('第一行输出')
    expect(logs.every(l => l.level === 'accent')).toBe(true)
    expect(states.at(-1)).toBe('ok')
  })
  it('a non-default model goes through `-c model.name=<m>` (never --model)', async () => {
    const logs: LogLine[] = [], states: string[] = []
    await makeTraeProvider({ bin: cli, defaultModels: [] }).run({ stageKey: 't', agentId: 'tr2', name: 'T', prompt: 'hi', cwd: dir, model: 'claude-3-7-sonnet-20250219' }, cbs(logs, states) as never, process.env).done
    expect(logs.some(l => l.text === 'ARGS ["-p","hi","-c","model.name=claude-3-7-sonnet-20250219"]')).toBe(true)
  })
  it('readonly: plan mode + every writer / shell / scheduler tool auto-rejected', async () => {
    const logs: LogLine[] = [], states: string[] = []
    await makeTraeProvider({ bin: cli, defaultModels: [] }).run({ stageKey: 't', agentId: 'tr3', name: 'T', prompt: 'hi', cwd: dir, model: 'default', permissionMode: 'readonly' }, cbs(logs, states) as never, process.env).done
    const deny = ['Edit', 'Write', 'ApplyPatch', 'Bash', 'KillShell', 'CronCreate', 'CronDelete'].flatMap(t => ['--disallowed-tool', t])
    expect(logs.some(l => l.text === `ARGS ${JSON.stringify(['-p', 'hi', '--permission-mode', 'plan', ...deny])}`)).toBe(true)
  })
  it('auto / full keep the plain invocation (no permission flags, never -y)', async () => {
    for (const permissionMode of ['auto', 'full'] as const) {
      const logs: LogLine[] = [], states: string[] = []
      await makeTraeProvider({ bin: cli, defaultModels: [] }).run({ stageKey: 't', agentId: 'tr4', name: 'T', prompt: 'hi', cwd: dir, model: 'default', permissionMode }, cbs(logs, states) as never, process.env).done
      expect(logs.some(l => l.text === 'ARGS ["-p","hi"]')).toBe(true)
    }
  })
  it('reports id, displayName and mcpTools:false', () => {
    const p = makeTraeProvider({ bin: 'traecli', defaultModels: [] })
    expect(p.id).toBe('trae'); expect(p.displayName).toBe('Trae')
    expect(p.capabilities.mcpTools).toBe(false)
  })
})
