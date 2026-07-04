import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeSubprocessProvider } from './subprocess'
import type { LogLine, AgentState, HandoffPayload } from '../types'

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

  // 回归(P2):自定义 subprocess agent 分配到工作流阶段时,须像其他文本兜底 provider 一样扫描
  // forge:handoff 围栏并回调 onHandoff,否则上游交接上下文/设计文档丢失,下游阶段拿不到。
  it('scans forge:handoff fence on stdout, calls onHandoff, and consumes the fence lines', async () => {
    const hoffCli = join(dir, 'hoffcli.js')
    writeFileSync(hoffCli, `#!/usr/bin/env node
console.log('working')
console.log('\\u0060\\u0060\\u0060forge:handoff')
console.log(JSON.stringify({ summary: 'plan done', artifacts: [{ path: 'PLAN.md', kind: 'md' }] }))
console.log('\\u0060\\u0060\\u0060')
console.log('after')
process.exit(0)
`)
    chmodSync(hoffCli, 0o755)
    const provider = makeSubprocessProvider({
      id: 'fake', displayName: 'Fake', bin: 'node', buildArgs: () => [hoffCli], models: []
    })
    const logs: LogLine[] = []; const handoffs: HandoffPayload[] = []
    const session = provider.run(
      { stageKey: 'design', agentId: 'a1', name: 'Dev', prompt: 'x', cwd: dir, model: 'm1' },
      { onLog: l => logs.push(l), onState: () => {}, onConfirm: async () => 'allow',
        onInput: async () => '', onDone: () => {}, onError: () => {}, onHandoff: p => handoffs.push(p) },
      process.env
    )
    await session.done
    expect(handoffs).toHaveLength(1)
    expect(handoffs[0].summary).toBe('plan done')
    expect(handoffs[0].artifacts).toEqual([{ path: 'PLAN.md', kind: 'md' }])
    const texts = logs.map(l => l.text)
    expect(texts).toContain('working')
    expect(texts).toContain('after')
    expect(texts.some(t => t.includes('forge:handoff'))).toBe(false)  // fence consumed, not logged
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
