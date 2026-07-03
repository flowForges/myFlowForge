import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeSubprocessProvider } from './subprocess'
import type { LogLine, AgentState } from '../types'

let dir: string, cliPath: string
const FAKE = `#!/usr/bin/env node
console.log('starting work')
console.log('done: wrote 2 files')
process.exit(0)
`
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-'))
  cliPath = join(dir, 'fakecli.js')
  writeFileSync(cliPath, FAKE); chmodSync(cliPath, 0o755)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('subprocess provider', () => {
  it('streams stdout as log lines, reports run→ok, resolves done', async () => {
    const provider = makeSubprocessProvider({
      id: 'fake', displayName: 'Fake', bin: 'node',
      buildArgs: (task) => [cliPath, task.prompt], models: [{ id: 'm1', label: 'M1' }]
    })
    const logs: LogLine[] = []; const states: AgentState[] = []
    const session = provider.run(
      { stageKey: 'develop', agentId: 'a1', name: 'Dev', prompt: 'do it', cwd: dir, model: 'm1' },
      { onLog: l => logs.push(l), onState: s => states.push(s),
        onConfirm: async () => 'allow', onInput: async () => '', onDone: () => {}, onError: () => {} },
      process.env
    )
    const result = await session.done
    expect(result.ok).toBe(true)
    expect(states[0]).toBe('run'); expect(states.at(-1)).toBe('ok')
    expect(logs.map(l => l.text)).toContain('starting work')
  })

  it('reports run→err with exit-code summary and surfaces stderr on non-zero exit', async () => {
    const failCli = join(dir, 'failcli.js')
    writeFileSync(failCli, `#!/usr/bin/env node
console.error('boom: something failed')
process.exit(3)
`)
    chmodSync(failCli, 0o755)
    const provider = makeSubprocessProvider({
      id: 'fake', displayName: 'Fake', bin: 'node',
      buildArgs: () => [failCli], models: []
    })
    const logs: LogLine[] = []; const states: AgentState[] = []
    const session = provider.run(
      { stageKey: 'develop', agentId: 'a1', name: 'Dev', prompt: 'x', cwd: dir, model: 'm1' },
      { onLog: l => logs.push(l), onState: s => states.push(s),
        onConfirm: async () => 'allow', onInput: async () => '', onDone: () => {}, onError: () => {} },
      process.env
    )
    const result = await session.done
    expect(result.ok).toBe(false)
    expect(result.summary).toBe('退出码 3')
    expect(states.at(-1)).toBe('err')
    expect(logs.map(l => l.text)).toContain('boom: something failed') // stderr is surfaced
  })
})
