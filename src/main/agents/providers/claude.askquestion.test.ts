import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeClaudeProvider } from './claude'
import type { ChatCallbacks, ConfirmReq } from '../types'

// claude 把 AskUserQuestion(模型在问人)伪装成一次 can_use_tool 权限请求发过来,而答案要塞回权限响应的
// updatedInput 里 —— 这两点合起来就是「卡片只有允许/拒绝、点了之后模型说没等到回复」那个 bug。
// 这里用一个假 CLI 把整条链路跑真:它发出真实形状的请求,并把收到的每一行 stdin 落盘供断言。

let dir: string, cli: string, sink: string

const fakeCli = (sinkPath: string) => `#!/usr/bin/env node
const fs = require('fs')
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
let buf = ''
process.stdin.on('data', (b) => {
  buf += b.toString()
  let nl
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    fs.appendFileSync(${JSON.stringify(sinkPath)}, line + '\\n')
    const o = JSON.parse(line)
    // 收到权限响应就收尾,让 done 能落地
    if (o.type === 'control_response') { out({ type: 'result', subtype: 'success', result: '好' }); setTimeout(() => process.exit(0), 20) }
  }
})
out({ type: 'control_request', request_id: 'rq-1', request: {
  subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: 'toolu_ask', requires_user_interaction: true,
  input: { questions: [{ question: '配置文件用哪种格式？', header: '配置格式', multiSelect: false, options: [
    { label: 'JSON', description: '通用性最好' },
    { label: 'YAML', description: '可读性强' },
    { label: 'TOML', description: '语法清晰' },
  ] }] },
} })
`

// 对照组:一个普通的写文件权限请求(没有 questions / requires_user_interaction)。
const PLAIN_CLI = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
process.stdin.on('data', () => { out({ type: 'result', subtype: 'success', result: '好' }); setTimeout(() => process.exit(0), 20) })
out({ type: 'control_request', request_id: 'rq-2', request: { subtype: 'can_use_tool', tool_name: 'Write', tool_use_id: 'toolu_w', input: { file_path: '/tmp/x.ts' } } })
`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-ask-'))
  sink = join(dir, 'stdin.jsonl')
  cli = join(dir, 'claude.js'); writeFileSync(cli, fakeCli(sink)); chmodSync(cli, 0o755)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function mkCb(onConfirm: ChatCallbacks['onConfirm']) {
  const seen: ConfirmReq[] = []
  const cb: ChatCallbacks = {
    onSession: () => {}, onAssistantDelta: () => {}, onThinkDelta: () => {},
    onDone: () => {}, onError: () => {},
    onConfirm: async (req) => { seen.push(req); return onConfirm!(req) },
  }
  return { cb, seen }
}

/** 假 CLI 落盘的 stdin 行里,找出那条权限响应。 */
function controlResponse() {
  const lines = existsSync(sink) ? readFileSync(sink, 'utf8').trim().split('\n') : []
  return lines.map(l => JSON.parse(l)).find(o => o.type === 'control_response')?.response?.response
}

const run = async (onConfirm: ChatCallbacks['onConfirm']) => {
  const provider = makeClaudeProvider({ bin: 'node', preArgs: [cli], defaultModels: [] })
  const { cb, seen } = mkCb(onConfirm)
  const session = provider.chat!({ id: 't1', cwd: dir, model: 'opus-4.8', text: '帮我选个格式', history: [], attachments: [] } as never, cb, process.env)
  await session.done
  return { seen }
}

describe('claude chat: AskUserQuestion 门', () => {
  it('把选项交给门,而不是只给一句「AskUserQuestion 请求执行」', async () => {
    const { seen } = await run(async () => 'deny')
    expect(seen).toHaveLength(1)
    // 标题就是问题本身 —— 用户第一眼看到的必须是「在问什么」。
    expect(seen[0].title).toBe('配置文件用哪种格式？')
    expect(seen[0].questions).toEqual([{
      question: '配置文件用哪种格式？',
      header: '配置格式',
      multiSelect: false,
      options: [
        { label: 'JSON', description: '通用性最好' },
        { label: 'YAML', description: '可读性强' },
        { label: 'TOML', description: '语法清晰' },
      ],
    }])
  })

  it('用户选的选项随权限响应回传(这才算真的回答了)', async () => {
    await run(async () => ({ decision: 'allow', answers: { '配置文件用哪种格式？': ['TOML'] } }))
    const resp = controlResponse()
    expect(resp.behavior).toBe('allow')
    expect(resp.updatedInput.answers).toEqual({ '配置文件用哪种格式？': 'TOML' })
    expect(resp.toolUseID).toBe('toolu_ask')
  })

  it('自由输入走 response 通道', async () => {
    await run(async () => ({ decision: 'allow', response: '都不合适,用 INI' }))
    expect(controlResponse().updatedInput.response).toBe('都不合适,用 INI')
  })

  it('回归护栏:光 allow 不带答案会让 CLI 拿空 answers 跑完工具,模型收到「没等到回复」', async () => {
    await run(async () => 'allow')
    const resp = controlResponse()
    expect(resp.behavior).toBe('allow')
    // 这正是修复前的形状 —— answers 缺席。断言它只出现在「调用方没给答案」这一种情况下。
    expect(resp.updatedInput.answers).toBeUndefined()
  })

  it('不回答 = deny,模型明确知道被跳过,而不是干等', async () => {
    await run(async () => 'deny')
    const resp = controlResponse()
    expect(resp.behavior).toBe('deny')
    expect(resp.toolUseID).toBe('toolu_ask')
  })

  it('工作流 run() 路径同样拿到选项,并把答案回传(阶段代理也会问人)', async () => {
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [cli], defaultModels: [] })
    const seen: ConfirmReq[] = []
    const session = provider.run(
      { stageKey: 'design', agentId: 'a1', name: 'Designer', prompt: 'x', cwd: dir, model: 'opus-4.8' },
      {
        onLog: () => {}, onState: () => {}, onInput: async () => '', onDone: () => {}, onError: () => {},
        onConfirm: async (req) => { seen.push(req); return { decision: 'allow', answers: { '配置文件用哪种格式？': ['YAML'] } } },
      },
      process.env,
    )
    await session.done
    expect(seen[0].questions?.[0].options.map(o => o.label)).toEqual(['JSON', 'YAML', 'TOML'])
    expect(controlResponse().updatedInput.answers).toEqual({ '配置文件用哪种格式？': 'YAML' })
  })

  it('普通权限请求不受影响:没有 questions,还是那张确认卡', async () => {
    const plain = join(dir, 'plain.js')
    writeFileSync(plain, PLAIN_CLI)
    chmodSync(plain, 0o755)
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [plain], defaultModels: [] })
    const { cb, seen } = mkCb(async () => 'allow')
    await provider.chat!({ id: 't2', cwd: dir, model: 'opus-4.8', text: 'x', history: [], attachments: [] } as never, cb, process.env).done
    expect(seen[0].questions).toBeUndefined()
    expect(seen[0].title).toBe('Write 请求执行')
    expect(seen[0].where).toBe('/tmp/x.ts')
  })
})
