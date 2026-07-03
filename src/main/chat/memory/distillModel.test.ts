import { describe, it, expect } from 'vitest'
import { distillModelFor } from './distillModel'

// 记忆蒸馏用当前会话的 provider 执行。蒸馏偏好便宜模型,但 model id 必须对该 provider 合法。
// 'haiku-4.5' 是 claude 专属别名(见 claude.ts CLI_MODEL_ALIAS);把它传给 codex/cursor 等会
// 触发 `The 'haiku-4.5' model is not supported when using Codex with a ChatGPT account` 400。
describe('distillModelFor', () => {
  it('claude 会话用便宜的 haiku 别名蒸馏', () => {
    expect(distillModelFor('claude')).toBe('haiku-4.5')
  })

  it('codex 会话不套 claude 专属别名(否则 ChatGPT 账号 400) → undefined 回退会话默认', () => {
    expect(distillModelFor('codex')).toBeUndefined()
  })

  it('其它 provider(cursor/qoder/自定义)同样不套 claude 别名', () => {
    expect(distillModelFor('cursor')).toBeUndefined()
    expect(distillModelFor('qoder')).toBeUndefined()
    expect(distillModelFor('some-custom-agent')).toBeUndefined()
  })
})
