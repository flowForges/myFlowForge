import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatTask } from '../types'

/**
 * codex 快速档:开 → 每条传输都带 `-c service_tier="priority"`;关/缺省 → 一个字都不传(不覆盖用户配置)。
 * 传输方式由 readSettings().codexTransport 决定,这里做成可切换的(见 codex.test.ts 顶部为什么必须钉死)。
 */
const transport = vi.hoisted(() => ({ value: 'exec' as 'exec' | 'app-server' }))
vi.mock('../../config/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/store')>()
  return { ...actual, readSettings: () => ({ ...actual.readSettings(), codexTransport: transport.value }) }
})

// 只把 argv 写下来就退出的假 codex。exec 那条路走 spec.bin;app-server 那条路写死 spawn('codex'),
// 所以同一个脚本也以 `codex` 的名字放进 PATH。
const ARGV_DUMP = `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(2)))
process.exit(0)
`
const TIER = 'service_tier="priority"'
let dir: string, bin: string, argvOut: string, oldPath: string | undefined
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-fast-'))
  bin = join(dir, 'codex'); writeFileSync(bin, ARGV_DUMP); chmodSync(bin, 0o755)
  argvOut = join(dir, 'argv.json')
  oldPath = process.env.PATH
  process.env.PATH = `${dir}:${oldPath ?? ''}`
  // app-server 的 spawn 不接 env 参数,继承的是 process.env —— ARGV_OUT 得放在这里。
  process.env.ARGV_OUT = argvOut
})
afterEach(() => {
  process.env.PATH = oldPath
  delete process.env.ARGV_OUT
  transport.value = 'exec'
  rmSync(dir, { recursive: true, force: true })
})

const NOOP_CB = { onSession: () => {}, onAssistantDelta: () => {}, onThinkDelta: () => {}, onDone: () => {}, onError: () => {} }
async function argvOf(task: Partial<ChatTask>, hasFast: (m: string) => boolean = () => true): Promise<string[]> {
  const { makeCodexProvider } = await import('./codex')
  const provider = makeCodexProvider({ bin, defaultModels: [], modelHasFastTier: hasFast })
  const s = provider.chat!({ id: 'a1', prompt: 'PROMPT_BODY', model: 'gpt-6-astra', cwd: dir, ...task }, NOOP_CB, { ...process.env, ARGV_OUT: argvOut })
  // app-server 那条路:假 codex 写完 argv 就退出,close → done 以失败收尾 —— 照样等它,argv 已经落盘。
  await s.done
  return JSON.parse(readFileSync(argvOut, 'utf8')) as string[]
}
const tierPairs = (args: string[]) => args.filter((a, i) => a === TIER && args[i - 1] === '-c').length

describe('codex 快速档 → -c service_tier="priority"', () => {
  it('exec:开 → 带一对 -c service_tier="priority",prompt 仍在最后', async () => {
    const args = await argvOf({ fast: true })
    expect(args[0]).toBe('exec')
    expect(tierPairs(args)).toBe(1)
    expect(args[args.length - 1]).toContain('PROMPT_BODY')
  })

  it('exec resume:开 → 同样带上', async () => {
    const args = await argvOf({ fast: true, sessionId: 'thread-9' })
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'thread-9'])
    expect(tierPairs(args)).toBe(1)
  })

  it('exec:关 / 缺省 → 不传任何 service_tier(不强行写 "default")', async () => {
    for (const fast of [false, undefined]) {
      const args = await argvOf({ fast })
      expect(args.some(a => a.includes('service_tier'))).toBe(false)
    }
  })

  it('exec resume:关 → 不传', async () => {
    const args = await argvOf({ fast: false, sessionId: 'thread-9' })
    expect(args.some(a => a.includes('service_tier'))).toBe(false)
  })

  it('开着但这个模型没有快速档(换了模型 / default)→ 不传', async () => {
    const args = await argvOf({ fast: true, model: 'default' }, () => false)
    expect(args.some(a => a.includes('service_tier'))).toBe(false)
  })

  it('app-server:开 → 启动参数里带 -c service_tier="priority"(在 app-server 子命令之前)', async () => {
    transport.value = 'app-server'
    const args = await argvOf({ fast: true })
    expect(args[args.length - 1]).toBe('app-server')
    expect(tierPairs(args)).toBe(1)
    expect(args.indexOf(TIER)).toBeLessThan(args.indexOf('app-server'))
  })

  it('app-server:关 / 缺省 → 不传', async () => {
    transport.value = 'app-server'
    for (const fast of [false, undefined]) {
      rmSync(argvOut, { force: true })
      const args = await argvOf({ fast })
      expect(args[args.length - 1]).toBe('app-server')
      expect(args.some(a => a.includes('service_tier'))).toBe(false)
    }
  })
})
