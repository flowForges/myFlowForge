import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeDeepseekProvider, dshPermissionMode } from './deepseek'
import { permissionArgs } from '../permissionArgs'
import { providerSupportsPermissions } from '@shared/permissions'
import type { AgentCallbacks, AgentTask, LogLine } from '../types'

let dir: string, cli: string, argvSink: string, envSink: string

// 假 dsh：先把 argv 和 DSH_PERMISSION_MODE 落盘（好断言命令行和权限档），再按【本机实测的真实
// 形状】输出 —— 推理增量走 stderr（前面顶一行 `dsh: reasoning:`），最终回复走 stdout。
const fakeCli = (argvPath: string, envPath: string, body: string) => `#!/usr/bin/env node
const fs = require('fs')
fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)))
fs.writeFileSync(${JSON.stringify(envPath)}, String(process.env.DSH_PERMISSION_MODE ?? ''))
${body}
`

const BODY_OK = `
process.stderr.write('dsh: reasoning:\\n')
process.stderr.write('先看一眼 package.json\\n')
process.stderr.write('再决定改哪个文件\\n')
process.stdout.write('我改好了三个文件。\\n')
process.exit(0)
`

// 没登录时的真实收尾（原样抄自本机 0.1.2-rc.1 的输出）。诊断走 stderr，stdout 一个字都没有。
const BODY_UNAUTH = `
process.stderr.write('\\ndsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment\\n')
process.exit(1)
`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-'))
  argvSink = join(dir, 'argv.json')
  envSink = join(dir, 'permmode.txt')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function withBody(body: string): string {
  const p = join(dir, 'dsh.js')
  writeFileSync(p, fakeCli(argvSink, envSink, body))
  chmodSync(p, 0o755)
  return p
}

const argv = (): string[] => JSON.parse(readFileSync(argvSink, 'utf8'))
const permMode = (): string => (existsSync(envSink) ? readFileSync(envSink, 'utf8') : '')

function mkRunCb() {
  const st = { logs: [] as LogLine[], states: [] as string[], beats: 0, done: null as any, errored: '' }
  const cb: AgentCallbacks = {
    onLog: (l) => st.logs.push(l),
    onState: (s) => st.states.push(s),
    onActivity: () => { st.beats++ },
    onConfirm: async () => 'allow',
    onInput: async () => '',
    onDone: (r) => { st.done = r },
    onError: (e) => { st.errored = e.message },
  }
  return { cb, st }
}

const task = (over: Partial<AgentTask> = {}): AgentTask => ({
  stageKey: 'develop', agentId: 'a1', name: 'dev', prompt: '把测试跑一遍', cwd: dir, model: 'default', ...over,
})

describe('deepseek (dsh) provider', () => {
  it('身份与能力：headless 没有结构化输出、没有逐操作审批、注入不了 forge MCP —— 都如实标 false', () => {
    const p = makeDeepseekProvider({ bin: 'dsh', defaultModels: [] })
    expect(p.id).toBe('deepseek')
    expect(p.displayName).toBe('DeepSeek')
    expect(p.bin).toBe('dsh')
    expect(p.capabilities).toEqual({ structuredOutput: false, permissionHook: false, pty: false, mcpTools: false })
    // headless 的 --help 里一个选项都没有 → 没有 chat()/resume，只能走 run 降级。
    expect(p.chat).toBeUndefined()
  })

  it('★★命令行必须是 `--profile headless -- -- <prompt>` —— 两个 `--` 缺一不可', async () => {
    const p = makeDeepseekProvider({ bin: withBody(BODY_OK), defaultModels: [] })
    const { cb } = mkRunCb()
    await p.run(task(), cb, {}).done
    expect(argv()).toEqual(['--profile', 'headless', '--', '--', '把测试跑一遍'])
  })

  it('★★以 `-` 开头的 prompt 也原样作为一个 argv 元素送进去（少一个 `--` 就会被当成未知选项拒掉）', async () => {
    const p = makeDeepseekProvider({ bin: withBody(BODY_OK), defaultModels: [] })
    const { cb } = mkRunCb()
    await p.run(task({ prompt: '--no-verify 是什么意思' }), cb, {}).done
    expect(argv()).toEqual(['--profile', 'headless', '--', '--', '--no-verify 是什么意思'])
  })

  it('stdout 是最终回复，整段按 accent 出（和 kimi/trae 一样被 chat 降级捕获）', async () => {
    const p = makeDeepseekProvider({ bin: withBody(BODY_OK), defaultModels: [] })
    const { cb, st } = mkRunCb()
    const r = await p.run(task(), cb, {}).done
    expect(r.ok).toBe(true)
    expect(st.states).toEqual(['run', 'ok'])
    expect(st.logs.filter(l => l.level === 'accent').map(l => l.text)).toEqual(['我改好了三个文件。'])
  })

  it('stderr 的推理增量折进 think，`dsh: reasoning:` 那行本身不出现在正文里', async () => {
    const p = makeDeepseekProvider({ bin: withBody(BODY_OK), defaultModels: [] })
    const { cb, st } = mkRunCb()
    await p.run(task(), cb, {}).done
    expect(st.logs.filter(l => l.kind === 'think').map(l => l.text)).toEqual(['先看一眼 package.json', '再决定改哪个文件'])
    expect(st.logs.map(l => l.text)).not.toContain('dsh: reasoning:')
  })

  it('★没登录时那条 MISSING_CREDENTIAL 必须原样露出来，不许被当成推理折叠掉', async () => {
    const p = makeDeepseekProvider({ bin: withBody(BODY_UNAUTH), defaultModels: [] })
    const { cb, st } = mkRunCb()
    const r = await p.run(task(), cb, {}).done
    expect(r.ok).toBe(false)
    expect(st.states).toEqual(['run', 'err'])
    const diag = st.logs.find(l => l.text.includes('MISSING_CREDENTIAL'))!
    expect(diag).toBeTruthy()
    expect(diag.level).toBe('info')
    expect(diag.kind).toBeUndefined()   // 不是推理 —— 折叠起来用户就看不见「你没登录」了
  })

  it('★★stdout 全程静默时，stderr 的字节也要报 onActivity —— 否则一轮长思考在 UI 上就是死的', async () => {
    // headless 只在最后吐一坨 stdout。只认 stdout 的活性信号 = 看门狗盲区（见 memory 那条）。
    const p = makeDeepseekProvider({ bin: withBody(BODY_UNAUTH), defaultModels: [] })
    const { cb, st } = mkRunCb()
    await p.run(task(), cb, {}).done
    expect(st.beats).toBeGreaterThan(0)
  })

  it('没有换行结尾的最后一行也要冲出来', async () => {
    const p = makeDeepseekProvider({ bin: withBody(`process.stdout.write('没有换行的收尾'); process.exit(0)`), defaultModels: [] })
    const { cb, st } = mkRunCb()
    await p.run(task(), cb, {}).done
    expect(st.logs.filter(l => l.level === 'accent').map(l => l.text)).toEqual(['没有换行的收尾'])
  })
})

describe('deepseek 权限档 · 走 DSH_PERMISSION_MODE 而不是命令行 flag', () => {
  it('三档映射到它 composed config 里现成的那三个值', () => {
    expect(dshPermissionMode('readonly')).toBe('read-only')
    expect(dshPermissionMode('auto')).toBe('workspace-write')
    expect(dshPermissionMode('full')).toBe('danger-full-access')
    // 没给档位时用它自己的默认值（`process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`）。
    expect(dshPermissionMode(undefined)).toBe('workspace-write')
  })

  it('★档位是塞进子进程环境的，不是拼进 argv 的', async () => {
    const p = makeDeepseekProvider({ bin: withBody(BODY_OK), defaultModels: [] })
    const { cb } = mkRunCb()
    await p.run(task({ permissionMode: 'full' }), cb, {}).done
    expect(permMode()).toBe('danger-full-access')
    expect(argv()).not.toContain('danger-full-access')
  })

  it('★permissionArgs 对 deepseek 必须返回空数组 —— 它没有权限相关的命令行 flag', () => {
    for (const m of ['readonly', 'auto', 'full'] as const) {
      expect(permissionArgs('deepseek', m), m).toEqual([])
    }
  })

  it('但它确实有沙箱维度，所以 UI 不许说「当前代理不支持权限档」', () => {
    expect(providerSupportsPermissions('deepseek')).toBe(true)
  })
})
