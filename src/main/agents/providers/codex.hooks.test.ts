import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatTask } from '../types'

/**
 * 我们拉起的 codex 每条路都带 `-c features.hooks=false`:用户 ~/.codex/hooks.json 里的
 * PermissionRequest 钩子(Ping Island 等)会把审批截走,我们这边永远等不到 → 一直「思考中」。
 */
const transport = vi.hoisted(() => ({ value: 'exec' as 'exec' | 'app-server' }))
vi.mock('../../config/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/store')>()
  return { ...actual, readSettings: () => ({ ...actual.readSettings(), codexTransport: transport.value }) }
})

const ARGV_DUMP = `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(2)))
process.exit(0)
`
const NO_HOOKS = 'features.hooks=false'
// ★旧版 codex 里这个特性叫 codex_hooks(用户 config.toml: [features] codex_hooks = true),两个名字都得关。
const NO_LEGACY_HOOKS = 'features.codex_hooks=false'
let dir: string, bin: string, argvOut: string, oldPath: string | undefined
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-hooks-'))
  bin = join(dir, 'codex'); writeFileSync(bin, ARGV_DUMP); chmodSync(bin, 0o755)
  argvOut = join(dir, 'argv.json')
  oldPath = process.env.PATH
  process.env.PATH = `${dir}:${oldPath ?? ''}`
  process.env.ARGV_OUT = argvOut
})
afterEach(() => {
  process.env.PATH = oldPath
  delete process.env.ARGV_OUT
  transport.value = 'exec'
  rmSync(dir, { recursive: true, force: true })
})

const NOOP_CB = { onSession: () => {}, onAssistantDelta: () => {}, onThinkDelta: () => {}, onDone: () => {}, onError: () => {} }
async function chatArgv(task: Partial<ChatTask>): Promise<string[]> {
  const { makeCodexProvider } = await import('./codex')
  const provider = makeCodexProvider({ bin, defaultModels: [], modelHasFastTier: () => false })
  const s = provider.chat!({ id: 'a1', prompt: 'PROMPT_BODY', model: 'gpt-6-astra', cwd: dir, ...task }, NOOP_CB, { ...process.env, ARGV_OUT: argvOut })
  await s.done
  return JSON.parse(readFileSync(argvOut, 'utf8')) as string[]
}
const hasPair = (args: string[], v: string) => args.some((a, i) => a === v && args[i - 1] === '-c')
const hasNoHooks = (args: string[]) => hasPair(args, NO_HOOKS) && hasPair(args, NO_LEGACY_HOOKS)

describe('codex 钩子一律关掉 → -c features.hooks=false', () => {
  it('chat exec', async () => {
    const args = await chatArgv({})
    expect(args[0]).toBe('exec')
    expect(hasNoHooks(args)).toBe(true)
    expect(args[args.length - 1]).toContain('PROMPT_BODY')
  })

  it('chat exec resume', async () => {
    const args = await chatArgv({ sessionId: 'thread-9' })
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'thread-9'])
    expect(hasNoHooks(args)).toBe(true)
  })

  it('app-server:在 app-server 子命令之前', async () => {
    transport.value = 'app-server'
    const args = await chatArgv({})
    expect(args[args.length - 1]).toBe('app-server')
    expect(hasNoHooks(args)).toBe(true)
  })

  it('workflow run()', async () => {
    const { makeCodexProvider } = await import('./codex')
    const provider = makeCodexProvider({ bin, defaultModels: [] })
    const s = provider.run(
      { stageKey: 't', agentId: 'a1', name: 'T', prompt: 'x', cwd: dir, model: 'default' },
      { onLog: () => {}, onState: () => {}, onConfirm: async () => 'allow', onInput: async () => '', onDone: () => {}, onError: () => {} },
      { ...process.env, ARGV_OUT: argvOut }
    )
    await s.done
    const args = JSON.parse(readFileSync(argvOut, 'utf8')) as string[]
    expect(args[0]).toBe('exec')
    expect(hasNoHooks(args)).toBe(true)
  })
})
