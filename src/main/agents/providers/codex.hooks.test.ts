import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatTask } from '../types'

/**
 * 我们拉起的 codex **不关钩子**:用户的 codex 钩子里有必须照常运行的(上报、审计一类)。
 * 审批钩子(Vibe/Ping Island)由用户自己从 hooks.json 里去掉。这里钉死:任何一条路都不带关钩子的覆盖。
 */
const transport = vi.hoisted(() => ({ value: 'exec' as 'exec' | 'app-server' }))
vi.mock('../../config/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/store')>()
  return { ...actual, readSettings: () => ({ ...actual.readSettings(), codexTransport: transport.value }) }
})

const ARGV_DUMP = `#!/usr/bin/env node
const fs = require('node:fs')
// 只记第一次起进程的 argv:app-server 那条路握手不成会退回 exec 再起一次,那一次不能把它盖掉。
if (!fs.existsSync(process.env.ARGV_OUT)) fs.writeFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(2)))
process.exit(0)
`
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
async function chatArgv(task: Partial<ChatTask>, extraEnv: NodeJS.ProcessEnv = {}): Promise<string[]> {
  const { makeCodexProvider } = await import('./codex')
  const provider = makeCodexProvider({ bin, defaultModels: [], modelHasFastTier: () => false })
  const s = provider.chat!({ id: 'a1', prompt: 'PROMPT_BODY', model: 'gpt-6-astra', cwd: dir, ...task }, NOOP_CB, { ...process.env, ARGV_OUT: argvOut, ...extraEnv })
  await s.done
  return JSON.parse(readFileSync(argvOut, 'utf8')) as string[]
}
const keepsHooks = (args: string[]) => !args.some(a => /features\.(codex_)?hooks/.test(a))

describe('codex 钩子保持开启 —— 不传任何关钩子的覆盖', () => {
  it('chat exec', async () => {
    const args = await chatArgv({})
    expect(args[0]).toBe('exec')
    expect(keepsHooks(args)).toBe(true)
    expect(args[args.length - 1]).toContain('PROMPT_BODY')
  })

  it('chat exec resume', async () => {
    const args = await chatArgv({ sessionId: 'thread-9' })
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'thread-9'])
    expect(keepsHooks(args)).toBe(true)
  })

  it('app-server:在 app-server 子命令之前', async () => {
    transport.value = 'app-server'
    const args = await chatArgv({})
    expect(args[args.length - 1]).toBe('app-server')
    expect(keepsHooks(args)).toBe(true)
  })

  // ★R6(2026-11-26,取代「app-server 照读用户配置」):app-server 没有 --ignore-user-config,
  //  用 -c 覆盖做到同样的隔离 —— notify / 插件 / 开发者指令关掉,用户的 MCP 逐个 enabled=false,forge 留着。
  //  ★R7:钩子例外,照常开着(见文件头)。
  it('app-server:隔离用户配置(notify / 插件 / 用户 MCP),钩子保持开启,forge 的覆盖排在后面', async () => {
    transport.value = 'app-server'
    const home = join(dir, 'codex-home')
    mkdirSync(home)
    writeFileSync(join(home, 'config.toml'), 'notify = ["x"]\n[mcp_servers.omx_state]\ncommand = "node"\n')
    const args = await chatArgv({}, { CODEX_HOME: home, FORGE_SOCKET: join(dir, 'sock'), FORGE_AGENT_ID: 'a1', FORGE_MCP_ENTRY: join(dir, 'mcp.js') })
    const pairs = args.flatMap((a, i) => a === '-c' ? [args[i + 1]] : [])
    for (const want of ['notify=[]', 'features.plugins=false', 'mcp_servers.omx_state.enabled=false']) expect(pairs).toContain(want)
    expect(keepsHooks(args)).toBe(true)
    expect(args.indexOf('app-server')).toBe(args.length - 1)
    const forgeAt = pairs.findIndex(p => p.startsWith('mcp_servers.forge.command='))
    expect(forgeAt).toBeGreaterThan(pairs.indexOf('mcp_servers.omx_state.enabled=false'))
    expect(pairs).not.toContain('mcp_servers.forge.enabled=false')
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
    expect(keepsHooks(args)).toBe(true)
  })
})
