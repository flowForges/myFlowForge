import { describe, it, expect, vi } from 'vitest'
import { makeGeminiProvider } from '../agents/providers/gemini'
import { fakeTransport } from '../agents/acp/acpTestKit'
import { resetAcpAvailability } from '../agents/acp/acpAvailability'
import { buildGateAnswerPrompt, runGateAnswer } from './gateAnswer'
import type { AgentProvider, ChatTask, ChatCallbacks } from '../agents/types'

describe('buildGateAnswerPrompt', () => {
  it('includes the stage doc, the question, and the requirement seed — and tells the model NOT to redo', () => {
    const p = buildGateAnswerPrompt('技术方案设计', '这是方案正文', '待澄清项3是什么意思', '把登录改成SSO')
    expect(p).toContain('技术方案设计')
    expect(p).toContain('这是方案正文')
    expect(p).toContain('待澄清项3是什么意思')
    expect(p).toContain('把登录改成SSO')           // requirement seed threaded in as ground truth
    expect(p).toContain('不要重新输出整份方案')       // the key instruction: answer, don't regenerate
  })
})

describe('runGateAnswer', () => {
  const args = { stageName: '技术方案设计', doc: 'd', question: 'q', model: 'm', cwd: '/ws', env: {} }

  it('returns "" when the provider has no chat (fail-open, caller shows a fallback)', async () => {
    const noChat = {} as unknown as AgentProvider
    expect(await runGateAnswer(noChat, args)).toBe('')
  })

  it('accumulates assistant deltas into the answer', async () => {
    const provider = {
      chat(_t: ChatTask, cb: ChatCallbacks) {
        cb.onAssistantDelta('这个待澄清项的意思是'); cb.onAssistantDelta('……'); cb.onDone({ elapsed: 0 })
        return { id: 'a', cancel() {}, done: Promise.resolve({ ok: true }) }
      },
    } as unknown as AgentProvider
    expect(await runGateAnswer(provider, args)).toBe('这个待澄清项的意思是……')
  })

  it('resolves "" (never throws) when the provider chat throws', async () => {
    const provider = { chat() { throw new Error('boom') } } as unknown as AgentProvider
    expect(await runGateAnswer(provider, args)).toBe('')
  })

  it('falls open to "" on timeout without waiting for a hung session', async () => {
    const provider = {
      chat() { return { id: 'a', cancel() {}, done: new Promise<{ ok: boolean }>(() => {}) } }, // never settles
    } as unknown as AgentProvider
    const immediate = (fn: () => void) => { fn(); return { clear() {} } } // fire the timeout synchronously
    expect(await runGateAnswer(provider, { ...args, setTimer: immediate })).toBe('')
  })
})

// ★★ACP provider(gemini/qwen/copilot/kimi)讲不了 ACP 时,一次性调用**不**回落到 run() —— run() 那条没有门,
//  这里也没人能答「以完全访问跑」。要和这条分支之前「这些 provider 没有 chat()」一模一样:返回 ''。
describe('runGateAnswer — ACP provider 讲不了 ACP', () => {
  it('不跑 run(),按没有 chat() 返回 ""', async () => {
    resetAcpAvailability()
    const refusing = () => fakeTransport((app) => app.onRequest('initialize', () => { throw new Error('unknown method') })).transport
    const provider = makeGeminiProvider({ bin: 'gemini-old', defaultModels: [], acp: { open: refusing } })
    const run = vi.spyOn(provider, 'run')
    const args = { stageName: '技术方案设计', doc: 'd', question: 'q', model: 'm', cwd: '/ws', env: {} }
    expect(await runGateAnswer(provider, args)).toBe('')
    expect(await runGateAnswer(provider, args)).toBe('')   // 第二次走「已知讲不了」那条,同样不跑
    expect(run).not.toHaveBeenCalled()
  })
})
