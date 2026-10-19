import { describe, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { makeGeminiProvider } from '../providers/gemini'
import { makeQwenProvider } from '../providers/qwen'
import { makeCopilotProvider } from '../providers/copilot'
import type { AgentProvider } from '../types'

/**
 * 对着**本机装的真 CLI** 跑一轮 ACP 聊天,把映射后的回调事件打出来。默认不跑 —— 要起真进程、走网络、花额度。
 *
 *   FORGE_ACP_SMOKE=1 npx vitest run --project main src/main/agents/acp/acpSmoke.test.ts
 *
 * 想看门是不是真的经 ACP 升上来:`FORGE_ACP_SMOKE_PROMPT='run the shell command: ls'`(门一律拒)。
 * 只跑某几个:`FORGE_ACP_SMOKE_ONLY=copilot,qwen`。
 *
 * ★走的是 provider.chat() 本身(真实的 ACP 参数 + 回落),不是另抄一份。没装 / 没登录不算失败,只打印出来。
 * ★权限门一律拒:prompt 是无害的「回一个词」,不该有任何工具调用;万一有,也不放行。
 * ★只打印事件,不打印 env —— 不会把任何凭据带进输出。
 */
const ON = process.env.FORGE_ACP_SMOKE === '1'
const PROMPT = process.env.FORGE_ACP_SMOKE_PROMPT || 'reply with the single word: pong'
const ONLY = process.env.FORGE_ACP_SMOKE_ONLY?.split(',').map((s) => s.trim()).filter(Boolean)

const CASES: { id: string; make: () => AgentProvider }[] = [
  { id: 'gemini', make: () => makeGeminiProvider({ bin: 'gemini', defaultModels: [] }) },
  { id: 'qwen', make: () => makeQwenProvider({ bin: 'qwen', defaultModels: [] }) },
  { id: 'copilot', make: () => makeCopilotProvider({ bin: 'copilot', defaultModels: [] }) },
]

const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\n/g, '⏎')

describe.runIf(ON)('真 CLI:一轮 ACP 聊天', () => {
  for (const c of CASES.filter((x) => !ONLY?.length || ONLY.includes(x.id))) {
    it(c.id, async () => {
      const p = c.make()
      const version = await execa(p.bin!, ['--version'], { reject: false }).then((r) => r.exitCode === 0 ? r.stdout.split('\n')[0] : null, () => null)
      if (!version) { console.log(`[${c.id}] skipped: not installed`); return }
      const dir = mkdtempSync(join(tmpdir(), `acp-smoke-${c.id}-`))
      const ev: string[] = []
      const log = (s: string) => { ev.push(s); console.log(`[${c.id}] ${s}`) }
      try {
        log(`version ${version}`)
        const start = Date.now()
        const s = p.chat!({ id: `smoke-${c.id}`, prompt: PROMPT, model: 'default', cwd: dir }, {
          onSession: (id) => log(`session ${id}`),
          onAssistantDelta: (t) => log(`text ${JSON.stringify(t)}`),
          onThinkDelta: (t) => log(`think ${clip(t)}`),
          onStatus: (t) => log(`status ${clip(t)}`),
          onUsage: (u) => log(`usage ${u.used}/${u.window ?? '?'}`),
          onTurnTokens: (t) => log(`tokens in=${t.input} out=${t.output}`),
          onToolActivity: (e) => log(`tool ${e.phase} ${e.name ?? ''} ${clip(e.title ?? '')}`),
          onConfirm: async (r) => { log(`confirm(denied) ${clip(r.title)}`); return 'deny' },
          onDone: (r) => log(`done elapsed=${r.elapsed}s`),
          onError: (e) => log(`error ${clip(e.message, 600)}`),
        }, { ...process.env })
        const timer = setTimeout(() => { log('timeout 150s → cancel'); s.cancel() }, 150_000)
        const r = await s.done
        clearTimeout(timer)
        log(`result ok=${r.ok} summary=${clip(r.summary ?? '')} in ${Math.round((Date.now() - start) / 1000)}s`)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 180_000)
  }
})
