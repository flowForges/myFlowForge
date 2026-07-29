import { describe, it, expect } from 'vitest'
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
